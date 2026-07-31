// End-to-end CLI smoke for Phase 4 (gate 3):
//   real sidecar process + mock stdio MCP server + mock OpenAI-SSE LLM.
// Proves that during a graph stage run the LLM's tool_calls actually hit
// the MCP tool (evidence: graph/tool_call notification with the MCP result),
// and the final deliverable embeds that result.

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
const mockMcpPath = path.join(root, 'fixtures', 'mockMcpServer.js')

// ─── mock OpenAI-compatible SSE endpoint ────────────────────────
// Round 1 (no tool result in messages yet)  → streams a tool_calls delta
// Round 2 (a role:'tool' message came back) → streams the final answer text
function sse(res, deltas) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const delta of deltas) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function startMockLLM() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      requests.push(parsed)
      const sawToolResult = parsed.messages.some((m) => m.role === 'tool')
      if (!sawToolResult && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        // split the arguments across two chunks to exercise delta accumulation
        sse(res, [
          { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'mock__add', arguments: '{"a":20,' } }] },
          { tool_calls: [{ index: 0, function: { arguments: '"b":22}' } }] },
        ])
      } else {
        sse(res, [{ content: '工具计算完成，' }, { content: '结果是 42。' }])
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests })
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

test('E2E: sidecar stage run — LLM tool_calls reach the MCP server and shape the deliverable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-mcp-e2e-'))
  const { server, port, requests } = await startMockLLM()
  const s = startSidecar()
  try {
    await s.next() // sidecar/ready

    s.send({
      jsonrpc: '2.0',
      id: 'e1',
      method: 'graph.start_delivery',
      params: {
        projectId: 'pe2e',
        deliveryId: 'de2e',
        projectName: 'MCP 冒烟',
        requirement: '算出 20+22',
        // single review-less node keeps the smoke to exactly one LLM stage
        dag: {
          nodes: [{
            id: 'node_req',
            stageId: 'req',
            dependsOn: [],
            config: { gate: { aiReview: false } },
          }],
        },
        modelConfig: { endpoint: `http://127.0.0.1:${port}`, apiKey: 'fake', modelId: 'mock-model' },
        checkpointDbPath: path.join(dir, 'checkpoints.db'),
        mcpServers: [{ name: 'mock', command: process.execPath, args: [mockMcpPath] }],
      },
    })

    const [resp] = await s.until((m) => m.id === 'e1')
    assert.equal(resp.result.threadId, 'pe2e_de2e')

    // evidence 1: the tool round-trip is surfaced as a notification
    const [toolNote] = await s.until((m) => m.method === 'graph/tool_call')
    assert.equal(toolNote.params.tool, 'mock__add')
    assert.equal(toolNote.params.result, '42')

    // evidence 2: the run completes with the tool-informed final answer
    const [done, all] = await s.until((m) => m.method === 'graph/completed')
    assert.deepEqual(done.params.stages, ['req'])
    const stageDone = all.find((m) => m.method === 'graph/stage_done')
      ?? (await s.until((m) => m.method === 'graph/stage_done'))[0]
    assert.ok(stageDone, 'expected graph/stage_done')

    // evidence 3: the LLM was offered the MCP tools and got the tool result back
    assert.ok(requests.length >= 2, `expected 2 LLM turns, got ${requests.length}`)
    assert.ok(requests[0].tools.some((t) => t.function.name === 'mock__add'))
    const toolMsg = requests[1].messages.find((m) => m.role === 'tool')
    assert.equal(toolMsg.content, '42')
    assert.equal(toolMsg.tool_call_id, 'call_1')

    // deliverable content came from the second (post-tool) LLM turn
    s.send({
      jsonrpc: '2.0', id: 'gs', method: 'graph.get_state',
      params: { threadId: 'pe2e_de2e', checkpointDbPath: path.join(dir, 'checkpoints.db') },
    })
    const [state] = await s.until((m) => m.id === 'gs')
    assert.deepEqual(state.result.completedStages, ['req'])
  } finally {
    s.stop()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
