/**
 * dataTransfer tests — export/import round-trip and payload validation
 * (Settings → 数据管理, Phase 2a backup tooling).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStorageService, MIGRATION_MARKER_KEY } from '@/adapters/StorageService'
import {
  exportAllData,
  importAllData,
  validateImportPayload,
  EXPORT_FORMAT_VERSION,
} from '@/services/dataTransfer'

describe('dataTransfer', () => {
  const svc = createStorageService('web')

  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('exports only flowforge* keys, excluding the migration marker', () => {
    svc.set('flowforge_custom_models', '[{"id":"m1"}]')
    svc.set('flowforge_dags', '[]')
    svc.set(MIGRATION_MARKER_KEY, '2026-01-01T00:00:00.000Z')
    localStorage.setItem('other_app_key', 'nope')

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

  it('import rejects invalid payloads without touching storage', () => {
    const result = importAllData({ version: 1, data: { evil_key: 'v' } }, svc)
    expect(result.ok).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('export → import round-trip restores every key', () => {
    svc.set('flowforge_custom_models', '[{"id":"m1","apiKey":"sk-…"}]')
    svc.setJSON('flowforge_repositories', [{ id: 'r1', url: 'git@x' }])
    const payload = exportAllData(svc)

    localStorage.clear()
    expect(svc.get('flowforge_custom_models')).toBeNull()

    const result = importAllData(payload, svc)
    expect(result).toEqual({ ok: true, keyCount: 2 })
    expect(svc.get('flowforge_custom_models')).toBe('[{"id":"m1","apiKey":"sk-…"}]')
    expect(svc.getJSON('flowforge_repositories')).toEqual([{ id: 'r1', url: 'git@x' }])
  })
})
