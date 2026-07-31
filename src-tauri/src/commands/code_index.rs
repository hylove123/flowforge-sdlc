// ================================================================
//  commands/code_index.rs — code intelligence layer (Phase 5)
//
//  tree-sitter based repository indexing:
//    * languages: JS / TS / TSX / Java / Go / Python
//    * extracts symbols (function/class/method/interface with line
//      ranges), import relations, call relations (same-file + best-
//      effort cross-file by unique name), cyclomatic complexity
//      (decision-point approximation)
//    * files walked with the `ignore` crate (respects .gitignore) and
//      parsed in parallel via rayon; a single-writer SQLite transaction
//      persists the result
//    * persistence: {FLOWFORGE_DATA_DIR || ~/.flowforge}/code_index/
//      {repoHash}.db — the same path convention the sidecar uses so
//      better-sqlite3 can read the index directly (code.search RPC)
//    * retrieval: SQLite FTS5 BM25 over name/signature/path/doc with
//      an LRU result cache (invalidated by a generation counter)
//
//  Incremental indexing + git plumbing live in git_ops.rs.
// ================================================================

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use lru::LruCache;
use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use tree_sitter::{Language, Node, Parser};

// ─── Language detection ─────────────────────────────────────────

/// Node-kind dialect group — JS/TS/TSX share one AST shape.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LangFamily {
  JsLike,
  Java,
  Go,
  Python,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
  Js,
  Ts,
  Tsx,
  Java,
  Go,
  Py,
}

impl Lang {
  pub fn from_path(path: &Path) -> Option<Lang> {
    match path.extension()?.to_str()? {
      "js" | "jsx" | "mjs" | "cjs" => Some(Lang::Js),
      "ts" | "mts" | "cts" => Some(Lang::Ts),
      "tsx" => Some(Lang::Tsx),
      "java" => Some(Lang::Java),
      "go" => Some(Lang::Go),
      "py" => Some(Lang::Py),
      _ => None,
    }
  }

  pub fn name(self) -> &'static str {
    match self {
      Lang::Js => "javascript",
      Lang::Ts => "typescript",
      Lang::Tsx => "tsx",
      Lang::Java => "java",
      Lang::Go => "go",
      Lang::Py => "python",
    }
  }

  fn family(self) -> LangFamily {
    match self {
      Lang::Js | Lang::Ts | Lang::Tsx => LangFamily::JsLike,
      Lang::Java => LangFamily::Java,
      Lang::Go => LangFamily::Go,
      Lang::Py => LangFamily::Python,
    }
  }

  fn grammar(self) -> Language {
    match self {
      Lang::Js => tree_sitter_javascript::LANGUAGE.into(),
      Lang::Ts => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
      Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
      Lang::Java => tree_sitter_java::LANGUAGE.into(),
      Lang::Go => tree_sitter_go::LANGUAGE.into(),
      Lang::Py => tree_sitter_python::LANGUAGE.into(),
    }
  }
}

// ─── Extraction records ─────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SymbolRec {
  pub name: String,
  pub kind: &'static str, // function | class | method | interface
  pub start_line: usize,  // 1-based
  pub end_line: usize,
  pub signature: String,
  pub doc: Option<String>,
  pub complexity: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RelationRec {
  pub kind: &'static str, // import | call
  pub source_symbol: Option<String>,
  pub target_name: String,
}

pub struct FileParse {
  pub rel_path: String,
  pub lang: Lang,
  pub mtime_ms: i64,
  pub size: i64,
  pub symbols: Vec<SymbolRec>,
  pub relations: Vec<RelationRec>,
}

// ─── AST walk ───────────────────────────────────────────────────

fn decision_kinds(family: LangFamily) -> &'static [&'static str] {
  match family {
    LangFamily::JsLike => &[
      "if_statement", "for_statement", "for_in_statement", "while_statement",
      "do_statement", "switch_case", "catch_clause", "ternary_expression",
    ],
    LangFamily::Java => &[
      "if_statement", "for_statement", "enhanced_for_statement", "while_statement",
      "do_statement", "switch_block_statement_group", "catch_clause", "ternary_expression",
    ],
    LangFamily::Go => &[
      "if_statement", "for_statement", "expression_case", "type_case", "communication_case",
    ],
    LangFamily::Python => &[
      "if_statement", "elif_clause", "for_statement", "while_statement",
      "except_clause", "conditional_expression", "case_clause",
    ],
  }
}

fn count_decisions(node: Node, family: LangFamily) -> i64 {
  let kinds = decision_kinds(family);
  let mut count = 0i64;
  let mut cursor = node.walk();
  let mut stack = vec![node];
  while let Some(n) = stack.pop() {
    if kinds.contains(&n.kind()) {
      count += 1;
    }
    for child in n.children(&mut cursor) {
      stack.push(child);
    }
  }
  count
}

fn node_text<'a>(node: Node, src: &'a str) -> &'a str {
  node.utf8_text(src.as_bytes()).unwrap_or("")
}

fn field_text(node: Node, field: &str, src: &str) -> Option<String> {
  node
    .child_by_field_name(field)
    .map(|n| node_text(n, src).to_string())
}

fn strip_quotes(s: &str) -> String {
  s.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
}

fn first_line(s: &str, max: usize) -> String {
  let line = s.lines().next().unwrap_or("");
  line.chars().take(max).collect::<String>().trim_end().to_string()
}

/// Preceding sibling comment (JSDoc/line comment) — best effort. Climbs
/// wrapper ancestors (export_statement, lexical_declaration…) while the
/// node is their first named child, so `/** … */ export function f()`
/// still finds the comment.
fn leading_comment(node: Node, src: &str) -> Option<String> {
  let mut current = node;
  for _ in 0..3 {
    if let Some(prev) = current.prev_named_sibling() {
      if !prev.kind().contains("comment") {
        return None;
      }
      let text: String = node_text(prev, src).chars().take(240).collect();
      return Some(text);
    }
    current = current.parent()?;
  }
  None
}

/// Symbol kind for a declaration node, or None when it isn't one.
fn classify_symbol(node: Node, family: LangFamily, class_depth: usize) -> Option<&'static str> {
  match family {
    LangFamily::JsLike => match node.kind() {
      "function_declaration" | "generator_function_declaration" => Some("function"),
      "class_declaration" | "abstract_class_declaration" | "enum_declaration" => Some("class"),
      "method_definition" => Some("method"),
      "interface_declaration" => Some("interface"),
      // const foo = () => {} / const foo = function () {}
      "variable_declarator" => {
        let value_kind = node.child_by_field_name("value").map(|v| v.kind());
        matches!(
          value_kind,
          Some("arrow_function") | Some("function_expression") | Some("generator_function") | Some("function")
        )
        .then_some("function")
      }
      _ => None,
    },
    LangFamily::Java => match node.kind() {
      "class_declaration" | "enum_declaration" | "record_declaration" => Some("class"),
      "interface_declaration" => Some("interface"),
      "method_declaration" | "constructor_declaration" => Some("method"),
      _ => None,
    },
    LangFamily::Go => match node.kind() {
      "function_declaration" => Some("function"),
      "method_declaration" => Some("method"),
      "type_spec" => match node.child_by_field_name("type").map(|t| t.kind()) {
        Some("struct_type") => Some("class"),
        Some("interface_type") => Some("interface"),
        _ => None,
      },
      _ => None,
    },
    LangFamily::Python => match node.kind() {
      "function_definition" => Some(if class_depth > 0 { "method" } else { "function" }),
      "class_definition" => Some("class"),
      _ => None,
    },
  }
}

/// Callee name for a call-expression node, or None.
fn callee_name(node: Node, family: LangFamily, src: &str) -> Option<String> {
  match family {
    LangFamily::JsLike if node.kind() == "call_expression" => {
      let f = node.child_by_field_name("function")?;
      match f.kind() {
        "identifier" => Some(node_text(f, src).to_string()),
        "member_expression" => field_text(f, "property", src),
        _ => None,
      }
    }
    LangFamily::Java if node.kind() == "method_invocation" => field_text(node, "name", src),
    LangFamily::Go if node.kind() == "call_expression" => {
      let f = node.child_by_field_name("function")?;
      match f.kind() {
        "identifier" => Some(node_text(f, src).to_string()),
        "selector_expression" => field_text(f, "field", src),
        _ => None,
      }
    }
    LangFamily::Python if node.kind() == "call" => {
      let f = node.child_by_field_name("function")?;
      match f.kind() {
        "identifier" => Some(node_text(f, src).to_string()),
        "attribute" => field_text(f, "attribute", src),
        _ => None,
      }
    }
    _ => None,
  }
}

/// Imported module/path for an import node, or None.
fn import_target(node: Node, family: LangFamily, src: &str) -> Option<String> {
  match family {
    LangFamily::JsLike if node.kind() == "import_statement" => {
      field_text(node, "source", src).map(|s| strip_quotes(&s))
    }
    LangFamily::Java if node.kind() == "import_declaration" => {
      node.named_child(0).map(|c| node_text(c, src).to_string())
    }
    LangFamily::Go if node.kind() == "import_spec" => {
      field_text(node, "path", src).map(|s| strip_quotes(&s))
    }
    LangFamily::Python if node.kind() == "import_statement" => {
      node.named_child(0).map(|c| node_text(c, src).to_string())
    }
    LangFamily::Python if node.kind() == "import_from_statement" => {
      field_text(node, "module_name", src)
    }
    _ => None,
  }
}

struct WalkState {
  symbols: Vec<SymbolRec>,
  relations: Vec<RelationRec>,
  class_depth: usize,
  fn_stack: Vec<String>,
}

fn walk_node(node: Node, family: LangFamily, src: &str, state: &mut WalkState) {
  let mut popped_fn = false;
  let mut popped_class = false;

  if let Some(target) = import_target(node, family, src) {
    if !target.is_empty() {
      state.relations.push(RelationRec {
        kind: "import",
        source_symbol: None,
        target_name: target,
      });
    }
  } else if let Some(callee) = callee_name(node, family, src) {
    if !callee.is_empty() {
      state.relations.push(RelationRec {
        kind: "call",
        source_symbol: state.fn_stack.last().cloned(),
        target_name: callee,
      });
    }
  } else if let Some(kind) = classify_symbol(node, family, state.class_depth) {
    if let Some(name) = field_text(node, "name", src).filter(|n| !n.is_empty()) {
      let function_like = matches!(kind, "function" | "method");
      state.symbols.push(SymbolRec {
        name: name.clone(),
        kind,
        start_line: node.start_position().row + 1,
        end_line: node.end_position().row + 1,
        signature: first_line(node_text(node, src), 200),
        doc: leading_comment(node, src),
        complexity: function_like.then(|| 1 + count_decisions(node, family)),
      });
      if function_like {
        state.fn_stack.push(name);
        popped_fn = true;
      } else {
        state.class_depth += 1;
        popped_class = true;
      }
    }
  }

  let mut cursor = node.walk();
  for child in node.children(&mut cursor) {
    walk_node(child, family, src, state);
  }

  if popped_fn {
    state.fn_stack.pop();
  }
  if popped_class {
    state.class_depth -= 1;
  }
}

/// Parses one source string and extracts symbols + relations.
pub fn parse_source(lang: Lang, src: &str) -> (Vec<SymbolRec>, Vec<RelationRec>) {
  let mut parser = Parser::new();
  if parser.set_language(&lang.grammar()).is_err() {
    return (vec![], vec![]);
  }
  let Some(tree) = parser.parse(src, None) else {
    return (vec![], vec![]);
  };
  let mut state = WalkState {
    symbols: vec![],
    relations: vec![],
    class_depth: 0,
    fn_stack: vec![],
  };
  walk_node(tree.root_node(), lang.family(), src, &mut state);
  (state.symbols, state.relations)
}

// ─── Repository walking ─────────────────────────────────────────

const SKIP_DIRS: &[&str] = &[
  "node_modules", ".git", "dist", "target", "build", "out", "coverage",
  ".next", ".venv", "venv", "__pycache__", "vendor",
];

/// Indexable files under `repo` — respects .gitignore, skips vendored dirs.
pub fn collect_files(repo: &Path) -> Vec<(PathBuf, Lang, i64, i64)> {
  let walker = ignore::WalkBuilder::new(repo)
    .hidden(true)
    .require_git(false) // honor .gitignore even before `git init`
    .filter_entry(|e| {
      e.file_name()
        .to_str()
        .map(|n| !SKIP_DIRS.contains(&n))
        .unwrap_or(true)
    })
    .build();

  let mut files = vec![];
  for entry in walker.flatten() {
    let path = entry.path();
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    let Some(lang) = Lang::from_path(path) else { continue };
    let Ok(meta) = entry.metadata() else { continue };
    let mtime_ms = meta
      .modified()
      .ok()
      .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
      .map(|d| d.as_millis() as i64)
      .unwrap_or(0);
    let rel = path.strip_prefix(repo).unwrap_or(path).to_path_buf();
    files.push((rel, lang, mtime_ms, meta.len() as i64));
  }
  files
}

/// Parses a batch of repo-relative files in parallel (rayon pool).
pub fn parse_files(repo: &Path, files: &[(PathBuf, Lang, i64, i64)]) -> Vec<FileParse> {
  files
    .par_iter()
    .filter_map(|(rel, lang, mtime_ms, size)| {
      let src = std::fs::read_to_string(repo.join(rel)).ok()?;
      let (symbols, relations) = parse_source(*lang, &src);
      Some(FileParse {
        rel_path: rel.to_string_lossy().replace('\\', "/"),
        lang: *lang,
        mtime_ms: *mtime_ms,
        size: *size,
        symbols,
        relations,
      })
    })
    .collect()
}

// ─── Index database ─────────────────────────────────────────────

const INDEX_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  lang         TEXT NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  signature  TEXT,
  doc        TEXT,
  complexity INTEGER
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  source_file   TEXT NOT NULL,
  source_symbol TEXT,
  target_name   TEXT NOT NULL,
  target_file   TEXT
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_file);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
  USING fts5(name, signature, path, doc);
";

pub fn open_index_db(db_path: &Path) -> Result<Connection, String> {
  if let Some(dir) = db_path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("create index dir failed: {e}"))?;
  }
  let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
  conn
    .execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;")
    .map_err(|e| e.to_string())?;
  conn.execute_batch(INDEX_SCHEMA).map_err(|e| e.to_string())?;
  Ok(conn)
}

fn fnv1a64(bytes: &[u8]) -> u64 {
  let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
  for b in bytes {
    hash ^= u64::from(*b);
    hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
  }
  hash
}

/// Stable per-repo id — FNV-1a64 hex over the canonicalized path.
/// (The sidecar mirrors this exactly in knowledge/codeSearch.ts.)
pub fn repo_hash(repo: &Path) -> String {
  let canonical = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
  format!("{:016x}", fnv1a64(canonical.to_string_lossy().as_bytes()))
}

/// {FLOWFORGE_DATA_DIR || ~/.flowforge}/code_index — shared with the sidecar.
pub fn default_index_dir() -> PathBuf {
  let base = std::env::var_os("FLOWFORGE_DATA_DIR")
    .map(PathBuf::from)
    .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".flowforge")))
    .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".flowforge")))
    .unwrap_or_else(|| PathBuf::from(".flowforge"));
  base.join("code_index")
}

pub fn index_db_path(repo: &Path) -> PathBuf {
  default_index_dir().join(format!("{}.db", repo_hash(repo)))
}

fn now_iso() -> String {
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  format!("epoch-ms:{ms}")
}

pub fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO meta(key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      (key, value),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn read_meta(conn: &Connection, key: &str) -> Option<String> {
  conn
    .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
    .ok()
}

// ─── Writing parses into the db ─────────────────────────────────

/// Replaces the rows of the given files inside one transaction, then
/// re-resolves cross-file call targets. Shared by full + incremental.
pub fn store_parses(conn: &mut Connection, parses: &[FileParse]) -> Result<(), String> {
  let tx = conn.transaction().map_err(|e| e.to_string())?;
  for p in parses {
    tx.execute(
      "DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?1)",
      [&p.rel_path],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM symbols WHERE file = ?1", [&p.rel_path])
      .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM relations WHERE source_file = ?1", [&p.rel_path])
      .map_err(|e| e.to_string())?;
    tx.execute(
      "INSERT INTO files(path, lang, mtime_ms, size, symbol_count) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(path) DO UPDATE SET lang=excluded.lang, mtime_ms=excluded.mtime_ms,
         size=excluded.size, symbol_count=excluded.symbol_count",
      (&p.rel_path, p.lang.name(), p.mtime_ms, p.size, p.symbols.len() as i64),
    )
    .map_err(|e| e.to_string())?;

    for s in &p.symbols {
      tx.execute(
        "INSERT INTO symbols(file, name, kind, start_line, end_line, signature, doc, complexity)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (
          &p.rel_path, &s.name, s.kind, s.start_line as i64, s.end_line as i64,
          &s.signature, &s.doc, s.complexity,
        ),
      )
      .map_err(|e| e.to_string())?;
      let rowid = tx.last_insert_rowid();
      tx.execute(
        "INSERT INTO symbols_fts(rowid, name, signature, path, doc) VALUES (?1, ?2, ?3, ?4, ?5)",
        (rowid, &s.name, &s.signature, &p.rel_path, s.doc.as_deref().unwrap_or("")),
      )
      .map_err(|e| e.to_string())?;
    }
    for r in &p.relations {
      tx.execute(
        "INSERT INTO relations(kind, source_file, source_symbol, target_name) VALUES (?1, ?2, ?3, ?4)",
        (r.kind, &p.rel_path, &r.source_symbol, &r.target_name),
      )
      .map_err(|e| e.to_string())?;
    }
  }

  // cross-file call resolution: unique symbol name → defining file
  tx.execute_batch(
    "UPDATE relations SET target_file = (
       SELECT file FROM symbols WHERE symbols.name = relations.target_name LIMIT 1
     ) WHERE kind = 'call';",
  )
  .map_err(|e| e.to_string())?;

  tx.commit().map_err(|e| e.to_string())?;
  bump_cache_generation();
  Ok(())
}

/// Drops files (and their symbols/relations) that disappeared from disk.
pub fn remove_files(conn: &Connection, paths: &[String]) -> Result<(), String> {
  for path in paths {
    conn
      .execute(
        "DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?1)",
        [path],
      )
      .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM symbols WHERE file = ?1", [path]).map_err(|e| e.to_string())?;
    conn
      .execute("DELETE FROM relations WHERE source_file = ?1", [path])
      .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM files WHERE path = ?1", [path]).map_err(|e| e.to_string())?;
  }
  Ok(())
}

// ─── Full index ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
  pub files: i64,
  pub symbols: i64,
  pub relations: i64,
  pub duration_ms: u64,
}

fn table_count(conn: &Connection, table: &str) -> i64 {
  conn
    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
    .unwrap_or(0)
}

/// Full (re)index of a repository into `db_path`.
pub fn full_index(repo: &Path, db_path: &Path) -> Result<IndexSummary, String> {
  let started = Instant::now();
  if !repo.is_dir() {
    return Err(format!("repo path is not a directory: {}", repo.display()));
  }
  let mut conn = open_index_db(db_path)?;
  conn
    .execute_batch(
      "DELETE FROM symbols_fts; DELETE FROM symbols; DELETE FROM relations; DELETE FROM files;",
    )
    .map_err(|e| e.to_string())?;

  let files = collect_files(repo);
  let parses = parse_files(repo, &files);
  store_parses(&mut conn, &parses)?;

  write_meta(&conn, "repo_path", &repo.to_string_lossy())?;
  write_meta(&conn, "last_indexed_at", &now_iso())?;
  let duration_ms = started.elapsed().as_millis() as u64;
  write_meta(&conn, "last_duration_ms", &duration_ms.to_string())?;

  Ok(IndexSummary {
    files: parses.len() as i64,
    symbols: table_count(&conn, "symbols"),
    relations: table_count(&conn, "relations"),
    duration_ms,
  })
}

// ─── BM25 query (FTS5) + LRU cache ──────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueryHit {
  pub file: String,
  pub name: String,
  pub kind: String,
  pub start_line: i64,
  pub end_line: i64,
  pub signature: String,
  pub score: f64,
}

/// User text → FTS5 prefix-match expression ("tok"* OR "tok2"* …).
pub fn fts_match_expr(query: &str) -> Option<String> {
  let tokens: Vec<String> = query
    .split(|c: char| !c.is_alphanumeric() && c != '_')
    .filter(|t| t.len() >= 2)
    .map(|t| format!("\"{t}\"*"))
    .collect();
  if tokens.is_empty() {
    None
  } else {
    Some(tokens.join(" OR "))
  }
}

static QUERY_CACHE: OnceLock<Mutex<LruCache<String, Vec<QueryHit>>>> = OnceLock::new();
static CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn query_cache() -> &'static Mutex<LruCache<String, Vec<QueryHit>>> {
  QUERY_CACHE.get_or_init(|| {
    Mutex::new(LruCache::new(NonZeroUsize::new(256).expect("nonzero cache size")))
  })
}

/// Any index write invalidates cached query results (generation key).
pub fn bump_cache_generation() {
  CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub fn query_index(db_path: &Path, query: &str, top_k: usize) -> Result<Vec<QueryHit>, String> {
  let generation = CACHE_GENERATION.load(Ordering::SeqCst);
  let cache_key = format!("{generation}:{}:{top_k}:{query}", db_path.display());
  if let Some(hits) = query_cache().lock().ok().and_then(|mut c| c.get(&cache_key).cloned()) {
    return Ok(hits);
  }

  let Some(expr) = fts_match_expr(query) else { return Ok(vec![]) };
  if !db_path.exists() {
    return Err(format!("code index not found: {}", db_path.display()));
  }
  let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
  let mut stmt = conn
    .prepare(
      "SELECT s.file, s.name, s.kind, s.start_line, s.end_line, s.signature,
              bm25(symbols_fts, 5.0, 1.0, 2.0, 1.0) AS rank
       FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
       WHERE symbols_fts MATCH ?1
       ORDER BY rank LIMIT ?2",
    )
    .map_err(|e| e.to_string())?;
  let hits: Vec<QueryHit> = stmt
    .query_map((expr, top_k as i64), |row| {
      Ok(QueryHit {
        file: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        start_line: row.get(3)?,
        end_line: row.get(4)?,
        signature: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        // bm25() is negative-is-better — flip so bigger means more relevant
        score: -row.get::<_, f64>(6)?,
      })
    })
    .map_err(|e| e.to_string())?
    .filter_map(Result::ok)
    .collect();

  if let Ok(mut cache) = query_cache().lock() {
    cache.put(cache_key, hits.clone());
  }
  Ok(hits)
}

// ─── Stats ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
  pub exists: bool,
  pub files: i64,
  pub symbols: i64,
  pub relations: i64,
  pub languages: Vec<String>,
  pub last_indexed_at: Option<String>,
  pub last_rev: Option<String>,
  pub last_duration_ms: Option<u64>,
  pub db_path: String,
}

pub fn index_stats(db_path: &Path) -> Result<IndexStats, String> {
  if !db_path.exists() {
    return Ok(IndexStats {
      exists: false,
      files: 0,
      symbols: 0,
      relations: 0,
      languages: vec![],
      last_indexed_at: None,
      last_rev: None,
      last_duration_ms: None,
      db_path: db_path.to_string_lossy().into_owned(),
    });
  }
  let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
  let mut stmt = conn
    .prepare("SELECT DISTINCT lang FROM files ORDER BY lang")
    .map_err(|e| e.to_string())?;
  let languages: Vec<String> = stmt
    .query_map([], |r| r.get(0))
    .map_err(|e| e.to_string())?
    .filter_map(Result::ok)
    .collect();
  Ok(IndexStats {
    exists: true,
    files: table_count(&conn, "files"),
    symbols: table_count(&conn, "symbols"),
    relations: table_count(&conn, "relations"),
    languages,
    last_indexed_at: read_meta(&conn, "last_indexed_at"),
    last_rev: read_meta(&conn, "last_rev"),
    last_duration_ms: read_meta(&conn, "last_duration_ms").and_then(|s| s.parse().ok()),
    db_path: db_path.to_string_lossy().into_owned(),
  })
}

// ─── Tauri commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn code_index_full(repo_path: String) -> Result<IndexSummary, String> {
  tokio::task::spawn_blocking(move || {
    let repo = PathBuf::from(&repo_path);
    full_index(&repo, &index_db_path(&repo))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn code_index_query(
  repo_path: String,
  query: String,
  top_k: Option<usize>,
) -> Result<Vec<QueryHit>, String> {
  tokio::task::spawn_blocking(move || {
    let repo = PathBuf::from(&repo_path);
    query_index(&index_db_path(&repo), &query, top_k.unwrap_or(5))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn code_index_stats(repo_path: String) -> Result<IndexStats, String> {
  tokio::task::spawn_blocking(move || {
    let repo = PathBuf::from(&repo_path);
    index_stats(&index_db_path(&repo))
  })
  .await
  .map_err(|e| e.to_string())?
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
pub mod tests {
  use super::*;

  pub const JS_FIXTURE: &str = r#"
import { getUser } from './user'
import fs from 'node:fs'

/** Fetch a user by id from the primary store. */
export function getUserById(id) {
  if (!id) return null
  for (const source of sources) {
    if (source.has(id)) return source.get(id)
  }
  return getUser(id)
}

export const formatUser = (user) => {
  return user ? `${user.name}` : 'anonymous'
}

class UserService {
  loadAll() {
    return getUserById('*')
  }
}
"#;

  pub const TS_FIXTURE: &str = r#"
import type { User } from './types'

export interface UserRepo {
  findById(id: string): Promise<User | null>
}

export class SqlUserRepo {
  async findById(id: string): Promise<User | null> {
    const row = await queryOne(id)
    return row ? mapUser(row) : null
  }
}

export function mapUser(row: unknown): User {
  return row as User
}
"#;

  pub const JAVA_FIXTURE: &str = r#"
import java.util.List;

public class OrderService {
  public Order findOrder(String id) {
    if (id == null || id.isEmpty()) {
      throw new IllegalArgumentException("id");
    }
    return repository.load(id);
  }

  private void audit(Order order) {
    logger.info(order.toString());
  }
}

interface OrderRepository {
  Order load(String id);
}
"#;

  pub const GO_FIXTURE: &str = r#"
package main

import "fmt"

type Store struct {
  items map[string]string
}

type Reader interface {
  Read(key string) string
}

func NewStore() *Store {
  return &Store{items: map[string]string{}}
}

func (s *Store) Read(key string) string {
  if v, ok := s.items[key]; ok {
    return v
  }
  fmt.Println("miss")
  return ""
}
"#;

  pub const PY_FIXTURE: &str = r#"
import os
from pathlib import Path

def load_config(path):
    if not os.path.exists(path):
        return {}
    for line in Path(path).read_text().splitlines():
        parse_line(line)
    return {}

def parse_line(line):
    return line.strip()

class ConfigStore:
    def reload(self):
        return load_config(self.path)
"#;

  fn kinds(symbols: &[SymbolRec], kind: &str) -> usize {
    symbols.iter().filter(|s| s.kind == kind).count()
  }

  #[test]
  fn js_extraction_symbols_calls_imports() {
    let (symbols, relations) = parse_source(Lang::Js, JS_FIXTURE);
    assert_eq!(kinds(&symbols, "function"), 2, "getUserById + formatUser arrow");
    assert_eq!(kinds(&symbols, "class"), 1);
    assert_eq!(kinds(&symbols, "method"), 1, "UserService.loadAll");
    let get_user = symbols.iter().find(|s| s.name == "getUserById").expect("getUserById");
    assert!(get_user.doc.as_deref().unwrap_or("").contains("primary store"));
    // complexity: 1 + if + for + if = 4
    assert_eq!(get_user.complexity, Some(4));
    let imports: Vec<_> = relations.iter().filter(|r| r.kind == "import").collect();
    assert_eq!(imports.len(), 2);
    assert!(imports.iter().any(|r| r.target_name == "./user"));
    // loadAll() calls getUserById — call attributed to enclosing method
    assert!(relations.iter().any(|r| r.kind == "call"
      && r.target_name == "getUserById"
      && r.source_symbol.as_deref() == Some("loadAll")));
  }

  #[test]
  fn ts_extraction_interface_and_methods() {
    let (symbols, _) = parse_source(Lang::Ts, TS_FIXTURE);
    assert_eq!(kinds(&symbols, "interface"), 1);
    assert_eq!(kinds(&symbols, "class"), 1);
    assert_eq!(kinds(&symbols, "function"), 1, "mapUser");
    assert!(symbols.iter().any(|s| s.name == "findById" && s.kind == "method"));
  }

  #[test]
  fn java_extraction() {
    let (symbols, relations) = parse_source(Lang::Java, JAVA_FIXTURE);
    assert_eq!(kinds(&symbols, "class"), 1);
    assert_eq!(kinds(&symbols, "interface"), 1);
    // findOrder, audit, and the interface's load signature
    assert_eq!(kinds(&symbols, "method"), 3);
    let find_order = symbols.iter().find(|s| s.name == "findOrder").expect("findOrder");
    assert_eq!(find_order.complexity, Some(2), "1 + if");
    assert!(relations.iter().any(|r| r.kind == "import" && r.target_name == "java.util.List"));
    assert!(relations.iter().any(|r| r.kind == "call" && r.target_name == "load"));
  }

  #[test]
  fn go_extraction() {
    let (symbols, relations) = parse_source(Lang::Go, GO_FIXTURE);
    assert_eq!(kinds(&symbols, "class"), 1, "struct Store");
    assert_eq!(kinds(&symbols, "interface"), 1);
    assert_eq!(kinds(&symbols, "function"), 1, "NewStore");
    assert_eq!(kinds(&symbols, "method"), 1, "Store.Read");
    let read = symbols.iter().find(|s| s.name == "Read" && s.kind == "method").expect("Read");
    assert_eq!(read.complexity, Some(2), "1 + if");
    assert!(relations.iter().any(|r| r.kind == "import" && r.target_name == "fmt"));
    assert!(relations.iter().any(|r| r.kind == "call" && r.target_name == "Println"));
  }

  #[test]
  fn python_extraction() {
    let (symbols, relations) = parse_source(Lang::Py, PY_FIXTURE);
    assert_eq!(kinds(&symbols, "function"), 2);
    assert_eq!(kinds(&symbols, "class"), 1);
    assert_eq!(kinds(&symbols, "method"), 1, "ConfigStore.reload");
    let load = symbols.iter().find(|s| s.name == "load_config").expect("load_config");
    assert_eq!(load.complexity, Some(3), "1 + if + for");
    assert!(relations.iter().any(|r| r.kind == "import" && r.target_name == "os"));
    assert!(relations.iter().any(|r| r.kind == "import" && r.target_name == "pathlib"));
    assert!(relations.iter().any(|r| r.kind == "call"
      && r.target_name == "parse_line"
      && r.source_symbol.as_deref() == Some("load_config")));
  }

  pub fn make_fixture_repo(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "flowforge-codeindex-{tag}-{}",
      SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src").join("user.js"), JS_FIXTURE).unwrap();
    std::fs::write(dir.join("src").join("repo.ts"), TS_FIXTURE).unwrap();
    std::fs::write(dir.join("src").join("Order.java"), JAVA_FIXTURE).unwrap();
    std::fs::write(dir.join("src").join("store.go"), GO_FIXTURE).unwrap();
    std::fs::write(dir.join("src").join("config.py"), PY_FIXTURE).unwrap();
    dir
  }

  #[test]
  fn full_index_then_bm25_query_is_relevant() {
    let repo = make_fixture_repo("bm25");
    let db = repo.join("index.db");
    let summary = full_index(&repo, &db).expect("full index");
    assert_eq!(summary.files, 5);
    assert!(summary.symbols >= 20, "expected >=20 symbols, got {}", summary.symbols);
    assert!(summary.relations > 10);

    // exact symbol name lands on top
    let hits = query_index(&db, "getUserById", 5).expect("query");
    assert!(!hits.is_empty());
    assert_eq!(hits[0].name, "getUserById");
    assert_eq!(hits[0].file, "src/user.js");
    // scores are descending
    for pair in hits.windows(2) {
      assert!(pair[0].score >= pair[1].score);
    }

    // cross-file resolution: loadAll → getUserById resolves to src/user.js
    let conn = Connection::open(&db).unwrap();
    let target: Option<String> = conn
      .query_row(
        "SELECT target_file FROM relations WHERE kind='call' AND target_name='getUserById' LIMIT 1",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(target.as_deref(), Some("src/user.js"));

    // second query round-trips through the LRU cache (same result)
    let cached = query_index(&db, "getUserById", 5).expect("cached query");
    assert_eq!(cached.len(), hits.len());

    std::fs::remove_dir_all(&repo).ok();
  }

  #[test]
  fn skips_vendored_dirs_and_honors_gitignore() {
    let repo = make_fixture_repo("skip");
    std::fs::create_dir_all(repo.join("node_modules").join("lib")).unwrap();
    std::fs::write(repo.join("node_modules").join("lib").join("x.js"), "function hidden() {}").unwrap();
    std::fs::create_dir_all(repo.join("generated")).unwrap();
    std::fs::write(repo.join("generated").join("g.js"), "function generated() {}").unwrap();
    std::fs::write(repo.join(".gitignore"), "generated/\n").unwrap();

    let files = collect_files(&repo);
    let paths: Vec<String> = files.iter().map(|f| f.0.to_string_lossy().into_owned()).collect();
    assert!(!paths.iter().any(|p| p.contains("node_modules")));
    assert!(!paths.iter().any(|p| p.contains("generated")));
    assert_eq!(paths.len(), 5);

    std::fs::remove_dir_all(&repo).ok();
  }

  #[test]
  fn stats_reports_counts_and_meta() {
    let repo = make_fixture_repo("stats");
    let db = repo.join("index.db");
    full_index(&repo, &db).unwrap();
    let stats = index_stats(&db).unwrap();
    assert!(stats.exists);
    assert_eq!(stats.files, 5);
    assert!(stats.symbols > 0);
    assert!(stats.last_indexed_at.is_some());
    assert_eq!(
      stats.languages,
      vec!["go", "java", "javascript", "python", "typescript"]
    );
    std::fs::remove_dir_all(&repo).ok();
  }

  #[test]
  fn repo_hash_is_stable_fnv1a64() {
    // parity vector shared with sidecar/src/knowledge/codeSearch.ts
    assert_eq!(format!("{:016x}", fnv1a64(b"/tmp/demo-repo")), "546d04c318ac10ae");
  }

  /// Perf gate: full index of this repository (run with --ignored --nocapture).
  #[test]
  #[ignore]
  fn perf_full_index_on_this_repo() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let db = std::env::temp_dir().join("flowforge-perf-index.db");
    std::fs::remove_file(&db).ok();
    let summary = full_index(&repo, &db).expect("full index");
    println!(
      "[perf] full index: files={} symbols={} relations={} duration={}ms",
      summary.files, summary.symbols, summary.relations, summary.duration_ms
    );
    let started = Instant::now();
    let hits = query_index(&db, "buildContextPackage", 5).expect("query");
    println!(
      "[perf] bm25 top-5 (cold): {} hits in {:?}; top: {:?}",
      hits.len(),
      started.elapsed(),
      hits.first().map(|h| format!("{}:{}", h.file, h.name))
    );
    let started = Instant::now();
    let _ = query_index(&db, "buildContextPackage", 5).expect("query");
    println!("[perf] bm25 top-5 (lru cached): {:?}", started.elapsed());
    std::fs::remove_file(&db).ok();
  }
}
