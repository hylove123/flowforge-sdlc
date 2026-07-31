// ================================================================
//  Knowledge Graph Engine
//
//  Manages entities (nodes) and relations (edges) based on the
//  ontology schema. Provides query, traversal, and traceability
//  chain capabilities.
//
//  IMPORTANT: The traceability chain is NOT hardcoded here.
//  All chain-based methods accept a `flowConfig` parameter that
//  comes from the project's custom delivery flow configuration.
//  If no flowConfig is provided, falls back to DEFAULT_TRACEABILITY_CHAIN.
// ================================================================

import {
  CONCEPTS, RELATIONS,
  DEFAULT_TRACEABILITY_CHAIN, ONTOLOGY_RULES, getConcept,
} from '@/data/ontology'
import { storage } from '@/adapters/StorageService'

const GRAPH_KEY = 'flowforge_knowledge_graph'

// ─── Graph Storage ──────────────────────────────────────────────

function loadGraph() {
  return storage.getJSON(GRAPH_KEY, { entities: [], edges: [] })
}

function saveGraph(graph) {
  storage.setJSON(GRAPH_KEY, graph)
}

function resolveFlow(flowConfig) {
  if (!flowConfig || !Array.isArray(flowConfig) || flowConfig.length === 0) {
    return DEFAULT_TRACEABILITY_CHAIN
  }
  return flowConfig
}

// ─── Graph Class ────────────────────────────────────────────────

class KnowledgeGraph {
  constructor() {
    this.graph = loadGraph()
  }

  _reload() {
    this.graph = loadGraph()
  }

  _persist() {
    saveGraph(this.graph)
  }

  // ─── Entity CRUD ──────────────────────────────────────────────

  addEntity({ concept, projectId, deliveryId, label, stage, properties = {} }) {
    this._reload()
    const entity = {
      id: `entity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      concept,
      projectId: projectId || null,
      deliveryId: deliveryId || null,
      label: label || `${concept}-${Date.now()}`,
      stage: stage || null,
      properties,
      createdAt: new Date().toISOString(),
    }
    this.graph.entities.push(entity)
    this._persist()
    return entity
  }

  updateEntity(id, updates) {
    this._reload()
    const idx = this.graph.entities.findIndex(e => e.id === id)
    if (idx >= 0) {
      this.graph.entities[idx] = {
        ...this.graph.entities[idx],
        ...updates,
        properties: { ...this.graph.entities[idx].properties, ...(updates.properties || {}) },
      }
      this._persist()
      return this.graph.entities[idx]
    }
    return null
  }

  deleteEntity(id) {
    this._reload()
    this.graph.edges = this.graph.edges.filter(e => e.sourceId !== id && e.targetId !== id)
    this.graph.entities = this.graph.entities.filter(e => e.id !== id)
    this._persist()
  }

  getEntity(id) {
    this._reload()
    return this.graph.entities.find(e => e.id === id)
  }

  getEntities(filter = {}) {
    this._reload()
    return this.graph.entities.filter(e => {
      if (filter.concept && e.concept !== filter.concept) return false
      if (filter.projectId && e.projectId !== filter.projectId) return false
      if (filter.deliveryId && e.deliveryId !== filter.deliveryId) return false
      if (filter.stage && e.stage !== filter.stage) return false
      return true
    })
  }

  getEntitiesByConcept(concept) {
    return this.getEntities({ concept })
  }

  getEntitiesByStage(stage) {
    return this.getEntities({ stage })
  }

  getEntitiesByProject(projectId) {
    return this.getEntities({ projectId })
  }

  getEntitiesByDelivery(deliveryId) {
    return this.getEntities({ deliveryId })
  }

  // ─── Edge CRUD ────────────────────────────────────────────────

  addEdge({ relation, sourceId, targetId, projectId, properties = {} }) {
    this._reload()
    const exists = this.graph.edges.some(e =>
      e.relation === relation && e.sourceId === sourceId && e.targetId === targetId
    )
    if (exists) return null

    const edge = {
      id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      relation,
      sourceId,
      targetId,
      projectId: projectId || null,
      properties,
      createdAt: new Date().toISOString(),
    }
    this.graph.edges.push(edge)
    this._persist()

    const relDef = RELATIONS[relation]
    if (relDef && relDef.inverse) {
      const inverseEdge = {
        ...edge,
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        relation: relDef.inverse,
        sourceId: targetId,
        targetId: sourceId,
      }
      this.graph.edges.push(inverseEdge)
      this._persist()
    }

    return edge
  }

  deleteEdge(id) {
    this._reload()
    const edge = this.graph.edges.find(e => e.id === id)
    if (edge) {
      const relDef = RELATIONS[edge.relation]
      if (relDef && relDef.inverse) {
        this.graph.edges = this.graph.edges.filter(e =>
          !(e.id === id ||
            (e.relation === relDef.inverse &&
             e.sourceId === edge.targetId &&
             e.targetId === edge.sourceId))
        )
      } else {
        this.graph.edges = this.graph.edges.filter(e => e.id !== id)
      }
      this._persist()
    }
  }

  getEdges(filter = {}) {
    this._reload()
    return this.graph.edges.filter(e => {
      if (filter.relation && e.relation !== filter.relation) return false
      if (filter.sourceId && e.sourceId !== filter.sourceId) return false
      if (filter.targetId && e.targetId !== filter.targetId) return false
      if (filter.projectId && e.projectId !== filter.projectId) return false
      return true
    })
  }

  getRelations(entityId, relationType = null) {
    this._reload()
    const filter = { sourceId: entityId }
    if (relationType) filter.relation = relationType
    const edges = this.getEdges(filter)
    return edges.map(edge => ({
      ...edge,
      relationDef: RELATIONS[edge.relation],
      target: this.getEntity(edge.targetId),
    })).filter(r => r.target)
  }

  getIncomingRelations(entityId, relationType = null) {
    this._reload()
    const filter = { targetId: entityId }
    if (relationType) filter.relation = relationType
    const edges = this.getEdges(filter)
    return edges.map(edge => ({
      ...edge,
      relationDef: RELATIONS[edge.relation],
      source: this.getEntity(edge.sourceId),
    })).filter(r => r.source)
  }

  // ─── Traceability Chain ───────────────────────────────────────
  // Builds the traceability chain based on the project's FLOW CONFIG.
  // flowConfig: array of { stage, concept, label } from project config.
  // If not provided, uses DEFAULT_TRACEABILITY_CHAIN.

  getTraceabilityChain(projectId, deliveryId = null, flowConfig = null) {
    this._reload()
    const chain = resolveFlow(flowConfig)
    const result = []

    chain.forEach((chainItem, idx) => {
      const filter = { stage: chainItem.stage, concept: chainItem.concept }
      if (projectId) filter.projectId = projectId
      if (deliveryId) filter.deliveryId = deliveryId

      const entities = this.getEntities(filter)
      const prevItem = idx > 0 ? result[idx - 1] : null

      const stageEntry = {
        ...chainItem,
        entities: entities.map(entity => ({
          ...entity,
          conceptDef: getConcept(entity.concept),
          relations: this.getRelations(entity.id),
          incomingRelations: this.getIncomingRelations(entity.id),
        })),
        linked: entities.length > 0,
        linkedToPrev: false,
      }

      if (prevItem && prevItem.entities.length > 0 && entities.length > 0) {
        const hasLink = this.graph.edges.some(e =>
          (e.sourceId === prevItem.entities[0]?.id && e.targetId === entities[0]?.id) ||
          (e.targetId === prevItem.entities[0]?.id && e.sourceId === entities[0]?.id)
        )
        stageEntry.linkedToPrev = hasLink
      }

      result.push(stageEntry)
    })

    return result
  }

  // ─── Graph Stats ──────────────────────────────────────────────

  getStats(projectId = null) {
    this._reload()
    let entities = this.graph.entities
    let edges = this.graph.edges
    if (projectId) {
      entities = entities.filter(e => e.projectId === projectId)
      const entityIds = new Set(entities.map(e => e.id))
      edges = edges.filter(e => entityIds.has(e.sourceId) || entityIds.has(e.targetId))
    }

    const byConcept = {}
    Object.keys(CONCEPTS).forEach(c => { byConcept[c] = 0 })
    entities.forEach(e => { byConcept[e.concept] = (byConcept[e.concept] || 0) + 1 })

    const byStage = {}
    entities.forEach(e => {
      if (e.stage) byStage[e.stage] = (byStage[e.stage] || 0) + 1
    })

    const traceabilityEdges = edges.filter(e => RELATIONS[e.relation]?.traceability)

    return {
      totalEntities: entities.length,
      totalEdges: edges.length,
      traceabilityEdges: traceabilityEdges.length,
      byConcept,
      byStage,
      conceptCount: Object.values(byConcept).filter(c => c > 0).length,
    }
  }

  // ─── Rule Evaluation ──────────────────────────────────────────
  // context: { flowConfig, targetStage, ... } — project-specific

  evaluateRules(entityId, context = {}) {
    this._reload()
    return ONTOLOGY_RULES.map(rule => {
      try {
        const result = rule.condition(this, entityId, context)
        return { ...rule, ...result }
      } catch (e) {
        return { ...rule, passed: true, error: e.message }
      }
    })
  }

  // ─── Context Injection for AI ─────────────────────────────────
  // Gathers upstream deliverable content based on the project's FLOW CONFIG.

  getAIContext(projectId, stageId, deliveryId = null, flowConfig = null) {
    this._reload()
    const chain = resolveFlow(flowConfig)
    const targetIdx = chain.findIndex(c => c.stage === stageId)
    if (targetIdx <= 0) return { context: [], summary: '' }

    const upstreamStages = chain.slice(0, targetIdx)
    const context = []

    upstreamStages.forEach(item => {
      const filter = { stage: item.stage, concept: item.concept }
      if (projectId) filter.projectId = projectId
      if (deliveryId) filter.deliveryId = deliveryId

      const entities = this.getEntities(filter)
      entities.forEach(entity => {
        const content = entity.properties.content || ''
        if (content.trim()) {
          context.push({
            stage: item.stage,
            stageLabel: item.label,
            entityId: entity.id,
            entityLabel: entity.label,
            concept: entity.concept,
            content: content.slice(0, 2000),
            qualityScore: entity.properties.qualityScore,
          })
        }
      })
    })

    const summary = context.length > 0
      ? `已注入 ${context.length} 个上游交付物作为上下文：${context.map(c => `${c.stageLabel}(${c.entityLabel})`).join('、')}`
      : '暂无上游交付物上下文'

    return { context, summary }
  }

  // ─── Search ───────────────────────────────────────────────────

  search(query, projectId = null) {
    this._reload()
    if (!query || !query.trim()) return []
    const q = query.toLowerCase()

    const matchingEntities = this.graph.entities.filter(e => {
      if (projectId && e.projectId !== projectId) return false
      const label = (e.label || '').toLowerCase()
      const content = (e.properties.content || '').toLowerCase()
      const title = (e.properties.title || '').toLowerCase()
      return label.includes(q) || content.includes(q) || title.includes(q)
    })

    return matchingEntities.map(entity => {
      const conceptDef = getConcept(entity.concept)
      const relations = this.getRelations(entity.id)
      return {
        entity,
        conceptDef,
        relationCount: relations.length,
        relations,
      }
    })
  }

  // ─── Register entities from delivery flow ─────────────────────
  // When a deliverable is generated, register it in the graph.
  // Uses flowConfig to determine the concept type for this stage.

  registerDeliverable({ projectId, deliveryId, stageId, label, content, qualityScore, author, flowConfig = null, concept = null }) {
    this._reload()

    // Determine concept: use explicit concept, or look up from flowConfig
    let entityConcept = concept
    if (!entityConcept) {
      const chain = resolveFlow(flowConfig)
      const chainItem = chain.find(c => c.stage === stageId)
      entityConcept = chainItem?.concept || 'Deliverable'
    }

    // Check if entity already exists for this delivery+stage
    const existing = this.graph.entities.find(e =>
      e.deliveryId === deliveryId && e.stage === stageId && e.concept === entityConcept
    )

    if (existing) {
      const updated = this.updateEntity(existing.id, {
        label: label || existing.label,
        properties: { content, qualityScore, author, status: 'generated' },
      })
      return updated
    }

    const entity = this.addEntity({
      concept: entityConcept,
      projectId,
      deliveryId,
      label: label || `${stageId}-deliverable`,
      stage: stageId,
      properties: { content, qualityScore, author, status: 'generated' },
    })

    // Auto-link to upstream entity
    this._autoLinkUpstream(entity, projectId, deliveryId, flowConfig)

    return entity
  }

  registerReview({ projectId, deliveryId, stageId, entityId, review }) {
    this._reload()

    const reviewEntity = this.addEntity({
      concept: 'Review',
      projectId,
      deliveryId,
      label: `${stageId}-评审-${new Date().toLocaleDateString('zh-CN')}`,
      stage: stageId,
      properties: {
        type: review.type || 'ai',
        score: review.totalScore,
        dimensions: review.dimensions,
        suggestions: review.suggestions,
        passed: review.passed,
        reviewer: review.reviewer || 'AI',
      },
    })

    if (entityId) {
      this.addEdge({
        relation: 'REVIEWED_BY',
        sourceId: entityId,
        targetId: reviewEntity.id,
        projectId,
      })
    }

    return reviewEntity
  }

  _autoLinkUpstream(entity, projectId, deliveryId, flowConfig = null) {
    const chain = resolveFlow(flowConfig)
    const currentIdx = chain.findIndex(c => c.stage === entity.stage)
    if (currentIdx <= 0) return

    // Find the most recent upstream entity (any concept)
    for (let i = currentIdx - 1; i >= 0; i--) {
      const upstreamStage = chain[i]
      const upstreamEntities = this.getEntities({
        stage: upstreamStage.stage,
        projectId,
        deliveryId,
      })

      if (upstreamEntities.length > 0) {
        const upstream = upstreamEntities[0]
        // Create DERIVED_FROM edge: current -> upstream
        this.addEdge({
          relation: 'DERIVED_FROM',
          sourceId: entity.id,
          targetId: upstream.id,
          projectId,
        })
        break
      }
    }
  }

  // ─── Clear ────────────────────────────────────────────────────

  clearProject(projectId) {
    this._reload()
    const entityIds = new Set(
      this.graph.entities.filter(e => e.projectId === projectId).map(e => e.id)
    )
    this.graph.entities = this.graph.entities.filter(e => e.projectId !== projectId)
    this.graph.edges = this.graph.edges.filter(e =>
      !entityIds.has(e.sourceId) && !entityIds.has(e.targetId)
    )
    this._persist()
  }

  clearAll() {
    this.graph = { entities: [], edges: [] }
    this._persist()
  }

  // ─── Export for visualization ─────────────────────────────────

  exportForVisualization(projectId = null) {
    this._reload()
    let entities = this.graph.entities
    let edges = this.graph.edges

    if (projectId) {
      entities = entities.filter(e => e.projectId === projectId)
      const entityIds = new Set(entities.map(e => e.id))
      edges = edges.filter(e => entityIds.has(e.sourceId) && entityIds.has(e.targetId))
    }

    const nodes = entities.map(e => {
      const conceptDef = getConcept(e.concept)
      return {
        id: e.id,
        label: e.label,
        concept: e.concept,
        conceptLabel: conceptDef?.label || e.concept,
        color: conceptDef?.color || '#999',
        icon: conceptDef?.icon || 'Circle',
        stage: e.stage,
        properties: e.properties,
      }
    })

    const links = edges.map(e => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      relation: e.relation,
      label: RELATIONS[e.relation]?.label || e.relation,
      color: RELATIONS[e.relation]?.color || '#999',
      traceability: RELATIONS[e.relation]?.traceability || false,
    }))

    return { nodes, links }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let graphInstance = null

export function getKnowledgeGraph() {
  if (!graphInstance) {
    graphInstance = new KnowledgeGraph()
  }
  return graphInstance
}

// ─── Convenience exports (all accept flowConfig) ────────────────

export function getGraphStats(projectId) {
  return getKnowledgeGraph().getStats(projectId)
}

export function getTraceabilityChain(projectId, deliveryId, flowConfig = null) {
  return getKnowledgeGraph().getTraceabilityChain(projectId, deliveryId, flowConfig)
}

export function getAIContext(projectId, stageId, deliveryId, flowConfig = null) {
  return getKnowledgeGraph().getAIContext(projectId, stageId, deliveryId, flowConfig)
}

export function searchGraph(query, projectId) {
  return getKnowledgeGraph().search(query, projectId)
}

export function exportGraph(projectId) {
  return getKnowledgeGraph().exportForVisualization(projectId)
}
