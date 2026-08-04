// ================================================================
//  llmConnect.check.ts — llm.connect_test RPC verification (t4)
//
//  Validates the sidecar-side model connectivity probe that replaced
//  the renderer-process fetch (CORS preflight was the root cause of
//  the old "网络错误" reports):
//    1. handler registered on the JSON-RPC surface
//    2. config validation short-circuits without network I/O
//    3. OK / 4xx / network failure classification via mock fetch
// ================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { llmMethods, testModelConnection } from '../src/services/llm.js'

const CFG = { endpoint: 'https://example.com/v1/', apiKey: 'sk-test', modelId: 'm1' }

function mockFetch(status: number, body = '{}') {
  return (async (url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    url,
  })) as unknown as typeof fetch
}

test('llm.connect_test handler is registered', () => {
  assert.equal(typeof llmMethods['llm.connect_test'], 'function')
})

test('missing config short-circuits with category=config (no network I/O)', async () => {
  const noKey = await testModelConnection({ endpoint: 'https://x', apiKey: '', modelId: 'm' })
  assert.equal(noKey.category, 'config')
  const noEndpoint = await testModelConnection({ endpoint: '', apiKey: 'k', modelId: 'm' })
  assert.equal(noEndpoint.category, 'config')
  const noModel = await testModelConnection({ endpoint: 'https://x', apiKey: 'k', modelId: '' })
  assert.equal(noModel.category, 'config')
})

test('HTTP 200 → success + trailing slash normalized (no double slash)', async () => {
  let calledUrl = ''
  const fetchImpl = (async (url: string) => {
    calledUrl = url
    return { ok: true, status: 200, text: async () => '{}' }
  }) as unknown as typeof fetch
  const res = await testModelConnection(CFG, fetchImpl)
  assert.equal(res.success, true)
  assert.equal(res.category, 'ok')
  assert.equal(calledUrl, 'https://example.com/v1/chat/completions')
})

test('HTTP 401 → http_4xx with token hint', async () => {
  const res = await testModelConnection(
    CFG,
    mockFetch(401, JSON.stringify({ error: { message: 'invalid api key' } }))
  )
  assert.equal(res.success, false)
  assert.equal(res.category, 'http_4xx')
  assert.equal(res.status, 401)
  assert.ok(res.message.includes('Token'))
})

test('fetch rejection → network category with diagnostics', async () => {
  const failing = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch
  const res = await testModelConnection(CFG, failing)
  assert.equal(res.success, false)
  assert.equal(res.category, 'network')
  assert.ok(res.message.includes('ENOTFOUND'))
})

test('RPC surface passes params through and tolerates empty payload', async () => {
  const res = await llmMethods['llm.connect_test']({})
  assert.equal(res.success, false)
  assert.equal(res.category, 'config')
})
