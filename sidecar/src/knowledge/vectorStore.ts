// ================================================================
//  Vector Store — chunk embeddings on sqlite-vec, BM25 fallback
//
//  - chunks live in a plain table (knowledge_chunks) keyed to graph
//    entities; embeddings go to a vec0 virtual table when sqlite-vec
//    loads successfully
//  - the embedder is injectable: production uses an OpenAI-compatible
//    /embeddings endpoint, tests use a deterministic fake
//  - every failure path degrades to pure BM25 keyword retrieval —
//    the store never throws out of search()
// ================================================================

import { createRequire } from 'node:module'
import type DatabaseT from 'better-sqlite3'

const requireCjs = createRequire(import.meta.url)

// ─── Embedder ───────────────────────────────────────────────────

/** Batch text → vectors. Must return one vector per input text. */
export type Embedder = (texts: string[]) => Promise<number[][]>

export interface EmbedderEndpointConfig {
  endpoint: string
  apiKey: string
  model: string
  dimensions?: number
  fetchImpl?: typeof fetch
}

/** OpenAI-compatible POST {endpoint}/embeddings client. */
export function createOpenAIEmbedder(config: EmbedderEndpointConfig): Embedder {
  const fetchImpl = config.fetchImpl ?? fetch
  return async (texts: string[]): Promise<number[][]> => {
    const res = await fetchImpl(`${config.endpoint}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: texts }),
    })
    if (!res.ok) throw new Error(`embeddings API ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
    return data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding)
  }
}

/**
 * Deterministic fake embedder for tests: hashed bag-of-3-grams, L2
 * normalized — identical input always yields the identical vector and
 * lexically similar texts land closer than unrelated ones.
 */
export function createFakeEmbedder(dim = 64): Embedder {
  const embedOne = (text: string): number[] => {
    const v = new Array<number>(dim).fill(0)
    const s = text.toLowerCase()
    for (let i = 0; i < s.length - 2; i++) {
      let h = 2166136261
      for (let j = i; j < i + 3; j++) {
        h = (h ^ s.charCodeAt(j)) * 16777619
        h >>>= 0
      }
      v[h % dim] += 1
    }
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
  return async (texts) => texts.map(embedOne)
}

// ─── Chunking ───────────────────────────────────────────────────

export function chunkText(text: string, maxLen = 800): string[] {
  const clean = (text || '').trim()
  if (!clean) return []
  if (clean.length <= maxLen) return [clean]
  const chunks: string[] = []
  // split on blank lines first, re-pack greedily up to maxLen
  const paras = clean.split(/\n{2,}/)
  let buf = ''
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > maxLen) {
      chunks.push(buf)
      buf = ''
    }
    if (p.length > maxLen) {
      if (buf) { chunks.push(buf); buf = '' }
      for (let i = 0; i < p.length; i += maxLen) chunks.push(p.slice(i, i + maxLen))
    } else {
      buf = buf ? `${buf}\n\n${p}` : p
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

// ─── BM25 (fallback retrieval) ──────────────────────────────────

function tokenize(text: string): string[] {
  const tokens: string[] = []
  // latin words + digits
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+/g)) tokens.push(m[0])
  // CJK bigrams (queries and docs are largely Chinese)
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2))
  if (cjk.length === 1) tokens.push(cjk)
  return tokens
}

function bm25Rank(
  query: string,
  docs: Array<{ id: number; text: string }>,
  topK: number
): Array<{ id: number; score: number }> {
  const qTokens = [...new Set(tokenize(query))]
  if (qTokens.length === 0 || docs.length === 0) return []
  const k1 = 1.2
  const b = 0.75
  const docTokens = docs.map((d) => tokenize(d.text))
  const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const scores = docs.map((doc, i) => {
    const tokens = docTokens[i]
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const q of qTokens) {
      const f = tf.get(q) ?? 0
      if (f === 0) continue
      const n = df.get(q) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (tokens.length / avgLen))))
    }
    return { id: doc.id, score }
  })
  return scores.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score).slice(0, topK)
}

// ─── Store ──────────────────────────────────────────────────────

export interface ChunkHit {
  entityId: string
  projectId: string | null
  stageId: string | null
  text: string
  score: number
  /** 'vector' when ranked by sqlite-vec KNN, 'bm25' otherwise. */
  backend: 'vector' | 'bm25'
}

const CHUNKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  TEXT NOT NULL,
  project_id TEXT,
  stage_id   TEXT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_entity ON knowledge_chunks(entity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_project ON knowledge_chunks(project_id);
`

export class VectorStore {
  readonly db: DatabaseT.Database
  private embedder: Embedder | null
  private dim: number
  private vecReady = false

  /**
   * @param db       shared better-sqlite3 handle (same file as GraphStore)
   * @param embedder injectable; null → BM25-only mode
   * @param dim      embedding dimensions (must match the embedder output)
   */
  constructor(db: DatabaseT.Database, embedder: Embedder | null, dim = 64) {
    this.db = db
    this.embedder = embedder
    this.dim = dim
    this.db.exec(CHUNKS_SCHEMA)
    if (this.embedder) this.vecReady = this.tryLoadSqliteVec()
  }

  /** 'vector' when sqlite-vec + embedder are active, else 'bm25'. */
  get backend(): 'vector' | 'bm25' {
    return this.vecReady && this.embedder ? 'vector' : 'bm25'
  }

  private tryLoadSqliteVec(): boolean {
    try {
      // createRequire keeps the native extension lazy — a missing/broken
      // sqlite-vec build must degrade to BM25, never crash the sidecar
      const mod = requireCjs('sqlite-vec') as { load(db: DatabaseT.Database): void }
      mod.load(this.db)
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors USING vec0(embedding float[${this.dim}])`
      )
      return true
    } catch {
      return false
    }
  }

  /** Replaces all chunks (and vectors) previously indexed for the entity. */
  async indexEntity(entry: {
    entityId: string
    projectId?: string | null
    stageId?: string | null
    text: string
  }): Promise<{ chunks: number; vectorized: boolean }> {
    const chunks = chunkText(entry.text)
    this.removeEntity(entry.entityId)
    if (chunks.length === 0) return { chunks: 0, vectorized: false }

    const insert = this.db.prepare(
      'INSERT INTO knowledge_chunks (entity_id, project_id, stage_id, text) VALUES (?, ?, ?, ?)'
    )
    const rowids: bigint[] = []
    for (const c of chunks) {
      const info = insert.run(entry.entityId, entry.projectId ?? null, entry.stageId ?? null, c)
      rowids.push(BigInt(info.lastInsertRowid))
    }

    if (!this.vecReady || !this.embedder) return { chunks: chunks.length, vectorized: false }
    try {
      const vectors = await this.embedder(chunks)
      const insertVec = this.db.prepare('INSERT INTO knowledge_vectors (rowid, embedding) VALUES (?, ?)')
      vectors.forEach((v, i) => {
        insertVec.run(rowids[i], new Float32Array(v))
      })
      return { chunks: chunks.length, vectorized: true }
    } catch {
      // embedding endpoint down → chunks stay searchable via BM25
      return { chunks: chunks.length, vectorized: false }
    }
  }

  removeEntity(entityId: string): void {
    const rows = this.db.prepare('SELECT id FROM knowledge_chunks WHERE entity_id = ?').all(entityId) as Array<{ id: number }>
    if (rows.length === 0) return
    if (this.vecReady) {
      const delVec = this.db.prepare('DELETE FROM knowledge_vectors WHERE rowid = ?')
      for (const r of rows) {
        try { delVec.run(BigInt(r.id)) } catch { /* vector row may not exist */ }
      }
    }
    this.db.prepare('DELETE FROM knowledge_chunks WHERE entity_id = ?').run(entityId)
  }

  /** Top-k retrieval: sqlite-vec KNN when available, BM25 otherwise. */
  async search(query: string, opts: { projectId?: string | null; topK?: number } = {}): Promise<ChunkHit[]> {
    const topK = opts.topK ?? 5
    if (!query || !query.trim()) return []

    if (this.vecReady && this.embedder) {
      try {
        const [qv] = await this.embedder([query])
        // over-fetch, then filter by project (vec0 has no metadata columns)
        const knn = this.db.prepare(
          'SELECT rowid, distance FROM knowledge_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
        ).all(new Float32Array(qv), topK * 8) as Array<{ rowid: number | bigint; distance: number }>
        const byId = this.db.prepare('SELECT * FROM knowledge_chunks WHERE id = ?')
        const hits: ChunkHit[] = []
        for (const k of knn) {
          const row = byId.get(Number(k.rowid)) as
            | { entity_id: string; project_id: string | null; stage_id: string | null; text: string }
            | undefined
          if (!row) continue
          if (opts.projectId && row.project_id !== opts.projectId) continue
          hits.push({
            entityId: row.entity_id,
            projectId: row.project_id,
            stageId: row.stage_id,
            text: row.text,
            score: 1 / (1 + k.distance),
            backend: 'vector',
          })
          if (hits.length >= topK) break
        }
        return hits
      } catch {
        // fall through to BM25
      }
    }

    const where = opts.projectId ? 'WHERE project_id = ?' : ''
    const args = opts.projectId ? [opts.projectId] : []
    const rows = this.db.prepare(`SELECT * FROM knowledge_chunks ${where}`).all(...args) as Array<{
      id: number
      entity_id: string
      project_id: string | null
      stage_id: string | null
      text: string
    }>
    const ranked = bm25Rank(query, rows.map((r) => ({ id: r.id, text: r.text })), topK)
    const byId = new Map(rows.map((r) => [r.id, r]))
    return ranked.map((r) => {
      const row = byId.get(r.id)!
      return {
        entityId: row.entity_id,
        projectId: row.project_id,
        stageId: row.stage_id,
        text: row.text,
        score: r.score,
        backend: 'bm25' as const,
      }
    })
  }

  countChunks(projectId: string | null = null): number {
    const row = projectId
      ? this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE project_id = ?').get(projectId)
      : this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get()
    return Number((row as { n: number }).n)
  }
}
