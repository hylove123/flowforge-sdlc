/**
 * tauriDb — SQLite bootstrap for tauri mode (Phase 1 skeleton)
 *
 * Loads {app_data_dir}/.flowforge/flowforge.db through tauri-plugin-sql.
 * `Database.load` runs the schema migrations registered in Rust
 * (src-tauri/src/commands/storage.rs); the pragma bootstrap (WAL,
 * busy_timeout=5000, foreign_keys) is applied right after. Phase 2a
 * will route StorageService CRUD through this handle — for now it is
 * used for connectivity/CRUD verification only.
 *
 * Never import this module in web mode code paths: callers must guard
 * with `detectRuntimeMode() === 'tauri'` (see SidecarContext).
 */

import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'

let dbPromise = null

/** Open (once) and return the FlowForge database handle. */
export function openFlowforgeDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = await invoke('storage_db_path')
      const db = await Database.load(url) // applies migrations
      const pragmas = await invoke('storage_pragmas')
      await db.execute(pragmas)
      return db
    })().catch((e) => {
      dbPromise = null // allow retry on next call
      throw e
    })
  }
  return dbPromise
}

/** Quick connectivity check: counts rows in `projects`. */
export async function checkDb() {
  const db = await openFlowforgeDb()
  const rows = await db.select('SELECT COUNT(*) AS n FROM projects')
  return { ok: true, projects: rows[0]?.n ?? 0 }
}
