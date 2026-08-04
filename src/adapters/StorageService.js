/**
 * StorageService — unified key-value storage adapter (pure client)
 *
 * The platform ships exclusively as a Tauri desktop app, so every key
 * is persisted locally in the SQLite kv_store table (tauri-plugin-sql,
 * see tauriDb). The API stays SYNCHRONOUS because all existing service
 * functions (getCustomModels, loadDAGs, ...) are sync and callers rely
 * on that:
 *
 *   - an in-memory cache is hydrated from SQLite once at startup;
 *     `await storage.ready()` gates the first render (see main.jsx)
 *   - sync get/set/remove operate on the cache (optimistic), writes are
 *     flushed to SQLite in debounced batches (~200ms) with retry
 *   - if SQLite init fails the service degrades to the in-memory cache
 *     for the current session (console.warn) — no browser storage is
 *     ever used
 */

// ─── Constants ──────────────────────────────────────────────────

/** Only keys with this prefix belong to FlowForge (export scope). */
export const FLOWFORGE_KEY_PREFIX = 'flowforge'

/** Legacy migration marker key (migration itself was removed with web mode;
 *  the constant is kept so data-export tooling continues to exclude it). */
export const MIGRATION_MARKER_KEY = 'flowforge_migrated_at'

const FLUSH_DEBOUNCE_MS = 200
const FLUSH_RETRY_MS = 2000

// ─── Runtime mode detection ─────────────────────────────────────

/**
 * The platform is a pure Tauri desktop client, so the runtime is always
 * 'tauri'. The window.__FLOWFORGE_MODE__ override is kept for tests and
 * debugging only.
 * @returns {'web' | 'tauri'}
 */
export function detectRuntimeMode() {
  if (typeof window !== 'undefined' && window.__FLOWFORGE_MODE__ === 'web') return 'web'
  return 'tauri'
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
    if (!db || dirty.size === 0) return Promise.resolve()

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

  async function init() {
    try {
      db = await loadDb()

      // hydrate cache from kv_store; optimistic pre-ready writes win
      const rows = await db.select('SELECT key, value FROM kv_store')
      for (const row of rows) {
        if (!cache.has(row.key) && !dirty.has(row.key)) cache.set(row.key, row.value)
      }

      if (dirty.size > 0) scheduleFlush(0)
    } catch (e) {
      // SQLite unusable: keep serving the in-memory cache for this session
      console.warn('[storage] SQLite unavailable, degrading to in-memory cache:', e)
      db = null
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
      return cache.has(key) ? cache.get(key) : null
    },

    set(key, value) {
      cache.set(key, String(value))
      dirty.set(key, 'set')
      scheduleFlush()
    },

    remove(key) {
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

    /** FlowForge-owned keys currently in the store (export scope). */
    keys() {
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
 * Create a storage service (always SQLite-backed; pure client platform).
 * Exported for tests; app code should use the `storage` singleton.
 * @param {object} [opts] options (see createTauriStorage)
 */
export function createStorageService(_mode = detectRuntimeMode(), opts = {}) {
  return createTauriStorage(opts)
}

export const storage = createStorageService()
