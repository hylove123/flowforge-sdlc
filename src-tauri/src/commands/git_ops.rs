// ================================================================
//  commands/git_ops.rs — git plumbing + incremental indexing (Phase 5)
//
//  All git operations run on the bundled libgit2 (git2 crate) — the
//  app needs no system git binary:
//    git_status / git_recent_commits / git_changed_files   (local)
//    git_clone / git_create_branch / git_checkout_branch /
//    git_branch_list / git_push / git_check_available      (network)
//
//  Network auth: https only; tokens are handed to libgit2 via the
//  credentials callback and never touch URLs, .git/config or logs.
//  Anything that can reach logs/events/errors still passes through
//  redact_credentials() as defense in depth.
//
//  Incremental indexing:
//    code_index_incremental compares the stored file mtimes (and records
//    HEAD rev in meta) — only changed/new files are re-parsed, deleted
//    files are dropped from the index. Target <0.5s for 1-file changes.
//
//  Commit watch:
//    code_index_watch starts a notify watcher on .git/logs (HEAD reflog
//    turns over on every commit), debounced 2s; after quiet it runs an
//    incremental pass and emits `code_index://updated` with the summary.
//    code_index_unwatch stops it. The loop is AppHandle-free (emitter
//    closure) so it is verifiable with plain `cargo test`.
// ================================================================

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::code_index::{
  collect_files, index_db_path, index_stats, open_index_db, parse_files, remove_files,
  store_parses, write_meta, IndexStats, IndexSummary,
};

const WATCH_DEBOUNCE_MS: u64 = 2_000;
const WATCH_POLL_MS: u64 = 200;

// ─── git2 helpers ───────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
  pub path: String,
  pub status: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
  pub branch: Option<String>,
  pub head_rev: Option<String>,
  pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
  pub rev: String,
  pub summary: String,
  pub author: String,
  pub time_epoch: i64,
}

fn open_repo(repo_path: &str) -> Result<git2::Repository, String> {
  git2::Repository::discover(repo_path).map_err(|e| format!("not a git repository: {e}"))
}

fn status_label(s: git2::Status) -> String {
  let mut parts = vec![];
  if s.intersects(git2::Status::INDEX_NEW | git2::Status::WT_NEW) {
    parts.push("new");
  }
  if s.intersects(git2::Status::INDEX_MODIFIED | git2::Status::WT_MODIFIED) {
    parts.push("modified");
  }
  if s.intersects(git2::Status::INDEX_DELETED | git2::Status::WT_DELETED) {
    parts.push("deleted");
  }
  if s.intersects(git2::Status::INDEX_RENAMED | git2::Status::WT_RENAMED) {
    parts.push("renamed");
  }
  if s.intersects(git2::Status::CONFLICTED) {
    parts.push("conflicted");
  }
  if parts.is_empty() {
    parts.push("other");
  }
  parts.join("+")
}

pub fn repo_status(repo_path: &str) -> Result<GitStatusResult, String> {
  let repo = open_repo(repo_path)?;
  let head = repo.head().ok();
  let branch = head.as_ref().and_then(|h| h.shorthand().map(String::from));
  let head_rev = head
    .as_ref()
    .and_then(|h| h.target())
    .map(|oid| oid.to_string());

  let mut opts = git2::StatusOptions::new();
  opts.include_untracked(true).recurse_untracked_dirs(true);
  let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
  let entries = statuses
    .iter()
    .filter_map(|e| {
      e.path().map(|p| GitStatusEntry {
        path: p.to_string(),
        status: status_label(e.status()),
      })
    })
    .collect();
  Ok(GitStatusResult { branch, head_rev, entries })
}

pub fn recent_commits(repo_path: &str, n: usize) -> Result<Vec<GitCommit>, String> {
  let repo = open_repo(repo_path)?;
  let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
  if walk.push_head().is_err() {
    return Ok(vec![]); // empty repo — no commits yet
  }
  let mut commits = vec![];
  for oid in walk.flatten().take(n) {
    if let Ok(commit) = repo.find_commit(oid) {
      commits.push(GitCommit {
        rev: oid.to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
        author: commit.author().name().unwrap_or("").to_string(),
        time_epoch: commit.time().seconds(),
      });
    }
  }
  Ok(commits)
}

/// Paths touched between `from_rev` (exclusive) and the working tree;
/// without `from_rev`, the current uncommitted changes vs HEAD.
pub fn changed_files(repo_path: &str, from_rev: Option<&str>) -> Result<Vec<String>, String> {
  let repo = open_repo(repo_path)?;
  let base_tree = match from_rev {
    Some(rev) => {
      let obj = repo
        .revparse_single(rev)
        .map_err(|e| format!("bad rev {rev}: {e}"))?;
      Some(obj.peel_to_commit().map_err(|e| e.to_string())?.tree().map_err(|e| e.to_string())?)
    }
    None => repo
      .head()
      .ok()
      .and_then(|h| h.peel_to_commit().ok())
      .and_then(|c| c.tree().ok()),
  };
  let mut opts = git2::DiffOptions::new();
  opts.include_untracked(true).recurse_untracked_dirs(true);
  let diff = repo
    .diff_tree_to_workdir_with_index(base_tree.as_ref(), Some(&mut opts))
    .map_err(|e| e.to_string())?;
  let mut paths = HashSet::new();
  for delta in diff.deltas() {
    for f in [delta.old_file(), delta.new_file()] {
      if let Some(p) = f.path() {
        paths.insert(p.to_string_lossy().into_owned());
      }
    }
  }
  let mut list: Vec<String> = paths.into_iter().collect();
  list.sort();
  Ok(list)
}

fn head_rev_of(repo_path: &Path) -> Option<String> {
  let repo = git2::Repository::discover(repo_path).ok()?;
  let head = repo.head().ok()?;
  head.target().map(|oid| oid.to_string())
}

// ─── Incremental index ──────────────────────────────────────────

/// mtime-diff incremental pass: re-parses only new/changed files and
/// drops deleted ones. `summary.files` counts re-parsed files only.
pub fn incremental_index(repo: &Path, db_path: &Path) -> Result<IndexSummary, String> {
  let started = Instant::now();
  if !db_path.exists() {
    // no previous index — degrade to a full pass
    return super::code_index::full_index(repo, db_path);
  }
  let mut conn = open_index_db(db_path)?;

  // stored file → mtime snapshot
  let mut stored: HashMap<String, i64> = HashMap::new();
  {
    let mut stmt = conn.prepare("SELECT path, mtime_ms FROM files").map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
      .map_err(|e| e.to_string())?;
    for row in rows.flatten() {
      stored.insert(row.0, row.1);
    }
  }

  let on_disk = collect_files(repo);
  let mut seen: HashSet<String> = HashSet::new();
  let changed: Vec<_> = on_disk
    .into_iter()
    .filter(|(rel, _, mtime_ms, _)| {
      let key = rel.to_string_lossy().replace('\\', "/");
      seen.insert(key.clone());
      stored.get(&key) != Some(mtime_ms)
    })
    .collect();
  let removed: Vec<String> = stored.keys().filter(|k| !seen.contains(*k)).cloned().collect();

  let parses = parse_files(repo, &changed);
  if !parses.is_empty() {
    store_parses(&mut conn, &parses)?;
  }
  if !removed.is_empty() {
    remove_files(&conn, &removed)?;
    super::code_index::bump_cache_generation();
  }

  if let Some(rev) = head_rev_of(repo) {
    write_meta(&conn, "last_rev", &rev)?;
  }
  write_meta(&conn, "last_indexed_at", &format!("epoch-ms:{}", now_ms()))?;
  let duration_ms = started.elapsed().as_millis() as u64;

  Ok(IndexSummary {
    files: parses.len() as i64,
    symbols: count(&conn, "symbols"),
    relations: count(&conn, "relations"),
    duration_ms,
  })
}

fn count(conn: &Connection, table: &str) -> i64 {
  conn
    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
    .unwrap_or(0)
}

fn now_ms() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis()
}

// ─── Commit watch loop (AppHandle-free, cargo-testable) ─────────

/// Watches `{repo}/.git/logs` (reflog turnover ⇒ commit) until cancelled.
/// Activity is debounced (`debounce`); after quiet the `reindex` closure
/// runs and its summary is pushed through `emit` as `code_index://updated`.
pub fn watch_repo_commits<F, R>(
  repo: PathBuf,
  cancel: Arc<AtomicBool>,
  debounce: Duration,
  reindex: R,
  emit: F,
) where
  F: Fn(&str, serde_json::Value),
  R: Fn(&Path) -> Result<IndexSummary, String>,
{
  let logs_dir = repo.join(".git").join("logs");
  let (tx, rx) = channel::<notify::Result<notify::Event>>();
  let mut watcher = match notify::recommended_watcher(move |res| {
    let _ = tx.send(res);
  }) {
    Ok(w) => w,
    Err(e) => {
      emit(
        "code_index://error",
        serde_json::json!({ "repoPath": repo.to_string_lossy(), "message": e.to_string() }),
      );
      return;
    }
  };
  if let Err(e) = watcher.watch(&logs_dir, RecursiveMode::Recursive) {
    emit(
      "code_index://error",
      serde_json::json!({ "repoPath": repo.to_string_lossy(), "message": e.to_string() }),
    );
    return;
  }

  let mut last_event: Option<Instant> = None;
  loop {
    if cancel.load(Ordering::SeqCst) {
      return;
    }
    match rx.recv_timeout(Duration::from_millis(WATCH_POLL_MS)) {
      Ok(Ok(event)) => {
        if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
          last_event = Some(Instant::now());
        }
      }
      Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => return,
    }
    if let Some(at) = last_event {
      if at.elapsed() >= debounce {
        last_event = None;
        match reindex(&repo) {
          Ok(summary) => emit(
            "code_index://updated",
            serde_json::json!({
              "repoPath": repo.to_string_lossy(),
              "summary": summary,
            }),
          ),
          Err(e) => emit(
            "code_index://error",
            serde_json::json!({ "repoPath": repo.to_string_lossy(), "message": e }),
          ),
        }
        // keep watching — subsequent commits trigger further passes
      }
    }
  }
}

/// repoPath → cancel flag for the running commit watcher.
#[derive(Default)]
pub struct CodeWatchState(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

// ─── Tauri commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatusResult, String> {
  tokio::task::spawn_blocking(move || repo_status(&repo_path))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_recent_commits(repo_path: String, n: Option<usize>) -> Result<Vec<GitCommit>, String> {
  tokio::task::spawn_blocking(move || recent_commits(&repo_path, n.unwrap_or(10)))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_changed_files(
  repo_path: String,
  from_rev: Option<String>,
) -> Result<Vec<String>, String> {
  tokio::task::spawn_blocking(move || changed_files(&repo_path, from_rev.as_deref()))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn code_index_incremental(repo_path: String) -> Result<IndexSummary, String> {
  tokio::task::spawn_blocking(move || {
    let repo = PathBuf::from(&repo_path);
    incremental_index(&repo, &index_db_path(&repo))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn code_index_watch(
  app: AppHandle,
  state: State<'_, CodeWatchState>,
  repo_path: String,
) -> Result<bool, String> {
  let mut map = state.0.lock().map_err(|_| "code watch state poisoned")?;
  if map.contains_key(&repo_path) {
    return Ok(false); // already watching
  }
  let repo = PathBuf::from(&repo_path);
  if !repo.join(".git").exists() {
    return Err(format!("not a git repository: {repo_path}"));
  }
  let cancel = Arc::new(AtomicBool::new(false));
  map.insert(repo_path.clone(), Arc::clone(&cancel));
  drop(map);

  std::thread::spawn(move || {
    watch_repo_commits(
      repo,
      cancel,
      Duration::from_millis(WATCH_DEBOUNCE_MS),
      |r| incremental_index(r, &index_db_path(r)),
      move |event, payload| {
        if let Err(e) = app.emit(event, payload) {
          log::warn!("code_index emit {event} failed: {e}");
        }
      },
    );
  });
  Ok(true)
}

#[tauri::command]
pub fn code_index_unwatch(
  state: State<'_, CodeWatchState>,
  repo_path: String,
) -> Result<bool, String> {
  let mut map = state.0.lock().map_err(|_| "code watch state poisoned")?;
  match map.remove(&repo_path) {
    Some(flag) => {
      flag.store(true, Ordering::SeqCst);
      Ok(true)
    }
    None => Ok(false),
  }
}

/// Exposed for parity checks (stats carries dbPath the sidecar reads).
#[allow(dead_code)]
pub fn stats_for(repo: &Path) -> Result<IndexStats, String> {
  index_stats(&index_db_path(repo))
}

// ─── Built-in git runtime (clone/branch/push via libgit2) ──────

const CLONE_PROGRESS_THROTTLE_MS: u64 = 200;

// ─── Token auth (per-host git credentials from Settings) ───────
//
// Credentials-callback injection: when the frontend supplies a GitAuth,
// the token is handed to libgit2 through the credentials callback for
// http(s) transports only. It never appears in any URL, .git/config,
// event payload or error text; redact_credentials() below remains as
// defense in depth for anything that can still reach logs/events.

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAuth {
  pub username: Option<String>,
  pub token: String,
}

fn is_http_url(url: &str) -> bool {
  url.starts_with("https://") || url.starts_with("http://")
}

/// Username for https token auth: explicit config wins, else `oauth2`
/// (the GitLab/GitHub token convention).
fn auth_username(auth: &GitAuth) -> String {
  auth
    .username
    .as_deref()
    .map(str::trim)
    .filter(|u| !u.is_empty())
    .unwrap_or("oauth2")
    .to_string()
}

/// Attaches the token credentials callback when `auth` applies to the
/// transport. Returns an owned AuthBundle so the callback closure stays
/// 'static for spawn_blocking.
struct AuthBundle {
  username: String,
  token: String,
}

fn auth_bundle(url: &str, auth: Option<&GitAuth>) -> Option<AuthBundle> {
  auth.filter(|_| is_http_url(url)).map(|a| AuthBundle {
    username: auth_username(a),
    token: a.token.clone(),
  })
}

/// Scrubs URL userinfo from any text bound for logs, events or error
/// returns: every `scheme://user:token@host…` becomes `scheme://***@host…`.
/// The authority segment spans from `://` to the next `/`, whitespace or
/// end of input; everything before its *last* `@` is replaced, so tokens
/// containing percent-encoded characters (`%40`, …), extra `@`s or quotes
/// never survive this function.
fn redact_credentials(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(pos) = rest.find("://") {
    let after = pos + 3;
    out.push_str(&rest[..after]);
    rest = &rest[after..];
    // userinfo can only sit before the first '/' or whitespace (or line end)
    let boundary = rest
      .find(|c: char| c == '/' || c.is_whitespace())
      .unwrap_or(rest.len());
    if let Some(at) = rest[..boundary].rfind('@') {
      out.push_str("***");
      rest = &rest[at..]; // keep '@host…'
    }
  }
  out.push_str(rest);
  out
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailability {
  pub available: bool,
  pub version: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
  pub local: Vec<String>,
  pub remote: Vec<String>,
  pub current: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
  pub repo_path: String,
  pub already_cloned: bool,
}

pub async fn check_git_available() -> GitAvailability {
  // Built-in libgit2 — always available, no system git required.
  let (maj, min, rev) = git2::Version::get().libgit2_version();
  GitAvailability {
    available: true,
    version: Some(format!("git version built-in (libgit2 {maj}.{min}.{rev})")),
  }
}

/// `git2::Repository::discover` succeeds ⇒ dir is inside a work tree.
fn is_git_repo(dir: &Path) -> bool {
  git2::Repository::discover(dir).is_ok()
}

fn clone_progress_payload(
  repo_url: &str,
  target_dir: &str,
  phase: &str,
  percent: Option<u8>,
  line: &str,
) -> serde_json::Value {
  serde_json::json!({
    "repoUrl": repo_url,
    "targetDir": target_dir,
    "phase": phase,
    "percent": percent,
    "line": line,
  })
}

/// Checks out `branch` (existing local branch, or a new local branch
/// tracking `origin/<branch>`), pointing HEAD at it — the libgit2
/// equivalent of `git clone --branch` / `git checkout <branch>`.
fn checkout_named_branch(repo: &git2::Repository, branch: &str) -> Result<(), String> {
  let local_ref = format!("refs/heads/{branch}");
  if repo.find_reference(&local_ref).is_err() {
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let obj = repo
      .revparse_single(&remote_ref)
      .map_err(|_| format!("branch `{branch}` not found locally or on origin"))?;
    let commit = obj.peel_to_commit().map_err(|e| e.to_string())?;
    repo.branch(branch, &commit, false).map_err(|e| e.to_string())?;
  }
  repo.set_head(&local_ref).map_err(|e| e.to_string())?;
  // safe checkout — refuses to clobber local modifications, like git
  repo.checkout_head(None).map_err(|e| e.to_string())?;
  Ok(())
}

fn attach_credentials<'cb>(cb: &mut git2::RemoteCallbacks<'cb>, bundle: Option<AuthBundle>) {
  if let Some(b) = bundle {
    cb.credentials(move |_url, _user_from_url, _allowed| {
      git2::Cred::userpass_plaintext(&b.username, &b.token)
    });
  }
}

/// Clones via the bundled libgit2. Idempotent: an existing valid repo at
/// `target_dir` short-circuits to success. Progress flows through `emit`
/// (throttled), mapped from the transfer-progress callback.
pub async fn clone_repo<F>(
  repo_url: &str,
  target_dir: &str,
  branch: Option<&str>,
  auth: Option<&GitAuth>,
  emit: F,
) -> Result<GitCloneResult, String>
where
  F: Fn(serde_json::Value) + Send + 'static,
{
  let target = PathBuf::from(target_dir);
  if target.exists() && is_git_repo(&target) {
    emit(clone_progress_payload(repo_url, target_dir, "done", Some(100), "already cloned"));
    return Ok(GitCloneResult { repo_path: target_dir.to_string(), already_cloned: true });
  }

  let url = repo_url.to_string();
  let dir = target_dir.to_string();
  let branch = branch.map(String::from);
  let bundle = auth_bundle(repo_url, auth);

  tokio::task::spawn_blocking(move || {
    let emit = Arc::new(emit);
    emit(clone_progress_payload(&url, &dir, "progress", Some(0), "connecting…"));

    let mut fo = git2::FetchOptions::new();
    {
      let mut cb = git2::RemoteCallbacks::new();
      attach_credentials(&mut cb, bundle);
      // throttled object-transfer progress
      let emit_p = Arc::clone(&emit);
      let url_p = url.clone();
      let dir_p = dir.clone();
      let last = Arc::new(Mutex::new(
        Instant::now() - Duration::from_millis(CLONE_PROGRESS_THROTTLE_MS),
      ));
      let last_p = Arc::clone(&last);
      cb.transfer_progress(move |stats| {
        let mut g = last_p.lock().unwrap();
        if g.elapsed() >= Duration::from_millis(CLONE_PROGRESS_THROTTLE_MS) {
          *g = Instant::now();
          let percent = if stats.total_objects() > 0 {
            Some(((stats.received_objects() * 100 / stats.total_objects()) as u8).min(99))
          } else {
            None
          };
          let line = format!(
            "receiving objects: {}/{} ({} bytes)",
            stats.received_objects(),
            stats.total_objects(),
            stats.received_bytes()
          );
          emit_p(clone_progress_payload(&url_p, &dir_p, "progress", percent, &line));
        }
        true
      });
      fo.remote_callbacks(cb);
    }

    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    let repo = match builder.clone(&url, &target) {
      Ok(r) => r,
      Err(e) => {
        // drop the partial checkout, mirroring the git CLI behavior
        std::fs::remove_dir_all(&target).ok();
        return Err(format!("git clone failed: {}", redact_credentials(&e.to_string())));
      }
    };

    if let Some(b) = branch {
      if let Err(e) = checkout_named_branch(&repo, &b) {
        std::fs::remove_dir_all(&target).ok();
        return Err(format!("git clone failed: {e}"));
      }
    }

    emit(clone_progress_payload(&url, &dir, "done", Some(100), "clone complete"));
    Ok(GitCloneResult { repo_path: dir, already_cloned: false })
  })
  .await
  .map_err(|e| format!("git clone failed: {e}"))?
}

pub async fn create_branch(
  repo_path: &Path,
  new_branch: &str,
  base: Option<&str>,
) -> Result<(), String> {
  let repo_path = repo_path.to_path_buf();
  let new_branch = new_branch.to_string();
  let base = base.map(String::from);
  tokio::task::spawn_blocking(move || {
    let repo = git2::Repository::discover(&repo_path)
      .map_err(|e| format!("git branch failed: not a git repository: {e}"))?;
    let target_commit = match base {
      Some(b) => repo
        .revparse_single(&b)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| format!("git branch failed: bad base `{b}`: {e}"))?,
      None => repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("git branch failed: {e}"))?,
    };
    repo
      .branch(&new_branch, &target_commit, false)
      .map_err(|e| format!("git branch failed: {e}"))?;
    Ok(())
  })
  .await
  .map_err(|e| format!("git branch failed: {e}"))?
}

pub async fn checkout_branch(repo_path: &Path, branch: &str) -> Result<(), String> {
  let repo_path = repo_path.to_path_buf();
  let branch = branch.to_string();
  tokio::task::spawn_blocking(move || {
    let repo = git2::Repository::discover(&repo_path)
      .map_err(|e| format!("git checkout failed: not a git repository: {e}"))?;
    checkout_named_branch(&repo, &branch).map_err(|e| format!("git checkout failed: {e}"))
  })
  .await
  .map_err(|e| format!("git checkout failed: {e}"))?
}

pub async fn branch_list(repo_path: &Path) -> Result<GitBranchList, String> {
  let repo_path = repo_path.to_path_buf();
  tokio::task::spawn_blocking(move || {
    let repo = git2::Repository::discover(&repo_path)
      .map_err(|e| format!("git branch failed: not a git repository: {e}"))?;
    let mut local = vec![];
    let mut remote = vec![];
    let refs = repo.references().map_err(|e| format!("git branch failed: {e}"))?;
    for r in refs.flatten() {
      let name = r.name().unwrap_or("");
      if let Some(n) = name.strip_prefix("refs/heads/") {
        local.push(n.to_string());
      } else if let Some(n) = name.strip_prefix("refs/remotes/") {
        if !n.ends_with("/HEAD") {
          remote.push(n.to_string());
        }
      }
    }
    // detached HEAD → None, matching `git branch --show-current`
    let current = repo
      .head()
      .ok()
      .filter(|h| h.is_branch())
      .and_then(|h| h.shorthand().map(String::from));
    Ok(GitBranchList { local, remote, current })
  })
  .await
  .map_err(|e| format!("git branch failed: {e}"))?
}

/// Explicit-only push: pushes `refs/heads/<branch>` to origin and sets
/// the upstream (the `-u` equivalent). With a GitAuth and an http(s)
/// origin the token goes through the credentials callback — remote URL
/// and .git/config stay clean; non-http(s) origins push unauthenticated.
pub async fn push_branch(repo_path: &Path, branch: &str, auth: Option<&GitAuth>) -> Result<String, String> {
  let repo_path = repo_path.to_path_buf();
  let branch = branch.to_string();
  let auth = auth.cloned();
  tokio::task::spawn_blocking(move || {
    let repo = git2::Repository::discover(&repo_path)
      .map_err(|e| format!("git push failed: not a git repository: {e}"))?;
    let mut remote = repo
      .find_remote("origin")
      .map_err(|_| "git push failed: no `origin` remote configured".to_string())?;
    let url = remote.url().unwrap_or_default().to_string();
    let bundle = auth.as_ref().and_then(|a| auth_bundle(&url, Some(a)));

    let mut cb = git2::RemoteCallbacks::new();
    attach_credentials(&mut cb, bundle);
    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(cb);

    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote
      .push(&[refspec.as_str()], Some(&mut opts))
      .map_err(|e| format!("git push failed: {}", redact_credentials(&e.to_string())))?;

    // `-u` equivalent: refresh the local remote-tracking ref and record
    // origin/<branch> as the upstream
    if let Ok(oid) = repo.refname_to_id(&format!("refs/heads/{branch}")) {
      let _ = repo.reference(
        &format!("refs/remotes/origin/{branch}"),
        oid,
        true,
        "flowforge push",
      );
    }
    if let Ok(mut b) = repo.find_branch(&branch, git2::BranchType::Local) {
      let _ = b.set_upstream(Some(&format!("origin/{branch}")));
    }
    Ok(format!("pushed refs/heads/{branch} to origin"))
  })
  .await
  .map_err(|e| format!("git push failed: {e}"))?
}

#[tauri::command]
pub async fn git_clone(
  app: AppHandle,
  repo_url: String,
  target_dir: String,
  branch: Option<String>,
  auth: Option<GitAuth>,
) -> Result<GitCloneResult, String> {
  clone_repo(&repo_url, &target_dir, branch.as_deref(), auth.as_ref(), move |payload| {
    if let Err(e) = app.emit("git://clone_progress", payload) {
      log::warn!("git clone_progress emit failed: {e}");
    }
  })
  .await
}

#[tauri::command]
pub async fn git_create_branch(
  repo_path: String,
  new_branch: String,
  base: Option<String>,
) -> Result<bool, String> {
  create_branch(&PathBuf::from(repo_path), &new_branch, base.as_deref())
    .await
    .map(|_| true)
}

#[tauri::command]
pub async fn git_checkout_branch(repo_path: String, branch: String) -> Result<bool, String> {
  checkout_branch(&PathBuf::from(repo_path), &branch).await.map(|_| true)
}

#[tauri::command]
pub async fn git_branch_list(repo_path: String) -> Result<GitBranchList, String> {
  branch_list(&PathBuf::from(repo_path)).await
}

#[tauri::command]
pub async fn git_push(
  repo_path: String,
  branch: String,
  auth: Option<GitAuth>,
) -> Result<String, String> {
  push_branch(&PathBuf::from(repo_path), &branch, auth.as_ref()).await
}

#[tauri::command]
pub async fn git_check_available() -> Result<GitAvailability, String> {
  Ok(check_git_available().await)
}

// ─── Local repo reference (引用本地已有目录，不 clone 不复制) ───

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepoInfo {
  pub exists: bool,
  pub is_directory: bool,
  pub is_git_repo: bool,
  pub git_root: Option<String>,
  pub current_branch: Option<String>,
}

/// Probes a local path for direct registration (no clone, no copy).
/// Missing paths and plain files come back as data (not Err) so the UI
/// can show precise feedback; only I/O failures (e.g. permission denied)
/// map to the unified `{code}: {message}` error shape. git2 discovery
/// walks up parent dirs, so a subdirectory of a work tree also reports
/// isGitRepo=true with gitRoot pointing at the real root.
pub fn local_repo_info(path: &str) -> Result<LocalRepoInfo, String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err("local repo validate failed: path is empty".to_string());
  }
  let p = Path::new(trimmed);
  let meta = match std::fs::metadata(p) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      return Ok(LocalRepoInfo {
        exists: false,
        is_directory: false,
        is_git_repo: false,
        git_root: None,
        current_branch: None,
      });
    }
    Err(e) => return Err(format!("local repo validate failed: {e}")),
  };
  if !meta.is_dir() {
    return Ok(LocalRepoInfo {
      exists: true,
      is_directory: false,
      is_git_repo: false,
      git_root: None,
      current_branch: None,
    });
  }
  match git2::Repository::discover(p) {
    Ok(repo) => {
      let git_root = repo.workdir().map(|w| {
        // drop the trailing separator git2 keeps on workdir paths
        let s = w.to_string_lossy();
        s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string()
      });
      let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from));
      Ok(LocalRepoInfo {
        exists: true,
        is_directory: true,
        is_git_repo: true,
        git_root,
        current_branch,
      })
    }
    Err(_) => Ok(LocalRepoInfo {
      exists: true,
      is_directory: true,
      is_git_repo: false,
      git_root: None,
      current_branch: None,
    }),
  }
}

#[tauri::command]
pub async fn validate_local_repo(path: String) -> Result<LocalRepoInfo, String> {
  tokio::task::spawn_blocking(move || local_repo_info(&path))
    .await
    .map_err(|e| e.to_string())?
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::commands::code_index::tests::make_fixture_repo;
  use crate::commands::code_index::{full_index, query_index};
  use std::process::Command;

  fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
      .current_dir(dir)
      .env("GIT_AUTHOR_NAME", "t")
      .env("GIT_AUTHOR_EMAIL", "t@t")
      .env("GIT_COMMITTER_NAME", "t")
      .env("GIT_COMMITTER_EMAIL", "t@t")
      .args(args)
      .output()
      .expect("git run");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  fn init_git_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "init"]);
  }

  #[test]
  fn incremental_reparses_only_the_changed_file() {
    let repo = make_fixture_repo("incr");
    init_git_repo(&repo);
    let db = repo.join("index.db");
    let full = full_index(&repo, &db).unwrap();
    assert_eq!(full.files, 5);

    // untouched pass → nothing re-parsed
    let noop = incremental_index(&repo, &db).unwrap();
    assert_eq!(noop.files, 0, "no changes → no re-parse");

    // touch exactly one file (content + mtime)
    std::thread::sleep(Duration::from_millis(20));
    let target = repo.join("src/config.py");
    let mut content = std::fs::read_to_string(&target).unwrap();
    content.push_str("\ndef added_by_incremental():\n    return 1\n");
    std::fs::write(&target, content).unwrap();

    let started = Instant::now();
    let incr = incremental_index(&repo, &db).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(incr.files, 1, "only src/config.py must be re-parsed");
    assert!(incr.symbols > full.symbols, "new symbol must land in the index");
    assert!(elapsed < Duration::from_millis(500), "incremental took {elapsed:?}");

    // the fresh symbol is queryable and the old data survives
    let hits = query_index(&db, "added_by_incremental", 5).unwrap();
    assert_eq!(hits.first().map(|h| h.name.as_str()), Some("added_by_incremental"));
    let old = query_index(&db, "getUserById", 5).unwrap();
    assert!(!old.is_empty());

    // deletion is picked up too
    std::fs::remove_file(repo.join("src/store.go")).unwrap();
    let after_rm = incremental_index(&repo, &db).unwrap();
    assert_eq!(after_rm.files, 0);
    let gone = query_index(&db, "NewStore", 5).unwrap();
    assert!(gone.is_empty(), "deleted file's symbols must be gone");

    std::fs::remove_dir_all(&repo).ok();
  }

  #[test]
  fn git_helpers_report_status_commits_and_diffs() {
    let repo = make_fixture_repo("git");
    init_git_repo(&repo);
    let repo_str = repo.to_string_lossy();

    let status = repo_status(&repo_str).unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    let first_rev = status.head_rev.clone().expect("head rev");

    // dirty file shows up in status + changed_files
    std::fs::write(repo.join("src/new.js"), "export function fresh() { return 1 }").unwrap();
    let status = repo_status(&repo_str).unwrap();
    assert!(status.entries.iter().any(|e| e.path == "src/new.js" && e.status.contains("new")));
    let changed = changed_files(&repo_str, None).unwrap();
    assert!(changed.contains(&"src/new.js".to_string()));

    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "add fresh"]);
    let commits = recent_commits(&repo_str, 10).unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].summary, "add fresh");

    // diff against the first commit still reports the file
    let since_first = changed_files(&repo_str, Some(&first_rev)).unwrap();
    assert!(since_first.contains(&"src/new.js".to_string()));

    std::fs::remove_dir_all(&repo).ok();
  }

  #[test]
  fn commit_watch_debounces_and_emits_updated() {
    let repo = make_fixture_repo("watch");
    init_git_repo(&repo);
    let db = repo.join("index.db");
    full_index(&repo, &db).unwrap();

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_thread = Arc::clone(&cancel);
    let (tx, rx) = std::sync::mpsc::channel::<(String, serde_json::Value)>();
    let repo_for_thread = repo.clone();
    let db_for_thread = db.clone();
    let handle = std::thread::spawn(move || {
      watch_repo_commits(
        repo_for_thread,
        cancel_for_thread,
        Duration::from_millis(400), // short debounce keeps the test fast
        move |r| incremental_index(r, &db_for_thread),
        move |event, payload| {
          let _ = tx.send((event.to_string(), payload));
        },
      );
    });

    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(repo.join("src/watched.py"), "def watched():\n    return 7\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "watched change"]);

    let (event, payload) = rx.recv_timeout(Duration::from_secs(8)).expect("no update event");
    assert_eq!(event, "code_index://updated");
    assert!(payload["summary"]["files"].as_i64().unwrap_or(0) >= 1);

    // the committed symbol is now searchable
    let hits = query_index(&db, "watched", 5).unwrap();
    assert!(hits.iter().any(|h| h.name == "watched"));

    cancel.store(true, Ordering::SeqCst);
    handle.join().unwrap();
    std::fs::remove_dir_all(&repo).ok();
  }

  // ─── system git CLI tests (local repos only, no network) ─────

  fn make_cli_repo(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flowforge-gitcli-{tag}-{}", now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("README.md"), "# fixture\n").unwrap();
    init_git_repo(&dir);
    dir
  }

  #[tokio::test]
  async fn check_available_reports_builtin_git() {
    // built-in libgit2 — always available, no system git required
    let avail = check_git_available().await;
    assert!(avail.available);
    assert!(avail.version.unwrap().contains("libgit2"));
  }

  #[tokio::test]
  async fn create_checkout_and_list_branches() {
    let repo = make_cli_repo("branch");
    create_branch(&repo, "feature/x", None).await.unwrap();
    create_branch(&repo, "feature/y", Some("main")).await.unwrap();
    checkout_branch(&repo, "feature/x").await.unwrap();

    let list = branch_list(&repo).await.unwrap();
    assert_eq!(list.current.as_deref(), Some("feature/x"));
    for b in ["main", "feature/x", "feature/y"] {
      assert!(list.local.contains(&b.to_string()), "missing local branch {b}");
    }
    assert!(list.remote.is_empty(), "fresh init has no remotes");

    // failures surface the unified `{code}: {message}` shape
    let err = checkout_branch(&repo, "does-not-exist").await.unwrap_err();
    assert!(err.starts_with("git checkout failed:"), "{err}");
    let err = create_branch(&repo, "feature/x", None).await.unwrap_err();
    assert!(err.starts_with("git branch failed:"), "{err}");
    // no `origin` remote → push fails locally, still no network involved
    let err = push_branch(&repo, "feature/x", None).await.unwrap_err();
    assert!(err.starts_with("git push failed:"), "{err}");

    std::fs::remove_dir_all(&repo).ok();
  }

  #[tokio::test]
  async fn clone_local_repo_emits_progress_and_is_idempotent() {
    let src = make_cli_repo("clone-src");
    let src_str = src.to_string_lossy().into_owned();
    let target = std::env::temp_dir().join(format!("flowforge-gitcli-clone-{}", now_ms()));
    let target_str = target.to_string_lossy().into_owned();

    let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = Arc::clone(&events);
    let res = clone_repo(&src_str, &target_str, None, None, move |p| {
      sink.lock().unwrap().push(p);
    })
    .await
    .unwrap();
    assert!(!res.already_cloned);
    assert!(target.join(".git").exists());
    assert!(
      events.lock().unwrap().iter().any(|e| e["phase"] == "done"),
      "a final done event must be emitted"
    );

    // second call short-circuits — idempotent, no re-clone
    let res2 = clone_repo(&src_str, &target_str, None, None, |_| {}).await.unwrap();
    assert!(res2.already_cloned);

    // remote-tracking branches show up in the clone
    let list = branch_list(&target).await.unwrap();
    assert!(list.remote.iter().any(|r| r == "origin/main"), "{:?}", list.remote);

    // --branch checks out the requested branch
    create_branch(&src, "feature/z", None).await.unwrap();
    let t2 = std::env::temp_dir().join(format!("flowforge-gitcli-clone2-{}", now_ms()));
    let t2_str = t2.to_string_lossy().into_owned();
    clone_repo(&src_str, &t2_str, Some("feature/z"), None, |_| {}).await.unwrap();
    let list2 = branch_list(&t2).await.unwrap();
    assert_eq!(list2.current.as_deref(), Some("feature/z"));

    // clone failure carries the unified error shape
    let bad_target = std::env::temp_dir().join(format!("flowforge-gitcli-bad-{}", now_ms()));
    let bad = clone_repo(
      "/nonexistent/definitely-missing-repo",
      &bad_target.to_string_lossy(),
      None,
      None,
      |_| {},
    )
    .await;
    assert!(bad.unwrap_err().starts_with("git clone failed:"));

    for d in [&src, &target, &t2, &bad_target] {
      std::fs::remove_dir_all(d).ok();
    }
  }

  #[test]
  fn auth_bundle_applies_to_http_urls_only() {
    let auth = fake_auth(None, "glpat-FAKE123");
    // username defaults to oauth2 (GitLab/GitHub token convention)
    let b = auth_bundle("https://gitlab.example.com/grp/repo.git", Some(&auth)).unwrap();
    assert_eq!(b.username, "oauth2");
    assert_eq!(b.token, "glpat-FAKE123");
    // explicit username + http scheme both work
    let b2 = auth_bundle("http://git.corp:8443/r.git", Some(&fake_auth(Some("bot"), "tok"))).unwrap();
    assert_eq!(b2.username, "bot");
    // ssh / scp-like / local paths → no token (credentials callback skipped)
    assert!(auth_bundle("git@github.com:org/repo.git", Some(&auth)).is_none());
    assert!(auth_bundle("ssh://git@host/repo.git", Some(&auth)).is_none());
    assert!(auth_bundle("/tmp/local/repo", Some(&auth)).is_none());
    assert!(auth_bundle("https://host/r.git", None).is_none());
  }

  // ─── validate_local_repo (本地目录引用校验) ────────────────

  #[test]
  fn local_repo_info_reports_missing_path() {
    let missing = std::env::temp_dir().join(format!("flowforge-localref-missing-{}", now_ms()));
    let info = local_repo_info(&missing.to_string_lossy()).unwrap();
    assert!(!info.exists);
    assert!(!info.is_directory);
    assert!(!info.is_git_repo);
    assert!(info.git_root.is_none());

    // empty path → unified `{code}: {message}` error
    let err = local_repo_info("   ").unwrap_err();
    assert!(err.starts_with("local repo validate failed:"), "{err}");
  }

  #[test]
  fn local_repo_info_reports_plain_file() {
    let dir = std::env::temp_dir().join(format!("flowforge-localref-file-{}", now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("notes.txt");
    std::fs::write(&file, "hi").unwrap();

    let info = local_repo_info(&file.to_string_lossy()).unwrap();
    assert!(info.exists);
    assert!(!info.is_directory, "a file must not pass as a directory");
    assert!(!info.is_git_repo);

    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn local_repo_info_reports_plain_directory() {
    // temp_dir itself may sit inside a git work tree on dev machines, so
    // nest a fresh dir and make sure discovery does not walk out of /tmp
    let dir = std::env::temp_dir().join(format!("flowforge-localref-plain-{}", now_ms()));
    std::fs::create_dir_all(&dir).unwrap();

    let info = local_repo_info(&dir.to_string_lossy()).unwrap();
    assert!(info.exists);
    assert!(info.is_directory);
    assert!(!info.is_git_repo, "plain dir must degrade to isGitRepo=false");
    assert!(info.current_branch.is_none());

    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn local_repo_info_reports_git_repo_and_subdir() {
    let repo = make_cli_repo("localref");
    let info = local_repo_info(&repo.to_string_lossy()).unwrap();
    assert!(info.exists && info.is_directory && info.is_git_repo);
    assert_eq!(info.current_branch.as_deref(), Some("main"));
    let root = info.git_root.expect("git root");
    assert_eq!(
      std::fs::canonicalize(&root).unwrap(),
      std::fs::canonicalize(&repo).unwrap()
    );

    // a subdirectory still resolves to the same git root
    let sub = repo.join("src");
    std::fs::create_dir_all(&sub).unwrap();
    let sub_info = local_repo_info(&sub.to_string_lossy()).unwrap();
    assert!(sub_info.is_git_repo);
    assert_eq!(
      std::fs::canonicalize(sub_info.git_root.unwrap()).unwrap(),
      std::fs::canonicalize(&repo).unwrap()
    );

    std::fs::remove_dir_all(&repo).ok();
  }

  // ─── token auth: URL injection + redaction ────────────────────

  fn fake_auth(user: Option<&str>, token: &str) -> GitAuth {
    GitAuth { username: user.map(String::from), token: token.to_string() }
  }

  #[test]
  fn redact_credentials_strips_userinfo_everywhere() {
    assert_eq!(
      redact_credentials("fatal: unable to access 'http://oauth2:glpat-FAKE@host/r.git/': timeout"),
      "fatal: unable to access 'http://***@host/r.git/': timeout"
    );
    // multiple URLs in one message
    assert_eq!(
      redact_credentials("push https://a:b@h1/x and https://c:d@h2/y"),
      "push https://***@h1/x and https://***@h2/y"
    );
    // credential-free text is untouched
    let clean = "Cloning into 'repo'... done https://host/r.git";
    assert_eq!(redact_credentials(clean), clean);
    // never let a token through, whatever the shape
    let redacted = redact_credentials("error: http://user:sec%3Aret@10.0.0.1:8080/g/r.git failed");
    assert!(!redacted.contains("sec"), "{redacted}");
    assert!(redacted.contains("://***@10.0.0.1:8080"), "{redacted}");
  }

  #[test]
  fn redact_credentials_handles_encoded_userinfo_and_ports() {
    // token containing a percent-encoded '@' (%40)
    assert_eq!(
      redact_credentials("fatal: 'https://oauth2:tok%40chunk@host/r.git' rejected"),
      "fatal: 'https://***@host/r.git' rejected"
    );
    // username containing %40 (user@corp percent-encoded)
    assert_eq!(
      redact_credentials("https://user%40corp:secret@gitlab.corp/g/r.git"),
      "https://***@gitlab.corp/g/r.git"
    );
    // multiple raw '@'s in userinfo → everything before the last one goes
    assert_eq!(
      redact_credentials("pull http://a@b:c@d@host/x failed"),
      "pull http://***@host/x failed"
    );
    // URL with explicit port keeps host:port, drops the whole userinfo
    assert_eq!(
      redact_credentials("https://bot:tok@git.corp:8443/r.git"),
      "https://***@git.corp:8443/r.git"
    );
    // several tokened URLs with ports/encodings on one line
    let redacted = redact_credentials(
      "mirror https://a%40x:p%40ss@h1:8080/r and http://b:q@h2/y done",
    );
    assert_eq!(redacted, "mirror https://***@h1:8080/r and http://***@h2/y done");
    // a quote inside the userinfo must not shield the token
    let redacted = redact_credentials("warn: https://u:to'k@host/r.git");
    assert!(!redacted.contains("to'k"), "{redacted}");
    assert_eq!(redacted, "warn: https://***@host/r.git");
  }

  #[tokio::test]
  async fn clone_and_push_with_auth_keep_local_behavior() {
    // local-path URLs ignore the token entirely — existing flows intact
    let auth = fake_auth(None, "glpat-FAKE123");
    let src = make_cli_repo("auth-src");
    let src_str = src.to_string_lossy().into_owned();
    let target = std::env::temp_dir().join(format!("flowforge-gitcli-authclone-{}", now_ms()));
    let target_str = target.to_string_lossy().into_owned();

    let res = clone_repo(&src_str, &target_str, None, Some(&auth), |_| {}).await.unwrap();
    assert!(!res.already_cloned);
    assert!(target.join(".git").exists());

    // origin stays the clean source URL (nothing token-ish in .git/config)
    let config = std::fs::read_to_string(target.join(".git/config")).unwrap();
    assert!(!config.contains("glpat-FAKE123"), "token must never land in .git/config");

    // push with auth against a bare-repo origin succeeds locally and
    // records the upstream (the `-u` equivalent); the token never leaks
    let bare = std::env::temp_dir().join(format!("flowforge-gitcli-authbare-{}.git", now_ms()));
    git2::Repository::init_bare(&bare).unwrap();
    {
      let repo = git2::Repository::discover(&target).unwrap();
      repo.remote_set_url("origin", &bare.to_string_lossy()).unwrap();
    }
    create_branch(&target, "feature/auth", None).await.unwrap();
    let out = push_branch(&target, "feature/auth", Some(&auth)).await.unwrap();
    assert!(!out.contains("glpat-FAKE123"));
    assert!(out.contains("feature/auth"), "{out}");
    // upstream got recorded like `git push -u`
    let repo = git2::Repository::discover(&target).unwrap();
    let b = repo.find_branch("feature/auth", git2::BranchType::Local).unwrap();
    assert_eq!(b.upstream().unwrap().name().unwrap(), Some("origin/feature/auth"));

    // push with auth but no origin remote → unified error, token-free
    let lone = make_cli_repo("auth-lone");
    let err = push_branch(&lone, "main", Some(&auth)).await.unwrap_err();
    assert!(err.starts_with("git push failed:"), "{err}");
    assert!(!err.contains("glpat-FAKE123"), "{err}");

    for d in [&src, &target, &lone, &bare] {
      std::fs::remove_dir_all(d).ok();
    }
  }

  #[tokio::test]
  async fn clone_failure_with_auth_never_leaks_the_token() {
    // connection-refused on localhost — fails fast, no DNS, no network
    let auth = fake_auth(None, "glpat-SUPERSECRET");
    let target = std::env::temp_dir().join(format!("flowforge-gitcli-authbad-{}", now_ms()));
    let err = clone_repo(
      "http://127.0.0.1:1/group/repo.git",
      &target.to_string_lossy(),
      None,
      Some(&auth),
      |p| {
        // progress/error lines must be redacted too
        assert!(!p.to_string().contains("glpat-SUPERSECRET"), "event leaked token: {p}");
      },
    )
    .await
    .unwrap_err();
    assert!(err.starts_with("git clone failed:"), "{err}");
    assert!(!err.contains("glpat-SUPERSECRET"), "error leaked token: {err}");
    std::fs::remove_dir_all(&target).ok();
  }

  // ─── real-repo E2E acceptance (opt-in, ignored by default) ────
  //
  // Clones the real wms-api GitLab repo, creates/checks out a
  // feature/ff-test-{ts} branch and full-indexes the Java tree.
  // Needs network access + git credentials from the system credential
  // helper (no credential ever appears in code or env here).
  //
  // Run: TMPDIR=/tmp cargo test --lib real_wms_api -- --ignored --nocapture
  // Override the repo with FF_E2E_REPO_URL when needed.

  #[tokio::test]
  #[ignore = "network E2E: clones the real wms-api repo (acceptance harness)"]
  async fn real_wms_api_clone_branch_and_index() {
    let repo_url = std::env::var("FF_E2E_REPO_URL")
      .unwrap_or_else(|_| "http://172.16.162.150/wms-project/wms-api.git".to_string());
    let ts = now_ms();
    let target = std::env::temp_dir().join(format!("flowforge-wms-e2e-{ts}"));
    let target_str = target.to_string_lossy().into_owned();

    // 1) real clone through the production clone_repo path
    let started = Instant::now();
    let res = clone_repo(&repo_url, &target_str, None, None, |_| {}).await.expect("clone wms-api");
    let clone_ms = started.elapsed().as_millis();
    assert!(!res.already_cloned);
    assert!(target.join(".git").exists());

    // 2) create + switch to the acceptance branch
    let branch = format!("feature/ff-test-{ts}");
    create_branch(&target, &branch, None).await.expect("create branch");
    checkout_branch(&target, &branch).await.expect("checkout branch");
    let list = branch_list(&target).await.expect("branch list");
    assert_eq!(list.current.as_deref(), Some(branch.as_str()));

    // 3) full index of the Java repo via the Phase 5 code_index module
    let db = std::env::temp_dir().join(format!("flowforge-wms-e2e-idx-{ts}.db"));
    let summary = full_index(&target, &db).expect("full index");
    assert!(summary.files > 0, "indexed file count must be > 0");

    let conn = rusqlite::Connection::open(&db).unwrap();
    let java_files: i64 = conn
      .query_row("SELECT COUNT(*) FROM files WHERE lang = 'java'", [], |r| r.get(0))
      .unwrap();
    let java_symbols: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM symbols s JOIN files f ON f.path = s.file WHERE f.lang = 'java'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    println!(
      "wms-api E2E: cloneMs={clone_ms} branch={branch} indexedFiles={} javaFiles={java_files} \
       symbols={} javaSymbols={java_symbols} relations={} indexMs={}",
      summary.files, summary.symbols, summary.relations, summary.duration_ms
    );
    assert!(java_files > 0, "repo must contain Java files");
    assert!(java_symbols > 0, "Java symbol count must be > 0");

    drop(conn);
    std::fs::remove_file(&db).ok();
    std::fs::remove_dir_all(&target).ok();
  }
}
