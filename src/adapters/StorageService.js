/**
 * StorageService — unified key-value storage adapter
 *
 * Phase 0 established the adapter: all services read/write through it
 * instead of touching localStorage directly. Phase 2a (this file) gives
 * the tauri implementation a real SQLite backing store (kv_store table
 * via tauri-plugin-sql) while keeping the API SYNCHRONOUS: every
 * existing service function (getCustomModels, loadDAGs, ...) is sync
 * and callers depend on that.
 *
 * Tauri mode design:
 *   - an in-memory cache is hydrated from SQLite once at startup;
 *     `await storage.ready()` gates the first render (see main.jsx)
 *   - sync get/set/remove operate on the cache (optimistic), writes are
 *     flushed to SQLite in debounced batches (~200ms) with retry
 *   - first launch migrates legacy localStorage data into kv_store with
 *     a per-key read-back consistency check; localStorage is kept as a
 *     backup (marker key records the migration timestamp)
 *   - if SQLite init/migration fails the service degrades to the
 *     localStorage-backed web implementation (console.warn)
 *
 * Web mode is unchanged: a 1:1 localStorage wrapper, ready() resolves
 * immediately, no migration ever runs.
 */

// ─── Constants ──────────────────────────────────────────────────

/** Only keys with this prefix belong to FlowForge (migration/export scope). */
export const FLOWFORGE_KEY_PREFIX = 'flowforge'

/** kv_store marker written after a verified legacy-data migration. */
export const MIGRATION_MARKER_KEY = 'flowforge_migrated_at'

const FLUSH_DEBOUNCE_MS = 200
const FLUSH_RETRY_MS = 2000

// ─── Runtime mode detection ─────────────────────────────────────

/**
 * Detect the runtime mode.
 * Priority: explicit window.__FLOWFORGE_MODE__ override (tests / debugging),
 * then Tauri 2.x internals probe, fallback 'web'.
 * @returns {'web' | 'tauri'}
 */
export function detectRuntimeMode() {
  if (typeof window !== 'undefined') {
    if (window.__FLOWFORGE_MODE__ === 'web' || window.__FLOWFORGE_MODE__ === 'tauri') {
      return window.__FLOWFORGE_MODE__
    }
    if (window.__TAURI_INTERNALS__) return 'tauri'
  }
  return 'web'
}

/** All localStorage keys owned by FlowForge (best-effort, [] on failure). */
function listLocalStorageFlowforgeKeys() {
  const keys = []
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && key.startsWith(FLOWFORGE_KEY_PREFIX)) keys.push(key)
    }
  } catch (e) { /* storage unavailable */ }
  return keys
}

// ─── Web implementation (localStorage) ──────────────────────────

function createWebStorage() {
  return {
    mode: 'web',
    /** True once the backing store is usable; web mode is always ready. */
    isReady: true,
    /** Resolves when the backing store is usable (immediately on web). */
    ready() {
      return Promise.resolve()
    },

    /** @returns {string|null} raw string value, null if absent or storage unavailable */
    get(key) {
      try {
        return localStorage.getItem(key)
      } catch (e) {
        return null
      }
    },

    set(key, value) {
      try {
        localStorage.setItem(key, value)
      } catch (e) { /* quota exceeded / unavailable */ }
    },

    remove(key) {
      try {
        localStorage.removeItem(key)
      } catch (e) { /* ignore */ }
    },

    /** Parse stored JSON; returns `fallback` on absence or parse error */
    getJSON(key, fallback = null) {
      try {
        const saved = localStorage.getItem(key)
        if (saved !== null) return JSON.parse(saved)
      } catch (e) { /* ignore */ }
      return fallback
    },

    setJSON(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch (e) { /* quota exceeded / unavailable */ }
    },

    /** FlowForge-owned keys currently in the store (export/migration scope). */
    keys() {
      return listLocalStorageFlowforgeKeys()
    },
  }
}

// ─── Tauri implementation (SQLite via tauri-plugin-sql) ─────────

const KV_UPSERT_SQL =
  'INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, $3) ' +
  'ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = $3'
const KV_DELETE_SQL = 'DELETE FROM kv_store WHERE key = $1'

/**
 * @param {object} [opts]
 * @param {() => Promise<{select: Function, execute: Function}>} [opts.loadDb]
 *   Database handle factory (injected in tests; defaults to tauriDb).
 */
function createTauriStorage(opts = {}) {
  const loadDb = opts.loadDb
    || (async () => (await import('@/adapters/tauriDb')).openFlowforgeDb())

  /** @type {Map<string, string>} authoritative in-memory KV cache */
  const cache = new Map()
  /** @type {Map<string, 'set'|'remove'>} keys awaiting flush to SQLite */
  const dirty = new Map()
  let db = null
  /** localStorage-backed service when SQLite is unusable (degraded mode). */
  let fallback = null
  let flushTimer = null
  let flushInFlight = null

  let readyResolve
  const readyPromise = new Promise((resolve) => { readyResolve = resolve })

  function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS) {
    if (flushTimer !== null) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, delayMs)
  }

  /** Write all dirty keys to SQLite in one batch; retry on failure. */
  function flush() {
    if (flushInFlight) return flushInFlight
    if (!db || fallback || dirty.size === 0) return Promise.resolve()

    const batch = Array.from(dirty.entries())
    dirty.clear()

    flushInFlight = (async () => {
      const now = new Date().toISOString()
      try {
        for (const [key, op] of batch) {
          if (op === 'remove') {
            await db.execute(KV_DELETE_SQL, [key])
          } else {
            // read the value at flush time so the batch carries the latest write
            await db.execute(KV_UPSERT_SQL, [key, cache.get(key) ?? '', now])
          }
        }
      } catch (e) {
        console.error('[storage] SQLite flush failed, will retry:', e)
        // re-mark unless a newer write superseded the entry meanwhile
        for (const [key, op] of batch) {
          if (!dirty.has(key)) dirty.set(key, op)
        }
        scheduleFlush(FLUSH_RETRY_MS)
      } finally {
        flushInFlight = null
        // writes that arrived while the batch was in flight
        if (dirty.size > 0 && flushTimer === null) scheduleFlush()
      }
    })()
    return flushInFlight
  }

  /**
   * One-time legacy migration: copy every flowforge* localStorage key into
   * kv_store, verify each value by reading it back, then write the marker.
   * localStorage data is deliberately KEPT as a backup (no auto-cleanup);
   * the marker records the migration timestamp. Throws on any mismatch so
   * init() degrades to localStorage mode.
   */
  async function migrateLegacyData() {
    if (cache.has(MIGRATION_MARKER_KEY)) return // already migrated

    const legacyKeys = listLocalStorageFlowforgeKeys()
      .filter((k) => k !== MIGRATION_MARKER_KEY)
    const now = new Date().toISOString()

    for (const key of legacyKeys) {
      const value = localStorage.getItem(key)
      if (value === null) continue
      await db.execute(KV_UPSERT_SQL, [key, value, now])
    }

    // consistency check: every key must read back byte-identical
    for (const key of legacyKeys) {
      const expected = localStorage.getItem(key)
      if (expected === null) continue
      const rows = await db.select('SELECT value FROM kv_store WHERE key = $1', [key])
      const actual = rows.length > 0 ? rows[0].value : null
      if (actual !== expected) {
        throw new Error(`legacy migration verify failed for key "${key}"`)
      }
      // hydrate cache unless an optimistic write already claimed the key
      if (!cache.has(key) && !dirty.has(key)) cache.set(key, expected)
    }

    await db.execute(KV_UPSERT_SQL, [MIGRATION_MARKER_KEY, now, now])
    cache.set(MIGRATION_MARKER_KEY, now)
    console.info(`[storage] migrated ${legacyKeys.length} legacy key(s) into SQLite (localStorage kept as backup)`)
  }

  async function init() {
    try {
      db = await loadDb()

      // hydrate cache from kv_store; optimistic pre-ready writes win
      const rows = await db.select('SELECT key, value FROM kv_store')
      for (const row of rows) {
        if (!cache.has(row.key) && !dirty.has(row.key)) cache.set(row.key, row.value)
      }

      await migrateLegacyData()

      if (dirty.size > 0) scheduleFlush(0)
    } catch (e) {
      console.warn('[storage] SQLite unavailable, degrading to localStorage:', e)
      db = null
      fallback = createWebStorage()
      // replay optimistic writes so nothing done before ready() is lost
      for (const [key, op] of dirty) {
        if (op === 'remove') fallback.remove(key)
        else fallback.set(key, cache.get(key) ?? '')
      }
      dirty.clear()
    } finally {
      svc.isReady = true
      readyResolve()
    }
  }

  const svc = {
    mode: 'tauri',
    isReady: false,
    ready() {
      return readyPromise
    },

    get(key) {
      if (fallback) return fallback.get(key)
      return cache.has(key) ? cache.get(key) : null
    },

    set(key, value) {
      const str = String(value)
      if (fallback) return fallback.set(key, str)
      cache.set(key, str)
      dirty.set(key, 'set')
      scheduleFlush()
    },

    remove(key) {
      if (fallback) return fallback.remove(key)
      cache.delete(key)
      dirty.set(key, 'remove')
      scheduleFlush()
    },

    getJSON(key, fallbackValue = null) {
      const saved = this.get(key)
      if (saved !== null) {
        try {
          return JSON.parse(saved)
        } catch (e) { /* corrupt payload */ }
      }
      return fallbackValue
    },

    setJSON(key, value) {
      this.set(key, JSON.stringify(value))
    },

    /** FlowForge-owned keys currently in the store (export/migration scope). */
    keys() {
      if (fallback) return fallback.keys()
      return Array.from(cache.keys()).filter((k) => k.startsWith(FLOWFORGE_KEY_PREFIX))
    },

    /** Force-write pending changes now (tests / shutdown); resolves when done. */
    flush() {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      return flush()
    },
  }

  init()
  return svc
}

// ─── Factory & singleton ────────────────────────────────────────

/**
 * Create a storage service for the given mode (auto-detected when omitted).
 * Exported for tests; app code should use the `storage` singleton.
 * @param {'web'|'tauri'} [mode]
 * @param {object} [opts] tauri-only options (see createTauriStorage)
 */
export function createStorageService(mode = detectRuntimeMode(), opts = {}) {
  return mode === 'tauri' ? createTauriStorage(opts) : createWebStorage()
}

export const storage = createStorageService()
