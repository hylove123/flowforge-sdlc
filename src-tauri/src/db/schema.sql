-- ================================================================
--  FlowForge SDLC — SQLite schema (migration v1)
--  Registered via tauri-plugin-sql migrations in commands/storage.rs.
--  Timestamps are ISO-8601 strings (UTC), written by the app layer;
--  created_at defaults to the insert time on the SQLite side.
-- ================================================================

-- ─── Projects ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  owner       TEXT DEFAULT '',
  custom_flow_json TEXT,                 -- per-project stage flow override
  stage_configs_json TEXT,               -- per-stage skills/mcps/rules/model
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─── Deliveries (one delivery run through the stage pipeline) ───
CREATE TABLE IF NOT EXISTS deliveries (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT DEFAULT '',
  current_stage TEXT DEFAULT 'req',
  status        TEXT NOT NULL DEFAULT 'in_progress',
  priority      TEXT DEFAULT 'P2',
  assignee      TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_project ON deliveries(project_id);

-- ─── Stage deliverables (documents produced per stage) ──────────
CREATE TABLE IF NOT EXISTS stage_deliverables (
  id           TEXT PRIMARY KEY,
  delivery_id  TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  stage_id     TEXT NOT NULL,
  title        TEXT DEFAULT '',
  content      TEXT DEFAULT '',
  review_score INTEGER,
  review_json  TEXT,                     -- full review result (dimensions, suggestions)
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'draft',
  author       TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_deliverables_delivery ON stage_deliverables(delivery_id, stage_id);

-- ─── Custom AI models (user-configured endpoints) ───────────────
CREATE TABLE IF NOT EXISTS custom_models (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT DEFAULT '',
  base_url   TEXT DEFAULT '',
  api_key    TEXT DEFAULT '',
  model_id   TEXT DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  extra_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─── Code repositories bound to projects ────────────────────────
CREATE TABLE IF NOT EXISTS repositories (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  url          TEXT DEFAULT '',
  branch       TEXT DEFAULT 'main',
  index_status TEXT DEFAULT 'pending',   -- pending | indexing | indexed | failed
  index_json   TEXT,                     -- codebase index snapshot
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_repositories_project ON repositories(project_id);

-- ─── Flow-editor DAGs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dags (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT DEFAULT '',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dags_project ON dags(project_id);

-- ─── Knowledge-graph entities ───────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_entities (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,         -- ontology concept id (Requirement, Deliverable, ...)
  label           TEXT DEFAULT '',
  stage_id        TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_entities_project ON graph_entities(project_id, type);

-- ─── Knowledge-graph edges ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_edges (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  relation        TEXT NOT NULL,         -- ontology relation id (DERIVED_FROM, IMPLEMENTS, ...)
  properties_json TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);

-- ─── AI chat sessions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT DEFAULT '',
  messages_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_id);

-- ─── Deliverable diffs (original vs. human-edited final) ────────
CREATE TABLE IF NOT EXISTS diffs (
  id          TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  stage_id    TEXT NOT NULL,
  original    TEXT DEFAULT '',
  final       TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_diffs_delivery ON diffs(delivery_id, stage_id);
