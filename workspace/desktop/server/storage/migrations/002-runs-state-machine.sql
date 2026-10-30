-- 002-runs-state-machine.sql
-- Package C: Task State Machine & Event Recovery Schema Extensions

-- 1. Extend runs table with phase, version, lease/heartbeat and evidence
ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE runs ADD COLUMN evidence_json TEXT;
ALTER TABLE runs ADD COLUMN client_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_phase ON runs(phase);
CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_client_msg ON runs(client_message_id);

-- 2. Extend tool_calls with verification requirements on interrupted executions
ALTER TABLE tool_calls ADD COLUMN requires_verification INTEGER NOT NULL DEFAULT 0;
