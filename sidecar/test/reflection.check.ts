// node --test checks for the Phase 6 reflection step (run via tsx loader).
// FakeLLM only — no network, no real model endpoint.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseReflection,
  reflectionFeedbackText,
  runReflection,
  type ReflectionEntry,
} from '../src/graph/reflection.js'
import { buildSdlcGraph, createCheckpointer, threadIdFor } from '../src/graph/sdlcGraph.js'
import {
  configureKnowledge,
  resetKnowledge,
  getKnowledgeService,
} from '../src/knowledge/knowledgeService.js'
import { createFakeEmbedder } from '../src/knowledge/vectorStore.js'
import type { LLMClient, ChatMessage, ChatOptions } from '../src/services/llm.js'

afterEach(() => {
  resetKnowledge()
})

// ─── Fake LLM ───────────────────────────────────────────────────

/** Scriptable fake: per-kind responses, records every call's meta. */
class FakeLLM implements LLMClient {
  calls: Array<{ stage: string; kind: string }> = []
  reflectAnswer: string | (() => string) = JSON.stringify({
    lowScoreAttribution: '验收标准缺失导致扣分',
    modificationAnalysis: '两次重试均补充了边界条件',
    strategySuggestion: '生成时先列验收标准清单',
  })

  async chatStream(_messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const meta = (options.meta ?? {}) as { stage?: string; kind?: string }
    const stage = meta.stage ?? 'unknown'
    const kind = meta.kind ?? 'generate'
    this.calls.push({ stage, kind })

    if (kind === 'review') {
      return JSON.stringify({ totalScore: 88, dimensions: {}, suggestions: ['ok'], passed: true })
    }
    if (kind === 'reflect') {
      return typeof this.reflectAnswer === 'function' ? this.reflectAnswer() : this.reflectAnswer
    }
    return `# ${stage} deliverable`
  }
}

class ThrowingLLM implements LLMClient {
  async chatStream(): Promise<string> {
    throw new Error('model endpoint unreachable')
  }
}

type Captured = Array<{ method: string; params: any }>
const capture = (events: Captured) => (method: string, params?: unknown) =>
  events.push({ method, params: params as any })

// ─── parseReflection: structured + degrade paths ────────────────

test('parseReflection extracts structured JSON (plain and fenced)', () => {
  const plain = parseReflection('{"lowScoreAttribution":"a","modificationAnalysis":"b","strategySuggestion":"c"}')
  assert.equal(plain.structured, true)
  assert.equal(plain.lowScoreAttribution, 'a')
  assert.equal(plain.strategySuggestion, 'c')
  assert.equal(plain.raw, null)

  const fenced = parseReflection('前置说明\n```json\n{"strategySuggestion":"用检查清单"}\n```')
  assert.equal(fenced.structured, true)
  assert.equal(fenced.strategySuggestion, '用检查清单')
})

test('parseReflection degrades to plain text on invalid / empty JSON', () => {
  const bad = parseReflection('模型输出了非 JSON 的自由文本反思')
  assert.equal(bad.structured, false)
  assert.equal(bad.raw, '模型输出了非 JSON 的自由文本反思')

  // valid JSON but none of the expected fields → unusable → degrade
  const empty = parseReflection('{"foo": 1}')
  assert.equal(empty.structured, false)
  assert.equal(empty.raw, '{"foo": 1}')
})

test('reflectionFeedbackText renders structured fields or the raw fallback', () => {
  const structured: ReflectionEntry = {
    stage: 'prd', at: 't', structured: true,
    lowScoreAttribution: 'A', modificationAnalysis: null, strategySuggestion: 'S',
    raw: null, reviewScore: 80, retryCount: 0,
  }
  assert.equal(reflectionFeedbackText(structured), '归因：A\n策略建议：S')

  const fallback: ReflectionEntry = { ...structured, structured: false, raw: '自由文本' }
  assert.equal(reflectionFeedbackText(fallback), '自由文本')
})

// ─── runReflection: improveFromFeedback + notification ──────────

test('runReflection writes a reflection asset and emits graph/reflection', async () => {
  configureKnowledge({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })
  const events: Captured = []
  const llm = new FakeLLM()

  const entry = await runReflection(llm, capture(events), {
    projectId: 'p1', deliveryId: 'd1', stage: 'prd',
    deliverable: 'PRD 内容', reviewScore: 62, reviewFeedback: '验收标准不可量化', retryCount: 1,
  })

  assert.ok(entry)
  assert.equal(entry!.structured, true)
  assert.equal(entry!.strategySuggestion, '生成时先列验收标准清单')
  assert.equal(entry!.reviewScore, 62)

  // notification carried the essentials
  const notif = events.find((e) => e.method === 'graph/reflection')
  assert.ok(notif, 'graph/reflection notification missing')
  assert.equal(notif!.params.stage, 'prd')
  assert.equal(notif!.params.structured, true)
  assert.equal(notif!.params.strategySuggestion, '生成时先列验收标准清单')

  // improveFromFeedback landed in the knowledge graph as a reflection asset
  const assets = getKnowledgeService().graph.getEntities({ projectId: 'p1', type: 'KnowledgeAsset' })
  const reflections = assets.filter((a) => a.properties.assetType === 'reflection')
  assert.equal(reflections.length, 1)
  assert.match(String(reflections[0].properties.feedback), /策略建议：生成时先列验收标准清单/)
})

test('runReflection parse failure degrades to a plain-text entry (still notified)', async () => {
  const events: Captured = []
  const llm = new FakeLLM()
  llm.reflectAnswer = '完全不是 JSON 的反思输出'

  const entry = await runReflection(llm, capture(events), {
    projectId: 'p1', deliveryId: 'd1', stage: 'dev',
    deliverable: 'code', reviewScore: null, reviewFeedback: null, retryCount: 0,
  })

  assert.ok(entry)
  assert.equal(entry!.structured, false)
  assert.equal(entry!.raw, '完全不是 JSON 的反思输出')
  const notif = events.find((e) => e.method === 'graph/reflection')
  assert.ok(notif)
  assert.equal(notif!.params.structured, false)
})

test('runReflection returns null when the LLM is unreachable (silent skip)', async () => {
  const events: Captured = []
  const entry = await runReflection(new ThrowingLLM(), capture(events), {
    projectId: 'p1', deliveryId: 'd1', stage: 'req',
    deliverable: 'x', reviewScore: null, reviewFeedback: null, retryCount: 0,
  })
  assert.equal(entry, null)
  assert.equal(events.filter((e) => e.method === 'graph/reflection').length, 0)
})

// ─── Graph integration: reflectionLog + reflectionEnabled flag ──

const SMALL_DAG = {
  nodes: [
    { id: 'n1', stageId: 'req', dependsOn: [] },
    { id: 'n2', stageId: 'brd', dependsOn: ['n1'] },
  ],
}

function startInput(projectId: string, deliveryId: string) {
  return {
    projectId,
    deliveryId,
    executionMode: 'builtin',
    contextPackage: { projectName: 'Demo 项目', requirement: '构建一个演示功能' },
  }
}

test('stage nodes append reflections to state.reflectionLog (default on)', async () => {
  const events: Captured = []
  const llm = new FakeLLM()
  const app = buildSdlcGraph(SMALL_DAG, { llm, notify: capture(events) }, {
    checkpointer: createCheckpointer(':memory:'),
  })
  const config = { configurable: { thread_id: threadIdFor('pr', 'dr1') } }

  await app.invoke(startInput('pr', 'dr1'), config)
  const snap = await app.getState(config)

  assert.deepEqual(snap.next, [])
  const log = snap.values.reflectionLog as ReflectionEntry[]
  assert.equal(log.length, 2, `expected one reflection per stage, got ${JSON.stringify(log)}`)
  assert.deepEqual(log.map((r) => r.stage).sort(), ['brd', 'req'])
  assert.ok(log.every((r) => r.structured))

  assert.equal(events.filter((e) => e.method === 'graph/reflection').length, 2)
  assert.equal(llm.calls.filter((c) => c.kind === 'reflect').length, 2)
})

test('reflectionEnabled: false skips step 5 entirely', async () => {
  const events: Captured = []
  const llm = new FakeLLM()
  const app = buildSdlcGraph(SMALL_DAG, {
    llm, notify: capture(events), reflectionEnabled: false,
  }, { checkpointer: createCheckpointer(':memory:') })
  const config = { configurable: { thread_id: threadIdFor('pr', 'dr2') } }

  await app.invoke(startInput('pr', 'dr2'), config)
  const snap = await app.getState(config)

  assert.deepEqual(snap.next, [])
  assert.equal((snap.values.reflectionLog as unknown[]).length, 0)
  assert.equal(llm.calls.filter((c) => c.kind === 'reflect').length, 0)
  assert.equal(events.filter((e) => e.method === 'graph/reflection').length, 0)
})
