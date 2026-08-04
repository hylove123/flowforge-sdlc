// ================================================================
//  graphEngine.check.ts — dual-index engine B verification (t3)
//
//  Validates the codebase-memory-mcp managed-process wrapper:
//    1. all graph_engine.* RPC handlers are exported
//    2. parameter validation rejects malformed requests
//    3. spawn failure surfaces as { available: false, error }
//       (search/index degrade to engine A instead of throwing)
//
//  The real codebase-memory-mcp binary is NOT spawned here — a
//  guaranteed-missing command exercises the failure path.
// ================================================================

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  graphEngineMethods,
  resetGraphEngine,
} from '../src/graph/graphEngine.js'

afterEach(async () => {
  await resetGraphEngine()
})

const EXPECTED_METHODS = [
  'graph_engine.configure',
  'graph_engine.status',
  'graph_engine.index_repo',
  'graph_engine.index_cross_repo',
  'graph_engine.search',
  'graph_engine.trace',
  'graph_engine.cypher',
  'graph_engine.index_status',
  'graph_engine.detect_changes',
  'graph_engine.projects',
  'graph_engine.delete_project',
]

test('all graph_engine.* RPC handlers are registered', () => {
  for (const name of EXPECTED_METHODS) {
    assert.equal(typeof graphEngineMethods[name], 'function', `missing handler ${name}`)
  }
})

test('index_repo requires repoPath', async () => {
  await assert.rejects(
    async () => graphEngineMethods['graph_engine.index_repo']({}),
    /repoPath/
  )
})

test('index_cross_repo requires repoPath', async () => {
  await assert.rejects(
    async () => graphEngineMethods['graph_engine.index_cross_repo']({}),
    /repoPath/
  )
})

test('search requires project and pattern|regex', async () => {
  await assert.rejects(
    async () => graphEngineMethods['graph_engine.search']({ project: 'x' }),
    /pattern/
  )
  await assert.rejects(
    async () => graphEngineMethods['graph_engine.search']({ pattern: 'foo' }),
    /project/
  )
})

test('trace requires project and functionName', async () => {
  await assert.rejects(
    async () => graphEngineMethods['graph_engine.trace']({ project: 'x' }),
    /functionName/
  )
})

test('cypher requires project and query', async () => {
  await assert.rejects(
    async () => graphEngineMethods['graph_engine.cypher']({ project: 'x' }),
    /query/
  )
})

test('spawn failure degrades to { available: false } instead of throwing', async () => {
  // point the engine at a binary that cannot exist
  await graphEngineMethods['graph_engine.configure']({
    config: { command: 'flowforge-graph-engine-binary-does-not-exist' },
  })
  const status = await graphEngineMethods['graph_engine.status']({})
  assert.equal(status.available, false)
  assert.ok(status.error, 'error message should explain the failure')
  assert.equal(status.config.command, 'flowforge-graph-engine-binary-does-not-exist')
})
