// node --test checks for the MCP client manager + tool registry (Phase 4).
// Spawns the local mock stdio MCP server (test/fixtures/mockMcpServer.js) —
// no network, no real MCP service credentials.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClientManager, resetMcpManager, getMcpManager } from '../src/tools/mcpClient.js'
import {
  buildToolset,
  filterTools,
  generateWithTools,
  namespacedToolName,
  toolsMethods,
  MAX_TOOL_ROUNDS,
} from '../src/tools/toolRegistry.js'
import type {
  ChatMessage,
  ChatOptions,
  ChatTurnResult,
  LLMClient,
} from '../src/services/llm.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const mockServerPath = path.join(root, 'fixtures', 'mockMcpServer.js')

const mockServer = (name = 'mock') => ({
  name,
  command: process.execPath,
  args: [mockServerPath],
})

const brokenServer = (name = 'broken') => ({
  name,
  command: process.execPath,
  args: ['-e', 'process.exit(1)'],
})

after(async () => {
  await resetMcpManager()
})

// ─── connection, listTools, callTool ────────────────────────────

test('mcpClient connects a stdio server, lists and calls tools', async () => {
  const manager = new McpClientManager()
  try {
    const tools = await manager.connect(mockServer())
    assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'boom', 'echo'])
    assert.equal(tools[0].server, 'mock')

    const echo = await manager.callTool('mock', 'echo', { text: 'hi' })
    assert.equal(echo.text, 'echo: hi')
    assert.equal(echo.isError, false)

    const sum = await manager.callTool('mock', 'add', { a: 2, b: 40 })
    assert.equal(sum.text, '42')

    // tool-level error is reported, not thrown
    const boom = await manager.callTool('mock', 'boom', {})
    assert.equal(boom.isError, true)
    assert.match(boom.text, /kaboom/)

    assert.equal(manager.status()[0].status, 'connected')
  } finally {
    await manager.disconnectAll()
  }
})

// ─── failure isolation ──────────────────────────────────────────

test('one broken server does not affect the healthy one (failure isolation)', async () => {
  const manager = new McpClientManager()
  try {
    const statuses = await manager.connectAll([mockServer('good'), brokenServer('bad')])
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]))
    assert.equal(byName.good.status, 'connected')
    assert.equal(byName.good.toolCount, 3)
    assert.equal(byName.bad.status, 'error')
    assert.ok(byName.bad.error)

    // healthy server keeps working; broken one reports a useful error
    const res = await manager.callTool('good', 'echo', { text: 'still alive' })
    assert.equal(res.text, 'echo: still alive')
    await assert.rejects(() => manager.callTool('bad', 'echo', {}), /不可用|未连接/)
  } finally {
    await manager.disconnectAll()
  }
})

// ─── toolRegistry: filtering + schema conversion ────────────────

test('buildToolset converts MCP tools to function-calling schemas and filters by agent config', async () => {
  const manager = new McpClientManager()
  try {
    // no filter → all tools, namespaced
    const all = await buildToolset({ servers: [mockServer()], manager })
    assert.ok(all)
    assert.deepEqual(
      all!.tools.map((t) => t.function.name).sort(),
      ['mock__add', 'mock__boom', 'mock__echo']
    )
    const echoDef = all!.tools.find((t) => t.function.name === 'mock__echo')!
    assert.equal((echoDef.function.parameters as any).properties.text.type, 'string')

    // agent-bound filter by bare tool name
    const onlyAdd = await buildToolset({ servers: [mockServer()], allowedTools: ['add'], manager })
    assert.deepEqual(onlyAdd!.tools.map((t) => t.function.name), ['mock__add'])

    // filter by server name selects the whole server
    const byServer = filterTools(
      [
        { name: 'x', server: 'mock' },
        { name: 'y', server: 'other' },
      ],
      ['mock']
    )
    assert.deepEqual(byServer.map((t) => t.name), ['x'])

    // execute routes through MCP; unknown / failing tools degrade to text
    assert.equal(await all!.execute('mock__add', { a: 1, b: 2 }), '3')
    assert.match(await all!.execute('mock__boom', {}), /工具执行报错/)
    assert.match(await all!.execute('nope__nope', {}), /未注册的工具/)

    // all servers broken → null toolset (graph degrades to tool-less generation)
    const none = await buildToolset({ servers: [brokenServer()], manager: new McpClientManager() })
    assert.equal(none, null)
  } finally {
    await manager.disconnectAll()
  }
})

// ─── tool-calling loop with a scripted FakeLLM ──────────────────

class ToolCallingFakeLLM implements LLMClient {
  turns: Array<{ hadTools: boolean; messages: ChatMessage[] }> = []
  /** Scripted responses consumed per chatTools call. */
  script: ChatTurnResult[] = []

  async chatStream(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return 'plain-stream-answer'
  }

  async chatTools(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatTurnResult> {
    this.turns.push({ hadTools: Boolean(options.tools?.length), messages: [...messages] })
    const next = this.script.shift()
    if (!next) return { content: '（脚本耗尽）', toolCalls: [] }
    return next
  }
}

test('generateWithTools: LLM tool_calls → MCP execution → result fed back → final answer', async () => {
  const manager = new McpClientManager()
  try {
    const toolset = await buildToolset({ servers: [mockServer()], manager })
    const llm = new ToolCallingFakeLLM()
    llm.script = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'mock__add', arguments: '{"a":20,"b":22}' } },
        ],
      },
      { content: '计算结果是 42。', toolCalls: [] },
    ]

    const events: any[] = []
    const answer = await generateWithTools(
      llm,
      [{ role: 'user', content: '20+22 等于几？' }],
      toolset,
      {},
      (e) => events.push(e)
    )

    assert.equal(answer, '计算结果是 42。')
    assert.equal(events.length, 1)
    assert.equal(events[0].tool, 'mock__add')
    assert.equal(events[0].result, '42')

    // second turn saw the assistant tool_calls + the tool result message
    const secondTurn = llm.turns[1].messages
    const toolMsg = secondTurn.find((m) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.equal(toolMsg!.content, '42')
    assert.equal(toolMsg!.tool_call_id, 'c1')
  } finally {
    await manager.disconnectAll()
  }
})

test('generateWithTools caps the loop at MAX_TOOL_ROUNDS and withdraws tools on the last round', async () => {
  const manager = new McpClientManager()
  try {
    const toolset = await buildToolset({ servers: [mockServer()], manager })
    const llm = new ToolCallingFakeLLM()
    // model keeps calling tools forever
    llm.script = Array.from({ length: MAX_TOOL_ROUNDS + 2 }, () => ({
      content: '',
      toolCalls: [{ id: 'x', type: 'function' as const, function: { name: 'mock__echo', arguments: '{"text":"again"}' } }],
    }))
    // last (tool-less) round returns a final text
    llm.script[MAX_TOOL_ROUNDS - 1] = { content: '强制收敛的最终答案', toolCalls: [] }

    const answer = await generateWithTools(llm, [{ role: 'user', content: 'loop' }], toolset, {})
    assert.equal(answer, '强制收敛的最终答案')
    assert.equal(llm.turns.length, MAX_TOOL_ROUNDS)
    assert.equal(llm.turns[MAX_TOOL_ROUNDS - 1].hadTools, false, 'final round must withdraw tools')
    for (let i = 0; i < MAX_TOOL_ROUNDS - 1; i++) assert.equal(llm.turns[i].hadTools, true)
  } finally {
    await manager.disconnectAll()
  }
})

test('generateWithTools falls back to chatStream without a toolset or chatTools', async () => {
  const llm = new ToolCallingFakeLLM()
  assert.equal(await generateWithTools(llm, [{ role: 'user', content: 'x' }], null, {}), 'plain-stream-answer')

  const streamOnly: LLMClient = { chatStream: async () => 'stream-only' }
  const fakeToolset = { tools: [{ type: 'function' as const, function: { name: 't' } }], execute: async () => '' }
  assert.equal(await generateWithTools(streamOnly, [{ role: 'user', content: 'x' }], fakeToolset, {}), 'stream-only')
})

// ─── RPC handlers ───────────────────────────────────────────────

test('tools.connect_test / tools.call / tools.list_servers RPC handlers', async () => {
  await resetMcpManager()

  // connect_test: healthy server → ok + tool list, probe connection dropped
  const ok = await toolsMethods['tools.connect_test']({ server: mockServer('probe') })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.tools!.map((t: any) => t.name).sort(), ['add', 'boom', 'echo'])
  assert.equal(getMcpManager().status().find((s) => s.name === 'probe'), undefined)

  // connect_test: broken server → ok:false + error message (no throw)
  const bad = await toolsMethods['tools.connect_test']({ server: brokenServer('probe-bad') })
  assert.equal(bad.ok, false)
  assert.ok(bad.error)

  // tools.call with an inline config connects on demand
  const call = await toolsMethods['tools.call']({ server: mockServer('call1'), tool: 'echo', arguments: { text: 'rpc' } })
  assert.equal(call.text, 'echo: rpc')

  // list_servers reflects the pool + isolates a broken config
  const listed = await toolsMethods['tools.list_servers']({ servers: [mockServer('call1'), brokenServer('bad2')] })
  const status = Object.fromEntries(listed.servers.map((s: any) => [s.name, s.status]))
  assert.equal(status.call1, 'connected')
  assert.equal(status.bad2, 'error')
  assert.ok(listed.tools.some((t: any) => t.server === 'call1' && t.name === 'echo'))

  await resetMcpManager()
})
