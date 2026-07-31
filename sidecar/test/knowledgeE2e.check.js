// E2E smoke: graph.start_delivery with a mock LLM endpoint drives real
// stage execution; the Phase 3 knowledge layer must register deliverables
// (knowledge.stats grows) and make them searchable (knowledge.search).
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
      const userMsg = (body.messages ?? []).map((m) => m.content).join('\n')
      const isReview = userMsg.includes('请评审')
      const text = isReview
        ? '```json\n{"totalScore": 92, "dimensions": {}, "suggestions": [], "passed": true}\n```'
        : `邮箱注册功能交付物：支持验证码校验与密码强度检测（mock 输出）`
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sseBody(text))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ─── sidecar harness (same pattern as graphRpc.check.js) ────────

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

// ─── the smoke ──────────────────────────────────────────────────

test('E2E: mock-LLM delivery run grows knowledge.stats and is searchable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-e2e-'))
  const llm = await startMockLLM()
  const endpoint = `http://127.0.0.1:${llm.address().port}/v1`
  const s = startSidecar({ FLOWFORGE_DATA_DIR: dir, FLOWFORGE_EMBEDDING_FAKE: '1' })
  try {
    await s.next() // sidecar/ready

    // baseline: empty knowledge graph for this project
    s.send({ jsonrpc: '2.0', id: 'st0', method: 'knowledge.stats', params: { projectId: 'e2e_p' } })
    const [base] = await s.until((m) => m.id === 'st0')
    assert.equal(base.result.totalEntities, 0)

    s.send({
      jsonrpc: '2.0',
      id: 'g1',
      method: 'graph.start_delivery',
      params: {
        projectId: 'e2e_p',
        deliveryId: 'e2e_d',
        projectName: 'E2E Demo',
        requirement: '实现邮箱注册功能',
        modelConfig: { endpoint, apiKey: 'mock', modelId: 'mock-model' },
        checkpointDbPath: path.join(dir, 'checkpoints.db'),
      },
    })
    const [resp] = await s.until((m) => m.id === 'g1')
    assert.equal(resp.result.threadId, 'e2e_p_e2e_d')

    // wait until at least the first three chain stages completed
    await s.until((m) => m.method === 'graph/stage_done' && m.params.stage === 'prd', 60000)

    // knowledge layer registered the deliverables — entity count grew
    s.send({ jsonrpc: '2.0', id: 'st1', method: 'knowledge.stats', params: { projectId: 'e2e_p' } })
    const [after] = await s.until((m) => m.id === 'st1')
    assert.ok(after.result.totalEntities >= 3,
      `expected ≥3 entities after req/brd/prd, got ${after.result.totalEntities}`)
    assert.ok(after.result.traceabilityEdges >= 1, 'auto-linking must create traceability edges')
    assert.ok(after.result.chunks >= 3, 'deliverable content must be chunk-indexed')

    // the registered deliverable is searchable via the hybrid search
    s.send({
      jsonrpc: '2.0', id: 'q1', method: 'knowledge.search',
      params: { projectId: 'e2e_p', query: '邮箱注册' },
    })
    const [found] = await s.until((m) => m.id === 'q1')
    assert.ok(found.result.results.length > 0, 'knowledge.search must find the deliverable')
    assert.ok(['vector', 'bm25'].includes(found.result.backend))
  } finally {
    s.stop()
    llm.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
