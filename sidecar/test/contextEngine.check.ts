// node --test checks for the context engine (Phase 4).
// Covers: section assembly, upstream ordering, knowledge/reflection
// integration, and the >10KB spill-to-file branch.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildContextPackage,
  collectUpstream,
  contextMethods,
  SPILL_THRESHOLD_BYTES,
} from '../src/domain/contextEngine.js'
import { buildStageContext } from '../src/graph/stageNode.js'
import { configureKnowledge, resetKnowledge, safeImprove } from '../src/knowledge/knowledgeService.js'
import { createFakeEmbedder } from '../src/knowledge/vectorStore.js'
import type { SDLCState } from '../src/graph/sdlcGraph.js'

afterEach(() => {
  resetKnowledge()
})

const baseState = {
  contextPackage: { projectName: 'Demo 项目', requirement: '构建注册功能' },
  deliverables: {
    req: { content: '需求：邮箱注册 + 验证码' },
    brd: { content: 'BRD：注册功能商业分析' },
  },
}

// ─── section assembly ───────────────────────────────────────────

test('buildContextPackage assembles all sections in structured markdown', async () => {
  const result = await buildContextPackage({
    projectId: 'p1',
    deliveryId: 'd1',
    stageId: 'prd',
    state: baseState,
    dependsOn: ['brd'],
  })

  assert.ok(result.markdown)
  assert.equal(result.filePath, undefined, 'small package must stay inline')
  assert.equal(result.size, Buffer.byteLength(result.markdown!, 'utf8'))

  const md = result.markdown!
  // header + the five sections
  assert.match(md, /^# 上下文包 · PRD（prd）/)
  assert.match(md, /## 交付背景/)
  assert.match(md, /- 项目：Demo 项目/)
  assert.match(md, /- 需求：构建注册功能/)
  assert.match(md, /## 上游交付物/)
  assert.match(md, /## 知识库召回/)
  assert.match(md, /## 阶段检查清单/)
  assert.match(md, /## 历史反思/)

  // dependsOn filter: only brd, not req
  assert.match(md, /BRD：注册功能商业分析/)
  assert.ok(!md.includes('邮箱注册 + 验证码'))
  assert.deepEqual(result.upstream.map((u) => u.stage), ['brd'])

  // checklist items come from domain/stages.ts prd guidance
  assert.match(md, /- \[ \] /)

  // knowledge layer unconfigured → recall degraded, sections keep placeholders
  assert.equal(result.knowledge, null)
  assert.match(md, /（知识层未启用或无相关资产）/)
})

test('collectUpstream falls back to every completed stage without dependsOn', () => {
  const all = collectUpstream(baseState)
  assert.deepEqual(all.map((u) => u.stage).sort(), ['brd', 'req'])
  // stage labels resolved from stage definitions
  assert.equal(all.find((u) => u.stage === 'req')!.label, '需求分析')
})

// ─── knowledge recall + reflections integration ─────────────────

test('armed knowledge layer surfaces reflections and recalled assets', async () => {
  configureKnowledge({ dbPath: ':memory:', embedder: createFakeEmbedder(), dim: 64 })
  await safeImprove({ projectId: 'p1', deliveryId: 'd1', stageId: 'prd', feedback: '验收标准要可量化' })

  const result = await buildContextPackage({
    projectId: 'p1',
    deliveryId: 'd1',
    stageId: 'prd',
    state: baseState,
  })
  assert.ok(result.knowledge, 'recall should return once configured')
  assert.match(result.markdown!, /验收标准要可量化/)
})

// ─── >10KB spill branch ─────────────────────────────────────────

test('packages over 10KB spill to a file under <dataDir>/context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-ctx-'))
  try {
    const big = 'x'.repeat(SPILL_THRESHOLD_BYTES + 1024)
    const result = await buildContextPackage({
      projectId: 'p1',
      deliveryId: 'd1',
      stageId: 'dev',
      state: { ...baseState, deliverables: { 'dev-plan': { content: big } } },
      dependsOn: ['dev-plan'],
      dataDir: dir,
    })

    assert.ok(result.size > SPILL_THRESHOLD_BYTES)
    assert.ok(result.filePath, 'expected spill file path')
    assert.ok(result.filePath!.startsWith(path.join(dir, 'context')))
    assert.ok(fs.existsSync(result.filePath!))
    // spilled file carries the exact markdown (in-process callers keep both)
    assert.equal(fs.readFileSync(result.filePath!, 'utf8'), result.markdown)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('context.build_package RPC omits markdown once spilled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-ctx-rpc-'))
  const prevEnv = process.env.FLOWFORGE_DATA_DIR
  process.env.FLOWFORGE_DATA_DIR = dir
  try {
    const small = await contextMethods['context.build_package']({
      projectId: 'p1', deliveryId: 'd1', stageId: 'req', requirement: '小需求',
    })
    assert.ok(small.markdown)
    assert.equal(small.filePath, undefined)

    const large = await contextMethods['context.build_package']({
      projectId: 'p1', deliveryId: 'd1', stageId: 'req',
      requirement: '大需求',
      deliverables: { req: { content: 'y'.repeat(SPILL_THRESHOLD_BYTES + 1024) } },
      dependsOn: ['req'],
    })
    assert.equal(large.markdown, undefined, 'RPC must drop inline markdown after spill')
    assert.ok(large.filePath && fs.existsSync(large.filePath))
    assert.ok(large.size > SPILL_THRESHOLD_BYTES)
  } finally {
    if (prevEnv === undefined) delete process.env.FLOWFORGE_DATA_DIR
    else process.env.FLOWFORGE_DATA_DIR = prevEnv
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── stageNode integration (buildStageContext delegates here) ───

test('buildStageContext keeps its shape while sourcing from the context engine', async () => {
  const state = {
    projectId: 'p1',
    deliveryId: 'd1',
    ...baseState,
  } as unknown as SDLCState

  const ctx = await buildStageContext(state, {
    id: 'n_prd',
    stageId: 'prd',
    dependsOn: ['brd'],
  })

  assert.equal(ctx.stage, 'prd')
  assert.equal(ctx.projectName, 'Demo 项目')
  assert.equal(ctx.requirement, '构建注册功能')
  assert.deepEqual(ctx.upstream.map((u) => u.stage), ['brd'])
  assert.match(ctx.contextBlock, /## 上游交付物/)
  assert.match(ctx.contextBlock, /## 阶段检查清单/)
  assert.equal(ctx.knowledge, null)
})
