// ================================================================
//  Knowledge Service — the single adapter the rest of the sidecar
//  talks to (DESIGN Phase 3, fallback route after the Cognee POC
//  gate failed: no embeddable TS client usable without a real LLM).
//
//  Composition:
//    graphStore.ts   entities + ontology-validated edges (SQLite WAL)
//    vectorStore.ts  chunk embeddings (sqlite-vec) with BM25 fallback
//    seedOntology.ts write-time schema constraints
//
//  Activation model:
//    - configureKnowledge() arms the layer (index.ts does this at boot;
//      tests pass a temp db + fake embedder). Until then every safe*
//      helper is a no-op — graph execution never depends on this layer.
//    - failures inside safe* helpers degrade silently and surface as a
//      `knowledge/error` notification.
// ================================================================

import { getStageDefinition } from '../domain/stages.js'
import type { ChainItem } from '../domain/ontology.js'
import { GraphStore, defaultKnowledgeDbPath, type GraphEntity } from './graphStore.js'
import {
  VectorStore,
  createOpenAIEmbedder,
  createFakeEmbedder,
  type Embedder,
  type ChunkHit,
} from './vectorStore.js'
import { conceptForStage, upstreamStagesOf, resolveTraceRelation } from './seedOntology.js'

// ─── Public parameter/result shapes ─────────────────────────────

export interface RegisterDeliverableInput {
  projectId: string
  deliveryId: string
  stageId: string
  /** Ontology concept; defaults to the stage's concept in the chain. */
  type?: string
  title?: string
  content: string
  /** Upstream refs — entity ids or stage ids; empty → auto-link by chain. */
  derivedFrom?: string[]
  qualityScore?: number | null
  review?: { totalScore: number; suggestions: string[]; passed: boolean; dimensions?: Record<string, unknown> } | null
  source?: string
  flowConfig?: ChainItem[] | null
}

export interface RecallInput {
  projectId: string
  stageId: string
  query?: string
  deliveryId?: string | null
  topK?: number
}

export interface StageRecall {
  upstreamDeliverables: Array<{
    stage: string
    stageLabel: string
    entityId: string
    label: string
    snippet: string
    qualityScore: number | null
  }>
  relatedAssets: Array<ChunkHit & { label: string; type: string }>
  reflections: Array<{ entityId: string; stage: string | null; feedback: string; createdAt: string }>
  traceChain: ReturnType<GraphStore['getTraceabilityChain']>
}

export interface FeedbackInput {
  projectId: string
  stageId: string
  feedback: string
  diff?: string | null
  deliveryId?: string | null
}

export interface RegisterCodeModulesInput {
  projectId: string
  deliveryId?: string | null
  /** Stage the modules belong to; defaults to 'dev'. */
  stageId?: string
  modules: Array<{ file: string; lang?: string; symbolCount?: number; topSymbols?: string[] }>
  /** IMPLEMENTS target — entity id or stage id; empty → nearest upstream Deliverable. */
  implementsRef?: string | null
}

// ─── Service ────────────────────────────────────────────────────

export class KnowledgeService {
  readonly graph: GraphStore
  readonly vectors: VectorStore

  constructor(opts: { dbPath?: string; embedder?: Embedder | null; dim?: number } = {}) {
    this.graph = new GraphStore(opts.dbPath ?? defaultKnowledgeDbPath())
    this.vectors = new VectorStore(this.graph.db, opts.embedder ?? null, opts.dim ?? 64)
  }

  close(): void {
    this.graph.close()
  }

  // ─── register: entity + relations + vectors ──────────────────

  async registerDeliverable(input: RegisterDeliverableInput): Promise<{ entity: GraphEntity; linkedTo: string[] }> {
    const { projectId, deliveryId, stageId } = input
    if (!projectId || !stageId) throw new Error('registerDeliverable: projectId and stageId are required')
    const type = input.type ?? conceptForStage(stageId, input.flowConfig ?? null)
    const label = input.title ?? `${getStageDefinition(stageId)?.name ?? stageId}-${deliveryId}`

    // upsert on (deliveryId, stage, type) — same key the frontend uses
    const existing = this.graph
      .getEntities({ projectId, deliveryId, stageId, type })
      .at(-1)
    const properties = {
      title: input.title ?? label,
      content: input.content,
      qualityScore: input.qualityScore ?? input.review?.totalScore ?? null,
      status: 'generated',
      source: input.source ?? 'builtin',
      generatedAt: new Date().toISOString(),
    }
    const entity = existing
      ? this.graph.updateEntity(existing.id, { label, properties })!
      : this.graph.addEntity({ type, label, stageId, projectId, deliveryId, properties })

    // relations: explicit derivedFrom refs, else nearest upstream in the chain
    const linkedTo: string[] = []
    const refs = (input.derivedFrom ?? []).length > 0
      ? (input.derivedFrom ?? [])
      : this.nearestUpstreamRef(projectId, deliveryId, stageId, input.flowConfig ?? null)
    for (const ref of refs) {
      const target = this.resolveRef(ref, projectId, deliveryId)
      if (!target || target.id === entity.id) continue
      // ontology-correct relation for the endpoint pair (DERIVED_FROM /
      // IMPLEMENTS / VALIDATES / REVIEWS / …); REFERENCES for assets
      const relation = resolveTraceRelation(entity.type, target.type)
        ?? (entity.type === 'Deliverable' && target.type === 'KnowledgeAsset' ? 'REFERENCES' : null)
      if (!relation) continue
      this.graph.addEdge({ relation, sourceId: entity.id, targetId: target.id })
      linkedTo.push(target.id)
    }

    // review record → Review entity (+ REVIEWED_BY edge when ontology allows)
    if (input.review) {
      const reviewEntity = this.graph.addEntity({
        type: 'Review',
        label: `${stageId}-评审`,
        stageId,
        projectId,
        deliveryId,
        properties: {
          type: 'ai',
          score: input.review.totalScore,
          dimensions: input.review.dimensions ?? {},
          suggestions: input.review.suggestions,
          passed: input.review.passed,
          reviewer: 'AI',
        },
      })
      if (entity.type === 'Deliverable') {
        this.graph.addEdge({ relation: 'REVIEWED_BY', sourceId: entity.id, targetId: reviewEntity.id })
      }
    }

    await this.vectors.indexEntity({
      entityId: entity.id,
      projectId,
      stageId,
      text: `${label}\n${input.content}`,
    })

    return { entity, linkedTo }
  }

  private nearestUpstreamRef(
    projectId: string,
    deliveryId: string,
    stageId: string,
    flowConfig: ChainItem[] | null
  ): string[] {
    for (const item of upstreamStagesOf(stageId, flowConfig).reverse()) {
      const found = this.graph.getEntities({ projectId, deliveryId, stageId: item.stage })
      if (found.length > 0) return [found[found.length - 1].id]
    }
    return []
  }

  private resolveRef(ref: string, projectId: string, deliveryId: string): GraphEntity | null {
    const byId = this.graph.getEntity(ref)
    if (byId) return byId
    // treat the ref as a stage id within the same delivery
    const byStage = this.graph.getEntities({ projectId, deliveryId, stageId: ref })
    return byStage.length > 0 ? byStage[byStage.length - 1] : null
  }

  // ─── register: batch CodeModule entities (Phase 5 code index) ─

  /**
   * Registers file-level code modules as CodeModule entities in one
   * SQLite transaction (upsert by label within project/delivery) and
   * links each to an IMPLEMENTS target Deliverable when resolvable.
   * Vector indexing intentionally stays out of the hot path — module
   * text is tiny and indexed after the transaction commits.
   */
  async registerCodeModules(input: RegisterCodeModulesInput): Promise<{ registered: number; edges: number }> {
    const { projectId } = input
    if (!projectId || !Array.isArray(input.modules)) {
      throw new Error('registerCodeModules: projectId and modules are required')
    }
    const stageId = input.stageId ?? 'dev'
    const deliveryId = input.deliveryId ?? null

    // IMPLEMENTS target: explicit ref → entity/stage lookup; else the
    // latest Deliverable in the project (dev-plan by convention)
    let target: GraphEntity | null = null
    if (input.implementsRef) {
      target = this.resolveRef(input.implementsRef, projectId, deliveryId ?? '')
    } else {
      const deliverables = this.graph.getEntities({ projectId, type: 'Deliverable', ...(deliveryId ? { deliveryId } : {}) })
      target = deliverables.at(-1) ?? null
    }
    if (target && target.type !== 'Deliverable') target = null

    const existing = new Map<string, GraphEntity>()
    for (const e of this.graph.getEntities({ projectId, type: 'CodeModule' })) {
      existing.set(e.label, e)
    }

    let registered = 0
    let edges = 0
    const entities: GraphEntity[] = []
    const runBatch = this.graph.db.transaction(() => {
      for (const mod of input.modules) {
        if (!mod.file) continue
        const properties = {
          file: mod.file,
          lang: mod.lang ?? null,
          symbolCount: mod.symbolCount ?? null,
          topSymbols: mod.topSymbols ?? [],
          content: `${mod.file}\n${(mod.topSymbols ?? []).join(' ')}`,
          source: 'code-index',
        }
        const prev = existing.get(mod.file)
        const entity = prev
          ? this.graph.updateEntity(prev.id, { label: mod.file, properties })!
          : this.graph.addEntity({ type: 'CodeModule', label: mod.file, stageId, projectId, deliveryId, properties })
        registered += 1
        entities.push(entity)
        if (target && !prev) {
          this.graph.addEdge({ relation: 'IMPLEMENTS', sourceId: entity.id, targetId: target.id })
          edges += 1
        }
      }
    })
    runBatch()

    for (const entity of entities) {
      await this.vectors.indexEntity({
        entityId: entity.id,
        projectId,
        stageId,
        text: `${entity.label}\n${String(entity.properties.content ?? '')}`,
      })
    }
    return { registered, edges }
  }

  // ─── recall: stage context assembly ───────────────────────────

  async recallStageContext(input: RecallInput): Promise<StageRecall> {
    const { projectId, stageId } = input
    if (!projectId || !stageId) throw new Error('recallStageContext: projectId and stageId are required')
    const topK = input.topK ?? 5

    const upstreamDeliverables: StageRecall['upstreamDeliverables'] = []
    for (const item of upstreamStagesOf(stageId)) {
      const filter = { projectId, stageId: item.stage, ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}) }
      for (const e of this.graph.getEntities(filter)) {
        if (e.type === 'Review') continue
        upstreamDeliverables.push({
          stage: item.stage,
          stageLabel: item.label,
          entityId: e.id,
          label: e.label,
          snippet: String(e.properties.content ?? '').slice(0, 2000),
          qualityScore: (e.properties.qualityScore as number | null) ?? null,
        })
      }
    }

    const query = input.query?.trim() || getStageDefinition(stageId)?.name || stageId
    const hits = await this.vectors.search(query, { projectId, topK })
    const relatedAssets = hits.map((h) => {
      const e = this.graph.getEntity(h.entityId)
      return { ...h, label: e?.label ?? h.entityId, type: e?.type ?? 'Deliverable' }
    })

    const reflections = this.graph
      .getEntities({ projectId, type: 'KnowledgeAsset' })
      .filter((e) => e.properties.assetType === 'reflection' && (!e.stageId || e.stageId === stageId))
      .slice(-5)
      .map((e) => ({
        entityId: e.id,
        stage: e.stageId,
        feedback: String(e.properties.feedback ?? e.properties.content ?? ''),
        createdAt: e.createdAt,
      }))

    const traceChain = this.graph.getTraceabilityChain(projectId, input.deliveryId ?? null)

    return { upstreamDeliverables, relatedAssets, reflections, traceChain }
  }

  // ─── improve: reflection / edit-pattern memory ────────────────

  async improveFromFeedback(input: FeedbackInput): Promise<GraphEntity> {
    const { projectId, stageId, feedback } = input
    if (!projectId || !stageId) throw new Error('improveFromFeedback: projectId and stageId are required')
    const entity = this.graph.addEntity({
      type: 'KnowledgeAsset',
      label: `反思-${stageId}-${new Date().toISOString().slice(0, 10)}`,
      stageId,
      projectId,
      deliveryId: input.deliveryId ?? null,
      properties: {
        assetType: 'reflection',
        tags: ['reflection', stageId],
        feedback,
        diff: input.diff ?? null,
        content: feedback,
      },
    })
    await this.vectors.indexEntity({
      entityId: entity.id,
      projectId,
      stageId,
      text: `${entity.label}\n${feedback}\n${input.diff ?? ''}`,
    })
    return entity
  }

  // ─── search: hybrid graph + vector ────────────────────────────

  async searchGraph(input: { projectId: string; query: string; type?: string | null; topK?: number }): Promise<{
    backend: 'vector' | 'bm25'
    results: Array<{
      entityId: string
      label: string
      type: string
      stageId: string | null
      score: number
      matchedIn: string[]
      snippet: string
      relationCount: number
    }>
  }> {
    const topK = input.topK ?? 10
    const keyword = this.graph.search(input.query, input.projectId, input.type ?? null)
    const vector = await this.vectors.search(input.query, { projectId: input.projectId, topK })

    const merged = new Map<string, {
      entityId: string; label: string; type: string; stageId: string | null
      score: number; matchedIn: string[]; snippet: string; relationCount: number
    }>()

    for (const k of keyword) {
      merged.set(k.entity.id, {
        entityId: k.entity.id,
        label: k.entity.label,
        type: k.entity.type,
        stageId: k.entity.stageId,
        score: 1, // exact keyword match ranks at least as high as any vector hit
        matchedIn: k.matchedIn,
        snippet: String(k.entity.properties.content ?? '').slice(0, 300),
        relationCount: k.relationCount,
      })
    }
    for (const v of vector) {
      const e = this.graph.getEntity(v.entityId)
      if (!e) continue
      if (input.type && e.type !== input.type) continue
      const prev = merged.get(e.id)
      if (prev) {
        prev.score += v.score
        if (!prev.matchedIn.includes(v.backend)) prev.matchedIn.push(v.backend)
      } else {
        merged.set(e.id, {
          entityId: e.id,
          label: e.label,
          type: e.type,
          stageId: e.stageId,
          score: v.score,
          matchedIn: [v.backend],
          snippet: v.text.slice(0, 300),
          relationCount: this.graph.getRelations(e.id).length,
        })
      }
    }

    const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK)
    return { backend: this.vectors.backend, results }
  }

  // ─── stats ────────────────────────────────────────────────────

  getStats(input: { projectId?: string | null } = {}): ReturnType<GraphStore['getStats']> & {
    chunks: number
    backend: 'vector' | 'bm25'
  } {
    const stats = this.graph.getStats(input.projectId ?? null)
    return {
      ...stats,
      chunks: this.vectors.countChunks(input.projectId ?? null),
      backend: this.vectors.backend,
    }
  }
}

// ─── Module-level activation + safe hooks ───────────────────────

type Notifier = (method: string, params?: unknown) => void

interface KnowledgeConfig {
  dbPath?: string
  embedder?: Embedder | null
  dim?: number
  notify?: Notifier
}

let config: KnowledgeConfig | null = null
let instance: KnowledgeService | null = null
let initError: string | null = null

/** Builds the default embedder from env; null (BM25 mode) without creds. */
function embedderFromEnv(): { embedder: Embedder | null; dim: number } {
  const endpoint = process.env.FLOWFORGE_EMBEDDING_ENDPOINT
  const apiKey = process.env.FLOWFORGE_EMBEDDING_API_KEY
  const model = process.env.FLOWFORGE_EMBEDDING_MODEL || 'text-embedding-3-small'
  const dim = Number(process.env.FLOWFORGE_EMBEDDING_DIM) || 1536
  if (process.env.FLOWFORGE_EMBEDDING_FAKE === '1') return { embedder: createFakeEmbedder(64), dim: 64 }
  if (!endpoint || !apiKey) return { embedder: null, dim }
  return { embedder: createOpenAIEmbedder({ endpoint, apiKey, model, dimensions: dim }), dim }
}

/** Arms the knowledge layer. Until called, all safe* hooks are no-ops. */
export function configureKnowledge(opts: KnowledgeConfig = {}): void {
  if (instance) {
    try { instance.close() } catch { /* already closed */ }
  }
  config = opts
  instance = null
  initError = null
}

export function isKnowledgeConfigured(): boolean {
  return config !== null
}

/** Lazily builds the singleton; throws when unconfigured or init failed. */
export function getKnowledgeService(): KnowledgeService {
  if (!config) throw new Error('knowledge layer is not configured')
  if (initError) throw new Error(`knowledge layer init failed: ${initError}`)
  if (!instance) {
    try {
      const env = embedderFromEnv()
      instance = new KnowledgeService({
        dbPath: config.dbPath,
        embedder: config.embedder !== undefined ? config.embedder : env.embedder,
        dim: config.dim ?? (config.embedder !== undefined ? 64 : env.dim),
      })
    } catch (e) {
      initError = e instanceof Error ? e.message : String(e)
      throw new Error(`knowledge layer init failed: ${initError}`)
    }
  }
  return instance
}

/** Test/shutdown helper — closes and disarms the layer. */
export function resetKnowledge(): void {
  if (instance) {
    try { instance.close() } catch { /* already closed */ }
  }
  config = null
  instance = null
  initError = null
}

function reportError(op: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  try {
    config?.notify?.('knowledge/error', { op, message })
  } catch { /* notification channel itself must never throw */ }
}

// The safe* helpers are what stageNode's hook points call: any failure
// (including "not configured") degrades to a no-op so graph execution
// never depends on knowledge-layer health.

export async function safeRecall(input: RecallInput): Promise<StageRecall | null> {
  if (!isKnowledgeConfigured()) return null
  try {
    return await getKnowledgeService().recallStageContext(input)
  } catch (e) {
    reportError('recall', e)
    return null
  }
}

export async function safeRegister(input: RegisterDeliverableInput): Promise<void> {
  if (!isKnowledgeConfigured()) return
  try {
    await getKnowledgeService().registerDeliverable(input)
  } catch (e) {
    reportError('register', e)
  }
}

export async function safeImprove(input: FeedbackInput): Promise<void> {
  if (!isKnowledgeConfigured()) return
  try {
    await getKnowledgeService().improveFromFeedback(input)
  } catch (e) {
    reportError('improve', e)
  }
}

// ─── JSON-RPC method handlers (registered by index.ts) ──────────

export const knowledgeMethods = {
  /** { projectId, query, type?, topK? } → { backend, results } */
  'knowledge.search': async (params: any) => {
    const { projectId, query } = params ?? {}
    if (!projectId || !query) throw new Error('projectId and query are required')
    return getKnowledgeService().searchGraph({ projectId, query, type: params.type ?? null, topK: params.topK })
  },

  /** { projectId? } → entity/edge/chunk stats */
  'knowledge.stats': (params: any) => {
    return getKnowledgeService().getStats({ projectId: params?.projectId ?? null })
  },

  /** RegisterDeliverableInput → { entity, linkedTo } */
  'knowledge.register': async (params: any) => {
    return getKnowledgeService().registerDeliverable(params)
  },

  /** RegisterCodeModulesInput → { registered, edges } (Phase 5) */
  'knowledge.register_code_modules': async (params: any) => {
    return getKnowledgeService().registerCodeModules(params)
  },

  /** RecallInput → StageRecall */
  'knowledge.recall': async (params: any) => {
    return getKnowledgeService().recallStageContext(params)
  },
}
