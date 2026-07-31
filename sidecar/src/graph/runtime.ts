// ================================================================
//  Graph Runtime — session manager behind the graph.* JSON-RPC methods
//
//  graph.start_delivery  → build + compile + run async, returns { threadId }
//  graph.continue        → resume after interrupt (gate or injected deliverable)
//  graph.get_state       → checkpoint snapshot (works across process restarts)
//  graph.abort           → cancel the in-flight run
//
//  Execution progress is pushed as notifications:
//    graph/stream · graph/stage_start · graph/stage_done ·
//    graph/interrupted · graph/completed · graph/error
// ================================================================

import { Command } from '@langchain/langgraph'
import {
  buildSdlcGraph,
  defaultDag,
  loadDagFromDb,
  threadIdFor,
  createCheckpointer,
  type DagDefinition,
  type SdlcGraph,
} from './sdlcGraph.js'
import type { Notifier } from './stageNode.js'
import { OpenAICompatibleClient, type LLMClient, type ModelConfig } from '../services/llm.js'
import { buildToolset } from '../tools/toolRegistry.js'
import { safeRecordDiff } from '../domain/flywheel.js'
import type { McpServerConfig } from '../tools/mcpClient.js'

// ─── Runtime configuration (injected from index.ts) ─────────────

interface RuntimeConfig {
  notify: Notifier
  /** Test seam: swap the LLM transport without touching the RPC surface. */
  llmFactory?: (config: ModelConfig) => LLMClient
}

let runtime: RuntimeConfig = { notify: () => {} }

export function configureGraphRuntime(config: RuntimeConfig): void {
  runtime = config
}

// ─── Sessions ───────────────────────────────────────────────────

type SessionStatus = 'running' | 'interrupted' | 'completed' | 'error' | 'aborted'

interface Session {
  threadId: string
  projectId: string
  deliveryId: string
  app: SdlcGraph
  controller: AbortController
  status: SessionStatus
  running: boolean
}

const sessions = new Map<string, Session>()

async function buildSession(params: {
  projectId: string
  deliveryId: string
  dag?: DagDefinition | null
  modelConfig: ModelConfig
  checkpointDbPath?: string
  businessDbPath?: string
  /** MCP servers configured on the Agents page (Phase 4). */
  mcpServers?: McpServerConfig[]
  /** Agent-bound skill/MCP names — filters which tools get registered. */
  allowedTools?: string[]
  /** Phase 6 反思飞轮 — default on; false disables the per-stage reflection step. */
  reflectionEnabled?: boolean
}): Promise<Session> {
  const { projectId, deliveryId } = params
  if (!projectId || !deliveryId) throw new Error('projectId and deliveryId are required')
  if (!params.modelConfig) throw new Error('modelConfig is required')

  // DAG precedence: explicit param → business SQLite db → built-in default
  const dag =
    params.dag ??
    (params.businessDbPath ? loadDagFromDb(params.businessDbPath, projectId) : null) ??
    defaultDag()

  const llm = runtime.llmFactory
    ? runtime.llmFactory(params.modelConfig)
    : new OpenAICompatibleClient(params.modelConfig)

  // MCP toolset (failure-isolated): broken servers are skipped, and any
  // toolset build error degrades to tool-less generation
  let toolset = null
  if (params.mcpServers && params.mcpServers.length > 0) {
    try {
      toolset = await buildToolset({ servers: params.mcpServers, allowedTools: params.allowedTools })
    } catch (e) {
      runtime.notify('tools/error', { message: e instanceof Error ? e.message : String(e) })
    }
  }

  const app = buildSdlcGraph(dag, {
    llm,
    notify: runtime.notify,
    toolset,
    reflectionEnabled: params.reflectionEnabled !== false,
  }, {
    checkpointer: createCheckpointer(params.checkpointDbPath),
  })

  const threadId = threadIdFor(projectId, deliveryId)
  const session: Session = {
    threadId,
    projectId,
    deliveryId,
    app,
    controller: new AbortController(),
    status: 'running',
    running: false,
  }
  sessions.set(threadId, session)
  return session
}

// ─── Async run loop with notification wrap-up ───────────────────

async function runGraph(session: Session, input: unknown): Promise<void> {
  const { threadId } = session
  const config = {
    configurable: { thread_id: threadId },
    signal: session.controller.signal,
  }

  session.running = true
  session.status = 'running'
  try {
    const stream = await session.app.stream(input as any, { ...config, streamMode: 'updates' })
    for await (const _chunk of stream) {
      // stage nodes push their own notifications; draining drives execution
    }

    const snap = await session.app.getState(config)
    const pending: string[] = snap.next ?? []
    if (pending.length > 0) {
      session.status = 'interrupted'
      runtime.notify('graph/interrupted', {
        threadId,
        next: pending,
        interrupts: collectInterrupts(snap),
        currentStage: snap.values?.currentStage ?? null,
      })
    } else {
      session.status = 'completed'
      runtime.notify('graph/completed', {
        threadId,
        currentStage: snap.values?.currentStage ?? null,
        stages: Object.keys(snap.values?.deliverables ?? {}),
        retryCount: snap.values?.retryCount ?? 0,
      })
    }
  } catch (e) {
    session.status = session.controller.signal.aborted ? 'aborted' : 'error'
    runtime.notify('graph/error', {
      threadId,
      message: e instanceof Error ? e.message : String(e),
      aborted: session.controller.signal.aborted,
    })
  } finally {
    session.running = false
  }
}

function collectInterrupts(snap: { tasks?: Array<{ name?: string; interrupts?: Array<{ value?: unknown }> }> }): unknown[] {
  const out: unknown[] = []
  for (const task of snap.tasks ?? []) {
    for (const intr of task.interrupts ?? []) {
      out.push({ node: task.name, value: intr.value })
    }
  }
  return out
}

// ─── RPC handlers ───────────────────────────────────────────────

export const graphMethods = {
  /**
   * { projectId, deliveryId, dag?, modelConfig, executionMode?, projectName?,
   *   requirement?, checkpointDbPath?, businessDbPath?,
   *   mcpServers?, allowedTools? } → { threadId }
   */
  'graph.start_delivery': async (params: any) => {
    const session = await buildSession(params)
    const input = {
      projectId: params.projectId,
      deliveryId: params.deliveryId,
      executionMode: params.executionMode ?? 'builtin',
      contextPackage: {
        projectName: params.projectName ?? params.projectId,
        requirement: params.requirement ?? '',
      },
    }
    void runGraph(session, input)
    return { threadId: session.threadId }
  },

  /** { threadId, resumeValue?, ...rebuild params } → { threadId, status } */
  'graph.continue': async (params: any) => {
    const { threadId, resumeValue } = params ?? {}
    if (!threadId) throw new Error('threadId is required')
    let session = sessions.get(threadId)
    if (!session) {
      // process was restarted — rebuild from the checkpoint when the caller
      // supplies enough context (projectId/deliveryId/modelConfig)
      if (!params.projectId || !params.deliveryId || !params.modelConfig) {
        throw new Error(`Unknown thread ${threadId}; pass projectId/deliveryId/modelConfig to rebuild`)
      }
      session = await buildSession(params)
    }
    if (session.running) throw new Error(`Thread ${threadId} is already running`)
    // a previous abort leaves a dead signal — arm a fresh one for the resume
    if (session.controller.signal.aborted) session.controller = new AbortController()
    // null input = resume from checkpoint; Command carries an injected value
    const input = resumeValue !== undefined && resumeValue !== null
      ? new Command({ resume: resumeValue })
      : null
    // 飞轮：delegate/manual 注入交付物时自动记录 diff（original = AI 草稿或空）
    if (input) {
      try {
        const snap = await session.app.getState({ configurable: { thread_id: threadId } })
        const stageId: string | undefined = snap.next?.[0]
        const finalContent = typeof resumeValue === 'string'
          ? resumeValue
          : String((resumeValue as Record<string, unknown>)?.content ?? '')
        if (stageId && finalContent) {
          await safeRecordDiff({
            projectId: session.projectId,
            deliveryId: session.deliveryId,
            stageId,
            original: String(snap.values?.deliverables?.[stageId]?.content ?? ''),
            final: finalContent,
          })
        }
      } catch { /* flywheel 静默降级，不阻塞恢复 */ }
    }
    void runGraph(session, input)
    return { threadId, status: 'running' }
  },

  /** { threadId, checkpointDbPath?, dag?, businessDbPath?, projectId? } → checkpoint snapshot summary */
  'graph.get_state': async (params: any) => {
    const { threadId } = params ?? {}
    if (!threadId) throw new Error('threadId is required')

    // sessionless read: a throwaway graph over the same checkpoint db is
    // enough to read state after a process restart (no LLM calls happen).
    // Custom-DAG checkpoints need a matching graph shape to deserialize,
    // so honor the same DAG precedence as buildSession: explicit dag →
    // business db → built-in default (default 9-stage behavior unchanged).
    const dag: DagDefinition =
      params.dag ??
      (params.businessDbPath && params.projectId
        ? loadDagFromDb(params.businessDbPath, params.projectId)
        : null) ??
      defaultDag()
    const app = sessions.get(threadId)?.app
      ?? buildSdlcGraph(dag, {
        llm: { chatStream: async () => '' },
        notify: () => {},
      }, { checkpointer: createCheckpointer(params.checkpointDbPath) })

    const snap = await app.getState({ configurable: { thread_id: threadId } })
    const values = snap.values ?? {}
    return {
      threadId,
      exists: Object.keys(values).length > 0,
      currentStage: values.currentStage ?? null,
      completedStages: Object.keys(values.deliverables ?? {}),
      next: snap.next ?? [],
      interrupts: collectInterrupts(snap),
      reviewScore: values.reviewScore ?? null,
      reviewFeedback: values.reviewFeedback ?? null,
      retryCount: values.retryCount ?? 0,
      executionMode: values.executionMode ?? null,
      status: sessions.get(threadId)?.status ?? ((snap.next ?? []).length > 0 ? 'interrupted' : 'unknown'),
    }
  },

  /** { threadId } → { ok } */
  'graph.abort': (params: any) => {
    const { threadId } = params ?? {}
    if (!threadId) throw new Error('threadId is required')
    const session = sessions.get(threadId)
    if (!session) return { ok: false, error: 'unknown_thread' }
    session.controller.abort()
    session.status = 'aborted'
    return { ok: true, threadId }
  },
}
