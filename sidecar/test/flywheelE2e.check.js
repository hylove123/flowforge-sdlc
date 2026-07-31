// E2E smoke (Phase 6): a mock-LLM stage run must emit `graph/reflection`
// notifications and feed flywheel.stats with quality-trend data; four
// same-pattern flywheel.record_diff calls must fire `flywheel/template_evolution`.
//
// Uses FLOWFORGE_DATA_DIR → temp dir and FLOWFORGE_EMBEDDING_FAKE=1 so the
// run touches neither ~/.flowforge nor any real embedding endpoint.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const tsxBin = path.join(root, '..', 'node_modules', '.bin', 'tsx')
const entry = path.join(root, '..', 'src', 'index.ts')

// ─── mock OpenAI-compatible /chat/completions (SSE) ─────────────

function sseBody(text) {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    'data: [DONE]\n\n'
  )
}

function startMockLLM() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* keep {} */ }
      const allMsg = (body.messages ?? []).map((m) => m.content).join('\n')
      let text
      if (allMsg.includes('请评审')) {
        text = '```json\n{"totalScore": 91, "dimensions": {}, "suggestions": [], "passed": true}\n```'
      } else if (allMsg.includes('结构化反思')) {
        text = '```json\n{"lowScoreAttribution":"得分稳定","modificationAnalysis":"无重试","strategySuggestion":"保持当前模板"}\n```'
      } else {
        text = '邮箱注册功能交付物：支持验证码校验（mock 输出）'
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sseBody(text))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ─── sidecar harness (same pattern as knowledgeE2e.check.js) ────

function startSidecar(env) {
  const child = spawn(tsxBin, [entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })
  const rl = createInterface({ input: child.stdout })
  const queue = []
  const waiters = []
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    const waiter = waiters.shift()
    if (waiter) waiter(msg)
    else queue.push(msg)
  })
  return {
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n') },
    next(timeoutMs = 20000) {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
        waiters.push((msg) => { clearTimeout(timer); resolve(msg) })
      })
    },
    async until(predicate, timeoutMs = 30000) {
      const seen = []
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const msg = await this.next(deadline - Date.now())
        seen.push(msg)
        if (predicate(msg)) return [msg, seen]
      }
      throw new Error(`predicate not matched; saw ${JSON.stringify(seen)}`)
    },
    stop() { child.stdin.end(); child.kill() },
  }
}

// ─── smoke 1: stage run → graph/reflection + quality trend ──────

test('E2E: stage run emits graph/reflection and flywheel.stats carries quality data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-fw-e2e-'))
  const llm = await startMockLLM()
  const endpoint = `http://127.0.0.1:${llm.address().port}/v1`
  const s = startSidecar({ FLOWFORGE_DATA_DIR: dir, FLOWFORGE_EMBEDDING_FAKE: '1' })
  try {
    await s.next() // sidecar/ready

    s.send({
      jsonrpc: '2.0',
      id: 'g1',
      method: 'graph.start_delivery',
      params: {
        projectId: 'fw_p',
        deliveryId: 'fw_d',
        projectName: 'Flywheel E2E',
        requirement: '实现邮箱注册功能',
        modelConfig: { endpoint, apiKey: 'mock', modelId: 'mock-model' },
        checkpointDbPath: path.join(dir, 'checkpoints.db'),
      },
    })
    await s.until((m) => m.id === 'g1')

    // reflection fires right after the first stage completes
    const [refl] = await s.until((m) => m.method === 'graph/reflection', 60000)
    assert.equal(refl.params.projectId, 'fw_p')
    assert.equal(refl.params.structured, true)
    assert.equal(refl.params.strategySuggestion, '保持当前模板')
    assert.ok(refl.params.entry.at, 'entry timestamp missing')

    // let a couple more stages land so reviews exist, then pull the stats
    await s.until((m) => m.method === 'graph/stage_done' && m.params.stage === 'prd', 60000)
    s.send({ jsonrpc: '2.0', id: 'fs1', method: 'flywheel.stats', params: { projectId: 'fw_p' } })
    const [stats] = await s.until((m) => m.id === 'fs1')
    assert.ok(stats.result.graph.totalEntities > 0, 'graph size must be non-zero')
    assert.ok(stats.result.qualityTrend.length >= 1,
      `expected review scores in the quality trend, got ${JSON.stringify(stats.result.qualityTrend)}`)
    assert.ok(stats.result.qualityTrend.every((p) => p.score === 91))
    assert.ok(stats.result.reuse.recallCalls >= 1, 'context-engine recalls must be counted')
  } finally {
    s.stop()
    llm.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── smoke 2: 4× same-pattern record_diff → template evolution ──

test('E2E: four same-pattern record_diff calls fire flywheel/template_evolution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-fw-diff-'))
  const s = startSidecar({ FLOWFORGE_DATA_DIR: dir, FLOWFORGE_EMBEDDING_FAKE: '1' })
  try {
    await s.next() // sidecar/ready

    // the evolution notification is written BEFORE the rd4 response, so it
    // is captured inside that response's `seen` batch
    const batches = []
    for (let i = 1; i <= 4; i++) {
      s.send({
        jsonrpc: '2.0', id: `rd${i}`, method: 'flywheel.record_diff',
        params: {
          projectId: 'fw_p2', deliveryId: `d${i}`, stageId: 'prd',
          original: 'AI 草稿一行',
          final: `AI 草稿一行\n用户补充 ${i}-1\n用户补充 ${i}-2\n用户补充 ${i}-3`,
        },
      })
      const [resp, seen] = await s.until((m) => m.id === `rd${i}`)
      batches.push(...seen)
      assert.equal(resp.result.pattern, 'content_expansion')
      assert.equal(resp.result.evolutionTriggered, i === 4)
    }

    const evo = batches.find((m) => m.method === 'flywheel/template_evolution')
    assert.ok(evo, 'flywheel/template_evolution notification missing')
    assert.equal(evo.params.stageId, 'prd')
    assert.equal(evo.params.occurrences, 4)
    assert.match(evo.params.suggestion, /演化/)

    // the evolution shows up in the stats aggregate
    s.send({ jsonrpc: '2.0', id: 'fs2', method: 'flywheel.stats', params: { projectId: 'fw_p2' } })
    const [stats] = await s.until((m) => m.id === 'fs2')
    assert.equal(stats.result.evolutions.length, 1)
    assert.equal(stats.result.diffs.total, 4)
  } finally {
    s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
