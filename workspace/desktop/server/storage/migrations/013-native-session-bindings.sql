-- 013-native-session-bindings.sql
-- R2: Native session bindings and exclusive write locks for native CLI/RPC adapters

CREATE TABLE IF NOT EXISTS native_session_bindings (
  id TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  context_key TEXT,
  agent_id TEXT NOT NULL,
  connection_id TEXT,
  adapter_kind TEXT NOT NULL,
  native_session_id TEXT,
  native_session_file TEXT,
  session_dir TEXT,
  last_leaf_id TEXT,
  active_run_id TEXT,
  active_attempt_id TEXT,
  lock_state TEXT NOT NULL DEFAULT 'idle' CHECK (lock_state IN ('idle', 'locked', 'awaiting_input', 'broken')),
  effective_model TEXT,
  effective_provider TEXT,
  config_fingerprint TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_native_session_bindings_channel_agent
  ON native_session_bindings(channel, agent_id);
CREATE INDEX IF NOT EXISTS idx_native_session_bindings_session_file
  ON native_session_bindings(native_session_file);
