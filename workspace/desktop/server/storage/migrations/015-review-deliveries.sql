ALTER TABLE parallel_batches ADD COLUMN native_budget_policy_json TEXT;
ALTER TABLE parallel_batches ADD COLUMN review_verification INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_lanes ADD COLUMN delivery_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_lanes ADD COLUMN reviewed_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parallel_lanes ADD COLUMN review_worktree_path TEXT;
UPDATE parallel_lanes SET delivery_version=1 WHERE commit_hash != '';
UPDATE parallel_lanes SET reviewed_version=1 WHERE commit_hash != '' AND reviewed_commit=commit_hash AND review_status='approved';
CREATE TABLE collaboration_reviews (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL REFERENCES parallel_lanes(id) ON DELETE CASCADE,
  delivery_version INTEGER NOT NULL,
  delivery_commit TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  run_id TEXT,
  verdict TEXT NOT NULL,
  notes TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE collaboration_run_usage ADD COLUMN usage_known INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collaboration_run_usage ADD COLUMN estimated_cost REAL;
