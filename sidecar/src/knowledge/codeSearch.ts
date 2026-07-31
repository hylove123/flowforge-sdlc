// ================================================================
//  Code Search — hybrid retrieval over the Rust-built code index
//  (DESIGN Phase 5). The Tauri shell (commands/code_index.rs) writes
//  {FLOWFORGE_DATA_DIR || ~/.flowforge}/code_index/{repoHash}.db;
//  this module reads the very same SQLite file with better-sqlite3
//  (no sidecar→Rust back-channel needed).
//
//  Retrieval strategy:
//    1. BM25 over the symbols_fts FTS5 table — always available
//    2. vector recall via the knowledge layer (CodeModule chunks),
//       raced against a timeout budget (default 200ms): when the
//       embedder is missing, slow, or throws, the result degrades to
//       pure BM25 — the caller never blocks on vector health
//
//  RPC surface (registered by index.ts):
//    code.search           { repoPath, query, topK?, projectId? }
//    code.register_modules { repoPath, projectId, deliveryId?, … }
// ================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  getKnowledgeService,
  isKnowledgeConfigured,
} from './knowledgeService.js'

// ─── Repo hash / db path (parity with commands/code_index.rs) ───

/** FNV-1a 64-bit hex — must stay byte-identical to the Rust fnv1a64. */
export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

export function codeIndexDir(): string {
  const base = process.env.FLOWFORGE_DATA_DIR || path.join(os.homedir(), '.flowforge')
  return path.join(base, 'code_index')
}

/** Same canonicalize-then-hash rule as Rust's repo_hash(). */
export function codeIndexDbPath(repoPath: string): string {
  let canonical = repoPath
  try {
    canonical = fs.realpathSync(repoPath)
  } catch {
    /* repo may not exist yet — hash the raw path like Rust does */
  }
  return path.join(codeIndexDir(), `${fnv1a64Hex(canonical)}.db`)
}

// ─── BM25 over symbols_fts ──────────────────────────────────────

export interface CodeSearchHit {
  file: string
  name: string
  kind: string
  startLine: number
  endLine: number
  signature: string
  score: number
  matchedIn: string[] // 'bm25' | 'vector'
}

/** User text → FTS5 prefix expression (mirror of Rust fts_match_expr). */
export function ftsMatchExpr(query: string): string | null {
  const tokens = (query || '')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2)
    .map((t) => `"${t.replace(/"/g, '')}"*`)
  return tokens.length > 0 ? tokens.join(' OR ') : null
}

export function bm25Search(dbPath: string, query: string, topK: number): CodeSearchHit[] {
  const expr = ftsMatchExpr(query)
  if (!expr || !fs.existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        `SELECT s.file, s.name, s.kind, s.start_line AS startLine, s.end_line AS endLine,
                s.signature, bm25(symbols_fts, 5.0, 1.0, 2.0, 1.0) AS rank
         FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
         WHERE symbols_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(expr, topK) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      file: String(r.file),
      name: String(r.name),
      kind: String(r.kind),
      startLine: Number(r.startLine),
      endLine: Number(r.endLine),
      signature: String(r.signature ?? ''),
      score: -Number(r.rank), // bm25() is negative-is-better
      matchedIn: ['bm25'],
    }))
  } finally {
    db.close()
  }
}

// ─── Hybrid search with vector timeout fallback ─────────────────

/** Vector recall seam: resolves file-level hits or null (unavailable). */
export type VectorCodeSearch = (
  query: string,
  topK: number
) => Promise<Array<{ file: string; score: number }>>

export const VECTOR_TIMEOUT_MS = 200

export interface CodeSearchInput {
  repoPath: string
  query: string
  topK?: number
  projectId?: string | null
  /** Vector time budget; beyond it the merge proceeds BM25-only. */
  timeoutMs?: number
  /** Test seam — defaults to the knowledge-layer CodeModule recall. */
  vectorSearch?: VectorCodeSearch | null
}

export interface CodeSearchResult {
  backend: 'bm25' | 'hybrid'
  results: CodeSearchHit[]
}

/** Knowledge-layer vector recall over registered CodeModule entities.
 *  Returns null when the layer is unarmed or running in BM25 mode
 *  (its keyword fallback would only duplicate our own BM25 pass). */
function knowledgeVectorSearch(projectId: string | null): VectorCodeSearch | null {
  if (!isKnowledgeConfigured()) return null
  try {
    const service = getKnowledgeService()
    if (service.vectors.backend !== 'vector') return null
    return async (query, topK) => {
      const hits = await service.vectors.search(query, { projectId, topK })
      const out: Array<{ file: string; score: number }> = []
      for (const h of hits) {
        const entity = service.graph.getEntity(h.entityId)
        if (entity?.type !== 'CodeModule') continue
        const file = String(entity.properties.file ?? entity.label ?? '')
        if (file) out.push({ file, score: h.score })
      }
      return out
    }
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise
      .then((v) => { clearTimeout(timer); resolve(v) })
      .catch(() => { clearTimeout(timer); resolve(null) })
  })
}

/**
 * BM25 + vector hybrid: vector hits (file level) boost matching BM25 rows
 * (weight 0.7/0.3 after max-normalization) and unseen files are appended
 * as module-level results. Vector failure/timeout → pure BM25.
 */
export async function codeSearch(input: CodeSearchInput): Promise<CodeSearchResult> {
  const topK = input.topK ?? 5
  const dbPath = codeIndexDbPath(input.repoPath)
  const bm25 = bm25Search(dbPath, input.query, Math.max(topK * 2, topK))

  const vectorFn =
    input.vectorSearch !== undefined
      ? input.vectorSearch
      : knowledgeVectorSearch(input.projectId ?? null)
  let vector: Array<{ file: string; score: number }> | null = null
  if (vectorFn) {
    vector = await withTimeout(
      vectorFn(input.query, topK),
      input.timeoutMs ?? VECTOR_TIMEOUT_MS
    )
  }

  if (!vector || vector.length === 0) {
    return { backend: 'bm25', results: bm25.slice(0, topK) }
  }

  // weighted merge: normalize both sides to 0..1, dedupe by file
  const maxBm25 = Math.max(...bm25.map((h) => h.score), 1e-9)
  const maxVec = Math.max(...vector.map((v) => v.score), 1e-9)
  const merged = new Map<string, CodeSearchHit>()
  for (const hit of bm25) {
    merged.set(`${hit.file}#${hit.name}`, { ...hit, score: 0.7 * (hit.score / maxBm25) })
  }
  for (const v of vector) {
    const boost = 0.3 * (v.score / maxVec)
    let matchedExisting = false
    for (const hit of merged.values()) {
      if (hit.file === v.file) {
        hit.score += boost
        if (!hit.matchedIn.includes('vector')) hit.matchedIn.push('vector')
        matchedExisting = true
      }
    }
    if (!matchedExisting) {
      merged.set(`${v.file}#`, {
        file: v.file,
        name: path.basename(v.file),
        kind: 'module',
        startLine: 1,
        endLine: 1,
        signature: '',
        score: boost,
        matchedIn: ['vector'],
      })
    }
  }
  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK)
  return { backend: 'hybrid', results }
}

// ─── CodeModule registration (post-index graph hookup) ──────────

export interface FileModuleRow {
  file: string
  lang: string
  symbolCount: number
  topSymbols: string[]
}

/** File-level module rollup read straight from the code index db. */
export function readFileModules(dbPath: string, limit = 200): FileModuleRow[] {
  if (!fs.existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const files = db
      .prepare(
        'SELECT path, lang, symbol_count AS symbolCount FROM files ORDER BY symbol_count DESC, path LIMIT ?'
      )
      .all(limit) as Array<{ path: string; lang: string; symbolCount: number }>
    const symStmt = db.prepare(
      'SELECT name FROM symbols WHERE file = ? ORDER BY (end_line - start_line) DESC LIMIT 5'
    )
    return files.map((f) => ({
      file: f.path,
      lang: f.lang,
      symbolCount: f.symbolCount,
      topSymbols: (symStmt.all(f.path) as Array<{ name: string }>).map((s) => s.name),
    }))
  } finally {
    db.close()
  }
}

// ─── JSON-RPC method handlers (registered by index.ts) ──────────

export const codeSearchMethods = {
  /** { repoPath, query, topK?, projectId?, timeoutMs? } → { backend, results, durationMs } */
  'code.search': async (params: any) => {
    const { repoPath, query } = params ?? {}
    if (!repoPath || !query) throw new Error('repoPath and query are required')
    const started = Date.now()
    const result = await codeSearch({
      repoPath,
      query,
      topK: params.topK,
      projectId: params.projectId ?? null,
      timeoutMs: params.timeoutMs,
    })
    return { ...result, durationMs: Date.now() - started }
  },

  /**
   * { repoPath, projectId, deliveryId?, stageId?, limit? }
   * Reads the file-level modules from the index db and registers them
   * as CodeModule entities (IMPLEMENTS-linked) in one transaction.
   */
  'code.register_modules': async (params: any) => {
    const { repoPath, projectId } = params ?? {}
    if (!repoPath || !projectId) throw new Error('repoPath and projectId are required')
    const modules = readFileModules(codeIndexDbPath(repoPath), params.limit ?? 200)
    if (modules.length === 0) return { registered: 0, edges: 0 }
    return getKnowledgeService().registerCodeModules({
      projectId,
      deliveryId: params.deliveryId ?? null,
      stageId: params.stageId ?? 'dev',
      modules,
      implementsRef: params.implementsRef ?? null,
    })
  },
}
