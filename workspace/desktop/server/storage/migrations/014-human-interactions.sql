CREATE TABLE human_interactions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  native_request_id TEXT NOT NULL,
  native_session TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('question','approval')),
  state TEXT NOT NULL DEFAULT 'waiting',
  questions_json TEXT NOT NULL,
  answer_json TEXT,
  idempotency_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  owner_pid INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  receipt TEXT,
  UNIQUE(run_id, attempt_id, native_request_id)
);
CREATE INDEX idx_human_interactions_channel ON human_interactions(channel, created_at);
CREATE INDEX idx_human_interactions_run ON human_interactions(run_id, state);
