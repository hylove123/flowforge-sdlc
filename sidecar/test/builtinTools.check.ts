// node --test checks for the builtin code-intelligence toolset (2.1).
// No MCP processes, no network — pure in-process function routing.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBuiltinToolset, mergeToolsets } from '../src/tools/builtinTools.js'
import type { ToolExecutor } from '../src/tools/toolRegistry.js'

test('buildBuiltinToolset always returns the four builtin tools', () => {
  const set = buildBuiltinToolset({ projectId: 'p1' })
  assert.ok(set, 'builtin toolset must never be null')
  const names = set.tools.map((t) => t.function.name)
  assert.deepEqual(names, [
    'builtin__code_search',
    'builtin__graph_search',
    'builtin__graph_trace',
    'builtin__knowledge_recall',
  ])
  for (const t of set.tools) {
    assert.equal(t.type, 'function')
    assert.ok(t.function.description && t.function.description.length > 0)
  }
})

test('code/graph tools surface a clear error when no repo is bound', async () => {
  const set = buildBuiltinToolset({ projectId: 'p1', repoPath: null })
  for (const name of ['builtin__code_search', 'builtin__graph_search', 'builtin__graph_trace']) {
    const out = await set.execute(name, { query: 'foo', pattern: 'foo', function_name: 'foo' })
    assert.ok(out.includes('未绑定仓库路径'), `${name} should report missing repo, got: ${out}`)
  }
})

test('unknown tool and tool errors come back as text, never throw', async () => {
  const set = buildBuiltinToolset({ projectId: 'p1' })
  const unknown = await set.execute('builtin__nope', {})
  assert.ok(unknown.includes('未注册的内置工具'))
  // knowledge recall with an unconfigured store must not throw
  const recall = await set.execute('builtin__knowledge_recall', { query: 'x' })
  assert.equal(typeof recall, 'string')
})

test('mergeToolsets routes by name and survives null inputs', async () => {
  const builtin = buildBuiltinToolset({ projectId: 'p1' })
  assert.equal(mergeToolsets(null, undefined), null)
  assert.equal(mergeToolsets(builtin, null), builtin)

  const mcp: ToolExecutor = {
    tools: [{ type: 'function', function: { name: 'srv__ping', description: 'ping', parameters: {} } }],
    async execute(name) {
      return name === 'srv__ping' ? 'pong' : '错误：未注册的工具'
    },
  }
  const merged = mergeToolsets(builtin, mcp)!
  assert.equal(merged.tools.length, 5)
  assert.equal(await merged.execute('srv__ping', {}), 'pong')
  const missingRepo = await merged.execute('builtin__code_search', { query: 'q' })
  assert.ok(missingRepo.includes('未绑定仓库路径'))
  assert.ok((await merged.execute('ghost__tool', {})).includes('未注册'))
})
