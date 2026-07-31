// ================================================================
//  llmResilience.check.ts — timeout + retry hardening for the
//  OpenAI-compatible client (task #16 verification gate)
//
//  Covers:
//    1. request timeout aborts the attempt and triggers a retry
//    2. HTTP 5xx retried with exponential backoff, then succeeds
//    3. HTTP 4xx (incl. 401/429) never retried
//    4. retries exhausted → structured LLMError (category/status/message)
//    5. network failures (fetch rejection) classified + retried
//    6. external AbortSignal passes through untouched (no retry)
//    7. modelConfig.timeoutMs overrides constructor resilience options
// ================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OpenAICompatibleClient,
  LLMError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  type FetchLike,
  type ModelConfig,
  type ChatMessage,
} from '../src/services/llm.js'

// ─── Fixtures ───────────────────────────────────────────────────

const CONFIG: ModelConfig = {
  endpoint: 'http://127.0.0.1:1/v1', // unreachable placeholder — never dialed (fetch is mocked)
  apiKey: 'test-key',
  modelId: 'test-model',
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'ping' }]

/** Fast resilience settings so retry tests finish in milliseconds. */
const FAST = { timeoutMs: 60, maxRetries: 2, retryBaseDelayMs: 1 }

/** Builds a 200 SSE Response streaming the given content deltas then [DONE]. */
function sseResponse(deltas: string[]): Response {
  const enc = new TextEncoder()
  const frames = [
    ...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`),
    'data: [DONE]\n\n',
  ]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** A fetch that never resolves but honors its AbortSignal (simulates a stalled server). */
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      { once: true }
    )
  })
}

/** Scripted fetch: pops one behavior per call and counts invocations. */
function scriptedFetch(script: Array<(init?: RequestInit) => Promise<Response>>) {
  const calls = { count: 0 }
  const impl: FetchLike = (_url, init) => {
    const step = script[Math.min(calls.count, script.length - 1)]
    calls.count += 1
    return step(init as RequestInit | undefined)
  }
  return { impl, calls }
}

// ─── 1. timeout triggers retry, then succeeds ───────────────────

test('timeout aborts the attempt and the retry succeeds', async () => {
  const { impl, calls } = scriptedFetch([
    (init) => hangUntilAborted(init),
    async () => sseResponse(['pong']),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const deltas: string[] = []
  const out = await client.chatStream(MESSAGES, { onDelta: (d) => deltas.push(d) })

  assert.equal(out, 'pong')
  assert.deepEqual(deltas, ['pong'])
  assert.equal(calls.count, 2, 'first attempt timed out, second succeeded')
})

// ─── 2. 5xx retried then succeeds ───────────────────────────────

test('HTTP 5xx is retried and eventually succeeds', async () => {
  const { impl, calls } = scriptedFetch([
    async () => new Response('{"error":{"message":"upstream boom"}}', { status: 502 }),
    async () => new Response('bad gateway', { status: 503 }),
    async () => sseResponse(['re', 'covered']),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const out = await client.chatStream(MESSAGES)
  assert.equal(out, 'recovered')
  assert.equal(calls.count, 3, 'two 5xx failures then success')
})

// ─── 3. 4xx never retried (incl. 401 and 429) ───────────────────

test('HTTP 401 is not retried and surfaces http_4xx', async () => {
  const { impl, calls } = scriptedFetch([
    async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const err = await client.chatStream(MESSAGES).then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(err instanceof LLMError)
  assert.equal(err.category, 'http_4xx')
  assert.equal(err.status, 401)
  assert.equal(err.retryable, false)
  assert.equal(err.message, 'invalid api key')
  assert.equal(calls.count, 1, '4xx must not be retried')
})

test('HTTP 429 (rate limit) follows the 4xx no-retry policy', async () => {
  const { impl, calls } = scriptedFetch([
    async () => new Response('rate limited', { status: 429 }),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const err = await client.chatStream(MESSAGES).then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(err instanceof LLMError)
  assert.equal(err.category, 'http_4xx')
  assert.equal(err.status, 429)
  assert.equal(calls.count, 1)
})

// ─── 4. retries exhausted → structured error ────────────────────

test('persistent 5xx exhausts retries and throws a structured LLMError', async () => {
  const { impl, calls } = scriptedFetch([
    async () => new Response('down', { status: 503 }),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const err = await client.chatStream(MESSAGES).then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(err instanceof LLMError)
  assert.equal(err.category, 'http_5xx')
  assert.equal(err.status, 503)
  assert.equal(err.retryable, true)
  assert.equal(calls.count, FAST.maxRetries + 1, 'initial attempt + 2 retries')

  // Toast-ready JSON shape
  const json = err.toJSON()
  assert.equal(json.name, 'LLMError')
  assert.equal(json.category, 'http_5xx')
  assert.equal(json.status, 503)
  assert.equal(typeof json.message, 'string')
  assert.ok(json.message.length > 0)
})

test('persistent timeout exhausts retries with category=timeout', async () => {
  const { impl, calls } = scriptedFetch([(init) => hangUntilAborted(init)])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const err = await client.chatStream(MESSAGES).then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(err instanceof LLMError)
  assert.equal(err.category, 'timeout')
  assert.equal(err.status, undefined)
  assert.match(err.message, /超时/)
  assert.equal(calls.count, FAST.maxRetries + 1)
})

// ─── 5. network failures classified + retried ───────────────────

test('fetch rejection (ECONNRESET-style) is retried then classified as network', async () => {
  const { impl, calls } = scriptedFetch([
    async () => { throw new TypeError('fetch failed: ECONNRESET') },
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const err = await client.chatStream(MESSAGES).then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(err instanceof LLMError)
  assert.equal(err.category, 'network')
  assert.match(err.message, /ECONNRESET/)
  assert.equal(calls.count, FAST.maxRetries + 1)
})

test('network failure recovers on retry', async () => {
  const { impl, calls } = scriptedFetch([
    async () => { throw new TypeError('fetch failed') },
    async () => sseResponse(['ok']),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  assert.equal(await client.chatStream(MESSAGES), 'ok')
  assert.equal(calls.count, 2)
})

// ─── 6. external abort passes through, no retry ─────────────────

test('external AbortSignal cancels without retry and without LLMError wrapping', async () => {
  const { impl, calls } = scriptedFetch([(init) => hangUntilAborted(init)])
  // generous timeout so only the external abort can fire
  const client = new OpenAICompatibleClient(CONFIG, impl, { ...FAST, timeoutMs: 60_000 })

  const ctl = new AbortController()
  const pending = client.chatStream(MESSAGES, { signal: ctl.signal })
  setTimeout(() => ctl.abort(), 10)

  const err = await pending.then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(!(err instanceof LLMError), 'user cancel keeps original abort semantics')
  assert.equal(calls.count, 1, 'cancellation must not trigger retries')
})

// ─── 7. config precedence + defaults ────────────────────────────

test('modelConfig.timeoutMs overrides constructor resilience timeout', async () => {
  const { impl } = scriptedFetch([(init) => hangUntilAborted(init)])
  const client = new OpenAICompatibleClient(
    { ...CONFIG, timeoutMs: 40 },
    impl,
    { timeoutMs: 60_000, maxRetries: 0 }
  )

  const started = Date.now()
  const err = await client.chatStream(MESSAGES).then(
    () => assert.fail('expected rejection'),
    (e) => e
  )
  assert.ok(err instanceof LLMError)
  assert.equal(err.category, 'timeout')
  assert.ok(Date.now() - started < 5_000, 'config timeout (40ms) applied, not 60s')
})

test('defaults: 120s timeout, 2 retries; invalid values rejected', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000)
  assert.equal(DEFAULT_MAX_RETRIES, 2)
  const noop: FetchLike = async () => new Response(null)
  assert.throws(() => new OpenAICompatibleClient({ ...CONFIG, timeoutMs: -1 }, noop))
  assert.throws(() => new OpenAICompatibleClient(CONFIG, noop, { maxRetries: -1 }))
})

// ─── chatTools path shares the same resilience pipeline ─────────

test('chatTools retries a 5xx then returns the tool turn', async () => {
  const enc = new TextEncoder()
  const toolFrame = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":1}' } }] } }],
  })}

data: [DONE]

`
  const toolResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(toolFrame)); c.close() },
      }),
      { status: 200 }
    )
  const { impl, calls } = scriptedFetch([
    async () => new Response('oops', { status: 500 }),
    async () => toolResponse(),
  ])
  const client = new OpenAICompatibleClient(CONFIG, impl, FAST)

  const turn = await client.chatTools(MESSAGES, {
    tools: [{ type: 'function', function: { name: 'search' } }],
  })
  assert.equal(turn.toolCalls.length, 1)
  assert.equal(turn.toolCalls[0].function.name, 'search')
  assert.equal(calls.count, 2)
})
