// ================================================================
//  Knowledge Flywheel — diff memory & template evolution (Phase 6)
//
//  recordDiff()        original vs final line diff after delegate/manual
//                      imports or user edits, classified into edit patterns
//  template evolution  same pattern on the same stage more than 3 times →
//                      improveFromFeedback + `flywheel/template_evolution`
//  getFlywheelStats()  graph size + quality trend + evolutions + reuse rate
//
//  Storage decision: diffs live in the sidecar-local SQLite db
//  (${FLOWFORGE_DATA_DIR||~/.flowforge}/flywheel.db), NOT the business
//  kv_store db — the sidecar is the single writer here and the business
//  schema.sql `diffs` table stays reserved for the (unused) Tauri-side
//  path. Evolution suggestions additionally flow into the knowledge
//  graph via improveFromFeedback so recall picks them up.
// ================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  safeImprove,
  isKnowledgeConfigured,
  getKnowledgeService,
} from '../knowledge/knowledgeService.js'

type Notifier = (method: string, params?: unknown) => void

// ─── Configuration & storage ────────────────────────────────────

/** Same-pattern diff count must EXCEED this to trigger template evolution. */
export const EVOLUTION_THRESHOLD = 3

interface FlywheelConfig {
  dbPath?: string
  notify?: Notifier
}

// Activation model mirrors knowledgeService: until configureFlywheel()
// runs (index.ts does this at boot; tests pass a temp/:memory: db),
// recordRecall/safeRecordDiff are no-ops and the RPC handlers throw.
let config: FlywheelConfig | null = null
let db: InstanceType<typeof Database> | null = null

export function defaultFlywheelDbPath(): string {
  const dir = process.env.FLOWFORGE_DATA_DIR || path.join(os.homedir(), '.flowforge')
  return path.join(dir, 'flywheel.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS diffs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  delivery_id   TEXT,
  stage_id      TEXT NOT NULL,
  original      TEXT NOT NULL DEFAULT '',
  final         TEXT NOT NULL DEFAULT '',
  pattern       TEXT NOT NULL,
  added_lines   INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  diff_text     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_diffs_pattern ON diffs(project_id, stage_id, pattern);

CREATE TABLE IF NOT EXISTS template_evolutions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  occurrences INTEGER NOT NULL,
  suggestion  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evolutions_project ON template_evolutions(project_id);

CREATE TABLE IF NOT EXISTS flywheel_counters (
  project_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);
`

export function configureFlywheel(opts: FlywheelConfig = {}): void {
  if (db) { try { db.close() } catch { /* already closed */ } }
  config = opts
  db = null
}

export function isFlywheelConfigured(): boolean {
  return config !== null
}

export function resetFlywheel(): void {
  if (db) { try { db.close() } catch { /* already closed */ } }
  config = null
  db = null
}

function getDb(): InstanceType<typeof Database> {
  if (!config) throw new Error('flywheel is not configured')
  if (!db) {
    const target = config.dbPath ?? defaultFlywheelDbPath()
    if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true })
    db = new Database(target)
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA)
  }
  return db
}

function notify(method: string, params?: unknown): void {
  try { config?.notify?.(method, params) } catch { /* channel must never throw */ }
}

// ─── Simple line diff (no external deps) ────────────────────────

export interface LineDiff {
  added: string[]
  removed: string[]
  /** Unified-ish text: "- old" / "+ new" lines only (context omitted). */
  text: string
}

/** Multiset line diff — enough for pattern heuristics, no LCS needed. */
export function computeLineDiff(original: string, final: string): LineDiff {
  const count = (text: string) => {
    const map = new Map<string, number>()
    for (const line of text.split('\n')) {
      const t = line.trimEnd()
      if (!t.trim()) continue
      map.set(t, (map.get(t) ?? 0) + 1)
    }
    return map
  }
  const before = count(original)
  const after = count(final)

  const removed: string[] = []
  for (const [line, n] of before) {
    const surplus = n - (after.get(line) ?? 0)
    for (let i = 0; i < surplus; i++) removed.push(line)
  }
  const added: string[] = []
  for (const [line, n] of after) {
    const surplus = n - (before.get(line) ?? 0)
    for (let i = 0; i < surplus; i++) added.push(line)
  }

  const text = [
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
  ].join('\n')
  return { added, removed, text }
}

// ─── Edit-pattern classification (heuristic) ────────────────────

export type EditPattern =
  | 'initial_import'      // 首次导入（original 为空 — 外派/手动注入）
  | 'section_added'       // 新增章节
  | 'term_replacement'    // 术语替换
  | 'content_expansion'   // 内容扩充
  | 'content_reduction'   // 内容精简
  | 'paragraph_rewrite'   // 重写段落

export const PATTERN_LABELS: Record<EditPattern, string> = {
  initial_import: '首次导入',
  section_added: '新增章节',
  term_replacement: '术语替换',
  content_expansion: '内容扩充',
  content_reduction: '内容精简',
  paragraph_rewrite: '重写段落',
}

const isHeading = (line: string) => /^#{1,6}\s/.test(line.trim())

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean))
  const tb = new Set(b.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++
  return hit / Math.max(ta.size, tb.size)
}

export function classifyEditPattern(diff: LineDiff, original: string): EditPattern {
  if (!original.trim()) return 'initial_import'
  const { added, removed } = diff

  // new markdown headings appeared without any heading being removed
  const addedHeadings = added.filter(isHeading).length
  const removedHeadings = removed.filter(isHeading).length
  if (addedHeadings > 0 && removedHeadings === 0) return 'section_added'

  // balanced small edits where lines stay mostly similar → wording swap
  if (added.length > 0 && added.length === removed.length) {
    const pairs = Math.min(added.length, 8)
    let similar = 0
    for (let i = 0; i < pairs; i++) {
      if (tokenOverlap(removed[i], added[i]) >= 0.5) similar++
    }
    if (similar >= Math.ceil(pairs / 2)) return 'term_replacement'
  }

  if (added.length >= removed.length * 2 && added.length > 0) return 'content_expansion'
  if (removed.length >= added.length * 2 && removed.length > 0) return 'content_reduction'
  return 'paragraph_rewrite'
}

// ─── recordDiff + template evolution ────────────────────────────

export interface RecordDiffInput {
  projectId: string
  deliveryId?: string | null
  stageId: string
  original: string
  final: string
}

export interface RecordDiffResult {
  id: string
  pattern: EditPattern
  patternLabel: string
  addedLines: number
  removedLines: number
  occurrences: number
  evolutionTriggered: boolean
}

export async function recordDiff(input: RecordDiffInput): Promise<RecordDiffResult> {
  const { projectId, stageId } = input
  if (!projectId || !stageId) throw new Error('recordDiff: projectId and stageId are required')
  const original = input.original ?? ''
  const final = input.final ?? ''

  const d = getDb()
  const diff = computeLineDiff(original, final)
  const pattern = classifyEditPattern(diff, original)
  const id = randomUUID()

  d.prepare(
    `INSERT INTO diffs (id, project_id, delivery_id, stage_id, original, final, pattern, added_lines, removed_lines, diff_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, input.deliveryId ?? null, stageId, original, final, pattern,
    diff.added.length, diff.removed.length, diff.text.slice(0, 20000))

  const { n: occurrences } = d.prepare(
    'SELECT COUNT(*) AS n FROM diffs WHERE project_id = ? AND stage_id = ? AND pattern = ?'
  ).get(projectId, stageId, pattern) as { n: number }

  // initial imports carry no modification signal — they never evolve templates
  let evolutionTriggered = false
  if (pattern !== 'initial_import' && occurrences > EVOLUTION_THRESHOLD) {
    const prior = d.prepare(
      `SELECT occurrences FROM template_evolutions
       WHERE project_id = ? AND stage_id = ? AND pattern = ?
       ORDER BY occurrences DESC LIMIT 1`
    ).get(projectId, stageId, pattern) as { occurrences: number } | undefined

    // fire on the first crossing, then only when the count doubled again
    if (!prior || occurrences >= prior.occurrences * 2) {
      const label = PATTERN_LABELS[pattern]
      const suggestion =
        `阶段「${stageId}」的交付物已出现 ${occurrences} 次「${label}」类修改，` +
        `建议演化该阶段的生成模板/提示词，将此类修改内容前置吸收（最近一次改动样例见 diff）。`
      d.prepare(
        `INSERT INTO template_evolutions (id, project_id, stage_id, pattern, occurrences, suggestion)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), projectId, stageId, pattern, occurrences, suggestion)

      // into the knowledge graph so future recalls surface the suggestion
      await safeImprove({
        projectId,
        deliveryId: input.deliveryId ?? null,
        stageId,
        feedback: suggestion,
        diff: diff.text.slice(0, 4000) || null,
      })
      notify('flywheel/template_evolution', {
        projectId,
        stageId,
        pattern,
        patternLabel: label,
        occurrences,
        suggestion,
      })
      evolutionTriggered = true
    }
  }

  return {
    id,
    pattern,
    patternLabel: PATTERN_LABELS[pattern],
    addedLines: diff.added.length,
    removedLines: diff.removed.length,
    occurrences,
    evolutionTriggered,
  }
}

/** Fire-and-forget recordDiff for the graph.continue injection path. */
export async function safeRecordDiff(input: RecordDiffInput): Promise<void> {
  if (!isFlywheelConfigured()) return
  try { await recordDiff(input) } catch { /* flywheel must never block the graph */ }
}

// ─── Reuse-rate counters (fed by the context engine's recall path) ───

export function recordRecall(projectId: string, hit: boolean): void {
  if (!isFlywheelConfigured()) return
  try {
    const d = getDb()
    const bump = d.prepare(
      `INSERT INTO flywheel_counters (project_id, key, value) VALUES (?, ?, 1)
       ON CONFLICT(project_id, key) DO UPDATE SET value = value + 1`
    )
    bump.run(projectId, 'recall_calls')
    if (hit) bump.run(projectId, 'recall_hits')
  } catch { /* counters are advisory */ }
}

// ─── Stats ──────────────────────────────────────────────────────

export interface FlywheelStats {
  graph: {
    totalEntities: number
    totalEdges: number
    traceabilityEdges: number
    chunks: number
    byConcept: Record<string, number>
  }
  qualityTrend: Array<{ stage: string; score: number; at: string }>
  evolutions: Array<{
    id: string; stageId: string; pattern: string; patternLabel: string
    occurrences: number; suggestion: string; createdAt: string
  }>
  diffs: { total: number; byPattern: Record<string, number> }
  reuse: { recallCalls: number; recallHits: number; registered: number; reuseRate: number }
}

export function getFlywheelStats(input: { projectId: string }): FlywheelStats {
  const { projectId } = input
  if (!projectId) throw new Error('getFlywheelStats: projectId is required')
  const d = getDb()

  // graph size + quality trend from the knowledge layer (zeros when unarmed)
  let graph: FlywheelStats['graph'] = {
    totalEntities: 0, totalEdges: 0, traceabilityEdges: 0, chunks: 0, byConcept: {},
  }
  let qualityTrend: FlywheelStats['qualityTrend'] = []
  let registered = 0
  if (isKnowledgeConfigured()) {
    try {
      const ks = getKnowledgeService()
      const stats = ks.getStats({ projectId })
      graph = {
        totalEntities: stats.totalEntities,
        totalEdges: stats.totalEdges,
        traceabilityEdges: stats.traceabilityEdges,
        chunks: stats.chunks,
        byConcept: stats.byConcept,
      }
      registered = stats.byConcept.Deliverable ?? 0
      qualityTrend = ks.graph
        .getEntities({ projectId, type: 'Review' })
        .map((e) => ({
          stage: e.stageId ?? 'unknown',
          score: Number(e.properties.score ?? 0),
          at: e.createdAt,
        }))
        .sort((a, b) => a.at.localeCompare(b.at))
    } catch { /* knowledge unhealthy → keep zeros */ }
  }

  const evolutions = (d.prepare(
    'SELECT * FROM template_evolutions WHERE project_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(projectId) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    stageId: String(r.stage_id),
    pattern: String(r.pattern),
    patternLabel: PATTERN_LABELS[r.pattern as EditPattern] ?? String(r.pattern),
    occurrences: Number(r.occurrences),
    suggestion: String(r.suggestion),
    createdAt: String(r.created_at),
  }))

  const byPattern: Record<string, number> = {}
  let total = 0
  for (const r of d.prepare(
    'SELECT pattern, COUNT(*) AS n FROM diffs WHERE project_id = ? GROUP BY pattern'
  ).all(projectId) as Array<{ pattern: string; n: number }>) {
    byPattern[r.pattern] = r.n
    total += r.n
  }

  const counter = (key: string) => {
    const row = d.prepare(
      'SELECT value FROM flywheel_counters WHERE project_id = ? AND key = ?'
    ).get(projectId, key) as { value: number } | undefined
    return row?.value ?? 0
  }
  const recallCalls = counter('recall_calls')
  const recallHits = counter('recall_hits')
  const reuseRate = registered > 0 ? Math.min(1, recallHits / registered) : 0

  return {
    graph,
    qualityTrend,
    evolutions,
    diffs: { total, byPattern },
    reuse: { recallCalls, recallHits, registered, reuseRate },
  }
}

// ─── JSON-RPC method handlers (registered by index.ts) ──────────

export const flywheelMethods = {
  /** RecordDiffInput → RecordDiffResult */
  'flywheel.record_diff': async (params: any) => {
    const { projectId, stageId } = params ?? {}
    if (!projectId || !stageId) throw new Error('projectId and stageId are required')
    return recordDiff({
      projectId,
      deliveryId: params.deliveryId ?? null,
      stageId,
      original: params.original ?? '',
      final: params.final ?? '',
    })
  },

  /** { projectId } → FlywheelStats */
  'flywheel.stats': (params: any) => {
    const { projectId } = params ?? {}
    if (!projectId) throw new Error('projectId is required')
    return getFlywheelStats({ projectId })
  },
}
