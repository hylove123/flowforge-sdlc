// ================================================================
//  Context Engine — structured context package assembly (Phase 4)
//
//  buildContextPackage() renders one Markdown document per stage run:
//    1. 交付背景        project name + requirement
//    2. 上游交付物      direct-upstream deliverables from graph state
//    3. 知识库召回      knowledge recall (safeRecall — silent no-op when unarmed)
//    4. 阶段检查清单    quality checklist from domain/stages.ts
//    5. 历史反思        reflection assets recalled from the knowledge layer
//
//  Packages larger than 10KB are spilled to
//  `${FLOWFORGE_DATA_DIR || ~/.flowforge}/context/` — the in-process
//  result always carries the markdown; RPC callers drop it when a
//  filePath is present (clipboard/dispatch reads the file instead).
// ================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getStageDefinition } from '../domain/stages.js'
import { safeRecall, type StageRecall } from '../knowledge/knowledgeService.js'
import { codeSearch, type CodeSearchHit } from '../knowledge/codeSearch.js'
import { recordRecall } from './flywheel.js'

export const SPILL_THRESHOLD_BYTES = 10 * 1024

// ─── Inputs / outputs ───────────────────────────────────────────

/** Subset of SDLCState the engine reads (also accepted from RPC callers). */
export interface ContextEngineState {
  contextPackage?: Record<string, unknown> | null
  deliverables?: Record<string, { content: string }>
}

export interface ContextPackageInput {
  projectId: string
  deliveryId: string
  stageId: string
  state: ContextEngineState
  /** Direct-upstream stage ids (DAG dependsOn); default: every completed stage. */
  dependsOn?: string[]
  /** Repository path — arms code-context injection (Phase 5); optional. */
  repoPath?: string
  /** Test seam / spill override; defaults to FLOWFORGE_DATA_DIR || ~/.flowforge. */
  dataDir?: string
}

export interface UpstreamEntry {
  stage: string
  label: string
  content: string
}

export interface ContextPackageResult {
  /** Always populated in-process; RPC layers omit it when filePath is set. */
  markdown?: string
  /** Set when the package exceeded SPILL_THRESHOLD_BYTES. */
  filePath?: string
  size: number
  upstream: UpstreamEntry[]
  knowledge: StageRecall | null
  /** Code-index hits injected for this stage (null: index unavailable). */
  code: CodeSearchHit[] | null
}

// ─── Code context injection (Phase 5) ───────────────────────

// stage id → query strategy: what slice of the codebase matters when
// this stage runs. Requirement-side stages want impact scope, planning
// wants architectural surface, review wants change surface.
const CODE_QUERY_KEYWORDS: Record<string, string> = {
  req: 'service handler controller api',      // 需求 → 影响范围
  brd: 'service handler controller api',
  prd: 'service handler controller api',
  test: 'test spec check validate',
  'dev-plan': 'module import service store config', // 方案 → 架构依赖
  dev: 'module import service store config',
  review: 'handler service test config',      // review → 变更影响
  'auto-test': 'test spec check validate',
  deploy: 'config build deploy env',
}

export function codeQueryForStage(stageId: string, requirement: string): string {
  const keywords = CODE_QUERY_KEYWORDS[stageId] ?? 'service module'
  return [requirement.trim(), keywords].filter(Boolean).join(' ')
}

/** Code-index recall that never throws — missing index/db ⇒ null. */
async function safeCodeSearch(
  repoPath: string | undefined,
  stageId: string,
  requirement: string
): Promise<CodeSearchHit[] | null> {
  if (!repoPath) return null
  try {
    const { results } = await codeSearch({
      repoPath,
      query: codeQueryForStage(stageId, requirement),
      topK: 5,
    })
    return results.length > 0 ? results : null
  } catch {
    return null // code index unavailable — stage execution must not care
  }
}

// ─── Assembly ───────────────────────────────────────────────────

export function collectUpstream(state: ContextEngineState, dependsOn?: string[]): UpstreamEntry[] {
  const deliverables = state.deliverables ?? {}
  const stages = dependsOn && dependsOn.length > 0 ? dependsOn : Object.keys(deliverables)
  return stages
    .map((dep) => {
      const entry = deliverables[dep]
      if (!entry || typeof entry.content !== 'string') return null
      const label = getStageDefinition(dep)?.name || dep
      return { stage: dep, label, content: entry.content }
    })
    .filter((x): x is UpstreamEntry => x !== null)
}

export function renderContextMarkdown(input: {
  stageId: string
  projectName: string
  requirement: string
  upstream: UpstreamEntry[]
  knowledge: StageRecall | null
  code?: CodeSearchHit[] | null
}): string {
  const { stageId, projectName, requirement, upstream, knowledge, code } = input
  const stageDef = getStageDefinition(stageId)
  const stageName = stageDef?.name || stageId
  const lines: string[] = []

  lines.push(`# 上下文包 · ${stageName}（${stageId}）`, '')
  lines.push('## 交付背景', '', `- 项目：${projectName}`, `- 需求：${requirement || '（未提供）'}`, '')

  lines.push('## 上游交付物', '')
  if (upstream.length === 0) {
    lines.push('（无上游交付物）', '')
  } else {
    for (const u of upstream) {
      lines.push(`### ${u.label}（${u.stage}）`, '', u.content, '')
    }
  }

  lines.push('## 知识库召回', '')
  const assets = knowledge?.relatedAssets ?? []
  if (assets.length === 0) {
    lines.push('（知识层未启用或无相关资产）', '')
  } else {
    for (const a of assets) {
      lines.push(`- **${a.label}**（${a.type}）：${a.text.slice(0, 300)}`)
    }
    lines.push('')
  }

  // 代码上下文（Phase 5）—— 索引不可用时整节静默省略
  if (code && code.length > 0) {
    lines.push('## 相关代码', '')
    for (const hit of code) {
      const sig = hit.signature ? `：\`${hit.signature.slice(0, 120)}\`` : ''
      lines.push(`- \`${hit.file}:${hit.startLine}\` ${hit.kind} **${hit.name}**${sig}`)
    }
    lines.push('')
  }

  lines.push('## 阶段检查清单', '')
  const checklist = stageDef?.guidance?.qualityChecklist ?? []
  if (stageDef?.guidance?.goal) lines.push(`> 目标：${stageDef.guidance.goal}`, '')
  if (checklist.length === 0) {
    lines.push('（该阶段无预置检查项）', '')
  } else {
    for (const item of checklist) lines.push(`- [ ] ${item}`)
    lines.push('')
  }

  lines.push('## 历史反思', '')
  const reflections = knowledge?.reflections ?? []
  if (reflections.length === 0) {
    lines.push('（暂无历史反思记录）', '')
  } else {
    for (const r of reflections) {
      lines.push(`- ${r.createdAt.slice(0, 10)}${r.stage ? ` [${r.stage}]` : ''}：${r.feedback}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function contextDir(dataDir?: string): string {
  const base = dataDir || process.env.FLOWFORGE_DATA_DIR || path.join(os.homedir(), '.flowforge')
  return path.join(base, 'context')
}

/**
 * Assembles the full context package for a stage. Knowledge recall runs
 * through safeRecall, so an unarmed/unhealthy knowledge layer degrades to
 * the "（知识层未启用）" section instead of failing the caller.
 */
export async function buildContextPackage(input: ContextPackageInput): Promise<ContextPackageResult> {
  const { projectId, deliveryId, stageId, state } = input
  if (!projectId || !stageId) throw new Error('buildContextPackage: projectId and stageId are required')

  const pkg = (state.contextPackage ?? {}) as Record<string, unknown>
  const projectName = typeof pkg.projectName === 'string' ? pkg.projectName : projectId
  const requirement = typeof pkg.requirement === 'string' ? pkg.requirement : ''

  const upstream = collectUpstream(state, input.dependsOn)
  const knowledge = await safeRecall({
    projectId,
    stageId,
    deliveryId,
    query: requirement || undefined,
  })
  // flywheel reuse-rate counter (Phase 6, advisory — recordRecall never throws)
  if (knowledge !== null) {
    recordRecall(projectId, knowledge.upstreamDeliverables.length > 0
      || knowledge.relatedAssets.length > 0
      || knowledge.reflections.length > 0)
  }
  const code = await safeCodeSearch(input.repoPath, stageId, requirement)

  const markdown = renderContextMarkdown({ stageId, projectName, requirement, upstream, knowledge, code })
  const size = Buffer.byteLength(markdown, 'utf8')

  const result: ContextPackageResult = { markdown, size, upstream, knowledge, code }
  if (size > SPILL_THRESHOLD_BYTES) {
    const dir = contextDir(input.dataDir)
    fs.mkdirSync(dir, { recursive: true })
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
    const filePath = path.join(dir, `${safe(projectId)}_${safe(deliveryId)}_${safe(stageId)}_${Date.now()}.md`)
    fs.writeFileSync(filePath, markdown, 'utf8')
    result.filePath = filePath
  }
  return result
}

// ─── JSON-RPC method handlers (registered by index.ts) ──────────

export const contextMethods = {
  /**
   * { projectId, deliveryId, stageId, projectName?, requirement?,
   *   deliverables?, dependsOn?, repoPath? } → { markdown?, filePath?, size }
   * Used by the delegate dispatch flow — markdown is omitted once
   * the package spilled to a file.
   */
  'context.build_package': async (params: any) => {
    const { projectId, deliveryId, stageId } = params ?? {}
    const result = await buildContextPackage({
      projectId,
      deliveryId: deliveryId ?? '',
      stageId,
      dependsOn: params?.dependsOn,
      repoPath: params?.repoPath,
      state: {
        contextPackage: {
          projectName: params?.projectName ?? projectId,
          requirement: params?.requirement ?? '',
        },
        deliverables: params?.deliverables ?? {},
      },
    })
    return result.filePath
      ? { filePath: result.filePath, size: result.size }
      : { markdown: result.markdown, size: result.size }
  },
}
