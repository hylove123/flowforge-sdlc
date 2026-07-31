/**
 * Codebase Index Service — manages code indexing
 * Builds searchable index of project repositories for knowledge Q&A and delivery flow
 *
 * Dual-mode (Phase 5):
 *   - tauri: real tree-sitter index via Rust commands (code_index_full/stats/query)
 *     plus hybrid retrieval through the sidecar `code.search` RPC
 *   - web:   original mock behavior, unchanged
 * The public function signatures stay identical across modes.
 */

import { storage, detectRuntimeMode } from '@/adapters/StorageService'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { sidecar } from '@/adapters/SidecarBridge'
import { getRepositories } from '@/services/repository'
import { getKnowledgeGraph } from '@/services/graph'

const INDEX_KEY = 'flowforge_codebase_index'

// Index structure:
// {
//   id: string,
//   projectId: string,
//   repoId: string,
//   repoName: string,
//   status: 'none' | 'indexing' | 'ready' | 'error',
//   fileCount: number,
//   language: string[],     // detected languages
//   indexSize: string,      // human-readable
//   lastIndexed: string,    // ISO date
//   error: string | null,
//   chunks: number,         // number of indexed chunks
// }

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

  // tauri mode: hand off to the real tree-sitter index
  if (detectRuntimeMode() === 'tauri') {
    return startIndexingTauri(projectId, repoId, onProgress)
  }

  // Simulate indexing process with progress
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Simulate completion with mock stats
  const mockFileCount = Math.floor(Math.random() * 800) + 200
  const mockChunks = Math.floor(mockFileCount * 1.5)
  const mockLanguages = ['TypeScript', 'JavaScript', 'JSON', 'CSS']
  const mockSize = `${(mockChunks * 0.8).toFixed(1)} MB`

  const updated = updateIndex(repoId, {
    status: 'ready',
    fileCount: mockFileCount,
    language: mockLanguages,
    indexSize: mockSize,
    lastIndexed: new Date().toISOString(),
    chunks: mockChunks,
    error: null,
  })

  return updated
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
      const result = registerCodeModuleEntities({
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
    return updated
  } catch (e) {
    notify('error')
    return updateIndex(repoId, { status: 'error', error: e?.message || String(e) })
  }
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
 * Register aggregated modules as CodeModule entities in the knowledge graph.
 * Idempotent: previous code-index entities of the same project+repo are
 * removed first (deleteEntity also drops their edges), then re-registered.
 * Each entity is linked IMPLEMENTS → the latest dev-plan Deliverable when one
 * exists, so the delivery flow's knowledge recall can reference the modules.
 * @returns {{registered: number, edges: number}}
 */
export function registerCodeModuleEntities({ projectId, repoId, repoName, modules }) {
  const graph = getKnowledgeGraph()

  // idempotency: clear the previous rollup for this project+repo
  const stale = graph
    .getEntities({ concept: 'CodeModule', projectId })
    .filter(e => e.properties?.source === 'code-index' && e.properties?.repoId === repoId)
  stale.forEach(e => graph.deleteEntity(e.id))

  // IMPLEMENTS target: latest dev-plan Deliverable of the project (if any)
  const devPlans = graph.getEntities({ concept: 'Deliverable', projectId, stage: 'dev-plan' })
  const target = devPlans[devPlans.length - 1] || null

  let registered = 0
  let edges = 0
  for (const mod of modules || []) {
    if (!mod?.name) continue
    const kindLabel = mod.kind === 'package' ? 'Java包' : '目录'
    const entity = graph.addEntity({
      concept: 'CodeModule',
      projectId,
      label: `${repoName}/${mod.name}`,
      stage: 'dev',
      properties: {
        source: 'code-index',
        repoId,
        repoName,
        moduleName: mod.name,
        kind: mod.kind,
        fileCount: mod.fileCount,
        languages: mod.languages || [],
        sampleFiles: mod.sampleFiles || [],
        content: `代码模块 ${mod.name}（${kindLabel}，${mod.fileCount} 个文件，语言：${(mod.languages || []).join('/') || '未知'}）\n示例文件：${(mod.sampleFiles || []).join('、')}`,
      },
    })
    registered += 1
    if (target) {
      const edge = graph.addEdge({
        relation: 'IMPLEMENTS',
        sourceId: entity.id,
        targetId: target.id,
        projectId,
      })
      if (edge) edges += 1
    }
  }
  return { registered, edges }
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
  saveIndexes(getIndexes().filter(i => i.repoId !== repoId))
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
 * Search the codebase index.
 * In production, this would call Codebase MCP's search tool.
 */
export async function searchCodebase(projectId, query) {
  const stats = getProjectIndexStats(projectId)
  if (stats.repoCount === 0) {
    return { results: [], message: '项目尚未建立代码索引' }
  }

  // tauri mode: hybrid retrieval (sidecar code.search → BM25 fallback)
  if (detectRuntimeMode() === 'tauri') {
    return searchCodebaseTauri(projectId, query, stats)
  }

  // Simulate search delay
  await new Promise(resolve => setTimeout(resolve, 500))

  // Return mock results
  return {
    results: [
      {
        file: 'src/services/userService.ts',
        line: 42,
        snippet: `export async function getUserById(id: string): Promise<User> {\n  return await db.user.findUnique({ where: { id } });\n}`,
        relevance: 0.95,
        repo: 'main',
      },
      {
        file: 'src/controllers/userController.ts',
        line: 18,
        snippet: `router.get('/users/:id', async (req, res) => {\n  const user = await getUserById(req.params.id);\n  res.json(user);\n});`,
        relevance: 0.82,
        repo: 'main',
      },
    ],
    message: `在 ${stats.totalFiles} 个文件中找到相关结果`,
    stats,
  }
}

/** tauri path of searchCodebase: sidecar hybrid search, Rust BM25 as fallback */
async function searchCodebaseTauri(projectId, query, stats) {
  const indexes = getIndexes(projectId).filter(i => i.status === 'ready' && i.repoPath)
  if (indexes.length === 0) {
    return { results: [], message: '项目尚未建立代码索引（tauri）', stats }
  }
  const all = []
  let backend = 'bm25'
  let durationMs = 0
  for (const idx of indexes) {
    try {
      const res = await sidecar.invoke('code.search', { repoPath: idx.repoPath, query, topK: 5, projectId })
      if (res?.backend === 'hybrid') backend = 'hybrid'
      durationMs += res?.durationMs ?? 0
      for (const hit of res?.results ?? []) all.push({ ...hit, repo: idx.repoName })
    } catch {
      // sidecar unavailable → query the Rust index directly (pure BM25)
      const hits = await tauriInvoke('code_index_query', { repoPath: idx.repoPath, query, topK: 5 })
      for (const hit of hits ?? []) all.push({ ...hit, repo: idx.repoName })
    }
  }
  const maxScore = Math.max(...all.map(h => h.score ?? 0), 1e-9)
  const results = all
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map(h => ({
      file: h.file,
      line: h.startLine ?? 1,
      snippet: h.signature
        ? `${h.signature}  // L${h.startLine}-${h.endLine} · ${h.kind} ${h.name}`
        : `${h.kind} ${h.name}`,
      relevance: Math.max(0, Math.min(1, (h.score ?? 0) / maxScore)),
      repo: h.repo,
      name: h.name,
      kind: h.kind,
    }))
  return {
    results,
    message: `${backend === 'hybrid' ? '混合（BM25+向量）' : 'BM25'} 检索命中 ${results.length} 条 · ${durationMs}ms`,
    stats,
    backend,
  }
}

// ─── Tauri-only helpers (index management UI) ──────────────────

/** Whether the real (Rust) code index backs this runtime. */
export function isTauriCodeIndex() {
  return detectRuntimeMode() === 'tauri'
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
  if (detectRuntimeMode() !== 'tauri') return () => {}
  const unlistenPromise = tauriListen('code_index://updated', (event) => handler(event.payload))
  return () => {
    unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
  }
}

/** Subscribe to indexing error events (`code_index://error`, emitted by the commit watcher). */
export function onCodeIndexError(handler) {
  if (detectRuntimeMode() !== 'tauri') return () => {}
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
