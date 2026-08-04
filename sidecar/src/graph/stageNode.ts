// ================================================================
//  Stage Node — the generic executable unit of the SDLC graph
//
//  Each node runs five steps (DESIGN-v3 §3.3 + Phase 6):
//    1. context assembly   buildStageContext (knowledge recall hook → Phase 3)
//    2. LLM generation     llm.ts, streaming tokens as graph/stream notifications
//    3. AI review          score 0-100 + feedback via llm.ts review prompt
//    4. registration       registerDeliverable hook (Phase 4) + graph/stage_done
//    5. reflection         runReflection (Phase 6) — best-effort, appends to
//                          state.reflectionLog; disabled via deps.reflectionEnabled
//
//  executionMode 'delegate' | 'manual' bypasses generation entirely:
//  the node interrupt()s and waits for the host to inject a deliverable.
// ================================================================

import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph'
import {
  type LLMClient,
  buildGenerationMessages,
  reviewDeliverable,
  type ReviewResult,
} from '../services/llm.js'
import { getStageDefinition } from '../domain/stages.js'
import { buildContextPackage } from '../domain/contextEngine.js'
import { generateWithTools, type ToolExecutor } from '../tools/toolRegistry.js'
import { safeRecall, safeRegister, safeImprove } from '../knowledge/knowledgeService.js'
import { runReflection, type ReflectionEntry } from './reflection.js'
import type { SDLCState, SDLCUpdate } from './sdlcGraph.js'

// ─── DAG node definition (flowEngine.js-compatible subset) ──────

export interface DagGate {
  aiReview?: boolean
  humanReview?: boolean
  manualTrigger?: boolean
  threshold?: number
}

export interface DagNodeDef {
  /** Raw node id from the DAG document (e.g. 'node_req'). */
  id: string
  /** Stage id — also used as the graph node name (e.g. 'req'). */
  stageId: string
  label?: string
  /** Predecessor stage ids (already resolved from raw node ids). */
  dependsOn: string[]
  config?: {
    gate?: DagGate
    guidance?: { goal?: string; steps?: string[]; qualityChecklist?: string[]; template?: string }
    temperature?: number
    [key: string]: unknown
  }
}

export type Notifier = (method: string, params?: unknown) => void

// ─── Hook points (kept intentionally thin) ──────────────────────

export interface StageContext {
  stage: string
  projectName: string
  requirement: string
  /** Direct-upstream deliverables, in dependsOn order. */
  upstream: Array<{ stage: string; label: string; content: string }>
  /** Concatenated context block for prompt injection. */
  contextBlock: string
  /** Phase 3: knowledge recalled from Cognee — null until wired up. */
  knowledge: unknown | null
}

/**
 * Phase 3 hook — knowledge recall (knowledgeService fallback route).
 * Returns null when the knowledge layer is unconfigured or unhealthy;
 * buildStageContext threads the result through StageContext.knowledge.
 */
export async function recallKnowledge(state: SDLCState, node: DagNodeDef): Promise<unknown | null> {
  const pkg = (state.contextPackage ?? {}) as Record<string, unknown>
  const requirement = typeof pkg.requirement === 'string' ? pkg.requirement : ''
  return safeRecall({
    projectId: state.projectId,
    stageId: node.stageId,
    deliveryId: state.deliveryId,
    query: requirement || undefined,
  })
}

/**
 * Phase 3 hook — deliverable registration into the knowledge graph.
 * Silent-degrading: safeRegister/safeImprove never throw, so graph
 * execution cannot fail because of knowledge-layer problems (errors
 * surface via the `knowledge/error` notification instead).
 */
export async function registerDeliverable(entry: {
  projectId: string
  deliveryId: string
  stage: string
  content: string
  review: ReviewResult | null
  source: string
}): Promise<void> {
  await safeRegister({
    projectId: entry.projectId,
    deliveryId: entry.deliveryId,
    stageId: entry.stage,
    content: entry.content,
    review: entry.review,
    qualityScore: entry.review?.totalScore ?? null,
    source: entry.source,
  })
  // review rejection → record the feedback as a reflection asset
  if (entry.review && !entry.review.passed) {
    await safeImprove({
      projectId: entry.projectId,
      deliveryId: entry.deliveryId,
      stageId: entry.stage,
      feedback: entry.review.suggestions.join('\n') || `评审未通过（得分 ${entry.review.totalScore}）`,
    })
  }
}

// ─── Step 1: context assembly (delegated to the context engine) ───

export async function buildStageContext(state: SDLCState, node: DagNodeDef): Promise<StageContext> {
  const pkg = (state.contextPackage ?? {}) as Record<string, unknown>
  const projectName = typeof pkg.projectName === 'string' ? pkg.projectName : state.projectId
  const requirement = typeof pkg.requirement === 'string' ? pkg.requirement : ''

  // context engine: upstream + knowledge recall + checklist + reflections
  // + 代码索引上下文（repoPath 由 start_delivery 透传，无索引时该节省略）
  const pack = await buildContextPackage({
    projectId: state.projectId,
    deliveryId: state.deliveryId,
    stageId: node.stageId,
    state,
    dependsOn: node.dependsOn,
    repoPath: typeof pkg.repoPath === 'string' ? pkg.repoPath : undefined,
  })

  return {
    stage: node.stageId,
    projectName,
    requirement,
    upstream: pack.upstream,
    contextBlock: pack.markdown ?? '',
    knowledge: pack.knowledge,
  }
}

// ─── Node factory ───────────────────────────────────────────────

export interface StageNodeDeps {
  llm: LLMClient
  notify: Notifier
  /** MCP-backed tools (Phase 4); null/absent → plain generation without tools. */
  toolset?: ToolExecutor | null
  /** Test override for the review step; defaults to reviewDeliverable via llm. */
  reviewFn?: (stage: string, content: string, state: SDLCState) => Promise<ReviewResult>
  /** Phase 6 反思飞轮 — step 5 runs unless explicitly set to false. */
  reflectionEnabled?: boolean
}

const DEFAULT_THRESHOLD = 75

/** 2.1 需要工具使用指引的阶段：编码/评审/自测最依赖代码事实。 */
const TOOL_GUIDED_STAGES = new Set(['dev', 'review', 'auto-test'])

/** 从 toolset 生成工具清单文本（注入生成提示词的【可用工具】段）。 */
function buildToolGuidance(stage: string, toolset: ToolExecutor | null | undefined): string | undefined {
  if (!TOOL_GUIDED_STAGES.has(stage) || !toolset || toolset.tools.length === 0) return undefined
  return toolset.tools
    .map((t) => `- ${t.function.name}：${t.function.description ?? ''}`)
    .join('\n')
}

export function makeStageNode(node: DagNodeDef, deps: StageNodeDeps) {
  const { llm, notify } = deps
  const stage = node.stageId
  const gate = node.config?.gate ?? {}
  const threshold = gate.threshold ?? DEFAULT_THRESHOLD

  return async function stageNode(state: SDLCState, config: LangGraphRunnableConfig): Promise<SDLCUpdate> {
    const threadId = (config.configurable?.thread_id as string) ?? ''
    const base = { threadId, stage, projectId: state.projectId, deliveryId: state.deliveryId }

    // ─── delegate / manual: park until the host injects the deliverable ───
    let content: string
    let source = state.executionMode
    if (state.executionMode === 'delegate' || state.executionMode === 'manual') {
      notify('graph/stage_start', { ...base, mode: state.executionMode })
      const injected = interrupt<{ stage: string; mode: string; reason: string }, unknown>({
        stage,
        mode: state.executionMode,
        reason: 'awaiting_external_deliverable',
      })
      content = typeof injected === 'string'
        ? injected
        : String((injected as Record<string, unknown>)?.content ?? '')
    } else {
      // ─── builtin: steps 1 + 2 — context assembly, then LLM generation ───
      notify('graph/stage_start', { ...base, mode: 'builtin' })
      const ctx = await buildStageContext(state, node)
      const messages = buildGenerationMessages(stage, {
        projectName: ctx.projectName,
        requirement: ctx.requirement,
        previousContent: ctx.upstream.map((u) => u.content).join('\n\n'),
        contextBlock: ctx.contextBlock || undefined,
        // 2.2 驳回重试：review 驳回回退后携上轮评审意见重生，而非盲目重试
        revisionFeedback: state.retryCount > 0 ? state.reviewFeedback ?? undefined : undefined,
        toolGuidance: buildToolGuidance(stage, deps.toolset),
      })
      content = await generateWithTools(
        llm,
        messages,
        deps.toolset ?? null,
        {
          temperature: node.config?.temperature ?? 0.7,
          signal: config.signal,
          meta: { stage, kind: 'generate' },
          onDelta: (delta) => notify('graph/stream', { ...base, delta }),
        },
        // surfaces every MCP tool round-trip as a notification (debug + UI)
        (event) => notify('graph/tool_call', {
          ...base,
          round: event.round,
          tool: event.tool,
          arguments: event.arguments,
          result: event.result.slice(0, 500),
        })
      )
      source = 'builtin'
    }

    // ─── Step 3: AI review (skipped when the gate doesn't require it) ───
    let review: ReviewResult | null = null
    if (gate.aiReview) {
      const stageName = getStageDefinition(stage)?.name || node.label || stage
      review = deps.reviewFn
        ? await deps.reviewFn(stage, content, state)
        : await reviewDeliverable(llm, stageName, content, { signal: config.signal, meta: { stage } })
    }
    const score = review ? review.totalScore : null
    const feedback = review ? review.suggestions.join('\n') : null
    const passed = review ? review.totalScore >= threshold : true

    // ─── Step 4: registration hook + stage_done notification ───
    await registerDeliverable({
      projectId: state.projectId,
      deliveryId: state.deliveryId,
      stage,
      content,
      review,
      source,
    })
    notify('graph/stage_done', {
      ...base, reviewScore: score, passed, source,
      // 交付物回写闭环：前端据此写入 stageDeliverables，无需再轮询 get_state
      content,
      review: review ? {
        totalScore: review.totalScore,
        passed: review.passed,
        suggestions: review.suggestions,
        dimensions: review.dimensions,
      } : null,
    })

    // ─── Step 5: reflection (Phase 6) — best-effort, silent degrade ───
    let reflection: ReflectionEntry | null = null
    if (deps.reflectionEnabled !== false) {
      reflection = await runReflection(llm, notify, {
        projectId: state.projectId,
        deliveryId: state.deliveryId,
        stage,
        deliverable: content,
        reviewScore: score,
        reviewFeedback: feedback,
        retryCount: state.retryCount,
      }, { signal: config.signal })
    }

    return {
      ...(reflection ? { reflectionLog: [reflection] } : {}),
      currentStage: stage,
      deliverable: content,
      reviewScore: score,
      reviewFeedback: feedback,
      // only the gated review node bumps retryCount on rejection — the
      // conditional router in sdlcGraph.ts reads it to cap the loop
      ...(stage === 'review' && !passed ? { retryCount: state.retryCount + 1 } : {}),
      deliverables: {
        [stage]: { content, reviewScore: score, passed, source, at: new Date().toISOString() },
      },
    }
  }
}
