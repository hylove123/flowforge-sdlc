import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStorageService, detectRuntimeMode, storage } from '@/adapters/StorageService'

describe('StorageService', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    window.__FLOWFORGE_MODE__ = 'web'
    delete window.__TAURI_INTERNALS__
  })

  describe('mode detection', () => {
    it('honors window.__FLOWFORGE_MODE__ override first', () => {
      window.__FLOWFORGE_MODE__ = 'web'
      window.__TAURI_INTERNALS__ = { invoke: () => {} }
      expect(detectRuntimeMode()).toBe('web')

      window.__FLOWFORGE_MODE__ = 'tauri'
      expect(detectRuntimeMode()).toBe('tauri')
    })

    it('falls back to __TAURI_INTERNALS__ probe, then web', () => {
      delete window.__FLOWFORGE_MODE__
      expect(detectRuntimeMode()).toBe('web')

      window.__TAURI_INTERNALS__ = { invoke: () => {} }
      expect(detectRuntimeMode()).toBe('tauri')
    })

    it('factory returns implementation matching mode', () => {
      expect(createStorageService('web').mode).toBe('web')
      expect(createStorageService('tauri').mode).toBe('tauri')
      // setup.js forces web mode, so singleton must be web
      expect(storage.mode).toBe('web')
    })
  })

  describe('web mode get/set/remove', () => {
    const svc = createStorageService('web')

    it('set then get returns the raw string', () => {
      svc.set('ff_test_key', 'hello')
      expect(svc.get('ff_test_key')).toBe('hello')
      expect(localStorage.getItem('ff_test_key')).toBe('hello')
    })

    it('get returns null for missing key', () => {
      expect(svc.get('ff_missing')).toBeNull()
    })

    it('remove deletes the key', () => {
      svc.set('ff_test_key', 'x')
      svc.remove('ff_test_key')
      expect(svc.get('ff_test_key')).toBeNull()
    })

    it('getJSON/setJSON round-trip and fallback on bad data', () => {
      svc.setJSON('ff_json', { a: 1, list: [1, 2] })
      expect(svc.getJSON('ff_json')).toEqual({ a: 1, list: [1, 2] })

      expect(svc.getJSON('ff_absent', [])).toEqual([])

      localStorage.setItem('ff_broken', '{not json')
      expect(svc.getJSON('ff_broken', { fallback: true })).toEqual({ fallback: true })
    })
  })

  describe('tauri mode fallback', () => {
    it('degrades to localStorage when SQLite init fails (Phase 2a guarantee)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const svc = createStorageService('tauri', {
        loadDb: async () => { throw new Error('sqlite unavailable') },
      })
      // optimistic write before ready must survive the fallback switch
      svc.set('ff_tauri_key', 'v')
      await svc.ready()

      expect(svc.isReady).toBe(true)
      expect(warn).toHaveBeenCalled()
      expect(localStorage.getItem('ff_tauri_key')).toBe('v')
      expect(svc.get('ff_tauri_key')).toBe('v')

      // post-fallback writes go straight to localStorage
      svc.set('ff_after', 'w')
      expect(localStorage.getItem('ff_after')).toBe('w')
      warn.mockRestore()
    })

    it('web mode is ready synchronously', () => {
      const svc = createStorageService('web')
      expect(svc.isReady).toBe(true)
      return expect(svc.ready()).resolves.toBeUndefined()
    })
  })
})
