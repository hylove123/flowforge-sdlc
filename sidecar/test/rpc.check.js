// node --test smoke tests for the sidecar JSON-RPC server.
// Spawns the real process (via tsx) and talks to it over stdin/stdout,
// exactly like the Tauri shell does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
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
    next(timeoutMs = 5000) {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
        waiters.push((msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    },
    stop() {
      child.stdin.end()
      child.kill()
    },
  }
}

test('emits sidecar/ready notification on startup', async () => {
  const s = startSidecar()
  try {
    const ready = await s.next()
    assert.equal(ready.method, 'sidecar/ready')
    assert.equal(ready.id, undefined) // notifications carry no id
    assert.ok(ready.params.pid > 0)
  } finally {
    s.stop()
  }
})

test('ping / echo / unknown method / notification round-trip', async () => {
  const s = startSidecar()
  try {
    await s.next() // consume sidecar/ready

    s.send({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
    const pong = await s.next()
    assert.equal(pong.id, 'p1')
    assert.equal(pong.result.ok, true)
    assert.ok(typeof pong.result.ts === 'number')

    s.send({ jsonrpc: '2.0', id: 'e1', method: 'echo', params: { hello: '世界', n: 42 } })
    const echoed = await s.next()
    assert.equal(echoed.id, 'e1')
    assert.deepEqual(echoed.result, { hello: '世界', n: 42 })

    s.send({ jsonrpc: '2.0', id: 'x1', method: 'no.such.method' })
    const missing = await s.next()
    assert.equal(missing.id, 'x1')
    assert.equal(missing.error.code, -32601)

    // notify.test → notification first, then its own response
    s.send({ jsonrpc: '2.0', id: 'n1', method: 'notify.test', params: { tag: 'evt' } })
    const evt = await s.next()
    assert.equal(evt.method, 'sidecar/test-event')
    assert.deepEqual(evt.params, { tag: 'evt' })
    const ack = await s.next()
    assert.equal(ack.id, 'n1')
    assert.deepEqual(ack.result, { ok: true })

    // domain modules are loaded
    s.send({ jsonrpc: '2.0', id: 'd1', method: 'domain.info' })
    const info = await s.next()
    assert.equal(info.result.concepts, 7)
    assert.equal(info.result.relations, 14)
    assert.equal(info.result.rules, 5)
    assert.equal(info.result.stages.length, 9)
  } finally {
    s.stop()
  }
})

test('malformed JSON gets a -32700 parse error', async () => {
  const s = startSidecar()
  try {
    await s.next() // consume sidecar/ready
    s.child.stdin.write('this is not json\n')
    const err = await s.next()
    assert.equal(err.error.code, -32700)
    assert.equal(err.id, null)
  } finally {
    s.stop()
  }
})
