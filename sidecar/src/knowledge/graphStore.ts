// ================================================================
//  Graph Store — sidecar knowledge graph on better-sqlite3
//
//  TS port of the src/services/graph.js CRUD / traceability logic
//  (the localStorage original stays untouched for web mode).
//
//  Schema is aligned with src-tauri/src/db/schema.sql:
//    graph_entities(id, type, label, stage_id, properties_json, project_id, ...)
//    graph_edges(id, source_id, target_id, relation, properties_json, ...)
//  but lives in its own db file: ${FLOWFORGE_DATA_DIR||~/.flowforge}/knowledge.db
//  (WAL mode, single-writer sidecar process).
//
//  Every write is validated against seedOntology (concepts/relations
//  are hard constraints; traceability edges enforce endpoint types).
// ================================================================

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { CONCEPTS, RELATIONS, DEFAULT_TRACEABILITY_CHAIN, type ChainItem } from '../domain/ontology.js'
import { assertConcept, assertEdge, inverseOf } from './seedOntology.js'

// ─── Types ──────────────────────────────────────────────────────

export interface GraphEntity {
  id: string
  type: string
  label: string
  stageId: string | null
  projectId: string | null
  /** deliveryId + content + qualityScore + … live in properties. */
  properties: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface GraphEdge {
  id: string
  sourceId: string
  targetId: string
  relation: string
  properties: Record<string, unknown>
  createdAt: string
}

export interface EntityFilter {
  type?: string
  projectId?: string
  deliveryId?: string
  stageId?: string
}

interface EntityRow {
  id: string
  type: string
  label: string
  stage_id: string | null
  properties_json: string
  project_id: string | null
  created_at: string
  updated_at: string
}

interface EdgeRow {
  id: string
  source_id: string
  target_id: string
  relation: string
  properties_json: string
  created_at: string
}

// ─── Paths & schema ─────────────────────────────────────────────

export function defaultKnowledgeDir(): string {
  const dir = process.env.FLOWFORGE_DATA_DIR || path.join(os.homedir(), '.flowforge')
  return path.join(dir, 'knowledge')
}

export function defaultKnowledgeDbPath(): string {
  return path.join(defaultKnowledgeDir(), 'knowledge.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_entities (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  label           TEXT DEFAULT '',
  stage_id        TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  project_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_entities_project ON graph_entities(project_id, type);
CREATE INDEX IF NOT EXISTS idx_graph_entities_stage ON graph_entities(project_id, stage_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  relation        TEXT NOT NULL,
  properties_json TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
`

function rowToEntity(row: EntityRow): GraphEntity {
  let properties: Record<string, unknown> = {}
  try { properties = JSON.parse(row.properties_json) } catch { /* keep {} */ }
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    stageId: row.stage_id,
    projectId: row.project_id,
    properties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToEdge(row: EdgeRow): GraphEdge {
  let properties: Record<string, unknown> = {}
  try { properties = JSON.parse(row.properties_json) } catch { /* keep {} */ }
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
    properties,
    createdAt: row.created_at,
  }
}

// ─── Store ──────────────────────────────────────────────────────

export class GraphStore {
  readonly db: InstanceType<typeof Database>

  constructor(dbPath: string = defaultKnowledgeDbPath()) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ─── Entity CRUD ──────────────────────────────────────────────

  addEntity(input: {
    type: string
    label?: string
    stageId?: string | null
    projectId?: string | null
    deliveryId?: string | null
    properties?: Record<string, unknown>
  }): GraphEntity {
    assertConcept(input.type)
    const id = `entity_${randomUUID()}`
    const properties = { ...(input.properties ?? {}) }
    if (input.deliveryId) properties.deliveryId = input.deliveryId
    this.db.prepare(
      `INSERT INTO graph_entities (id, type, label, stage_id, properties_json, project_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.type, input.label ?? `${input.type}-${Date.now()}`,
      input.stageId ?? null, JSON.stringify(properties), input.projectId ?? null)
    return this.getEntity(id)!
  }

  updateEntity(id: string, updates: { label?: string; properties?: Record<string, unknown> }): GraphEntity | null {
    const existing = this.getEntity(id)
    if (!existing) return null
    const merged = { ...existing.properties, ...(updates.properties ?? {}) }
    this.db.prepare(
      `UPDATE graph_entities
       SET label = ?, properties_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(updates.label ?? existing.label, JSON.stringify(merged), id)
    return this.getEntity(id)
  }

  getEntity(id: string): GraphEntity | null {
    const row = this.db.prepare('SELECT * FROM graph_entities WHERE id = ?').get(id) as EntityRow | undefined
    return row ? rowToEntity(row) : null
  }

  getEntities(filter: EntityFilter = {}): GraphEntity[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.type) { where.push('type = ?'); args.push(filter.type) }
    if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId) }
    if (filter.stageId) { where.push('stage_id = ?'); args.push(filter.stageId) }
    if (filter.deliveryId) {
      where.push(`json_extract(properties_json, '$.deliveryId') = ?`)
      args.push(filter.deliveryId)
    }
    const sql = `SELECT * FROM graph_entities${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`
    return (this.db.prepare(sql).all(...args) as EntityRow[]).map(rowToEntity)
  }

  // ─── Edge CRUD ────────────────────────────────────────────────

  /**
   * Inserts the edge plus its ontology inverse (mirrors graph.js).
   * Ontology-validated; returns null when the same edge already exists.
   */
  addEdge(input: {
    relation: string
    sourceId: string
    targetId: string
    properties?: Record<string, unknown>
  }): GraphEdge | null {
    const source = this.getEntity(input.sourceId)
    const target = this.getEntity(input.targetId)
    if (!source) throw new Error(`addEdge: source entity ${input.sourceId} not found`)
    if (!target) throw new Error(`addEdge: target entity ${input.targetId} not found`)
    assertEdge(input.relation, source.type, target.type)

    const dup = this.db.prepare(
      'SELECT id FROM graph_edges WHERE relation = ? AND source_id = ? AND target_id = ?'
    ).get(input.relation, input.sourceId, input.targetId)
    if (dup) return null

    const id = `edge_${randomUUID()}`
    const props = JSON.stringify(input.properties ?? {})
    const insert = this.db.prepare(
      `INSERT INTO graph_edges (id, source_id, target_id, relation, properties_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    insert.run(id, input.sourceId, input.targetId, input.relation, props)

    const inverse = inverseOf(input.relation)
    if (inverse) {
      insert.run(`edge_${randomUUID()}`, input.targetId, input.sourceId, inverse, props)
    }
    const row = this.db.prepare('SELECT * FROM graph_edges WHERE id = ?').get(id) as EdgeRow
    return rowToEdge(row)
  }

  getEdges(filter: { relation?: string; sourceId?: string; targetId?: string } = {}): GraphEdge[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.relation) { where.push('relation = ?'); args.push(filter.relation) }
    if (filter.sourceId) { where.push('source_id = ?'); args.push(filter.sourceId) }
    if (filter.targetId) { where.push('target_id = ?'); args.push(filter.targetId) }
    const sql = `SELECT * FROM graph_edges${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`
    return (this.db.prepare(sql).all(...args) as EdgeRow[]).map(rowToEdge)
  }

  getRelations(entityId: string, relationType: string | null = null): Array<GraphEdge & { target: GraphEntity }> {
    const edges = this.getEdges({ sourceId: entityId, ...(relationType ? { relation: relationType } : {}) })
    return edges
      .map((e) => ({ ...e, target: this.getEntity(e.targetId) }))
      .filter((e): e is GraphEdge & { target: GraphEntity } => e.target !== null)
  }

  getIncomingRelations(entityId: string, relationType: string | null = null): Array<GraphEdge & { source: GraphEntity }> {
    const edges = this.getEdges({ targetId: entityId, ...(relationType ? { relation: relationType } : {}) })
    return edges
      .map((e) => ({ ...e, source: this.getEntity(e.sourceId) }))
      .filter((e): e is GraphEdge & { source: GraphEntity } => e.source !== null)
  }

  // ─── Traceability chain (port of graph.js getTraceabilityChain) ──

  getTraceabilityChain(
    projectId: string,
    deliveryId: string | null = null,
    flowConfig: ChainItem[] | null = null
  ): Array<ChainItem & { entities: GraphEntity[]; linked: boolean; linkedToPrev: boolean }> {
    const chain = flowConfig && flowConfig.length > 0 ? flowConfig : DEFAULT_TRACEABILITY_CHAIN
    const result: Array<ChainItem & { entities: GraphEntity[]; linked: boolean; linkedToPrev: boolean }> = []

    chain.forEach((chainItem, idx) => {
      const filter: EntityFilter = { stageId: chainItem.stage, type: chainItem.concept, projectId }
      if (deliveryId) filter.deliveryId = deliveryId
      const entities = this.getEntities(filter)
      const prev = idx > 0 ? result[idx - 1] : null

      let linkedToPrev = false
      if (prev && prev.entities.length > 0 && entities.length > 0) {
        const a = prev.entities[0].id
        const b = entities[0].id
        const link = this.db.prepare(
          `SELECT id FROM graph_edges
           WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?) LIMIT 1`
        ).get(a, b, b, a)
        linkedToPrev = Boolean(link)
      }

      result.push({ ...chainItem, entities, linked: entities.length > 0, linkedToPrev })
    })

    return result
  }

  // ─── Stats (port of graph.js getStats) ────────────────────────

  getStats(projectId: string | null = null): {
    totalEntities: number
    totalEdges: number
    traceabilityEdges: number
    byConcept: Record<string, number>
    byStage: Record<string, number>
    conceptCount: number
  } {
    const entities = projectId ? this.getEntities({ projectId }) : this.getEntities()
    const ids = new Set(entities.map((e) => e.id))

    const allEdges = this.getEdges()
    const edges = projectId ? allEdges.filter((e) => ids.has(e.sourceId) || ids.has(e.targetId)) : allEdges

    const byConcept: Record<string, number> = {}
    Object.keys(CONCEPTS).forEach((c) => { byConcept[c] = 0 })
    entities.forEach((e) => { byConcept[e.type] = (byConcept[e.type] || 0) + 1 })

    const byStage: Record<string, number> = {}
    entities.forEach((e) => {
      if (e.stageId) byStage[e.stageId] = (byStage[e.stageId] || 0) + 1
    })

    return {
      totalEntities: entities.length,
      totalEdges: edges.length,
      traceabilityEdges: edges.filter((e) => RELATIONS[e.relation]?.traceability).length,
      byConcept,
      byStage,
      conceptCount: Object.values(byConcept).filter((c) => c > 0).length,
    }
  }

  // ─── Keyword search (port of graph.js search) ─────────────────

  search(query: string, projectId: string | null = null, type: string | null = null): Array<{
    entity: GraphEntity
    relationCount: number
    matchedIn: string[]
  }> {
    if (!query || !query.trim()) return []
    const q = query.trim().toLowerCase()

    const entities = this.getEntities({
      ...(projectId ? { projectId } : {}),
      ...(type ? { type } : {}),
    })

    const out: Array<{ entity: GraphEntity; relationCount: number; matchedIn: string[] }> = []
    for (const e of entities) {
      const matchedIn: string[] = []
      if ((e.label || '').toLowerCase().includes(q)) matchedIn.push('label')
      if (String(e.properties.title ?? '').toLowerCase().includes(q)) matchedIn.push('title')
      if (String(e.properties.content ?? '').toLowerCase().includes(q)) matchedIn.push('content')
      if (matchedIn.length > 0) {
        out.push({ entity: e, relationCount: this.getRelations(e.id).length, matchedIn })
      }
    }
    return out
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  clearProject(projectId: string): void {
    // edges cascade via FK when both endpoints are project entities;
    // cross-project edges are cleaned explicitly first
    const ids = this.getEntities({ projectId }).map((e) => e.id)
    const del = this.db.prepare('DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?')
    for (const id of ids) del.run(id, id)
    this.db.prepare('DELETE FROM graph_entities WHERE project_id = ?').run(projectId)
  }
}
