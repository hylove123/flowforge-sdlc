// node --test checks for the SDLC LangGraph runtime (run via tsx loader).
// Uses a fake LLM client — no network, no real model endpoint.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Command } from '@langchain/langgraph'
import Database from 'better-sqlite3'

import {
  buildSdlcGraph,
  createCheckpointer,
  defaultDag,
  loadDagFromDb,
  threadIdFor,
} from '../src/graph/sdlcGraph.js'
import type { LLMClient, ChatMessage, ChatOptions } from '../src/services/llm.js'

// ─── Fake LLM ───────────────────────────────────────────────────

class FakeLLM implements LLMClient {
  /** Generation calls in execution order (stage ids). */
  generated: string[] = []
  /** Pairs of stages observed running concurrently. */
  overlaps: Array<[string, string]> = []
  /** Scripted review scores per stage (shifted per call); default 90. */
  reviewScores: Record<string, number[]> = {}
  private running = new Set<string>()

  async chatStream(_messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const meta = (options.meta ?? {}) as { stage?: string; kind?: string }
    const stage = meta.stage ?? 'unknown'

    if (meta.kind === 'review') {
      const queue = this.reviewScores[stage]
      const score = queue && queue.length > 0 ? queue.shift()! : 90
      return JSON.stringify({
        totalScore: score,
        dimensions: {},
        suggestions: score >= 75 ? ['ok'] : ['需要补充完整性'],
        passed: score >= 75,
      })
    }

    // Phase 6 reflection turn — answered without touching generation bookkeeping
    if (meta.kind === 'reflect') {
      return JSON.stringify({
        lowScoreAttribution: 'ok',
        modificationAnalysis: 'none',
        strategySuggestion: `keep-${stage}`,
      })
    }

    this.generated.push(stage)
    this.running.add(stage)
    await delay(15) // give parallel branch a chance to overlap
    for (const other of this.running) {
      if (other !== stage) this.overlaps.push([stage, other])
    }
    this.running.delete(stage)
    options.onDelta?.(`[${stage}] `)
    return `# ${stage} deliverable\ncontent for ${stage}`
  }
}

const noopNotify = () => {}

function startInput(projectId: string, deliveryId: string, executionMode = 'builtin') {
  return {
    projectId,
    deliveryId,
    executionMode,
    contextPackage: { projectName: 'Demo 项目', requirement: '构建一个演示功能' },
  }
}

function threadConfig(projectId: string, deliveryId: string) {
  return { configurable: { thread_id: threadIdFor(projectId, deliveryId) } }
}

/** Keeps resuming (null input) until the graph has nothing pending. */
async function resumeUntilDone(app: any, config: any, maxRounds = 10) {
  for (let i = 0; i < maxRounds; i++) {
    const snap = await app.getState(config)
    if (!snap.next || snap.next.length === 0) return snap
    await app.invoke(null, config)
  }
  throw new Error('graph did not settle within maxRounds')
}

// ─── a) + b) default DAG order, parallelism, review gate ────────

test('default DAG runs in order, test ∥ dev-plan in parallel, gated before review', async () => {
  const llm = new FakeLLM()
  const app = buildSdlcGraph(null, { llm, notify: noopNotify }, { checkpointer: createCheckpointer(':memory:') })
  const config = threadConfig('p1', 'd1')

  await app.invoke(startInput('p1', 'd1'), config)

  // interruptBefore: ['review'] — paused with review pending, review not yet run
  let snap = await app.getState(config)
  assert.deepEqual(snap.next, ['review'])
  assert.ok(!('review' in snap.values.deliverables))
  assert.deepEqual(
    llm.generated.slice().sort(),
    ['brd', 'dev', 'dev-plan', 'prd', 'req', 'test'].sort()
  )

  // graph.continue equivalent: resume with null input
  snap = await resumeUntilDone(app, config)
  assert.deepEqual(snap.next, [])
  assert.equal(Object.keys(snap.values.deliverables).length, 9)
  assert.equal(snap.values.currentStage, 'deploy')

  // sequential ordering constraints
  const idx = (s: string) => llm.generated.indexOf(s)
  assert.ok(idx('req') < idx('brd'))
  assert.ok(idx('brd') < idx('prd'))
  assert.ok(idx('prd') < idx('test') && idx('prd') < idx('dev-plan'))
  assert.ok(idx('dev-plan') < idx('dev'))
  assert.ok(idx('dev') < idx('review'))
  assert.ok(idx('review') < idx('auto-test'))
  assert.ok(idx('auto-test') < idx('deploy'))

  // test and dev-plan actually overlapped (same superstep)
  const parallel = llm.overlaps.some(
    ([a, b]) => (a === 'test' && b === 'dev-plan') || (a === 'dev-plan' && b === 'test')
  )
  assert.ok(parallel, `expected test ∥ dev-plan overlap, got ${JSON.stringify(llm.overlaps)}`)
})

// ─── c) review rejection routes back with retryCount ────────────

test('review rejection routes back to dev and increments retryCount (capped)', async () => {
  const llm = new FakeLLM()
  llm.reviewScores = { review: [40, 95] } // first review fails, second passes
  const app = buildSdlcGraph(null, { llm, notify: noopNotify }, { checkpointer: createCheckpointer(':memory:') })
  const config = threadConfig('p1', 'd2')

  await app.invoke(startInput('p1', 'd2'), config)
  const snap = await resumeUntilDone(app, config)

  assert.deepEqual(snap.next, [])
  // dev executed twice: original run + retry after rejection
  assert.equal(llm.generated.filter((s) => s === 'dev').length, 2)
  assert.equal(llm.generated.filter((s) => s === 'review').length, 2)
  assert.equal(snap.values.retryCount, 1)
  // per-stage record keeps the passing score (top-level reviewScore reflects the last stage)
  assert.equal(snap.values.deliverables.review.reviewScore, 95)
  assert.ok('deploy' in snap.values.deliverables)
})

// ─── d) checkpoint persists across a "process restart" ──────────

test('checkpoint survives restart: fresh graph instance resumes from sqlite file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-ckpt-'))
  const dbPath = path.join(dir, 'checkpoints.db')
  const config = threadConfig('p2', 'd1')

  // process #1: run up to the review gate, then "die"
  {
    const llm = new FakeLLM()
    const app = buildSdlcGraph(null, { llm, notify: noopNotify }, { checkpointer: createCheckpointer(dbPath) })
    await app.invoke(startInput('p2', 'd1'), config)
  }

  // process #2: brand-new saver + graph over the same db file
  const llm2 = new FakeLLM()
  const app2 = buildSdlcGraph(null, { llm: llm2, notify: noopNotify }, { checkpointer: createCheckpointer(dbPath) })
  let snap = await app2.getState(config)
  assert.deepEqual(snap.next, ['review'])
  for (const s of ['req', 'brd', 'prd', 'test', 'dev-plan', 'dev']) {
    assert.ok(s in snap.values.deliverables, `missing ${s} after restart`)
  }

  snap = await resumeUntilDone(app2, config)
  assert.deepEqual(snap.next, [])
  assert.equal(snap.values.currentStage, 'deploy')
  // only the remaining stages ran in the second "process"
  assert.deepEqual(llm2.generated.slice().sort(), ['auto-test', 'deploy', 'review'].sort())

  fs.rmSync(dir, { recursive: true, force: true })
})

// ─── manual/delegate mode: interrupt + injected deliverable ─────

test('manual executionMode interrupts each node and accepts injected deliverables', async () => {
  const dag = {
    nodes: [
      { id: 'n1', stageId: 'req', dependsOn: [] },
      { id: 'n2', stageId: 'brd', dependsOn: ['n1'] },
    ],
  }
  const llm = new FakeLLM()
  const app = buildSdlcGraph(dag, { llm, notify: noopNotify }, { checkpointer: createCheckpointer(':memory:') })
  const config = threadConfig('p3', 'd1')

  await app.invoke(startInput('p3', 'd1', 'manual'), config)
  let snap = await app.getState(config)
  assert.deepEqual(snap.next, ['req'])
  const intr = snap.tasks[0].interrupts[0].value as any
  assert.equal(intr.stage, 'req')
  assert.equal(intr.reason, 'awaiting_external_deliverable')

  await app.invoke(new Command({ resume: '人工导入的需求文档' }), config)
  await app.invoke(new Command({ resume: '人工导入的BRD' }), config)

  snap = await app.getState(config)
  assert.deepEqual(snap.next, [])
  assert.equal(snap.values.deliverables.req.content, '人工导入的需求文档')
  assert.equal(snap.values.deliverables.brd.content, '人工导入的BRD')
  assert.equal(llm.generated.length, 0) // no LLM generation in manual mode
})

// ─── loadDagFromDb: direct read + graceful fallback ─────────────

test('loadDagFromDb reads dags table and falls back gracefully', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-dag-'))
  const dbPath = path.join(dir, 'flowforge.db')

  // missing db → null
  assert.equal(loadDagFromDb(path.join(dir, 'nope.db'), 'p1'), null)

  const db = new Database(dbPath)
  db.exec('CREATE TABLE dags (id TEXT, project_id TEXT, nodes_json TEXT, edges_json TEXT)')
  const nodes = defaultDag().nodes
  db.prepare('INSERT INTO dags VALUES (?, ?, ?, ?)').run('dag1', 'p1', JSON.stringify(nodes), null)
  db.close()

  const dag = loadDagFromDb(dbPath, 'p1')
  assert.ok(dag)
  assert.equal(dag!.id, 'dag1')
  assert.equal(dag!.nodes.length, 9)

  // unknown project → null
  assert.equal(loadDagFromDb(dbPath, 'p_other'), null)

  fs.rmSync(dir, { recursive: true, force: true })
})
