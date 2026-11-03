-- R1: Real Agent connections, native configuration sources, and multi-file change journal.
-- Existing `agent_definitions` rows with `connection_id IS NULL` remain legacy compatible members
-- (`runtimeKind: 'pi'` continues to mean the built-in Pi SDK assistant).

CREATE TABLE agent_connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('native-pi','native-codex','native-antigravity','native-openclaw','native-hermes')),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 80),
  environment TEXT NOT NULL DEFAULT 'local' CHECK(environment IN ('local','wsl','remote')),
  installation_ref TEXT NOT NULL,
  config_dir TEXT,
  native_profile TEXT,
  capability_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(capability_snapshot_json)),
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_connections_kind ON agent_connections(kind);

CREATE TABLE agent_config_sources (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('session','profile','project','global')),
  format TEXT NOT NULL CHECK(format IN ('json','jsonc','toml')),
  canonical_path TEXT NOT NULL,
  content_sha256 TEXT,
  holds_secret INTEGER NOT NULL DEFAULT 0 CHECK(holds_secret IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, source_key)
);

CREATE INDEX idx_agent_config_sources_conn ON agent_config_sources(connection_id);

CREATE TABLE agent_config_changes (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('prepared','applying','committed','activating','applied','apply_failed','rolled_back')),
  scope TEXT NOT NULL DEFAULT 'global',
  redacted_patch_json TEXT NOT NULL CHECK(json_valid(redacted_patch_json)),
  files_json TEXT NOT NULL CHECK(json_valid(files_json)),
  apply_result_json TEXT CHECK(apply_result_json IS NULL OR json_valid(apply_result_json)),
  actor TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_config_changes_conn ON agent_config_changes(connection_id, created_at DESC);

ALTER TABLE agent_definitions ADD COLUMN connection_id TEXT REFERENCES agent_connections(id) ON DELETE RESTRICT;
CREATE INDEX idx_agent_definitions_connection ON agent_definitions(connection_id);
