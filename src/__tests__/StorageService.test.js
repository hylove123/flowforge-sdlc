import { describe, it, expect, afterEach, vi } from 'vitest'
import { createStorageService, detectRuntimeMode, storage } from '@/adapters/StorageService'

// Minimal mock of the tauri-plugin-sql database used by the adapter.
function createMockDb(initialRows = {}) {
  const table = new Map(Object.entries(initialRows))
  return {
    table,
    async select(sql) {
      if (/SELECT key, value FROM kv_store/.test(sql)) {
        return Array.from(table, ([key, value]) => ({ key, value }))
      }
      throw new Error(`unexpected select: ${sql}`)
    },
    async execute(sql, params = []) {
      if (/INSERT INTO kv_store/.test(sql)) table.set(params[0], params[1])
      else if (/DELETE FROM kv_store/.test(sql)) table.delete(params[0])
      else throw new Error(`unexpected execute: ${sql}`)
    },
  }
}

describe('StorageService (pure client)', () => {
  afterEach(() => {
    delete window.__FLOWFORGE_MODE__
    vi.restoreAllMocks()
  })

  describe('mode detection', () => {
    it('always reports tauri on the desktop platform', () => {
      delete window.__FLOWFORGE_MODE__
      expect(detectRuntimeMode()).toBe('tauri')
    })

    it('keeps the __FLOWFORGE_MODE__ override for debugging', () => {
      window.__FLOWFORGE_MODE__ = 'web'
      expect(detectRuntimeMode()).toBe('web')
    })

    it('factory always returns the SQLite-backed implementation', () => {
      // Even a "web" argument yields the single tauri implementation
      expect(createStorageService('web', { loadDb: async () => createMockDb() }).mode).toBe('tauri')
      expect(createStorageService('tauri', { loadDb: async () => createMockDb() }).mode).toBe('tauri')
      expect(storage.mode).toBe('tauri')
    })
  })

  describe('get/set/remove (SQLite-backed)', () => {
    it('set then get returns the raw string; missing key yields null', async () => {
      const svc = createStorageService('tauri', { loadDb: async () => createMockDb() })
      await svc.ready()

      svc.set('flowforge_k', 'hello')
      expect(svc.get('flowforge_k')).toBe('hello')
      expect(svc.get('flowforge_missing')).toBeNull()
    })

    it('remove deletes the key', async () => {
      const svc = createStorageService('tauri', { loadDb: async () => createMockDb({ flowforge_k: 'x' }) })
      await svc.ready()

      expect(svc.get('flowforge_k')).toBe('x')
      svc.remove('flowforge_k')
      expect(svc.get('flowforge_k')).toBeNull()
    })

    it('getJSON/setJSON round-trip and fallback on bad data', async () => {
      const svc = createStorageService('tauri', { loadDb: async () => createMockDb() })
      await svc.ready()

      svc.setJSON('flowforge_json', { a: 1, list: [1, 2] })
      expect(svc.getJSON('flowforge_json')).toEqual({ a: 1, list: [1, 2] })
      expect(svc.getJSON('flowforge_absent', [])).toEqual([])

      svc.set('flowforge_broken', '{not json')
      expect(svc.getJSON('flowforge_broken', { fallback: true })).toEqual({ fallback: true })
    })
  })

  describe('in-memory fallback', () => {
    it('degrades to the in-memory cache when SQLite init fails; browser storage is never used', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const svc = createStorageService('tauri', {
        loadDb: async () => { throw new Error('sqlite unavailable') },
      })
      // optimistic write before ready must survive the fallback switch
      svc.set('flowforge_key', 'v')
      await svc.ready()

      expect(svc.isReady).toBe(true)
      expect(warn).toHaveBeenCalled()
      expect(svc.get('flowforge_key')).toBe('v')
      expect(localStorage.getItem('flowforge_key')).toBeNull()

      // post-fallback writes keep working from the cache
      svc.set('flowforge_after', 'w')
      expect(svc.get('flowforge_after')).toBe('w')
      warn.mockRestore()
    })

    it('ready() resolves once init settles', async () => {
      const svc = createStorageService('tauri', { loadDb: async () => createMockDb() })
      await svc.ready()
      expect(svc.isReady).toBe(true)
    })
  })
})
