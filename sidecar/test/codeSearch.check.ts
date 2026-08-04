// ================================================================
//  codeSearch.check.ts — Phase 5 verification gate (sidecar side)
//
//  Covers (task gate #3):
//    1. repo-hash / db-path parity with the Rust side (FNV-1a64 vector)
//    2. BM25 top-k relevance over a fixture index db (Rust schema)
//    3. hybrid merge: vector hits boost/append, backend flips to hybrid
//    4. vector timeout (>200ms budget) and vector error → BM25 fallback
//    5. registerCodeModules: batch entities + IMPLEMENTS edges
//    6. contextEngine code intelligence: engine B degrades gracefully —
//       unavailable graph engine ⇒ note-marked empty result (no throw);
//       skipped only without repoPath
// ================================================================

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  fnv1a64Hex,
  codeIndexDbPath,
  ftsMatchExpr,
  bm25Search,
  codeSearch,
  readFileModules,
} from '../src/knowledge/codeSearch.js'
import {
  KnowledgeService,
  configureKnowledge,
  resetKnowledge,
} from '../src/knowledge/knowledgeService.js'
import { createFakeEmbedder } from '../src/knowledge/vectorStore.js'
import { buildContextPackage, codeQueryForStage, extractDomainTerms } from '../src/domain/contextEngine.js'
import { getGraphEngine, resetGraphEngine } from '../src/graph/graphEngine.js'

// ─── Fixture index db (schema mirror of commands/code_index.rs) ─

const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, lang TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL, symbol_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  signature TEXT, doc TEXT, complexity INTEGER
);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source_file TEXT NOT NULL,
  source_symbol TEXT, target_name TEXT NOT NULL, target_file TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, signature, path, doc);
`

interface FixtureSymbol {
  file: string
  name: string
  kind: string
  startLine: number
  endLine: number
  signature: string
  doc?: string
}

const FIXTURE_SYMBOLS: FixtureSymbol[] = [
  { file: 'src/user.js', name: 'getUserById', kind: 'function', startLine: 5, endLine: 12, signature: 'export function getUserById(id) {', doc: 'Fetch a user by id' },
  { file: 'src/user.js', name: 'formatUser', kind: 'function', startLine: 14, endLine: 16, signature: 'export const formatUser = (user) => {' },
  { file: 'src/order.ts', name: 'OrderService', kind: 'class', startLine: 3, endLine: 30, signature: 'export class OrderService {' },
  { file: 'src/order.ts', name: 'findOrder', kind: 'method', startLine: 8, endLine: 15, signature: 'async findOrder(id: string) {' },
  { file: 'src/payment.py', name: 'charge_card', kind: 'function', startLine: 10, endLine: 25, signature: 'def charge_card(card, amount):' },
]

let tmpDirs: string[] = []

function makeTmpDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-codesearch-${tag}-`))
  tmpDirs.push(dir)
  return dir
}

/** Builds a fake repo + its index db at the path code.search will resolve. */
function makeFixtureIndex(tag: string): { repoPath: string; dbPath: string } {
  const dataDir = makeTmpDir(`${tag}-data`)
  const repoPath = makeTmpDir(`${tag}-repo`)
  process.env.FLOWFORGE_DATA_DIR = dataDir

  const dbPath = codeIndexDbPath(repoPath)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(INDEX_SCHEMA)
  const files = new Map<string, number>()
  const insSym = db.prepare(
    'INSERT INTO symbols(file, name, kind, start_line, end_line, signature, doc) VALUES (?,?,?,?,?,?,?)'
  )
  const insFts = db.prepare(
    'INSERT INTO symbols_fts(rowid, name, signature, path, doc) VALUES (?,?,?,?,?)'
  )
  for (const s of FIXTURE_SYMBOLS) {
    const info = insSym.run(s.file, s.name, s.kind, s.startLine, s.endLine, s.signature, s.doc ?? '')
    insFts.run(info.lastInsertRowid, s.name, s.signature, s.file, s.doc ?? '')
    files.set(s.file, (files.get(s.file) ?? 0) + 1)
  }
  const insFile = db.prepare('INSERT INTO files(path, lang, mtime_ms, size, symbol_count) VALUES (?,?,?,?,?)')
  for (const [file, count] of files) {
    insFile.run(file, path.extname(file).slice(1), Date.now(), 100, count)
  }
  db.close()
  return { repoPath, dbPath }
}

afterEach(async () => {
  resetKnowledge()
  await resetGraphEngine()
  delete process.env.FLOWFORGE_DATA_DIR
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

// ─── 1. Rust parity ─────────────────────────────────────────────

test('fnv1a64 parity with the Rust repo_hash implementation', () => {
  // vector asserted on the Rust side in code_index.rs repo_hash_is_stable_fnv1a64
  assert.equal(fnv1a64Hex('/tmp/demo-repo'), '546d04c318ac10ae')
})

test('codeIndexDbPath uses FLOWFORGE_DATA_DIR/code_index/{hash}.db', () => {
  const dataDir = makeTmpDir('path-data')
  process.env.FLOWFORGE_DATA_DIR = dataDir
  const p = codeIndexDbPath('/nonexistent/repo')
  assert.equal(path.dirname(p), path.join(dataDir, 'code_index'))
  assert.match(path.basename(p), /^[0-9a-f]{16}\.db$/)
})

// ─── 2. BM25 relevance ──────────────────────────────────────────

test('BM25: exact symbol name ranks first, scores descend', () => {
  const { dbPath } = makeFixtureIndex('bm25')
  const hits = bm25Search(dbPath, 'getUserById', 5)
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].name, 'getUserById')
  assert.equal(hits[0].file, 'src/user.js')
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'scores must be descending')
  }
})

test('BM25: match expression + missing db degrade to empty results', () => {
  assert.equal(ftsMatchExpr('!!'), null)
  assert.deepEqual(bm25Search('/nonexistent/index.db', 'user', 5), [])
})

// ─── 3./4. Hybrid merge + fallback ──────────────────────────────

test('hybrid: vector hits boost matching files and flip backend', async () => {
  const { repoPath } = makeFixtureIndex('hybrid')
  const res = await codeSearch({
    repoPath,
    query: 'order service',
    topK: 5,
    vectorSearch: async () => [{ file: 'src/payment.py', score: 0.9 }, { file: 'src/order.ts', score: 0.5 }],
  })
  assert.equal(res.backend, 'hybrid')
  const payment = res.results.find((r) => r.file === 'src/payment.py')
  assert.ok(payment, 'vector-only file must be appended')
  assert.deepEqual(payment!.matchedIn, ['vector'])
  const order = res.results.find((r) => r.file === 'src/order.ts' && r.name === 'OrderService')
  assert.ok(order, 'bm25 hit expected')
  assert.ok(order!.matchedIn.includes('vector'), 'bm25 hit on the same file gets the vector boost')
})

test('fallback: vector timeout beyond the 200ms budget → pure BM25', async () => {
  const { repoPath } = makeFixtureIndex('timeout')
  const slowVector = () =>
    new Promise<Array<{ file: string; score: number }>>((resolve) =>
      setTimeout(() => resolve([{ file: 'src/payment.py', score: 1 }]), 500)
    )
  const started = Date.now()
  const res = await codeSearch({ repoPath, query: 'getUserById', topK: 5, vectorSearch: slowVector, timeoutMs: 100 })
  assert.ok(Date.now() - started < 400, 'must not wait for the slow vector path')
  assert.equal(res.backend, 'bm25')
  assert.equal(res.results[0].name, 'getUserById')
})

test('fallback: vector error and null vector search → pure BM25', async () => {
  const { repoPath } = makeFixtureIndex('err')
  const failing = async () => {
    throw new Error('embedder down')
  }
  const errRes = await codeSearch({ repoPath, query: 'formatUser', vectorSearch: failing })
  assert.equal(errRes.backend, 'bm25')
  assert.equal(errRes.results[0]?.name, 'formatUser')

  const nullRes = await codeSearch({ repoPath, query: 'formatUser', vectorSearch: null })
  assert.equal(nullRes.backend, 'bm25')
})

// ─── 5. registerCodeModules batch ───────────────────────────────

test('registerCodeModules: batch entities + IMPLEMENTS edges + upsert', async () => {
  const svc = new KnowledgeService({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })
  try {
    // upstream deliverable the modules should IMPLEMENTS-link against
    const { entity: plan } = await svc.registerDeliverable({
      projectId: 'p1', deliveryId: 'd1', stageId: 'dev-plan',
      content: '技术方案：用户模块拆分', type: 'Deliverable',
    })

    const { registered, edges } = await svc.registerCodeModules({
      projectId: 'p1', deliveryId: 'd1',
      modules: [
        { file: 'src/user.js', lang: 'javascript', symbolCount: 2, topSymbols: ['getUserById'] },
        { file: 'src/order.ts', lang: 'typescript', symbolCount: 2, topSymbols: ['OrderService'] },
      ],
    })
    assert.equal(registered, 2)
    assert.equal(edges, 2)

    const mods = svc.graph.getEntities({ projectId: 'p1', type: 'CodeModule' })
    assert.equal(mods.length, 2)
    for (const mod of mods) {
      const rels = svc.graph.getRelations(mod.id)
      assert.ok(
        rels.some((r) => r.relation === 'IMPLEMENTS' && r.targetId === plan.id),
        `${mod.label} must IMPLEMENTS-link to the plan deliverable`
      )
    }

    // re-register is an upsert: no duplicate entities, no duplicate edges
    const second = await svc.registerCodeModules({
      projectId: 'p1', deliveryId: 'd1',
      modules: [{ file: 'src/user.js', symbolCount: 3, topSymbols: ['getUserById', 'formatUser'] }],
    })
    assert.equal(second.registered, 1)
    assert.equal(second.edges, 0, 'existing module must not gain a second edge')
    assert.equal(svc.graph.getEntities({ projectId: 'p1', type: 'CodeModule' }).length, 2)
  } finally {
    svc.close()
  }
})

test('code.register_modules RPC reads file modules from the index db', async () => {
  const { repoPath, dbPath } = makeFixtureIndex('rpc')
  const modules = readFileModules(dbPath)
  assert.equal(modules.length, 3)
  assert.ok(modules.every((m) => m.topSymbols.length > 0))

  configureKnowledge({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })
  const { codeSearchMethods } = await import('../src/knowledge/codeSearch.js')
  const result = (await codeSearchMethods['code.register_modules']({
    repoPath, projectId: 'p9',
  })) as { registered: number; edges: number }
  assert.equal(result.registered, 3)
  assert.equal(result.edges, 0, 'no deliverable in the project → no IMPLEMENTS edges')
})

// ─── 6. contextEngine code intelligence (engine B, graceful degrade) ─

test('buildContextPackage degrades with a note when engine B is unavailable', async () => {
  const { repoPath } = makeFixtureIndex('ctx')
  // force engine B spawn to fail fast: fake binary exits immediately
  getGraphEngine().configure({ command: process.execPath, args: ['-e', 'process.exit(1)'] })
  // harness 原则：上下文缺失不阻断交付 —— resolve 且 note 标注降级原因
  const result = await buildContextPackage({
    projectId: 'p1', deliveryId: 'd1', stageId: 'dev-plan',
    repoPath,
    state: { contextPackage: { projectName: 'Demo', requirement: 'getUserById 改造' }, deliverables: {} },
  })
  assert.ok(result.codeIntel, 'codeIntel section must still be present')
  assert.equal(result.codeIntel!.graphHits.length, 0)
  assert.match(result.codeIntel!.note ?? '', /图谱引擎不可用|无法解析图谱项目名/)
  assert.match(result.markdown ?? '', /代码结构上下文/)
  assert.match(result.markdown ?? '', /说明：/)
})

test('buildContextPackage degrades silently on zero-hit Chinese requirement', async () => {
  const { repoPath } = makeFixtureIndex('ctx-zero')
  // 引擎不可用 + 纯中文需求（提取不出代码符号）⇒ 依然正常交付不 throw
  getGraphEngine().configure({ command: process.execPath, args: ['-e', 'process.exit(1)'] })
  const result = await buildContextPackage({
    projectId: 'p1', deliveryId: 'd1', stageId: 'dev',
    repoPath,
    state: { contextPackage: { projectName: 'Demo', requirement: '入库单条码打印支持' }, deliverables: {} },
  })
  assert.ok(result.markdown, 'package must still be delivered')
  assert.ok(result.codeIntel, 'codeIntel section must still be present')
  assert.equal(result.codeIntel!.graphHits.length, 0)
  assert.match(result.markdown ?? '', /交付背景/)
})

test('buildContextPackage skips code intelligence without repoPath', async () => {
  // no repoPath at all → engine B not involved, no code sections
  const noRepo = await buildContextPackage({
    projectId: 'p1', deliveryId: 'd1', stageId: 'dev',
    state: { contextPackage: { projectName: 'Demo', requirement: 'X' }, deliverables: {} },
  })
  assert.equal(noRepo.code, null)
  assert.equal(noRepo.codeIntel, null)
  assert.ok(!noRepo.markdown!.includes('## 代码结构上下文'))
  assert.ok(!noRepo.markdown!.includes('## 相关代码'))
})

test('codeQueryForStage maps stages to query strategies', () => {
  assert.match(codeQueryForStage('prd', '用户注册'), /^用户注册 /)
  assert.notEqual(codeQueryForStage('dev-plan', 'x'), codeQueryForStage('review', 'x'))
  assert.ok(codeQueryForStage('unknown-stage', '').length > 0)
})

test('extractDomainTerms maps Chinese domain words to code identifiers', () => {
  // 用户真实需求：入库单条码打印支持 → 仓储域英文等价词
  const terms = extractDomainTerms('入库单条码打印支持')
  assert.ok(terms.includes('inbound'), '入库 → inbound')
  assert.ok(terms.includes('barcode'), '条码 → barcode')
  assert.ok(terms.includes('print'), '打印 → print')
  // 去重：入库+收货共享 inbound，只出现一次
  const dedup = extractDomainTerms('入库收货流程')
  assert.equal(dedup.filter((t) => t === 'inbound').length, 1)
  // 无领域词 → 空数组（不注入噪音词）
  assert.deepEqual(extractDomainTerms('优化性能'), [])
})
