// ================================================================
//  CodebaseIndexModules.test.js
//
//  Covers the tauri-mode CodeModule rollup added to codebaseIndex.js:
//    - aggregateTopModules: Java package / top-dir aggregation, top-N cap
//    - registerCodeModuleEntities: delegates module registration to the
//      sidecar knowledge layer (knowledge.register_code_modules)
//    - startIndexing (tauri): full pipeline with mocked tauri invoke /
//      plugin-sql, progress callback phases
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

// sidecar knowledge layer: registration is an upsert by label on the
// sidecar side, so the mock just echoes the module count back
const sidecarInvokeMock = vi.fn((method, params) => {
  if (method === 'knowledge.register_code_modules') {
    return Promise.resolve({ registered: params?.modules?.length ?? 0, edges: 0 })
  }
  return Promise.resolve({ registered: 0, edges: 0 })
})
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
} from '@/services/codebaseIndex'

// ─── Helpers ────────────────────────────────────────────────────

const PROJECT = 'proj-1'
const REPO = 'repo-1'

function registerCodeModulesCalls() {
  return sidecarInvokeMock.mock.calls.filter(([m]) => m === 'knowledge.register_code_modules')
}

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockReset()
  sidecarInvokeMock.mockClear()
  dbSelectMock.mockReset()
  dbCloseMock.mockClear()
})

afterEach(() => {
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

  it('maps modules and delegates to sidecar knowledge.register_code_modules', async () => {
    const result = await registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    expect(result.registered).toBe(2)

    expect(sidecarInvokeMock).toHaveBeenCalledWith('knowledge.register_code_modules', {
      projectId: PROJECT,
      stageId: 'dev',
      modules: [
        { file: 'demo-repo/com.acme.order', lang: 'java', symbolCount: 3, topSymbols: ['a.java'] },
        { file: 'demo-repo/src', lang: 'javascript', symbolCount: 2, topSymbols: ['src/a.js'] },
      ],
    })
  })

  it('skips modules without a name', async () => {
    const result = await registerCodeModuleEntities({
      projectId: PROJECT, repoId: REPO, repoName: 'demo-repo',
      modules: [{ kind: 'directory' }, ...modules],
    })
    expect(result.registered).toBe(2)
    const [, params] = registerCodeModulesCalls().at(-1)
    expect(params.modules.map(m => m.file)).toEqual(['demo-repo/com.acme.order', 'demo-repo/src'])
  })

  it('tolerates the sidecar returning nothing', async () => {
    sidecarInvokeMock.mockResolvedValueOnce(null)
    const result = await registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    expect(result).toEqual({ registered: 0, edges: 0 })
  })

  it('re-indexing calls the sidecar upsert again (idempotency lives in the sidecar)', async () => {
    await registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    await registerCodeModuleEntities({ projectId: PROJECT, repoId: REPO, repoName: 'demo-repo', modules })
    expect(registerCodeModulesCalls()).toHaveLength(2)
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
    mockTauriIndex()

    const phases = []
    const updated = await startIndexing(PROJECT, REPO, 'demo-repo', (p) => phases.push(p.phase))

    expect(updated.status).toBe('ready')
    expect(updated.fileCount).toBe(4)
    expect(updated.modulesRegistered).toBe(2)
    expect(phases).toEqual(['indexing', 'registering_modules', 'done'])

    const [, params] = registerCodeModulesCalls().at(-1)
    expect(params.modules.map(m => m.file).sort()).toEqual(['demo-repo/com.acme.order', 'demo-repo/web'])
    expect(sidecarInvokeMock).toHaveBeenCalledWith('code.register_modules', { repoPath: '/tmp/demo-repo', projectId: PROJECT })
    expect(dbCloseMock).toHaveBeenCalled()
  })

  it('re-indexing the same repo re-invokes the sidecar upsert', async () => {
    mockTauriIndex()
    await startIndexing(PROJECT, REPO, 'demo-repo')
    await startIndexing(PROJECT, REPO, 'demo-repo')
    expect(registerCodeModulesCalls()).toHaveLength(2)
  })

  it('still completes the index when the module rollup fails', async () => {
    mockTauriIndex()
    dbSelectMock.mockRejectedValue(new Error('db locked'))

    const updated = await startIndexing(PROJECT, REPO, 'demo-repo')
    expect(updated.status).toBe('ready')
    expect(updated.modulesRegistered).toBe(0)
    expect(registerCodeModulesCalls()).toHaveLength(0)
  })

  it('marks the index as error when the tauri command fails', async () => {
    invokeMock.mockRejectedValue(new Error('tree-sitter exploded'))

    const updated = await startIndexing(PROJECT, REPO, 'demo-repo')
    expect(updated.status).toBe('error')
    expect(updated.error).toContain('tree-sitter exploded')
  })
})
