// ================================================================
//  SDLC Graph — LangGraph.js StateGraph for the delivery pipeline
//
//  Default DAG (from domain/stages.ts, mirroring flowEngine.buildDefaultDAG):
//      req → brd → prd → (test ∥ dev-plan) → dev ─┐
//                            └────────────────────┴→ review → auto-test → deploy
//
//  - review is a fan-in node (defer: true) gated by interruptBefore
//  - conditional edge after review: pass → continue, reject → back to
//    the previous stage with retryCount+1 (capped at MAX_REVIEW_RETRIES)
//  - checkpoints persist through @langchain/langgraph-checkpoint-sqlite
// ================================================================

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Annotation, StateGraph, START, END, type CompiledStateGraph } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'
import { STAGE_DEFINITIONS } from '../domain/stages.js'
import { makeStageNode, type DagNodeDef, type StageNodeDeps } from './stageNode.js'

// ─── State (DESIGN-v3 §3.2) ─────────────────────────────────────

export interface StageResult {
  content: string
  reviewScore: number | null
  passed: boolean
  source: string
  at: string
}

export type ExecutionMode = 'builtin' | 'delegate' | 'manual'

// Reducers are written to tolerate parallel writes (test ∥ dev-plan update
// the same channels in one superstep) — plain LastValue would throw.
const lastWins = <T>(fallback: T) => ({
  reducer: (a: T, b: T | undefined) => (b === undefined ? a : b),
  default: () => fallback,
})

export const SDLCStateAnnotation = Annotation.Root({
  projectId: Annotation<string>(lastWins('')),
  deliveryId: Annotation<string>(lastWins('')),
  currentStage: Annotation<string>(lastWins('')),
  deliverable: Annotation<string | null>(lastWins<string | null>(null)),
  reviewScore: Annotation<number | null>(lastWins<number | null>(null)),
  reviewFeedback: Annotation<string | null>(lastWins<string | null>(null)),
  executionMode: Annotation<ExecutionMode>(lastWins<ExecutionMode>('builtin')),
  contextPackage: Annotation<Record<string, unknown> | null>(lastWins<Record<string, unknown> | null>(null)),
  reflectionLog: Annotation<unknown[]>({
    reducer: (a, b) => a.concat(Array.isArray(b) ? b : b === undefined ? [] : [b]),
    default: () => [],
  }),
  retryCount: Annotation<number>(lastWins(0)),
  /** Per-stage accumulated results — the source of truth for context assembly. */
  deliverables: Annotation<Record<string, StageResult>>({
    reducer: (a, b) => ({ ...a, ...(b ?? {}) }),
    default: () => ({}),
  }),
})

export type SDLCState = typeof SDLCStateAnnotation.State
export type SDLCUpdate = typeof SDLCStateAnnotation.Update

// ─── DAG definition & normalization ─────────────────────────────

export interface DagEdge {
  from?: string
  to?: string
  source?: string
  target?: string
}

/** Accepts flowEngine.js-shaped documents: nodes with dependsOn, optional edges array. */
export interface DagDefinition {
  id?: string
  name?: string
  nodes: Array<Partial<DagNodeDef> & { id?: string; stageId?: string }>
  edges?: DagEdge[]
}

export const MAX_REVIEW_RETRIES = 3

/** Default 9-stage DAG mirroring flowEngine.buildDefaultDAG (PRD → test ∥ dev-plan). */
export function defaultDag(): DagDefinition {
  const nodes = STAGE_DEFINITIONS.map((s, idx) => ({
    id: `node_${s.id}`,
    stageId: s.id,
    label: s.shortName || s.name,
    dependsOn: idx === 0 ? [] : [`node_${STAGE_DEFINITIONS[idx - 1].id}`],
    config: {
      gate: { aiReview: s.hasAiReview, humanReview: false, manualTrigger: true, threshold: 75 },
      guidance: { ...s.guidance },
      temperature: s.defaultConfig.temperature,
    },
  }))

  const byStage = (id: string) => nodes.find((n) => n.stageId === id)
  const prd = byStage('prd')
  const test = byStage('test')
  const devPlan = byStage('dev-plan')
  const dev = byStage('dev')
  const review = byStage('review')
  if (prd && test && devPlan) {
    test.dependsOn = [prd.id]
    devPlan.dependsOn = [prd.id]
    if (dev) dev.dependsOn = [devPlan.id]
    if (review) review.dependsOn = [test.id, dev ? dev.id : devPlan.id]
  }

  return { id: 'dag_default', name: '标准交付流程', nodes }
}

/**
 * Normalizes a raw DAG document into graph-ready nodes:
 * - resolves dependsOn / edges from raw node ids to stage ids
 * - ensures unique graph node names (stageId, suffixed on collision)
 */
export function normalizeDag(dag: DagDefinition): DagNodeDef[] {
  const rawNodes = dag.nodes ?? []
  if (rawNodes.length === 0) throw new Error('DAG has no nodes')

  // raw id → graph name (stage id, deduped)
  const used = new Set<string>()
  const nameByRawId = new Map<string, string>()
  const normalized: DagNodeDef[] = rawNodes.map((n, idx) => {
    const rawId = n.id ?? `node_${idx}`
    let name = n.stageId && n.stageId !== 'custom' ? n.stageId : rawId
    while (used.has(name)) name = `${name}_${idx}`
    used.add(name)
    nameByRawId.set(rawId, name)
    return {
      id: rawId,
      stageId: name,
      label: n.label,
      dependsOn: [...(n.dependsOn ?? [])],
      config: n.config as DagNodeDef['config'],
    }
  })

  // merge edges array (if provided) into dependsOn
  for (const e of dag.edges ?? []) {
    const from = e.from ?? e.source
    const to = e.to ?? e.target
    if (!from || !to) continue
    const target = normalized.find((n) => n.id === to || n.stageId === to)
    if (target && !target.dependsOn.includes(from)) target.dependsOn.push(from)
  }

  // resolve dependsOn raw ids → graph names, drop unknown refs
  for (const n of normalized) {
    n.dependsOn = n.dependsOn
      .map((dep) => nameByRawId.get(dep) ?? (used.has(dep) ? dep : null))
      .filter((d): d is string => d !== null)
  }

  return normalized
}

// ─── SQLite business-db loader (dags table, graceful fallback) ──

/**
 * Reads the latest DAG for a project from the business SQLite db
 * (table: dags(id, project_id, nodes_json, edges_json, ...)).
 * Returns null when the db/table/row is missing or unreadable —
 * callers fall back to defaultDag().
 */
export function loadDagFromDb(dbPath: string, projectId: string): DagDefinition | null {
  if (!dbPath || !fs.existsSync(dbPath)) return null
  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare('SELECT id, nodes_json, edges_json FROM dags WHERE project_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(projectId) as { id: string; nodes_json: string; edges_json: string | null } | undefined
    if (!row) return null
    const nodes = JSON.parse(row.nodes_json)
    const edges = row.edges_json ? JSON.parse(row.edges_json) : undefined
    if (!Array.isArray(nodes) || nodes.length === 0) return null
    return { id: row.id, nodes, edges }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

// ─── Checkpoint db path ─────────────────────────────────────────

export function defaultCheckpointDbPath(): string {
  const dir = process.env.FLOWFORGE_DATA_DIR || path.join(os.homedir(), '.flowforge')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'checkpoints.db')
}

export function createCheckpointer(dbPath?: string): SqliteSaver {
  const target = dbPath ?? defaultCheckpointDbPath()
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true })
  return SqliteSaver.fromConnString(target)
}

export function threadIdFor(projectId: string, deliveryId: string): string {
  return `${projectId}_${deliveryId}`
}

// ─── Graph builder ──────────────────────────────────────────────

export interface BuildGraphOptions {
  /** Pre-built checkpointer; defaults to SqliteSaver at defaultCheckpointDbPath(). */
  checkpointer?: SqliteSaver
  checkpointDbPath?: string
}

export type SdlcGraph = CompiledStateGraph<any, any, any>

export function buildSdlcGraph(
  dag: DagDefinition | null | undefined,
  deps: StageNodeDeps,
  options: BuildGraphOptions = {}
): SdlcGraph {
  const nodes = normalizeDag(dag ?? defaultDag())
  const nodeNames = new Set(nodes.map((n) => n.stageId))

  const graph = new StateGraph(SDLCStateAnnotation) as any

  // nodes — fan-in nodes get defer:true so they wait for all branches
  for (const n of nodes) {
    graph.addNode(n.stageId, makeStageNode(n, deps), n.dependsOn.length > 1 ? { defer: true } : undefined)
  }

  // successor map for routing
  const successors = new Map<string, string[]>()
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      const list = successors.get(dep) ?? []
      list.push(n.stageId)
      successors.set(dep, list)
    }
  }

  // edges
  const reviewNode = nodes.find((n) => n.stageId === 'review')
  for (const n of nodes) {
    if (n.dependsOn.length === 0) graph.addEdge(START, n.stageId)
    for (const dep of n.dependsOn) {
      // outgoing edges of the review node are replaced by the conditional router below
      if (reviewNode && dep === 'review') continue
      graph.addEdge(dep, n.stageId)
    }
  }
  for (const n of nodes) {
    if (n.stageId === 'review') continue
    if (!successors.has(n.stageId)) graph.addEdge(n.stageId, END)
  }

  // conditional routing after review: pass → continue; reject → previous stage
  if (reviewNode) {
    const next = successors.get('review') ?? []
    const threshold = reviewNode.config?.gate?.threshold ?? 75
    // "previous stage" = the review node's deepest predecessor: prefer the
    // dev branch over the parallel test branch (dev is what gets reworked)
    const preds = reviewNode.dependsOn.filter((d) => nodeNames.has(d))
    const retryTarget = preds.includes('dev') ? 'dev' : preds[preds.length - 1] ?? null

    graph.addConditionalEdges(
      'review',
      (state: SDLCState) => {
        const score = state.reviewScore
        const rejected = score !== null && score < threshold
        if (rejected && retryTarget && state.retryCount <= MAX_REVIEW_RETRIES) {
          deps.notify('graph/review_rejected', {
            score,
            threshold,
            retryCount: state.retryCount,
            retryTarget,
          })
          return retryTarget
        }
        return next.length > 0 ? next : END
      },
      [...new Set([...next, ...(retryTarget ? [retryTarget] : []), END])]
    )
  }

  const checkpointer = options.checkpointer ?? createCheckpointer(options.checkpointDbPath)
  return graph.compile({
    checkpointer,
    // human gate: pause before the review node so the host decides when to proceed
    interruptBefore: nodeNames.has('review') ? ['review'] : [],
  }) as SdlcGraph
}
