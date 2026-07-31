// ================================================================
//  CodebaseIndexModules.test.js
//
//  Covers the tauri-mode CodeModule rollup added to codebaseIndex.js:
//    - aggregateTopModules: Java package / top-dir aggregation, top-N cap
//    - registerCodeModuleEntities: graph registration + IMPLEMENTS link
//      + idempotency on re-index
//    - startIndexing (tauri): full pipeline with mocked tauri invoke /
//      plugin-sql, progress callback phases
//    - startIndexing (web): mock path untouched, no graph writes
// ================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks (must precede importing the module under test) ───────

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => invokeMock(...args),
}))

const listenMock = vi.fn(() => Promise.resolve(() => {}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args) => listenMock(...args),
}))

const sidecarInvokeMock = vi.fn(() => Promise.resolve({ registered: 0, edges: 0 }))
vi.mock('@/adapters/SidecarBridge', () => ({
  sidecar: { invoke: (...args) => sidecarInvokeMock(...args) },
}))

const dbSelectMock = vi.fn()
const dbCloseMock = vi.fn(() => Promise.resolve())
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn(() => Promise.resolve({ select: dbSelectMock, close: dbCloseMock })),
  },
}))

vi.mock('@/services/repository', () => ({
  getRepositories: vi.fn(() => [
    { id: 'repo-1', name: 'demo-repo', path: '/tmp/demo-repo' },
  ]),
}))

import {
  aggregateTopModules,
  registerCodeModuleEntities,
  startIndexing,
  getIndex,
} from '@/services/codebaseIndex'
import { getKnowledgeGraph } from '@/services/graph'

// ─── Helpers ────────────────────────────────────────────────────

const PROJECT = 'proj-1'
const REPO = 'repo-1'

function codeModulesOf(projectId = PROJECT) {
  return getKnowledgeGraph().getEntities({ concept: 'CodeModule', projectId })
}

beforeEach(() => {
  localStorage.clear()
  getKnowledgeGraph().clearAll()
  invokeMock.mockReset()
  sidecarInvokeMock.mockClear()
  dbSelectMock.mockReset()
  dbCloseMock.mockClear()
})

afterEach(() => {
  window.__FLOWFORGE_MODE__ = 'web'
  vi.useRealTimers()
})

// ─── aggregateTopModules ────────────────────────────────────────

describe('aggregateTopModules', () => {
  it('aggregates Java files at package level', () => {
    const files = [
      { path: 'src/main/java/com/acme/order/OrderService.java', lang: 'java' },
      { path: 'src/main/java/com/acme/order/OrderRepo.java', lang: 'java' },
      { path: 'src/main/java/com/acme/user/UserService.java', lang: 'java' },
      { path: 'src/test/java/com/acme/order/OrderServiceTest.java', lang: 'java' },
    ]
    const mods = aggregateTopModules(files)
    expect(mods).toHaveLength(2)
    const order = mods.find(m => m.name === 'com.acme.order')
    expect(order).toBeTruthy()
    expect(order.kind).toBe('package')
    expect(order.fileCount).toBe(3) // main + test roll into the same package
    expect(order.languages).toEqual(['java'])
    expect(mods.find(m => m.name === 'com.acme.user').fileCount).toBe(1)
  })

  it('aggregates non-Java files by top-level directory', () => {
    const files = [
      { path: 'src/pages/Login.jsx', lang: 'javascript' },
      { path: 'src/services/ai.js', lang: 'javascript' },
      { path: 'sidecar/src/index.ts', lang: 'typescript' },
      { path: 'README.md', lang: 'markdown' },
    ]
    const mods = aggregateTopModules(files)
    const src = mods.find(m => m.name === 'src')
    expect(src.kind).toBe('directory')
    expect(src.fileCount).toBe(2)
    expect(mods.find(m => m.name === 'sidecar').fileCount).toBe(1)
    expect(mods.find(m => m.name === '(root)').fileCount).toBe(1)
  })

  it('sorts by file count desc and caps at the limit (default 20)', () => {
    const files = []
    for (let d = 0; d < 30; d += 1) {
      for (let f = 0; f <= d % 5; f += 1) {
        files.push({ path: `dir${d}/file${f}.go`, lang: 'go' })
      }
    }
    const mods = aggregateTopModules(files)
    expect(mods).toHaveLength(20)
    for (let i = 1; i < mods.length; i += 1) {
      expect(mods[i - 1].fileCount).toBeGreaterThanOrEqual(mods[i].fileCount)
    }
    const custom = aggregateTopModules(files, { limit: 5 })
    expect(custom).toHaveLength(5)
  })

  it('caps sampleFiles at 5 and tolerates empty input', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `app/f${i}.py`, lang: 'python' }))
    expect(aggregateTopModules(files)[0].sampleFiles).toHaveLength(5)
    expect(aggregateTopModules([])).toEqual([])
    expect(aggregateTopModules(null)).toEqual([])
  })
})

// ─── registerCodeModuleEntities ─────────────────────────────────

describe('registerCodeModuleEntities', () => {
  const modules = [
    { name: 'com.acme.order', kind: 'package', fileCount: 3, languages: ['java'], sampleFiles: ['a.java'] },
    { name: 'src', kind: 'directory', fileCount: 2, languages: ['javascript'], sampleFiles: ['src/a.js'] },
  ]

  it('registers CodeModule entities scoped to the project', () => {
    const result = registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    expect(result.registered).toBe(2)

    const entities = codeModulesOf()
    expect(entities).toHaveLength(2)
    const order = entities.find(e => e.properties.moduleName === 'com.acme.order')
    expect(order.label).toBe('demo-repo/com.acme.order')
    expect(order.stage).toBe('dev')
    expect(order.projectId).toBe(PROJECT)
    expect(order.properties).toMatchObject({
      source: 'code-index',
      repoId: REPO,
      repoName: 'demo-repo',
      kind: 'package',
      fileCount: 3,
      languages: ['java'],
    })
    expect(order.properties.content).toContain('com.acme.order')
  })

  it('links modules IMPLEMENTS → latest dev-plan Deliverable when present', () => {
    const graph = getKnowledgeGraph()
    const plan = graph.addEntity({
      concept: 'Deliverable', projectId: PROJECT, label: '技术方案', stage: 'dev-plan',
      properties: { content: 'plan' },
    })
    const result = registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    expect(result.edges).toBe(2)
    const edges = graph.getEdges({ relation: 'IMPLEMENTS', targetId: plan.id })
    expect(edges).toHaveLength(2)
    // inverse edges created by the graph engine
    expect(graph.getEdges({ relation: 'IMPLEMENTED_BY', sourceId: plan.id })).toHaveLength(2)
  })

  it('is idempotent across repeated indexing of the same repo', () => {
    registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    expect(codeModulesOf()).toHaveLength(2)
  })

  it('does not clobber other repos or manually created CodeModules', () => {
    const graph = getKnowledgeGraph()
    const manual = graph.addEntity({
      concept: 'CodeModule', projectId: PROJECT, label: '手工模块', stage: 'dev', properties: {},
    })
    registerCodeModuleEntities({
      projectId: PROJECT, repoId: 'repo-2', repoName: 'other',
      modules: [{ name: 'lib', kind: 'directory', fileCount: 1, languages: [], sampleFiles: [] }],
    })
    registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })

    const entities = codeModulesOf()
    expect(entities.find(e => e.id === manual.id)).toBeTruthy()
    expect(entities.filter(e => e.properties.repoId === 'repo-2')).toHaveLength(1)
    expect(entities.filter(e => e.properties.repoId === REPO)).toHaveLength(2)
  })
})

// ─── startIndexing (tauri pipeline) ─────────────────────────────

describe('startIndexing — tauri mode', () => {
  function mockTauriIndex() {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'code_index_full') {
        return Promise.resolve({ files: 4, symbols: 40, relations: 12, durationMs: 88 })
      }
      if (cmd === 'code_index_stats') {
        return Promise.resolve({ exists: true, files: 4, languages: ['java', 'javascript'], dbPath: '/tmp/idx.db' })
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`))
    })
    dbSelectMock.mockResolvedValue([
      { path: 'src/main/java/com/acme/order/A.java', lang: 'java' },
      { path: 'src/main/java/com/acme/order/B.java', lang: 'java' },
      { path: 'web/app.js', lang: 'javascript' },
      { path: 'web/util.js', lang: 'javascript' },
    ])
  }

  it('indexes, registers aggregated CodeModules and reports progress', async () => {
    window.__FLOWFORGE_MODE__ = 'tauri'
    mockTauriIndex()

    const phases = []
    const updated = await startIndexing(PROJECT, REPO, 'demo-repo', (p) => phases.push(p.phase))

    expect(updated.status).toBe('ready')
    expect(updated.fileCount).toBe(4)
    expect(updated.modulesRegistered).toBe(2)
    expect(phases).toEqual(['indexing', 'registering_modules', 'done'])

    const entities = codeModulesOf()
    expect(entities).toHaveLength(2)
    expect(entities.map(e => e.properties.moduleName).sort()).toEqual(['com.acme.order', 'web'])
    expect(sidecarInvokeMock).toHaveBeenCalledWith('code.register_modules', { repoPath: '/tmp/demo-repo', projectId: PROJECT })
    expect(dbCloseMock).toHaveBeenCalled()
  })

  it('re-indexing the same repo keeps the graph deduplicated', async () => {
    window.__FLOWFORGE_MODE__ = 'tauri'
    mockTauriIndex()
    await startIndexing(PROJECT, REPO, 'demo-repo')
    await startIndexing(PROJECT, REPO, 'demo-repo')
    expect(codeModulesOf()).toHaveLength(2)
  })

  it('still completes the index when the module rollup fails', async () => {
    window.__FLOWFORGE_MODE__ = 'tauri'
    mockTauriIndex()
    dbSelectMock.mockRejectedValue(new Error('db locked'))

    const updated = await startIndexing(PROJECT, REPO, 'demo-repo')
    expect(updated.status).toBe('ready')
    expect(updated.modulesRegistered).toBe(0)
    expect(codeModulesOf()).toHaveLength(0)
  })

  it('marks the index as error when the tauri command fails', async () => {
    window.__FLOWFORGE_MODE__ = 'tauri'
    invokeMock.mockRejectedValue(new Error('tree-sitter exploded'))

    const updated = await startIndexing(PROJECT, REPO, 'demo-repo')
    expect(updated.status).toBe('error')
    expect(updated.error).toContain('tree-sitter exploded')
  })
})

// ─── startIndexing (web mock unchanged) ─────────────────────────

describe('startIndexing — web mode', () => {
  it('keeps the mock behavior and never touches tauri or the graph', async () => {
    window.__FLOWFORGE_MODE__ = 'web'
    vi.useFakeTimers()

    const promise = startIndexing(PROJECT, REPO, 'demo-repo')
    await vi.advanceTimersByTimeAsync(2000)
    const updated = await promise

    expect(updated.status).toBe('ready')
    expect(updated.language).toEqual(['TypeScript', 'JavaScript', 'JSON', 'CSS'])
    expect(invokeMock).not.toHaveBeenCalled()
    expect(sidecarInvokeMock).not.toHaveBeenCalled()
    expect(codeModulesOf()).toHaveLength(0)
    expect(getIndex(REPO).status).toBe('ready')
  })
})
