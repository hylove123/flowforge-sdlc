// ================================================================
//  Reflection — post-stage self-review step (Phase 6 反思飞轮)
//
//  After a stage node finishes (deliverable + review recorded), the
//  LLM produces a structured reflection over the run:
//    lowScoreAttribution   为什么评审得分不高 / 哪里薄弱
//    modificationAnalysis  重试或修改揭示了什么问题
//    strategySuggestion    下次执行该阶段的策略建议
//
//  Failure model (nothing here may block the main flow):
//    - LLM unreachable (delegate-mode dummy config etc.) → skip, no entry
//    - JSON parse failure → degrade to a plain-text entry (structured: false)
//    - knowledge layer down → safeImprove already degrades silently
//
//  Every produced entry is (1) appended to state.reflectionLog by the
//  stage node, (2) written into the knowledge graph via safeImprove,
//  (3) pushed to the host as a `graph/reflection` notification.
// ================================================================

import type { LLMClient } from '../services/llm.js'
import { safeImprove } from '../knowledge/knowledgeService.js'
import type { Notifier } from './stageNode.js'

// ─── Types ──────────────────────────────────────────────────────

export interface ReflectionEntry {
  stage: string
  at: string
  /** false when the LLM answer failed JSON parsing (raw carries the text). */
  structured: boolean
  lowScoreAttribution: string | null
  modificationAnalysis: string | null
  strategySuggestion: string | null
  /** Plain-text fallback when parsing failed. */
  raw: string | null
  reviewScore: number | null
  retryCount: number
}

export interface ReflectionInput {
  projectId: string
  deliveryId: string
  stage: string
  deliverable: string
  reviewScore: number | null
  reviewFeedback: string | null
  retryCount: number
}

// ─── Prompt & parsing ───────────────────────────────────────────

export const REFLECTION_SYSTEM_PROMPT = `你是一位软件交付过程改进专家。请针对刚完成的阶段执行做结构化反思，输出 JSON：
{
  "lowScoreAttribution": "若评审得分偏低或被驳回，归因分析（得分高则说明保持了什么优势）",
  "modificationAnalysis": "重试次数/评审意见反映出的修改模式分析",
  "strategySuggestion": "下次执行该阶段时的具体策略建议（提示词/模板/检查项层面）"
}
只输出 JSON，不要额外解释。`

export function buildReflectionMessages(input: ReflectionInput) {
  const user = [
    `阶段：${input.stage}`,
    `评审得分：${input.reviewScore ?? '（未评审）'}`,
    `评审意见：${input.reviewFeedback || '（无）'}`,
    `重试次数：${input.retryCount}`,
    '',
    '交付物（截取）：',
    input.deliverable.slice(0, 4000),
  ].join('\n')
  return [
    { role: 'system' as const, content: REFLECTION_SYSTEM_PROMPT },
    { role: 'user' as const, content: user },
  ]
}

/** Extracts the structured reflection; parse failure → structured:false + raw. */
export function parseReflection(raw: string): Pick<
  ReflectionEntry,
  'structured' | 'lowScoreAttribution' | 'modificationAnalysis' | 'strategySuggestion' | 'raw'
> {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0])
      const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
      const entry = {
        structured: true,
        lowScoreAttribution: pick(parsed.lowScoreAttribution),
        modificationAnalysis: pick(parsed.modificationAnalysis),
        strategySuggestion: pick(parsed.strategySuggestion),
        raw: null,
      }
      // an object with none of the expected fields is not a usable reflection
      if (entry.lowScoreAttribution || entry.modificationAnalysis || entry.strategySuggestion) {
        return entry
      }
    }
  } catch { /* fall through to the plain-text record */ }
  return {
    structured: false,
    lowScoreAttribution: null,
    modificationAnalysis: null,
    strategySuggestion: null,
    raw: raw.trim() || null,
  }
}

/** Text persisted into the knowledge graph (recalled by the context engine later). */
export function reflectionFeedbackText(entry: ReflectionEntry): string {
  if (!entry.structured) return entry.raw ?? ''
  return [
    entry.lowScoreAttribution ? `归因：${entry.lowScoreAttribution}` : null,
    entry.modificationAnalysis ? `修改分析：${entry.modificationAnalysis}` : null,
    entry.strategySuggestion ? `策略建议：${entry.strategySuggestion}` : null,
  ].filter(Boolean).join('\n')
}

// ─── Execution ──────────────────────────────────────────────────

/**
 * Runs the reflection LLM turn for a completed stage. Returns the entry
 * to append to state.reflectionLog, or null when the LLM was unavailable
 * (silent skip — the stage result itself is already committed).
 */
export async function runReflection(
  llm: LLMClient,
  notify: Notifier,
  input: ReflectionInput,
  options: { signal?: AbortSignal } = {}
): Promise<ReflectionEntry | null> {
  let raw: string
  try {
    raw = await llm.chatStream(buildReflectionMessages(input), {
      temperature: 0.3,
      maxTokens: 1024,
      signal: options.signal,
      meta: { stage: input.stage, kind: 'reflect' },
    })
  } catch {
    // delegate/manual runs carry a dummy model config — reflection is
    // best-effort and must never fail the stage
    return null
  }

  const entry: ReflectionEntry = {
    stage: input.stage,
    at: new Date().toISOString(),
    ...parseReflection(raw),
    reviewScore: input.reviewScore,
    retryCount: input.retryCount,
  }

  // knowledge flywheel: reflections become recallable assets (silent degrade)
  const feedback = reflectionFeedbackText(entry)
  if (feedback) {
    await safeImprove({
      projectId: input.projectId,
      deliveryId: input.deliveryId,
      stageId: input.stage,
      feedback,
    })
  }

  notify('graph/reflection', {
    projectId: input.projectId,
    deliveryId: input.deliveryId,
    stage: input.stage,
    structured: entry.structured,
    reviewScore: entry.reviewScore,
    retryCount: entry.retryCount,
    strategySuggestion: entry.strategySuggestion,
    entry,
  })
  return entry
}
