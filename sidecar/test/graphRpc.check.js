// node --test smoke tests for the graph.* JSON-RPC methods.
// Spawns the real sidecar process; the mock model config points at an
// unreachable endpoint, so the run must surface graph/error (not crash).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const tsxBin = path.join(root, '..', 'node_modules', '.bin', 'tsx')
const entry = path.join(root, '..', 'src', 'index.ts')

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
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n')
    },
    next(timeoutMs = 15000) {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
        waiters.push((msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    },
    /** Reads messages until predicate matches; returns [matched, all]. */
    async until(predicate, timeoutMs = 20000) {
      const seen = []
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const msg = await this.next(deadline - Date.now())
        seen.push(msg)
        if (predicate(msg)) return [msg, seen]
      }
      throw new Error(`predicate not matched; saw ${JSON.stringify(seen)}`)
    },
    stop() {
      child.stdin.end()
      child.kill()
    },
  }
}

test('graph.start_delivery with unreachable endpoint → graph/error, process stays alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-rpc-'))
  const checkpointDbPath = path.join(dir, 'checkpoints.db')
  const s = startSidecar()
  try {
    await s.next() // sidecar/ready

    s.send({
      jsonrpc: '2.0',
      id: 'g1',
      method: 'graph.start_delivery',
      params: {
        projectId: 'p1',
        deliveryId: 'd9',
        projectName: 'Demo',
        requirement: '冒烟测试',
        modelConfig: { endpoint: 'http://127.0.0.1:1', apiKey: 'fake', modelId: 'fake-model' },
        checkpointDbPath,
      },
    })

    // response comes back immediately with the thread id
    const [resp, pre] = await s.until((m) => m.id === 'g1')
    assert.equal(resp.result.threadId, 'p1_d9')

    // the run starts (stage_start) and then fails cleanly (graph/error)
    const [errNote, all] = await s.until((m) => m.method === 'graph/error')
    assert.equal(errNote.params.threadId, 'p1_d9')
    assert.ok(errNote.params.message.length > 0)
    const started = [...pre, ...all].some(
      (m) => m.method === 'graph/stage_start' && m.params.stage === 'req'
    )
    assert.ok(started, 'expected a graph/stage_start notification for req')

    // process survived the failed run — ping still answers
    s.send({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
    const [pong] = await s.until((m) => m.id === 'p1')
    assert.equal(pong.result.ok, true)

    // get_state reads the checkpoint written before the failure
    s.send({
      jsonrpc: '2.0',
      id: 'gs1',
      method: 'graph.get_state',
      params: { threadId: 'p1_d9', checkpointDbPath },
    })
    const [state] = await s.until((m) => m.id === 'gs1')
    assert.equal(state.result.threadId, 'p1_d9')
    assert.ok(Array.isArray(state.result.completedStages))

    // abort on the dead thread is a graceful no-op result
    s.send({ jsonrpc: '2.0', id: 'a1', method: 'graph.abort', params: { threadId: 'p1_d9' } })
    const [abortResp] = await s.until((m) => m.id === 'a1')
    assert.equal(abortResp.result.ok, true)
  } finally {
    s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('graph.continue on unknown thread returns a JSON-RPC error (no crash)', async () => {
  const s = startSidecar()
  try {
    await s.next() // sidecar/ready
    s.send({ jsonrpc: '2.0', id: 'c1', method: 'graph.continue', params: { threadId: 'nope_x' } })
    const [resp] = await s.until((m) => m.id === 'c1')
    assert.ok(resp.error)
    assert.match(resp.error.message, /Unknown thread/)

    s.send({ jsonrpc: '2.0', id: 'p2', method: 'ping' })
    const [pong] = await s.until((m) => m.id === 'p2')
    assert.equal(pong.result.ok, true)
  } finally {
    s.stop()
  }
})
