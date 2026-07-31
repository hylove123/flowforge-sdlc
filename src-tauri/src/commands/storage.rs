// ================================================================
//  commands/storage.rs — SQLite bootstrap via tauri-plugin-sql
//
//  Opens {app_data_dir}/.flowforge/flowforge.db, applies WAL +
//  busy_timeout pragmas and the schema migration. The frontend does
//  CRUD through the tauri-plugin-sql JS API against the same db URL
//  (exposed via the `storage_db_path` command). A future phase (2a)
//  moves StorageService reads/writes onto this store.
// ================================================================

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Schema migration source, embedded at compile time.
const SCHEMA_SQL: &str = include_str!("../db/schema.sql");

/// Migration v2 (Phase 2a): generic key-value store backing the frontend
/// StorageService in tauri mode. Values are the raw strings previously
/// held in localStorage (mostly JSON blobs); `updated_at` is written by
/// the frontend flush loop.
const KV_STORE_SQL: &str = "\
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);";

/// Connection-level pragmas, applied by the frontend right after
/// `Database.load()` (see src/adapters/tauriDb.js). They cannot live in a
/// migration: sqlx wraps migrations in a transaction and
/// `PRAGMA journal_mode=WAL` is rejected inside one. Note sqlx's SQLite
/// driver already defaults new connections to WAL, so the explicit pragma
/// is a guard, and busy_timeout/foreign_keys are per-connection settings.
pub const PRAGMA_SQL: &str =
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;";

/// Absolute path to the FlowForge SQLite database file, creating the
/// parent `.flowforge` directory if needed.
pub fn db_file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let dir = data_dir.join(".flowforge");
    fs::create_dir_all(&dir).map_err(|e| format!("create .flowforge dir failed: {e}"))?;
    Ok(dir.join("flowforge.db"))
}

/// The `sqlite:` connection URL the plugin (and the JS `Database.load`
/// call) use. Migrations are keyed on this exact string.
pub fn db_url<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let path = db_file_path(app)?;
    Ok(format!("sqlite:{}", path.to_string_lossy()))
}

/// Migration set registered with tauri-plugin-sql. Ordered by version.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial schema (10 core tables)",
            sql: SCHEMA_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "kv_store for StorageService (Phase 2a)",
            sql: KV_STORE_SQL,
            kind: MigrationKind::Up,
        },
    ]
}

/// Command: return the absolute `sqlite:` URL for the frontend so it can
/// `Database.load(url)` against the exact connection migrations ran on.
#[tauri::command]
pub fn storage_db_path<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    db_url(&app)
}

/// Command: pragma bootstrap statements for the frontend to execute
/// right after `Database.load()`.
#[tauri::command]
pub fn storage_pragmas() -> &'static str {
    PRAGMA_SQL
}
