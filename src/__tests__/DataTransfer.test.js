/**
 * dataTransfer tests — export/import round-trip and payload validation
 * (Settings → 数据管理, local backup tooling for the pure client).
 */

import { describe, it, expect } from 'vitest'
import { createStorageService, MIGRATION_MARKER_KEY } from '@/adapters/StorageService'
import {
  exportAllData,
  importAllData,
  validateImportPayload,
  EXPORT_FORMAT_VERSION,
} from '@/services/dataTransfer'

// Map-backed stand-in for the kv_store table.
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

async function createSvc(rows = {}) {
  const svc = createStorageService('tauri', { loadDb: async () => createMockDb(rows) })
  await svc.ready()
  return svc
}

describe('dataTransfer', () => {
  it('exports only flowforge* keys, excluding the migration marker', async () => {
    const svc = await createSvc({
      flowforge_custom_models: '[{"id":"m1"}]',
      flowforge_dags: '[]',
      [MIGRATION_MARKER_KEY]: '2026-01-01T00:00:00.000Z',
    })

    const payload = exportAllData(svc)
    expect(payload.version).toBe(EXPORT_FORMAT_VERSION)
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload.data).toEqual({
      flowforge_custom_models: '[{"id":"m1"}]',
      flowforge_dags: '[]',
    })
  })

  it('validates payload shape strictly', () => {
    expect(validateImportPayload(null).ok).toBe(false)
    expect(validateImportPayload([]).ok).toBe(false)
    expect(validateImportPayload({ version: 99, data: {} }).ok).toBe(false)
    expect(validateImportPayload({ version: 1 }).ok).toBe(false)
    expect(validateImportPayload({ version: 1, data: { bad_key: 'v' } }).ok).toBe(false)
    expect(validateImportPayload({ version: 1, data: { flowforge_x: 42 } }).ok).toBe(false)

    const good = validateImportPayload({ version: 1, data: { flowforge_x: 'v' } })
    expect(good).toEqual({ ok: true, keyCount: 1 })
  })

  it('import rejects invalid payloads without touching storage', async () => {
    const svc = await createSvc()
    const result = importAllData({ version: 1, data: { evil_key: 'v' } }, svc)
    expect(result.ok).toBe(false)
    expect(svc.keys()).toHaveLength(0)
  })

  it('export → import round-trip restores every key', async () => {
    const src = await createSvc()
    src.set('flowforge_custom_models', '[{"id":"m1","apiKey":"sk-…"}]')
    src.setJSON('flowforge_repositories', [{ id: 'r1', url: 'git@x' }])
    const payload = exportAllData(src)

    // fresh (empty) local store: import must restore both keys
    const dst = await createSvc()
    expect(dst.get('flowforge_custom_models')).toBeNull()

    const result = importAllData(payload, dst)
    expect(result).toEqual({ ok: true, keyCount: 2 })
    expect(dst.get('flowforge_custom_models')).toBe('[{"id":"m1","apiKey":"sk-…"}]')
    expect(dst.getJSON('flowforge_repositories')).toEqual([{ id: 'r1', url: 'git@x' }])
  })
})
