// node --test checks for the Phase 6 knowledge flywheel (run via tsx loader).
// In-memory sqlite only — never touches ~/.flowforge.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  EVOLUTION_THRESHOLD,
  computeLineDiff,
  classifyEditPattern,
  configureFlywheel,
  resetFlywheel,
  isFlywheelConfigured,
  recordDiff,
  safeRecordDiff,
  recordRecall,
  getFlywheelStats,
  flywheelMethods,
} from '../src/domain/flywheel.js'
import {
  configureKnowledge,
  resetKnowledge,
  getKnowledgeService,
} from '../src/knowledge/knowledgeService.js'
import { createFakeEmbedder } from '../src/knowledge/vectorStore.js'

afterEach(() => {
  resetFlywheel()
  resetKnowledge()
})

type Captured = Array<{ method: string; params: any }>
function arm(): Captured {
  const events: Captured = []
  configureFlywheel({
    dbPath: ':memory:',
    notify: (method, params) => events.push({ method, params: params as any }),
  })
  return events
}

// ─── line diff + pattern heuristics ─────────────────────────────

test('computeLineDiff reports added/removed lines (multiset semantics)', () => {
  const diff = computeLineDiff('a\nb\nc', 'a\nc\nd\ne')
  assert.deepEqual(diff.removed, ['b'])
  assert.deepEqual(diff.added.sort(), ['d', 'e'])
  assert.match(diff.text, /- b/)
  assert.match(diff.text, /\+ d/)
})

test('classifyEditPattern covers the heuristic families', () => {
  const classify = (original: string, final: string) =>
    classifyEditPattern(computeLineDiff(original, final), original)

  assert.equal(classify('', '# 新交付物'), 'initial_import')
  assert.equal(classify('# 标题\n正文', '# 标题\n正文\n## 新章节\n补充内容'), 'section_added')
  assert.equal(
    classify('系统 使用 用户 口令 完成 登录', '系统 使用 用户 密码 完成 登录'),
    'term_replacement'
  )
  assert.equal(classify('一行', '一行\n扩充一\n扩充二\n扩充三'), 'content_expansion')
  assert.equal(classify('一行\n删一\n删二\n删三', '一行'), 'content_reduction')
  assert.equal(
    classify('旧的第一段描述业务背景\n旧的第二段', '完全重写的第一段\n换了说法的第二段'),
    'paragraph_rewrite'
  )
})

// ─── recordDiff + template evolution trigger ────────────────────

test(`same pattern > ${EVOLUTION_THRESHOLD} times triggers flywheel/template_evolution`, async () => {
  const events = arm()
  configureKnowledge({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })

  const expand = (i: number) => recordDiff({
    projectId: 'p1', deliveryId: `d${i}`, stageId: 'prd',
    original: '一行', final: `一行\n扩充${i}-1\n扩充${i}-2\n扩充${i}-3`,
  })

  for (let i = 1; i <= EVOLUTION_THRESHOLD; i++) {
    const r = await expand(i)
    assert.equal(r.pattern, 'content_expansion')
    assert.equal(r.evolutionTriggered, false, `must not fire at occurrence ${i}`)
  }
  assert.equal(events.filter((e) => e.method === 'flywheel/template_evolution').length, 0)

  // 4th same-pattern diff crosses the threshold
  const fourth = await expand(4)
  assert.equal(fourth.occurrences, 4)
  assert.equal(fourth.evolutionTriggered, true)

  const evo = events.find((e) => e.method === 'flywheel/template_evolution')
  assert.ok(evo, 'template_evolution notification missing')
  assert.equal(evo!.params.stageId, 'prd')
  assert.equal(evo!.params.pattern, 'content_expansion')
  assert.equal(evo!.params.occurrences, 4)
  assert.match(evo!.params.suggestion, /演化/)

  // suggestion also entered the knowledge graph via improveFromFeedback
  const assets = getKnowledgeService().graph.getEntities({ projectId: 'p1', type: 'KnowledgeAsset' })
  assert.equal(assets.filter((a) => a.properties.assetType === 'reflection').length, 1)

  // 5th occurrence: no re-fire until the count doubles
  const fifth = await expand(5)
  assert.equal(fifth.evolutionTriggered, false)
  assert.equal(events.filter((e) => e.method === 'flywheel/template_evolution').length, 1)
})

test('initial_import diffs never trigger template evolution', async () => {
  const events = arm()
  for (let i = 1; i <= EVOLUTION_THRESHOLD + 2; i++) {
    const r = await recordDiff({
      projectId: 'p1', stageId: 'req', original: '', final: `外部导入的交付物 ${i}`,
    })
    assert.equal(r.pattern, 'initial_import')
    assert.equal(r.evolutionTriggered, false)
  }
  assert.equal(events.filter((e) => e.method === 'flywheel/template_evolution').length, 0)
})

// ─── stats aggregation ──────────────────────────────────────────

test('getFlywheelStats aggregates diffs, evolutions, reuse counters and graph size', async () => {
  arm()
  configureKnowledge({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })

  // knowledge side: one deliverable with a review → graph size + quality trend
  await getKnowledgeService().registerDeliverable({
    projectId: 'p1', deliveryId: 'd1', stageId: 'prd', content: 'PRD 正文',
    review: { totalScore: 82, dimensions: {}, suggestions: [], passed: true } as any,
    qualityScore: 82, source: 'builtin',
  })

  // flywheel side: diffs + reuse counters
  for (let i = 1; i <= 4; i++) {
    await recordDiff({
      projectId: 'p1', stageId: 'prd',
      original: '一行', final: `一行\n扩${i}a\n扩${i}b\n扩${i}c`,
    })
  }
  recordRecall('p1', true)
  recordRecall('p1', false)

  const stats = getFlywheelStats({ projectId: 'p1' })
  assert.ok(stats.graph.totalEntities > 0)
  assert.equal(stats.qualityTrend.length, 1)
  assert.equal(stats.qualityTrend[0].stage, 'prd')
  assert.equal(stats.qualityTrend[0].score, 82)
  assert.equal(stats.diffs.total, 4)
  assert.equal(stats.diffs.byPattern.content_expansion, 4)
  assert.equal(stats.evolutions.length, 1)
  assert.equal(stats.reuse.recallCalls, 2)
  assert.equal(stats.reuse.recallHits, 1)
  assert.equal(stats.reuse.registered, 1)
  assert.equal(stats.reuse.reuseRate, 1)
})

test('stats render all-zero friendly when nothing was recorded', () => {
  arm() // knowledge layer stays unconfigured
  const stats = getFlywheelStats({ projectId: 'empty' })
  assert.equal(stats.graph.totalEntities, 0)
  assert.deepEqual(stats.qualityTrend, [])
  assert.deepEqual(stats.evolutions, [])
  assert.equal(stats.diffs.total, 0)
  assert.deepEqual(stats.reuse, { recallCalls: 0, recallHits: 0, registered: 0, reuseRate: 0 })
})

// ─── activation model + RPC handlers ────────────────────────────

test('unconfigured flywheel: safe helpers are no-ops, RPC throws', async () => {
  resetFlywheel()
  assert.equal(isFlywheelConfigured(), false)
  await safeRecordDiff({ projectId: 'p1', stageId: 'req', original: '', final: 'x' }) // must not throw
  recordRecall('p1', true) // must not throw
  assert.throws(() => getFlywheelStats({ projectId: 'p1' }), /not configured/)
})

test('flywheel.record_diff / flywheel.stats RPC handlers round-trip', async () => {
  arm()
  const rec = (await flywheelMethods['flywheel.record_diff']({
    projectId: 'p1', stageId: 'dev', original: '', final: '导入内容',
  })) as { pattern: string }
  assert.equal(rec.pattern, 'initial_import')

  const stats = flywheelMethods['flywheel.stats']({ projectId: 'p1' })
  assert.equal(stats.diffs.total, 1)

  await assert.rejects(() => flywheelMethods['flywheel.record_diff']({ projectId: 'p1' }))
  assert.throws(() => flywheelMethods['flywheel.stats']({}))
})
