/**
 * dataTransfer — export / import of all FlowForge KV data
 *
 * Phase 2a tooling: lets users back up the full flowforge* key set as a
 * JSON payload and restore it later. Works in both modes because it only
 * talks to the StorageService adapter (localStorage on web, SQLite-backed
 * cache on tauri). The migration marker is excluded so an imported backup
 * never suppresses the legacy migration on a fresh tauri install.
 */

import { storage, FLOWFORGE_KEY_PREFIX, MIGRATION_MARKER_KEY } from '@/adapters/StorageService'

export const EXPORT_FORMAT_VERSION = 1

/**
 * Snapshot every flowforge* key into a portable payload.
 * @returns {{version:number, exportedAt:string, mode:string, data:Object<string,string>}}
 */
export function exportAllData(svc = storage) {
  const data = {}
  for (const key of svc.keys()) {
    if (key === MIGRATION_MARKER_KEY) continue
    const value = svc.get(key)
    if (value !== null) data[key] = value
  }
  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    mode: svc.mode,
    data,
  }
}

/**
 * Validate an import payload (parsed JSON).
 * @returns {{ok:true, keyCount:number} | {ok:false, error:string}}
 */
export function validateImportPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '导入文件不是有效的 FlowForge 备份（缺少对象结构）' }
  }
  if (payload.version !== EXPORT_FORMAT_VERSION) {
    return { ok: false, error: `不支持的备份版本：${payload.version ?? '未知'}` }
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return { ok: false, error: '备份缺少 data 字段' }
  }
  const keys = Object.keys(payload.data)
  for (const key of keys) {
    if (!key.startsWith(FLOWFORGE_KEY_PREFIX)) {
      return { ok: false, error: `非法 key：「${key}」（仅允许 flowforge* 前缀）` }
    }
    if (typeof payload.data[key] !== 'string') {
      return { ok: false, error: `key「${key}」的值必须是字符串` }
    }
  }
  return { ok: true, keyCount: keys.length }
}

/**
 * Write a validated payload into storage (overwrites existing keys).
 * @returns {{ok:true, keyCount:number} | {ok:false, error:string}}
 */
export function importAllData(payload, svc = storage) {
  const check = validateImportPayload(payload)
  if (!check.ok) return check
  for (const [key, value] of Object.entries(payload.data)) {
    if (key === MIGRATION_MARKER_KEY) continue
    svc.set(key, value)
  }
  return check
}
