/**
 * TauriStorage tests — SQLite-backed StorageService (Phase 2a)
 *
 * The tauri-plugin-sql database is mocked: a Map-based table that honors
 * the exact SQL shapes the adapter issues (hydration SELECT, per-key
 * verify SELECT, upsert, delete). Covers: cache hydration + sync reads,
 * debounced batch flush, flush retry, legacy localStorage migration with
 * consistency check, and the mismatch → localStorage fallback path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStorageService, MIGRATION_MARKER_KEY } from '@/adapters/StorageService'

// ─── Mock tauri-plugin-sql database ─────────────────────────────

function createMockDb(initialRows = {}, opts = {}) {
  const table = new Map(Object.entries(initialRows))
  const db = {
    table,
    executed: [],
    failNextExecutes: opts.failNextExecutes || 0,
    corruptWrites: opts.corruptWrites || false,

    async select(sql, params = []) {
      if (/SELECT key, value FROM kv_store/.test(sql)) {
        return Array.from(table, ([key, value]) => ({ key, value }))
      }
      if (/SELECT value FROM kv_store WHERE key/.test(sql)) {
        return table.has(params[0]) ? [{ value: table.get(params[0]) }] : []
      }
      throw new Error(`unexpected select: ${sql}`)
    },

    async execute(sql, params = []) {
      if (db.failNextExecutes > 0) {
        db.failNextExecutes -= 1
        throw new Error('mock sqlite write failure')
      }
      db.executed.push({ sql, params })
      if (/INSERT INTO kv_store/.test(sql)) {
        table.set(params[0], db.corruptWrites ? `${params[1]}__CORRUPT` : params[1])
      } else if (/DELETE FROM kv_store/.test(sql)) {
        table.delete(params[0])
      } else {
        throw new Error(`unexpected execute: ${sql}`)
      }
    },
  }
  return db
}

function createTauriSvc(db) {
  return createStorageService('tauri', { loadDb: async () => db })
}

/** Marker row so tests that don't target migration skip it entirely. */
const MIGRATED = { [MIGRATION_MARKER_KEY]: '2026-01-01T00:00:00.000Z' }

const upserts = (db) => db.executed.filter((e) => /INSERT INTO kv_store/.test(e.sql))
const deletes = (db) => db.executed.filter((e) => /DELETE FROM kv_store/.test(e.sql))

describe('TauriStorage (SQLite-backed)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  describe('cache hydration & sync API', () => {
    it('hydrates the cache from kv_store and serves sync reads', async () => {
      const db = createMockDb({ ...MIGRATED, flowforge_dags: '[{"id":"d1"}]' })
      const svc = createTauriSvc(db)
      await svc.ready()

      expect(svc.get('flowforge_dags')).toBe('[{"id":"d1"}]')
      expect(svc.getJSON('flowforge_dags')).toEqual([{ id: 'd1' }])
      expect(svc.get('missing')).toBeNull()
      expect(svc.getJSON('missing', { fb: 1 })).toEqual({ fb: 1 })
      expect(svc.keys()).toContain('flowforge_dags')
    })

    it('optimistic writes before ready win over stale db rows', async () => {
      const db = createMockDb({ ...MIGRATED, flowforge_active_model: 'old' })
      const svc = createTauriSvc(db)
      svc.set('flowforge_active_model', 'new') // before hydration completes
      await svc.ready()

      expect(svc.get('flowforge_active_model')).toBe('new')
      await vi.advanceTimersByTimeAsync(250)
      expect(db.table.get('flowforge_active_model')).toBe('new')
    })
  })

  describe('debounced batch flush', () => {
    it('batches writes: nothing hits SQLite before the debounce window', async () => {
      const db = createMockDb(MIGRATED)
      const svc = createTauriSvc(db)
      await svc.ready()

      svc.setJSON('flowforge_a', { v: 1 })
      svc.set('flowforge_b', 'raw')
      svc.set('flowforge_a', 'latest') // supersedes the first write

      expect(upserts(db)).toHaveLength(0) // not flushed yet

      await vi.advanceTimersByTimeAsync(250)

      // one upsert per key, carrying the latest value
      const flushed = upserts(db)
      expect(flushed).toHaveLength(2)
      expect(db.table.get('flowforge_a')).toBe('latest')
      expect(db.table.get('flowforge_b')).toBe('raw')
    })

    it('remove deletes from cache immediately and from SQLite on flush', async () => {
      const db = createMockDb({ ...MIGRATED, flowforge_gone: 'x' })
      const svc = createTauriSvc(db)
      await svc.ready()

      svc.remove('flowforge_gone')
      expect(svc.get('flowforge_gone')).toBeNull() // optimistic

      await vi.advanceTimersByTimeAsync(250)
      expect(deletes(db)).toHaveLength(1)
      expect(db.table.has('flowforge_gone')).toBe(false)
    })

    it('retries a failed flush with console.error, data eventually lands', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = createMockDb(MIGRATED)
      const svc = createTauriSvc(db)
      await svc.ready()

      db.failNextExecutes = 1
      svc.set('flowforge_retry', 'v1')

      await vi.advanceTimersByTimeAsync(250) // first flush fails
      expect(error).toHaveBeenCalled()
      expect(db.table.has('flowforge_retry')).toBe(false)
      expect(svc.get('flowforge_retry')).toBe('v1') // cache keeps the value

      await vi.advanceTimersByTimeAsync(2100) // retry window
      expect(db.table.get('flowforge_retry')).toBe('v1')
    })

    it('flush() forces pending writes immediately (shutdown/test hook)', async () => {
      const db = createMockDb(MIGRATED)
      const svc = createTauriSvc(db)
      await svc.ready()

      svc.set('flowforge_now', 'v')
      await svc.flush()
      expect(db.table.get('flowforge_now')).toBe('v')
    })
  })

  describe('legacy localStorage migration', () => {
    it('migrates flowforge* keys, verifies per-key, writes the marker, keeps localStorage', async () => {
      localStorage.setItem('flowforge_custom_models', '[{"id":"m1"}]')
      localStorage.setItem('flowforge_repositories', '[]')
      localStorage.setItem('unrelated_key', 'ignore-me')

      const db = createMockDb() // fresh install: empty kv_store
      const svc = createTauriSvc(db)
      await svc.ready()

      // data landed in SQLite and in the cache
      expect(db.table.get('flowforge_custom_models')).toBe('[{"id":"m1"}]')
      expect(db.table.get('flowforge_repositories')).toBe('[]')
      expect(db.table.has('unrelated_key')).toBe(false)
      expect(svc.get('flowforge_custom_models')).toBe('[{"id":"m1"}]')

      // marker written with a timestamp; localStorage backup untouched
      expect(db.table.get(MIGRATION_MARKER_KEY)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(localStorage.getItem('flowforge_custom_models')).toBe('[{"id":"m1"}]')
    })

    it('skips migration when the marker already exists', async () => {
      localStorage.setItem('flowforge_custom_models', '[{"id":"m1"}]')
      const db = createMockDb(MIGRATED)
      const svc = createTauriSvc(db)
      await svc.ready()

      expect(db.table.has('flowforge_custom_models')).toBe(false)
      expect(upserts(db)).toHaveLength(0)
    })

    it('degrades to localStorage when the consistency check fails, marker not written', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      localStorage.setItem('flowforge_custom_models', '[{"id":"m1"}]')

      const db = createMockDb({}, { corruptWrites: true }) // read-back never matches
      const svc = createTauriSvc(db)
      await svc.ready()

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('degrading to localStorage'),
        expect.anything(),
      )
      // no marker → next launch retries the migration
      expect(db.table.get(MIGRATION_MARKER_KEY)).toBeUndefined()

      // service still fully works, backed by localStorage
      expect(svc.get('flowforge_custom_models')).toBe('[{"id":"m1"}]')
      svc.set('flowforge_post_fallback', 'ok')
      expect(localStorage.getItem('flowforge_post_fallback')).toBe('ok')
    })
  })
})
