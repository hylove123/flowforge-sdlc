// ================================================================
//  flowforge-sidecar — stdin/stdout JSON-RPC 2.0 server
//
//  Protocol: one JSON message per line.
//    request      {"jsonrpc":"2.0","id":"...","method":"...","params":{}}
//    response     {"jsonrpc":"2.0","id":"...","result":...} | {"...","error":{code,message}}
//    notification {"jsonrpc":"2.0","method":"...","params":{}}   (no id, sidecar → host)
//
//  The Tauri shell (src-tauri/src/commands/sidecar.rs) routes responses
//  by id and re-emits notifications as the `sidecar://event` event.
// ================================================================

import { createInterface } from 'node:readline'
import { CONCEPTS, RELATIONS, ONTOLOGY_RULES } from './domain/ontology.js'
import { STAGE_DEFINITIONS } from './domain/stages.js'
import { contextMethods } from './domain/contextEngine.js'
import { flywheelMethods, configureFlywheel } from './domain/flywheel.js'
import { graphMethods, configureGraphRuntime } from './graph/runtime.js'
import { graphEngineMethods } from './graph/graphEngine.js'
import { knowledgeMethods, configureKnowledge } from './knowledge/knowledgeService.js'
import { codeSearchMethods } from './knowledge/codeSearch.js'
import { toolsMethods } from './tools/toolRegistry.js'
import { llmMethods } from './services/llm.js'

// ─── JSON-RPC plumbing ──────────────────────────────────────────

type JsonRpcId = string | number

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

function writeLine(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function respondResult(id: JsonRpcId, result: unknown): void {
  writeLine({ jsonrpc: '2.0', id, result })
}

function respondError(id: JsonRpcId | null, code: number, message: string): void {
  writeLine({ jsonrpc: '2.0', id, error: { code, message } })
}

/** Push a JSON-RPC notification (no id) — surfaces in the webview as a stream event. */
export function notify(method: string, params: unknown = {}): void {
  writeLine({ jsonrpc: '2.0', method, params })
}

// ─── Method registry ────────────────────────────────────────────

type MethodHandler = (params: any) => unknown | Promise<unknown>

const methods: Record<string, MethodHandler> = {
  /** Health check used by the Rust heartbeat and the frontend ready probe. */
  ping: () => ({ ok: true, ts: Date.now() }),

  /** Round-trip test: returns the params untouched. */
  echo: (params) => params ?? null,

  /** Emits a notification back — lets callers test the event stream end to end. */
  'notify.test': (params) => {
    notify('sidecar/test-event', params ?? {})
    return { ok: true }
  },

  /** Smoke check that the domain modules are loaded and consistent. */
  'domain.info': () => ({
    concepts: Object.keys(CONCEPTS).length,
    relations: Object.keys(RELATIONS).length,
    rules: ONTOLOGY_RULES.length,
    stages: STAGE_DEFINITIONS.map((s) => s.id),
  }),

  // graph.start_delivery / graph.continue / graph.get_state / graph.abort
  ...graphMethods,

  // graph_engine.* — codebase-memory-mcp 图谱引擎（双引擎索引 B，t3）
  ...graphEngineMethods,

  // knowledge.search / knowledge.stats / knowledge.register / knowledge.recall
  ...knowledgeMethods,

  // code.search / code.register_modules (code intelligence, Phase 5)
  ...codeSearchMethods,

  // tools.list_servers / tools.connect_test / tools.call (MCP, Phase 4)
  ...toolsMethods,

  // llm.connect_test (模型连接测试，规避渲染进程 CORS)
  ...llmMethods,

  // context.build_package (context engine, Phase 4)
  ...contextMethods,

  // flywheel.record_diff / flywheel.stats (反思飞轮, Phase 6)
  ...flywheelMethods,
}

// wire the runtime's notification channel to this process's stdout
configureGraphRuntime({ notify })
// arm the knowledge layer (stageNode safe* hooks stay no-ops until this runs)
configureKnowledge({ notify })
// arm the flywheel (diff memory + template evolution notifications)
configureFlywheel({ notify })

// ─── Dispatch loop ──────────────────────────────────────────────

async function dispatch(line: string): Promise<void> {
  const trimmed = line.trim()
  if (!trimmed) return

  let req: JsonRpcRequest
  try {
    req = JSON.parse(trimmed)
  } catch {
    respondError(null, PARSE_ERROR, 'Parse error')
    return
  }

  const { id, method, params } = req
  if (typeof method !== 'string') {
    respondError(id ?? null, INVALID_REQUEST, 'Invalid Request: missing method')
    return
  }
  // notification from host — nothing to answer
  if (id === undefined || id === null) return

  const handler = methods[method]
  if (!handler) {
    respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`)
    return
  }

  try {
    respondResult(id, await handler(params))
  } catch (e) {
    respondError(id, INTERNAL_ERROR, e instanceof Error ? e.message : String(e))
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  void dispatch(line)
})
rl.on('close', () => process.exit(0))

// announce readiness — arrives in the webview via `sidecar://event`
notify('sidecar/ready', { pid: process.pid, ts: Date.now() })
