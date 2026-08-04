// ================================================================
//  Context Engine — structured context package assembly (Phase 4)
//
//  buildContextPackage() renders one Markdown document per stage run:
//    1. 交付背景        project name + requirement
//    2. 上游交付物      direct-upstream deliverables from graph state
//    3. 知识库召回      knowledge recall (safeRecall — silent no-op when unarmed)
//    4. 代码结构上下文  engine B graph: structural search + trace impact
//       + cross-service edges (missing index ⇒ explicit error, no degrade)
//    5. 阶段检查清单    quality checklist from domain/stages.ts
//    6. 历史反思        reflection assets recalled from the knowledge layer
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
import { getGraphEngine, resolveProjectName } from '../graph/graphEngine.js'
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
  /** Code-index hits injected for this stage (null: no repoPath). */
  code: CodeSearchHit[] | null
  /** Engine B code intelligence (structural search / traces / cross-service). */
  codeIntel: CodeIntelligence | null
}

export interface CodeIntelligence {
  /** 相关模块（引擎 B 结构搜索）— rendered markdown lines. */
  graphHits: string[]
  /** 调用链影响面（dev/review/auto-test 阶段）。 */
  traces: string[]
  /** 跨服务调用关系（CROSS_* 边）。 */
  crossEdges: string[]
  /** 引擎不可用/无命中时的降级原因（渲染为提示而非报错）。 */
  note?: string
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
  // 中文领域词的英文等价词一并入查询（BM25 对中文分词无效，靠等价词命中）
  const domain = extractDomainTerms(requirement).join(' ')
  return [requirement.trim(), domain, keywords].filter(Boolean).join(' ')
}

/** Extract code-like symbols (camelCase / PascalCase / snake_case) from text. */
export function extractSymbols(text: string): string[] {
  const found = text.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of found) {
    if (seen.has(tok)) continue
    seen.add(tok)
    if (/(_|[a-z0-9][A-Z]|[A-Z][a-z0-9]+[A-Z])/.test(tok)) out.push(tok)
  }
  return out
}

// 领域词 → 代码标识符映射：纯中文需求 grep 零命中时，用领域词的
// 英文等价物检索（WMS 仓储域优先，通用词兼顾）。宁缺毋滥：映射
// 不到就不注入通用噪音词。
const DOMAIN_TERM_MAP: Record<string, string[]> = {
  入库: ['inbound', 'asn', 'putaway'],
  出库: ['outbound', 'shipping', 'picking'],
  收货: ['receive', 'inbound'],
  上架: ['putaway'],
  拣货: ['pick', 'picking'],
  复核: ['check', 'recheck'],
  打包: ['pack', 'packing'],
  发货: ['ship', 'shipping'],
  盘点: ['inventory', 'count', 'stocktake'],
  库存: ['inventory', 'stock'],
  条码: ['barcode'],
  标签: ['label'],
  打印: ['print'],
  波次: ['wave'],
  货位: ['location', 'bin'],
  库位: ['location', 'bin'],
  容器: ['container'],
  单据: ['order', 'document'],
  订单: ['order'],
  退货: ['return'],
  补货: ['replenish'],
  调拨: ['transfer'],
  分拣: ['sort', 'sorting'],
  装载: ['load', 'loading'],
  月台: ['dock'],
  报表: ['report'],
  权限: ['permission', 'auth'],
  登录: ['login', 'auth'],
}

/** 从中文需求提取领域词的英文等价检索词（去重、保序）。 */
export function extractDomainTerms(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const [zh, ens] of Object.entries(DOMAIN_TERM_MAP)) {
    if (!text.includes(zh)) continue
    for (const en of ens) {
      if (!seen.has(en)) { seen.add(en); out.push(en) }
    }
  }
  return out
}

// 结构搜索噪音路径：构建/配置/元数据文件与需求代码无关，命中即剔除
const NOISE_PATH_PATTERNS = [
  /(^|\/)pom\.xml/i,
  /(^|\/)build\.gradle/i,
  /\.qoder\//,
  /repowiki/,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(vite|tailwind|postcss)\.config\./,
]

function isNoiseHit(h: any): boolean {
  const file = String(h?.file ?? h?.path ?? '')
  return NOISE_PATH_PATTERNS.some((re) => re.test(file))
}

/** Normalize search_code results into markdown bullet lines. */
function searchHitsToLines(res: unknown): string[] {
  if (!res) return []
  const anyRes = res as any
  const arr = Array.isArray(res)
    ? res
    : anyRes.matches ?? anyRes.results ?? anyRes.hits ?? []
  if (!Array.isArray(arr)) {
    const text = String(res).trim()
    return text ? text.split('\n').slice(0, 8).map((l) => `- ${l.trim()}`) : []
  }
  return arr
    .filter((h: any) => !isNoiseHit(h))
    .slice(0, 8)
    .map((h: any) => {
      if (typeof h === 'string') return `- ${h}`
      const file = h.file ?? h.path ?? h.location?.file ?? ''
      const line = h.start_line ?? h.line ?? h.startLine ?? h.location?.line ?? ''
      // search_code 真实结构：qualified_name / label；兼容旧字段 name/symbol
      const qualified = typeof h.qualified_name === 'string' ? h.qualified_name : ''
      const shortName = qualified ? qualified.split('.').slice(-2).join('.') : ''
      const name = h.name ?? h.symbol ?? shortName
      const kind = h.label ?? h.kind ?? h.type ?? ''
      const snippet = String(h.snippet ?? h.content ?? h.text ?? '').trim().split('\n')[0]?.slice(0, 120) ?? ''
      const parts = [
        file ? `\`${file}${line ? `:${line}` : ''}\`` : '',
        name ? `**${name}**` : '',
        kind ? `(${kind})` : '',
        snippet,
      ].filter(Boolean)
      return parts.length > 0 ? `- ${parts.join(' — ')}` : ''
    })
    .filter(Boolean)
}

/**
 * Engine B structural search for the stage. Harness 原则：检索增强是
 * 锦上添花，不能阻断交付——中文需求往往提取不出代码符号，grep 零命中
 * 是常态；只有图谱引擎本身不可用（项目未索引）才提示用户，其余情形
 * 返回空列表降级继续。返回值 null = 引擎不可用（附原因），[] = 无命中。
 */
async function codeSearchForStage(
  repoPath: string,
  stageId: string,
  requirement: string
): Promise<{ hits: string[]; unavailable?: string }> {
  const project = await resolveProjectName(undefined, repoPath)
  if (!project) return { hits: [], unavailable: '无法解析图谱项目名，可先在项目配置中完成代码索引' }
  // 查询策略（优先级从高到低）：
  //   1. 需求中的代码符号（camelCase/snake_case）
  //   2. 中文领域词的英文等价词（入库→inbound、条码→barcode…）
  //   3. 实在无词可用才退回阶段关键词（噪音大，保底）
  // 全部零命中则降级返回空（不报错）。
  const symbols = extractSymbols(requirement)
  const domainTerms = extractDomainTerms(requirement)
  const candidates = symbols.length > 0
    ? symbols.slice(0, 3)
    : domainTerms.length > 0
      ? domainTerms.slice(0, 4)
      : codeQueryForStage(stageId, requirement).split(/\s+/).slice(0, 2)
  for (const pattern of candidates) {
    if (!pattern) continue
    let res: unknown
    try {
      res = await getGraphEngine().call('search_code', {
        project,
        pattern,
        mode: 'compact',
        limit: 8,
      })
    } catch {
      return { hits: [], unavailable: '图谱引擎不可用，可先在项目配置中完成代码索引' }
    }
    const hits = searchHitsToLines(res)
    if (hits.length > 0) return { hits }
  }
  return { hits: [] }
}

/** Normalize a trace_path result for one symbol into readable lines. */
function traceToLines(sym: string, res: unknown): string[] {
  if (!res) return []
  if (typeof res === 'string') {
    return res.trim().split('\n').slice(0, 4).map((l) => `- ${sym}: ${l.trim()}`).filter(Boolean)
  }
  const obj = res as any
  const chain = obj.path ?? obj.calls ?? obj.chain ?? obj.nodes
  if (Array.isArray(chain) && chain.length > 0) {
    const names = chain.map((n: any) => (typeof n === 'string' ? n : n?.name ?? n?.function ?? n?.label ?? '?'))
    return [`- ${sym} 调用链：${names.join(' → ')}`]
  }
  return []
}

/** Call-chain impact for dev/review/auto-test stages (symbol-driven). */
async function traceContextForStage(
  repoPath: string,
  stageId: string,
  requirement: string
): Promise<string[]> {
  if (!['dev', 'review', 'auto-test'].includes(stageId)) return []
  const symbols = extractSymbols(requirement).slice(0, 3)
  if (symbols.length === 0) return []
  const project = await resolveProjectName(undefined, repoPath)
  if (!project) return []
  const lines: string[] = []
  for (const sym of symbols) {
    try {
      const res = await getGraphEngine().call('trace_path', {
        project,
        function_name: sym,
        direction: 'both',
        depth: 2,
        mode: 'calls',
      })
      lines.push(...traceToLines(sym, res))
    } catch { /* symbol has no call chain in the graph — skip */ }
  }
  return [...new Set(lines)].slice(0, 12)
}

/** Cross-service call edges (CROSS_HTTP_CALLS / CROSS_ASYNC_CALLS / CROSS_CHANNEL). */
async function crossRepoContext(repoPath: string): Promise<string[]> {
  const project = await resolveProjectName(undefined, repoPath)
  if (!project) return []
  try {
    const res = await getGraphEngine().call('query_graph', {
      project,
      query: "MATCH (a)-[r]->(b) WHERE type(r) STARTS WITH 'CROSS_' RETURN a.name AS source, type(r) AS rel, b.name AS target LIMIT 20",
      max_rows: 20,
    })
    const rows = Array.isArray(res) ? res : (res as any)?.rows ?? (res as any)?.results ?? []
    if (!Array.isArray(rows)) return []
    return rows
      .slice(0, 20)
      .map((row: any) => (row?.rel ? `- ${row.rel}: ${row.source ?? '?'} → ${row.target ?? '?'}` : ''))
      .filter(Boolean)
  } catch {
    // no CROSS_* edges (single-repo projects) is a normal state, not an error
    return []
  }
}

/** Engine A BM25 keyword search — supplemental retrieval next to engine B. */
async function keywordCodeSearch(
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
    return null // engine A index not built — engine B already reports clearly
  }
}

/**
 * Full code-intelligence section for the context package.
 * 降级而非中断：引擎不可用/无命中 ⇒ 返回带 note 的空结果，
 * 交付流程继续（harness：上下文缺失不应阻断交付）。
 */
async function collectCodeIntelligence(
  repoPath: string | undefined,
  stageId: string,
  requirement: string
): Promise<CodeIntelligence | null> {
  if (!repoPath) return null
  const { hits, unavailable } = await codeSearchForStage(repoPath, stageId, requirement)
  const [traces, crossEdges] = await Promise.all([
    traceContextForStage(repoPath, stageId, requirement),
    crossRepoContext(repoPath),
  ])
  const note = unavailable
    ?? (hits.length === 0 ? '图谱未命中相关代码（需求可能无直接代码符号），以下仅提供调用链与跨服务信息' : undefined)
  return { graphHits: hits, traces, crossEdges, note }
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
  codeIntel?: CodeIntelligence | null
}): string {
  const { stageId, projectName, requirement, upstream, knowledge, code, codeIntel } = input
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

  // 代码结构上下文（引擎 B 图谱：结构搜索 + 调用链 + 跨服务）
  if (codeIntel) {
    lines.push('## 代码结构上下文', '')
    if (codeIntel.note) lines.push(`> 说明：${codeIntel.note}`, '')
    lines.push('### 相关模块（结构搜索）', '')
    if (codeIntel.graphHits.length > 0) {
      lines.push(...codeIntel.graphHits, '')
    } else {
      lines.push('（本次未命中，可在项目配置中重建代码索引以提升命中率）', '')
    }
    if (codeIntel.traces.length > 0) {
      lines.push('### 调用链影响面', '')
      lines.push(...codeIntel.traces, '')
    }
    if (codeIntel.crossEdges.length > 0) {
      lines.push('### 跨服务调用', '')
      lines.push(...codeIntel.crossEdges, '')
    }
  }

  // 引擎 A 关键词补充命中（有则展示）
  if (code && code.length > 0) {
    lines.push('## 相关代码（关键词命中）', '')
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
  const code = await keywordCodeSearch(input.repoPath, stageId, requirement)
  // 引擎 B 代码智能：不可用/无命中时降级（note 标注），不阻断交付
  const codeIntel = await collectCodeIntelligence(input.repoPath, stageId, requirement)

  const markdown = renderContextMarkdown({ stageId, projectName, requirement, upstream, knowledge, code, codeIntel })
  const size = Buffer.byteLength(markdown, 'utf8')

  const result: ContextPackageResult = { markdown, size, upstream, knowledge, code, codeIntel }
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
