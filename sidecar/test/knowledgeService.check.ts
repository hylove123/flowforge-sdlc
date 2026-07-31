// ================================================================
//  knowledgeService.check.ts — Phase 3 verification gate
//
//  Covers (task gate #2):
//    1. register → recall closed loop, incl. traceability chain
//    2. projectId isolation
//    3. improveFromFeedback write + read-back
//    4. fake-embedder top-k determinism
//    5. stageNode hooks degrade silently (unconfigured + error paths)
// ================================================================

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  KnowledgeService,
  configureKnowledge,
  resetKnowledge,
  isKnowledgeConfigured,
  safeRecall,
  safeRegister,
  safeImprove,
} from '../src/knowledge/knowledgeService.js'
import { createFakeEmbedder } from '../src/knowledge/vectorStore.js'
import { resolveTraceRelation, assertEdge, assertConcept, OntologyError } from '../src/knowledge/seedOntology.js'
import { registerDeliverable as stageRegisterHook, recallKnowledge as stageRecallHook } from '../src/graph/stageNode.js'
import type { SDLCState } from '../src/graph/sdlcGraph.js'
import type { DagNodeDef } from '../src/graph/stageNode.js'

function makeService(): KnowledgeService {
  return new KnowledgeService({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })
}

afterEach(() => {
  resetKnowledge()
})

// ─── 1. register → recall closed loop ───────────────────────────

test('register → recall closed loop with traceability chain', async () => {
  const svc = makeService()
  try {
    await svc.registerDeliverable({
      projectId: 'p1', deliveryId: 'd1', stageId: 'req',
      content: '用户可以通过邮箱注册账号，需支持验证码校验',
    })
    await svc.registerDeliverable({
      projectId: 'p1', deliveryId: 'd1', stageId: 'brd',
      content: 'BRD：注册功能的商业价值与目标用户分析',
      review: { totalScore: 88, suggestions: [], passed: true },
    })

    const recall = await svc.recallStageContext({
      projectId: 'p1', stageId: 'prd', deliveryId: 'd1', query: '注册',
    })

    // upstream deliverables from both req and brd stages, Review rows excluded
    const stages = recall.upstreamDeliverables.map((u) => u.stage).sort()
    assert.deepEqual(stages, ['brd', 'req'])
    const brd = recall.upstreamDeliverables.find((u) => u.stage === 'brd')!
    assert.equal(brd.qualityScore, 88)
    assert.match(recall.upstreamDeliverables.find((u) => u.stage === 'req')!.snippet, /邮箱注册/)

    // vector/BM25 recall surfaces related content
    assert.ok(recall.relatedAssets.length > 0, 'related assets should not be empty')

    // traceability chain: req + brd linked, brd auto-linked to req (DERIVED_FROM)
    const chainByStage = Object.fromEntries(recall.traceChain.map((c) => [c.stage, c]))
    assert.equal(chainByStage.req.linked, true)
    assert.equal(chainByStage.brd.linked, true)
    assert.equal(chainByStage.brd.linkedToPrev, true, 'brd should auto-link to nearest upstream (req)')

    // ontology guards behave as hard constraints
    assert.equal(resolveTraceRelation('Deliverable', 'Deliverable'), 'DERIVED_FROM')
    assert.throws(() => assertConcept('Nonsense'), OntologyError)
    assert.throws(() => assertEdge('IMPLEMENTS', 'Deliverable', 'Deliverable'), OntologyError)
  } finally {
    svc.close()
  }
})

// ─── 2. projectId isolation ─────────────────────────────────────

test('projectId isolation: another project sees nothing', async () => {
  const svc = makeService()
  try {
    await svc.registerDeliverable({
      projectId: 'p1', deliveryId: 'd1', stageId: 'req', content: '仅属于项目一的需求内容',
    })

    const other = await svc.recallStageContext({ projectId: 'p2', stageId: 'prd' })
    assert.equal(other.upstreamDeliverables.length, 0)
    assert.equal(other.relatedAssets.length, 0)
    assert.equal(other.reflections.length, 0)

    const search = await svc.searchGraph({ projectId: 'p2', query: '需求内容' })
    assert.equal(search.results.length, 0)

    assert.equal(svc.getStats({ projectId: 'p2' }).totalEntities, 0)
    assert.ok(svc.getStats({ projectId: 'p1' }).totalEntities > 0)
  } finally {
    svc.close()
  }
})

// ─── 3. improveFromFeedback write + read-back ───────────────────

test('improveFromFeedback stores a reflection recallable at the same stage', async () => {
  const svc = makeService()
  try {
    const entity = await svc.improveFromFeedback({
      projectId: 'p1', stageId: 'prd', deliveryId: 'd1',
      feedback: '缺少异常流程描述，需要补充边界条件',
      diff: '- 无\n+ 增加超时与重试说明',
    })
    assert.equal(entity.type, 'KnowledgeAsset')
    assert.equal(entity.properties.assetType, 'reflection')

    const recall = await svc.recallStageContext({ projectId: 'p1', stageId: 'prd' })
    assert.equal(recall.reflections.length, 1)
    assert.match(recall.reflections[0].feedback, /边界条件/)

    // a different stage must not surface this reflection
    const otherStage = await svc.recallStageContext({ projectId: 'p1', stageId: 'req' })
    assert.equal(otherStage.reflections.length, 0)
  } finally {
    svc.close()
  }
})

// ─── 4. fake embedder top-k determinism ─────────────────────────

test('fake embedder yields deterministic top-k search results', async () => {
  const embed = createFakeEmbedder(64)
  const [v1] = await embed(['注册账号流程'])
  const [v2] = await embed(['注册账号流程'])
  assert.deepEqual(v1, v2, 'identical input must embed identically')

  const svc = makeService()
  try {
    await svc.registerDeliverable({ projectId: 'p1', deliveryId: 'd1', stageId: 'req', content: '用户注册账号与登录流程需求' })
    await svc.registerDeliverable({ projectId: 'p1', deliveryId: 'd1', stageId: 'brd', content: '支付对账模块的商业分析' })
    await svc.registerDeliverable({ projectId: 'p1', deliveryId: 'd1', stageId: 'prd', content: '注册账号 PRD：验证码、邮箱、密码强度' })

    const a = await svc.searchGraph({ projectId: 'p1', query: '注册账号', topK: 3 })
    const b = await svc.searchGraph({ projectId: 'p1', query: '注册账号', topK: 3 })
    assert.deepEqual(a, b, 'same query twice must return identical ranked results')
    assert.ok(a.results.length > 0)
    assert.ok(['vector', 'bm25'].includes(a.backend))
    // registered content about 注册账号 must outrank the unrelated 支付 doc
    assert.notEqual(a.results[0].snippet.includes('支付对账'), true)
  } finally {
    svc.close()
  }
})

// ─── 5. stageNode hooks degrade silently ────────────────────────

test('stageNode hooks are no-ops while the layer is unconfigured', async () => {
  resetKnowledge()
  assert.equal(isKnowledgeConfigured(), false)

  assert.equal(await safeRecall({ projectId: 'p1', stageId: 'req' }), null)
  await safeRegister({ projectId: 'p1', deliveryId: 'd1', stageId: 'req', content: 'x' })
  await safeImprove({ projectId: 'p1', stageId: 'req', feedback: 'y' })

  // the actual stageNode hook functions must also resolve quietly
  const state = {
    projectId: 'p1', deliveryId: 'd1', contextPackage: { requirement: '需求' },
    deliverables: {}, retryCount: 0,
  } as unknown as SDLCState
  const node = { id: 'node_req', stageId: 'req', dependsOn: [] } as DagNodeDef
  assert.equal(await stageRecallHook(state, node), null)
  await stageRegisterHook({
    projectId: 'p1', deliveryId: 'd1', stage: 'req', content: 'c', review: null, source: 'builtin',
  })
})

test('safe hooks catch errors and emit knowledge/error notifications', async () => {
  const events: Array<{ method: string; params: any }> = []
  configureKnowledge({
    dbPath: ':memory:',
    embedder: createFakeEmbedder(),
    notify: (method, params) => events.push({ method, params: params as any }),
  })

  // invalid input → recallStageContext throws inside → swallowed + notified
  const res = await safeRecall({ projectId: '', stageId: '' })
  assert.equal(res, null)
  assert.equal(events.length, 1)
  assert.equal(events[0].method, 'knowledge/error')
  assert.equal(events[0].params.op, 'recall')

  await safeRegister({ projectId: '', deliveryId: '', stageId: '', content: '' })
  assert.equal(events[1].params.op, 'register')

  await safeImprove({ projectId: '', stageId: '', feedback: '' })
  assert.equal(events[2].params.op, 'improve')

  // a valid call after failures still works — the layer stays healthy
  await safeRegister({ projectId: 'p1', deliveryId: 'd1', stageId: 'req', content: '正常注册' })
  assert.equal(events.length, 3)
  const recall = await safeRecall({ projectId: 'p1', stageId: 'brd' })
  assert.ok(recall && recall.upstreamDeliverables.length === 1)
})

// ─── review rejection path (stageNode → safeImprove) ────────────

test('review rejection records a reflection via the stageNode hook', async () => {
  configureKnowledge({ dbPath: ':memory:', embedder: createFakeEmbedder() })

  await stageRegisterHook({
    projectId: 'p1', deliveryId: 'd1', stage: 'prd', content: 'PRD 草稿',
    review: { totalScore: 55, dimensions: {}, suggestions: ['补充验收标准'], passed: false } as any,
    source: 'builtin',
  })

  const recall = await safeRecall({ projectId: 'p1', stageId: 'prd' })
  assert.ok(recall)
  assert.equal(recall!.reflections.length, 1)
  assert.match(recall!.reflections[0].feedback, /验收标准/)
})
