// End-to-end checks for the Test Plan's "断点恢复与门禁审批" items at the
// JSON-RPC boundary (real sidecar process + mock OpenAI-SSE LLM):
//   1) 门禁审批: interruptBefore('review') pauses the run → graph.continue
//      (the host's approval) drives it to graph/completed.
//   2) 断点恢复: kill the sidecar at the gate → a brand-new process reads the
//      checkpoint via graph.get_state and finishes the run via graph.continue.
// Graph-layer equivalents live in sdlcGraph.check.ts; these prove the same
// paths through the real process/RPC surface used by the Tauri shell.

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

// ─── mock OpenAI-compatible SSE endpoint ────────────────────────
// Always answers with a review-shaped JSON payload: generation turns treat
// it as plain deliverable text, review turns parse it as a passing score.
const MOCK_ANSWER = JSON.stringify({ totalScore: 90, dimensions: {}, suggestions: ['ok'], passed: true })
function startMockLLM() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: MOCK_ANSWER } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

// ─── sidecar process harness (same protocol as graphRpc.check.js) ───
function startSidecar() {
  const child = spawn(tsxBin, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
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
    child,
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

// The default 9-stage DAG is used on purpose (no `dag` param): its review
// node installs interruptBefore: ['review'] (the human gate), and the
// sessionless graph.get_state path rebuilds over defaultDag(), so the
// checkpoint written here stays readable after a process restart.
const GATE_STAGES = ['req', 'brd', 'prd', 'test', 'dev-plan', 'dev'] // done before the gate
const ALL_STAGES = [...GATE_STAGES, 'review', 'auto-test', 'deploy']

function startParams(port, checkpointDbPath) {
  return {
    projectId: 'pgate',
    deliveryId: 'dgate',
    projectName: '门禁冒烟',
    requirement: '验证门禁审批与断点恢复',
    modelConfig: { endpoint: `http://127.0.0.1:${port}`, apiKey: 'fake', modelId: 'mock-model' },
    checkpointDbPath,
    reflectionEnabled: false,
  }
}

// ─── 1) 门禁审批: interrupt → approve (graph.continue) → completed ───

test('gate approval: run pauses at review gate, graph.continue completes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-gate-'))
  const { server, port } = await startMockLLM()
  const s = startSidecar()
  try {
    await s.next() // sidecar/ready

    s.send({
      jsonrpc: '2.0', id: 'g1', method: 'graph.start_delivery',
      params: startParams(port, path.join(dir, 'checkpoints.db')),
    })
    const [resp] = await s.until((m) => m.id === 'g1')
    assert.equal(resp.result.threadId, 'pgate_dgate')

    // the human gate fires: req is done, review is pending
    const [intr] = await s.until((m) => m.method === 'graph/interrupted')
    assert.deepEqual(intr.params.next, ['review'])

    s.send({
      jsonrpc: '2.0', id: 'gs1', method: 'graph.get_state',
      params: { threadId: 'pgate_dgate', checkpointDbPath: path.join(dir, 'checkpoints.db') },
    })
    const [state] = await s.until((m) => m.id === 'gs1')
    assert.ok(state.result, `get_state failed: ${JSON.stringify(state.error)}`)
    assert.equal(state.result.status, 'interrupted')
    assert.deepEqual(state.result.completedStages.slice().sort(), GATE_STAGES.slice().sort())
    assert.deepEqual(state.result.next, ['review'])

    // approval: continue with no resume value = "gate passed, proceed"
    s.send({ jsonrpc: '2.0', id: 'c1', method: 'graph.continue', params: { threadId: 'pgate_dgate' } })
    const [contResp] = await s.until((m) => m.id === 'c1')
    assert.equal(contResp.result.status, 'running')

    const [done] = await s.until((m) => m.method === 'graph/completed')
    assert.equal(done.params.threadId, 'pgate_dgate')
    assert.deepEqual(done.params.stages.slice().sort(), ALL_STAGES.slice().sort())
  } finally {
    s.stop()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 2) 断点恢复: kill at the gate → new process resumes to completion ───

test('checkpoint recovery: new sidecar process resumes an interrupted run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-resume-'))
  const checkpointDbPath = path.join(dir, 'checkpoints.db')
  const { server, port } = await startMockLLM()

  // process #1: run to the review gate, then die without continuing
  const s1 = startSidecar()
  try {
    await s1.next() // sidecar/ready
    s1.send({
      jsonrpc: '2.0', id: 'r1', method: 'graph.start_delivery',
      params: startParams(port, checkpointDbPath),
    })
    await s1.until((m) => m.method === 'graph/interrupted')
  } finally {
    s1.stop() // simulated crash/restart
  }

  // process #2: brand-new sidecar over the same checkpoint db
  const s2 = startSidecar()
  try {
    await s2.next() // sidecar/ready

    // sessionless state read proves the checkpoint survived the restart
    s2.send({
      jsonrpc: '2.0', id: 'gs2', method: 'graph.get_state',
      params: { threadId: 'pgate_dgate', checkpointDbPath },
    })
    const [state] = await s2.until((m) => m.id === 'gs2')
    assert.ok(state.result, `get_state failed: ${JSON.stringify(state.error)}`)
    assert.equal(state.result.exists, true)
    assert.deepEqual(state.result.completedStages.slice().sort(), GATE_STAGES.slice().sort())
    assert.deepEqual(state.result.next, ['review'])

    // continue on an unknown session rebuilds it from the rebuild params
    s2.send({
      jsonrpc: '2.0', id: 'c2', method: 'graph.continue',
      params: { threadId: 'pgate_dgate', ...startParams(port, checkpointDbPath) },
    })
    const [contResp] = await s2.until((m) => m.id === 'c2')
    assert.equal(contResp.result.status, 'running')

    const [done] = await s2.until((m) => m.method === 'graph/completed')
    assert.deepEqual(done.params.stages.slice().sort(), ALL_STAGES.slice().sort())
  } finally {
    s2.stop()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 3) 自定义 DAG 断点恢复: get_state 需要匹配的 dag 才能读回 checkpoint ───

test('custom DAG recovery: get_state with dag param reads the checkpoint, continue finishes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-customdag-'))
  const checkpointDbPath = path.join(dir, 'checkpoints.db')
  const { server, port } = await startMockLLM()

  // 2-node DAG: req → review; review installs the interruptBefore gate
  const customDag = {
    nodes: [
      { id: 'node_req', stageId: 'req', dependsOn: [], config: { gate: { aiReview: false } } },
      { id: 'node_review', stageId: 'review', dependsOn: ['node_req'], config: { gate: { aiReview: false } } },
    ],
  }
  const params = { ...startParams(port, checkpointDbPath), projectId: 'pcus', deliveryId: 'dcus', dag: customDag }

  // process #1: run to the gate, then die
  const s1 = startSidecar()
  try {
    await s1.next() // sidecar/ready
    s1.send({ jsonrpc: '2.0', id: 'x1', method: 'graph.start_delivery', params })
    const [intr] = await s1.until((m) => m.method === 'graph/interrupted')
    assert.deepEqual(intr.params.next, ['review'])
  } finally {
    s1.stop() // simulated crash/restart
  }

  // process #2: sessionless get_state must accept the custom dag shape
  const s2 = startSidecar()
  try {
    await s2.next() // sidecar/ready

    s2.send({
      jsonrpc: '2.0', id: 'xs', method: 'graph.get_state',
      params: { threadId: 'pcus_dcus', checkpointDbPath, dag: customDag },
    })
    const [state] = await s2.until((m) => m.id === 'xs')
    assert.ok(state.result, `get_state failed: ${JSON.stringify(state.error)}`)
    assert.equal(state.result.exists, true)
    assert.deepEqual(state.result.completedStages, ['req'])
    assert.deepEqual(state.result.next, ['review'])

    // rebuild + resume over the same custom dag
    s2.send({ jsonrpc: '2.0', id: 'xc', method: 'graph.continue', params: { threadId: 'pcus_dcus', ...params } })
    const [contResp] = await s2.until((m) => m.id === 'xc')
    assert.equal(contResp.result.status, 'running')

    const [done] = await s2.until((m) => m.method === 'graph/completed')
    assert.deepEqual(done.params.stages.slice().sort(), ['req', 'review'])
  } finally {
    s2.stop()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
