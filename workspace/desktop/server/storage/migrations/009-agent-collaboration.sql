ALTER TABLE parallel_batches ADD COLUMN runtime_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_batches ADD COLUMN base_commit TEXT NOT NULL DEFAULT '';
ALTER TABLE parallel_batches ADD COLUMN review_snapshot_json TEXT;
ALTER TABLE parallel_batches ADD COLUMN integration_path TEXT;
ALTER TABLE parallel_lanes ADD COLUMN agent_id TEXT REFERENCES agent_definitions(id) ON DELETE SET NULL;
ALTER TABLE parallel_lanes ADD COLUMN agent_snapshot_json TEXT;
ALTER TABLE parallel_lanes ADD COLUMN dispatch_event_id TEXT;
ALTER TABLE parallel_lanes ADD COLUMN context_key TEXT;
ALTER TABLE parallel_lanes ADD COLUMN claim_token TEXT;
ALTER TABLE parallel_lanes ADD COLUMN delivery_json TEXT;
ALTER TABLE parallel_lanes ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_lanes ADD COLUMN attempt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_lanes ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_lanes ADD COLUMN review_run_id TEXT;
ALTER TABLE parallel_lanes ADD COLUMN review_event_id TEXT;
ALTER TABLE parallel_lanes ADD COLUMN review_snapshot_json TEXT;
CREATE UNIQUE INDEX idx_bound_batch_channel ON parallel_batches(channel_name)
WHERE runtime_version = 1 AND status IN ('running', 'review', 'blocked');
CREATE TABLE collaboration_run_usage (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  lane_id TEXT NOT NULL REFERENCES parallel_lanes(id) ON DELETE CASCADE,
  tokens INTEGER NOT NULL
);
