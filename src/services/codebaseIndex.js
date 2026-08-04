/**
 * Codebase Index Service — manages code indexing (dual-engine, t3)
 *
 * 引擎 A：tree-sitter FTS5 BM25 + sqlite-vec 向量（Rust code_index_*）——搜得快
 * 引擎 B：codebase-memory-mcp 图谱引擎（sidecar graph_engine.*）——看得深
 *
 * 统一构建：startIndexing 先建 A，随后后台建 B（不阻塞）；
 * 统一搜索：searchCodebase 并行两路 + RRF 融合，B 不可用时自动降级仅用 A。
 */

import { storage } from '@/adapters/StorageService'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { sidecar } from '@/adapters/SidecarBridge'
import { getRepositories } from '@/services/repository'
import { registerCodeModules } from '@/services/knowledge'
import {
  graphProjectName, indexRepoGraph, indexCrossRepo, searchGraphCode,
  traceSymbol, detectGraphChanges, deleteGraphProject,
} from '@/services/graphEngine'

const INDEX_KEY = 'flowforge_codebase_index'
// 项目级图谱（引擎 B 跨仓库）状态：{ [projectId]: { crossStatus, crossEdges, crossByType, lastCrossAt } }
const GRAPH_STATE_KEY = 'flowforge_graph_state'

// Index structure:
// {
//   id: string,
//   projectId: string,
//   repoId: string,
//   repoName: string,
//   status: 'none' | 'indexing' | 'ready' | 'error',   // 引擎 A（FTS/向量）
//   graphStatus: 'none' | 'indexing' | 'ready' | 'error', // 引擎 B（图谱）
//   graphError: string | null,
//   graphIndexedAt: string | null,
//   fileCount: number,
//   language: string[],     // detected languages
//   indexSize: string,      // human-readable
//   lastIndexed: string,    // ISO date
//   error: string | null,
//   chunks: number,         // number of indexed chunks
// }

// ─── 项目级图谱（跨仓库）状态 ───────────────────────────────

export function getGraphState(projectId) {
  const all = storage.getJSON(GRAPH_STATE_KEY, {}) || {}
  return projectId ? (all[projectId] || null) : all
}

export function saveGraphState(projectId, updates) {
  const all = storage.getJSON(GRAPH_STATE_KEY, {}) || {}
  all[projectId] = { ...(all[projectId] || {}), ...updates }
  storage.setJSON(GRAPH_STATE_KEY, all)
  return all[projectId]
}

export function getIndexes(projectId) {
  const all = storage.getJSON(INDEX_KEY, []) || []
  if (!projectId) return all
  return all.filter(i => i.projectId === projectId)
}

export function getIndex(repoId) {
  return getIndexes().find(i => i.repoId === repoId)
}

export function saveIndexes(indexes) {
  storage.setJSON(INDEX_KEY, indexes)
}

/**
 * Start indexing a repository via Codebase MCP.
 * In production, this would call the Codebase MCP server.
 */
export async function startIndexing(projectId, repoId, repoName, onProgress) {
  const all = getIndexes()
  const existing = all.find(i => i.repoId === repoId)

  if (existing) {
    // Update existing to indexing
    existing.status = 'indexing'
    existing.error = null
    saveIndexes(all)
  } else {
    // Create new index entry
    all.push({
      id: `idx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      repoId,
      repoName,
      status: 'indexing',
      fileCount: 0,
      language: [],
      indexSize: '0 KB',
      lastIndexed: null,
      error: null,
      chunks: 0,
    })
    saveIndexes(all)
  }

  // hand off to the real tree-sitter index
  return startIndexingTauri(projectId, repoId, onProgress)
}

/** tauri path of startIndexing: full index + knowledge-graph module hookup */
async function startIndexingTauri(projectId, repoId, onProgress) {
  const notify = (phase, extra = {}) => {
    updateIndex(repoId, { phase })
    try { onProgress?.({ phase, repoId, projectId, ...extra }) } catch { /* UI callback must not break indexing */ }
  }
  const repo = getRepositories(projectId).find(r => r.id === repoId)
  const repoPath = repo?.path
  if (!repoPath) {
    return updateIndex(repoId, { status: 'error', error: '仓库缺少本地路径，无法建立索引' })
  }
  try {
    notify('indexing')
    const summary = await tauriInvoke('code_index_full', { repoPath })
    // best-effort graph hookup: file modules become CodeModule entities (sidecar graph)
    sidecar.invoke('code.register_modules', { repoPath, projectId }).catch(() => {})
    const stats = await tauriInvoke('code_index_stats', { repoPath })
    notify('registering_modules', { summary })
    // best-effort: aggregate top-level modules into the frontend knowledge graph
    let modulesRegistered = 0
    try {
      const files = await listIndexedFiles(stats.dbPath)
      const modules = aggregateTopModules(files)
      const result = await registerCodeModuleEntities({
        projectId, repoId, repoName: repo.name || repoId, modules,
      })
      modulesRegistered = result.registered
    } catch { /* module rollup is auxiliary; never fail the index */ }
    const updated = updateIndex(repoId, {
      status: 'ready',
      phase: 'done',
      fileCount: summary.files,
      language: stats.languages ?? [],
      indexSize: `${summary.symbols} 符号 / ${summary.relations} 关系`,
      lastIndexed: new Date().toISOString(),
      chunks: summary.symbols,
      relations: summary.relations,
      durationMs: summary.durationMs,
      modulesRegistered,
      repoPath,
      error: null,
    })
    try { onProgress?.({ phase: 'done', repoId, projectId, modulesRegistered }) } catch { /* ignore */ }
    // ── 统一构建：引擎 A 就绪后，后台启动引擎 B 图谱索引（不阻塞 A 可用） ──
    // full/moderate 按仓库规模选择（大仓库跳过全量相似度边）
    const graphMode = (summary.files ?? 0) > 2000 ? 'moderate' : 'full'
    void startGraphIndexing(projectId, repoId, repoPath, graphMode)
    return updated
  } catch (e) {
    notify('error')
    return updateIndex(repoId, { status: 'error', error: e?.message || String(e) })
  }
}

// ─── 引擎 B（codebase-memory-mcp 图谱）统一构建 ────────────────

/**
 * 后台建立单仓库图谱索引（引擎 B）。内部函数：唯一对外入口是
 * startIndexing（串行 引擎A → 引擎B）。失败只记录 graphStatus。
 */
async function startGraphIndexing(projectId, repoId, repoPath, mode) {
  if (!repoPath) return null
  updateIndex(repoId, { graphStatus: 'indexing', graphError: null })
  try {
    const result = await indexRepoGraph(repoPath, mode)
    updateIndex(repoId, { graphStatus: 'ready', graphIndexedAt: new Date().toISOString(), graphError: null })
    return result
  } catch (e) {
    updateIndex(repoId, { graphStatus: 'error', graphError: e?.message || String(e) })
    return null
  }
}

/**
 * 一键建立跨仓库智能：cross-repo-intelligence 模式匹配 Route/Channel，
 * 生成 CROSS_HTTP_CALLS / CROSS_ASYNC_CALLS / CROSS_CHANNEL 边。
 * 需要项目内至少一个仓库的引擎 B 索引就绪。
 */
export async function buildCrossRepoIntelligence(projectId) {
  const indexes = getIndexes(projectId).filter(i => i.graphStatus === 'ready' && i.repoPath)
  if (indexes.length === 0) {
    throw new Error('请先完成至少一个仓库的图谱索引')
  }
  saveGraphState(projectId, { crossStatus: 'indexing' })
  try {
    const result = await indexCrossRepo(indexes[0].repoPath, ['*'])
    saveGraphState(projectId, { crossStatus: 'ready', lastCrossAt: new Date().toISOString() })
    return result
  } catch (e) {
    saveGraphState(projectId, { crossStatus: 'error', crossError: e?.message || String(e) })
    throw e
  }
}

/**
 * 统一增量：commit watcher 触发引擎 A 重索引后（code_index://updated），
 * 同步触发引擎 B 的 detect_changes（尽力而为，逐仓库独立失败隔离）。
 */
export async function syncGraphChanges(projectId) {
  const indexes = getIndexes(projectId).filter(i => i.graphStatus === 'ready' && i.repoPath)
  const results = []
  for (const idx of indexes) {
    const repo = getRepositories(projectId).find(r => r.id === idx.repoId)
    const project = graphProjectName(repo || { path: idx.repoPath, name: idx.repoName })
    if (!project) continue
    try {
      results.push({ project, ok: true, result: await detectGraphChanges(project, undefined, repo?.path || idx.repoPath) })
    } catch (e) {
      results.push({ project, ok: false, error: e?.message || String(e) })
    }
  }
  return results
}

// ─── Knowledge-graph CodeModule rollup (tauri) ─────────────────

/** Read the indexed file list (path + lang) from the code-index SQLite db. */
async function listIndexedFiles(dbPath) {
  if (!dbPath) return []
  const { default: Database } = await import('@tauri-apps/plugin-sql')
  const db = await Database.load(`sqlite:${dbPath}`)
  try {
    return await db.select('SELECT path, lang FROM files')
  } finally {
    try { await db.close() } catch { /* ignore */ }
  }
}

/** Derive the Java package name from a repo-relative file path. */
function javaPackageOf(filePath) {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
  if (!dir) return '(default)'
  // strip conventional source roots: src/main/java/, src/test/java/, src/java/, …
  const m = dir.match(/(?:^|\/)(?:src\/(?:[^/]+\/)?)?java\/(.+)$/)
  const pkgPath = m ? m[1] : dir
  return pkgPath.split('/').join('.')
}

/**
 * Aggregate indexed files into top-level modules:
 *   - Java files roll up per package (src/main/java/com/a/b/C.java → com.a.b)
 *   - other languages roll up per top-level directory
 * Sorted by file count (desc), capped at `limit` (default 20).
 * @param {Array<{path: string, lang?: string}>} files
 * @returns {Array<{name, kind, fileCount, languages, sampleFiles}>}
 */
export function aggregateTopModules(files, { limit = 20 } = {}) {
  const buckets = new Map()
  for (const f of files || []) {
    const path = (f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path) continue
    const isJava = (f.lang || '').toLowerCase() === 'java' || path.endsWith('.java')
    const name = isJava
      ? javaPackageOf(path)
      : (path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)')
    const kind = isJava ? 'package' : 'directory'
    const key = `${kind}:${name}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { name, kind, fileCount: 0, languages: new Set(), sampleFiles: [] }
      buckets.set(key, bucket)
    }
    bucket.fileCount += 1
    if (f.lang) bucket.languages.add(f.lang)
    if (bucket.sampleFiles.length < 5) bucket.sampleFiles.push(path)
  }
  return [...buckets.values()]
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(b => ({ ...b, languages: [...b.languages] }))
}

/**
 * Register aggregated modules as CodeModule entities in the knowledge graph
 * (sidecar knowledgeService, SQLite WAL). Idempotent: the sidecar upserts by
 * label (`{repoName}/{moduleName}`) within the project, and links each new
 * module IMPLEMENTS → the latest Deliverable when one exists.
 * @returns {Promise<{registered: number, edges: number}>}
 */
export async function registerCodeModuleEntities({ projectId, repoName, modules }) {
  const mapped = (modules || [])
    .filter(mod => mod?.name)
    .map(mod => ({
      file: `${repoName}/${mod.name}`,
      lang: (mod.languages || [])[0] ?? null,
      symbolCount: mod.fileCount,
      topSymbols: mod.sampleFiles || [],
    }))
  const result = await registerCodeModules({ projectId, stageId: 'dev', modules: mapped })
  return { registered: result?.registered ?? 0, edges: result?.edges ?? 0 }
}

export function updateIndex(repoId, updates) {
  const all = getIndexes()
  const idx = all.findIndex(i => i.repoId === repoId)
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...updates }
    saveIndexes(all)
    return all[idx]
  }
  return null
}

export function deleteIndex(repoId) {
  const target = getIndex(repoId)
  saveIndexes(getIndexes().filter(i => i.repoId !== repoId))
  // 尽力而为清理引擎 B 侧的图谱项目（以仓库目录名为项目名）
  if (target?.repoPath) {
    const project = graphProjectName({ path: target.repoPath, name: target.repoName })
    if (project) deleteGraphProject(project, target.repoPath).catch(() => {})
  }
}

/**
 * Cascade cleanup: drop every index record of a project
 * (used when a project is removed from the project center).
 * @returns {number} number of removed records
 */
export function removeIndexesForProject(projectId) {
  const all = getIndexes()
  const removedRecords = all.filter(i => i.projectId === projectId)
  const remaining = all.filter(i => i.projectId !== projectId)
  const removed = all.length - remaining.length
  if (removed > 0) saveIndexes(remaining)
  // 尽力而为：同步清理引擎 B 图谱项目与项目级跨仓库状态
  for (const rec of removedRecords) {
    if (rec.repoPath) {
      const project = graphProjectName({ path: rec.repoPath, name: rec.repoName })
      if (project) deleteGraphProject(project, rec.repoPath).catch(() => {})
    }
  }
  const states = storage.getJSON(GRAPH_STATE_KEY, {}) || {}
  if (states[projectId]) {
    delete states[projectId]
    storage.setJSON(GRAPH_STATE_KEY, states)
  }
  return removed
}

/**
 * Check if a project has any indexed repositories
 */
export function hasProjectIndex(projectId) {
  return getIndexes(projectId).some(i => i.status === 'ready')
}

/**
 * Get total index stats for a project
 */
export function getProjectIndexStats(projectId) {
  const indexes = getIndexes(projectId).filter(i => i.status === 'ready')
  return {
    repoCount: indexes.length,
    totalFiles: indexes.reduce((sum, i) => sum + i.fileCount, 0),
    totalChunks: indexes.reduce((sum, i) => sum + i.chunks, 0),
    languages: [...new Set(indexes.flatMap(i => i.language))],
    lastIndexed: indexes.length > 0
      ? indexes.map(i => i.lastIndexed).sort().reverse()[0]
      : null,
  }
}

/**
 * Search the codebase index — dual-engine fused retrieval (t3).
 * 引擎 B 未就绪时自动降级仅用引擎 A。
 */
export async function searchCodebase(projectId, query) {
  const stats = getProjectIndexStats(projectId)
  if (stats.repoCount === 0) {
    return { results: [], message: '项目尚未建立代码索引' }
  }

  // hybrid retrieval (sidecar code.search → BM25 fallback) + graph engine fusion
  return searchCodebaseTauri(projectId, query, stats)
}

// ─── Dual-engine fusion helpers ─────────────────────────────────

/** Reciprocal Rank Fusion：多路排序列表按 1/(k+rank) 累加融合。 */
export function reciprocalRankFusion(lists, k = 60) {
  const acc = new Map()
  for (const { source, items } of lists) {
    items.forEach((item, rank) => {
      const key = [item.repo, item.file, item.name || item.line].join('|')
      const cur = acc.get(key) || { item, score: 0, sources: [] }
      cur.score += 1 / (k + rank + 1)
      if (!cur.sources.includes(source)) cur.sources.push(source)
      acc.set(key, cur)
    })
  }
  return [...acc.values()].sort((a, b) => b.score - a.score)
}

/** 引擎 B（search_code compact）命中归一化为统一结构。 */
function normalizeGraphHits(res, repoName) {
  const list = Array.isArray(res) ? res : res?.results ?? res?.matches ?? []
  if (!Array.isArray(list)) return []
  return list.map(h => ({
    file: h.file ?? h.path ?? h.filePath ?? '',
    line: h.line ?? h.start_line ?? h.startLine ?? 1,
    name: h.name ?? h.symbol ?? h.function ?? '',
    kind: h.kind ?? h.type ?? 'symbol',
    signature: h.signature ?? h.declaration ?? '',
    score: typeof h.score === 'number' ? h.score : 0,
    repo: repoName,
  }))
}

/** Top 命中符号用引擎 B trace_path 增补调用方/被调方上下文（尽力而为，4s 上限）。 */
async function enrichWithTrace(hits) {
  const candidates = hits.filter(h => h.sources.includes('graph') && h.name).slice(0, 2)
  await Promise.all(candidates.map(async (h) => {
    const project = graphProjectName({ path: '', name: h.repo })
    if (!project || !h.name) return
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('trace timeout')), 4000))
      const trace = await Promise.race([traceSymbol(project, h.name, { depth: 2 }), timeout])
      const hops = Array.isArray(trace) ? trace.length : trace?.hops?.length ?? trace?.path?.length ?? 0
      if (hops > 0) h.trace = `调用链深度 ${hops} 跳（trace_path）`
    } catch { /* trace 是增补信息，失败静默 */ }
  }))
  return hits
}

/** tauri path of searchCodebase: engine A (hybrid) ∥ engine B (graph) → RRF fusion */
async function searchCodebaseTauri(projectId, query, stats) {
  const indexes = getIndexes(projectId).filter(i => i.status === 'ready' && i.repoPath)
  if (indexes.length === 0) {
    return { results: [], message: '项目尚未建立代码索引（tauri）', stats }
  }

  // ── 引擎 A：sidecar code.search（BM25+向量），失败回落 Rust BM25 ──
  const engineAHits = []
  let backend = 'bm25'
  let durationMs = 0
  const engineATasks = indexes.map(async (idx) => {
    try {
      const res = await sidecar.invoke('code.search', { repoPath: idx.repoPath, query, topK: 5, projectId })
      if (res?.backend === 'hybrid') backend = 'hybrid'
      durationMs += res?.durationMs ?? 0
      for (const hit of res?.results ?? []) engineAHits.push({ ...hit, repo: idx.repoName })
    } catch {
      // sidecar unavailable → query the Rust index directly (pure BM25)
      const hits = await tauriInvoke('code_index_query', { repoPath: idx.repoPath, query, topK: 5 })
      for (const hit of hits ?? []) engineAHits.push({ ...hit, repo: idx.repoName })
    }
  })

  // ── 引擎 B：结构感知搜索（仅图谱就绪的仓库，并行且失败隔离） ──
  const graphIndexes = indexes.filter(i => i.graphStatus === 'ready')
  const engineBHits = []
  const engineBTasks = graphIndexes.map(async (idx) => {
    const repo = getRepositories(projectId).find(r => r.id === idx.repoId)
    const project = graphProjectName(repo || { path: idx.repoPath, name: idx.repoName })
    if (!project) return
    try {
      const res = await searchGraphCode(project, query, { limit: 5, repoPath: idx.repoPath })
      engineBHits.push(...normalizeGraphHits(res, idx.repoName))
    } catch { /* 引擎 B 不可用 → 自动降级仅用 A */ }
  })

  await Promise.all([...engineATasks, ...engineBTasks])

  // ── RRF 融合（单路时退化为直接排序） ──
  const listA = engineAHits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const listB = engineBHits
  const fused = reciprocalRankFusion([
    { source: 'fts-vector', items: listA },
    { source: 'graph', items: listB },
  ])

  const maxScore = Math.max(...fused.map(f => f.score), 1e-9)
  let results = fused.slice(0, 8).map(({ item: h, sources }) => ({
    file: h.file,
    line: h.startLine ?? h.line ?? 1,
    snippet: h.signature
      ? `${h.signature}  // L${h.startLine ?? h.line ?? 1}-${h.endLine ?? ''} · ${h.kind} ${h.name}`
      : `${h.kind} ${h.name}`,
    relevance: Math.max(0, Math.min(1, h.score != null && maxScore > 0 ? (sources.length > 1 ? 1 : 0.5 + 0.5 * ((h.score ?? 0) / (listA[0]?.score ?? 1))) : 0.5)),
    repo: h.repo,
    name: h.name,
    kind: h.kind,
    sources,
  }))
  results = results.slice(0, 5)
  await enrichWithTrace(results)

  // 融合排序后 relevance 按 RRF 分数归一化（双路命中天然靠前）
  const maxRRF = Math.max(...fused.slice(0, 5).map(f => f.score), 1e-9)
  results.forEach((r, i) => {
    r.relevance = Math.max(0, Math.min(1, fused[i].score / maxRRF))
  })

  const enginesUsed = [
    listA.length > 0 ? `A·${backend === 'hybrid' ? 'BM25+向量' : 'BM25'}` : null,
    listB.length > 0 ? 'B·图谱结构' : null,
  ].filter(Boolean)
  const message = enginesUsed.length > 1
    ? `双引擎融合检索（${enginesUsed.join(' + ')}）命中 ${results.length} 条 · ${durationMs}ms`
    : `${enginesUsed[0] || '无引擎可用'} 检索命中 ${results.length} 条 · ${durationMs}ms`
  return {
    results,
    message,
    stats,
    backend,
    engines: enginesUsed,
  }
}

// ─── Tauri-only helpers (index management UI) ──────────────────

/** Whether the real (Rust) code index backs this runtime. */
export function isTauriCodeIndex() {
  return true
}

export async function getCodeIndexStats(repoPath) {
  return tauriInvoke('code_index_stats', { repoPath })
}

export async function rebuildCodeIndex(repoPath) {
  return tauriInvoke('code_index_full', { repoPath })
}

export async function incrementalCodeIndex(repoPath) {
  return tauriInvoke('code_index_incremental', { repoPath })
}

export async function watchCodeIndex(repoPath) {
  return tauriInvoke('code_index_watch', { repoPath })
}

export async function unwatchCodeIndex(repoPath) {
  return tauriInvoke('code_index_unwatch', { repoPath })
}

/** Subscribe to auto-incremental reindex events (`code_index://updated`). */
export function onCodeIndexUpdated(handler) {
  const unlistenPromise = tauriListen('code_index://updated', (event) => handler(event.payload))
  return () => {
    unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
  }
}

/** Subscribe to indexing error events (`code_index://error`, emitted by the commit watcher). */
export function onCodeIndexError(handler) {
  const unlistenPromise = tauriListen('code_index://error', (event) => handler(event.payload))
  return () => {
    unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
  }
}

/**
 * Get index status summary for display
 */
export function getIndexStatus(repoId) {
  const index = getIndex(repoId)
  if (!index) return { status: 'none', label: '未索引', color: 'var(--fg-muted)' }
  switch (index.status) {
    case 'indexing': return { status: 'indexing', label: '索引中', color: 'var(--color-progress)' }
    case 'ready': return { status: 'ready', label: '已索引', color: 'var(--color-success)' }
    case 'error': return { status: 'error', label: '索引失败', color: 'var(--color-error)' }
    default: return { status: 'none', label: '未索引', color: 'var(--fg-muted)' }
  }
}
