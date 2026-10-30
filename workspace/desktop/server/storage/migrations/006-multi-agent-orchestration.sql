-- Migration 006: Multi-Agent Orchestration, Work Profiles & Parallel Batches

-- 1. Work Profiles table
CREATE TABLE IF NOT EXISTS work_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '52hz',
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  role TEXT DEFAULT 'implementer',
  model TEXT DEFAULT '',
  mode TEXT DEFAULT 'execute',
  description TEXT DEFAULT '',
  allowed_tools_json TEXT DEFAULT '[]',
  budget_tokens INTEGER DEFAULT 0,
  budget_cost_micros INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_profiles_ws ON work_profiles(workspace_id);

-- 2. Parallel Batches table
CREATE TABLE IF NOT EXISTS parallel_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '52hz',
  channel_name TEXT NOT NULL,
  parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  isolation TEXT NOT NULL DEFAULT 'worktree',
  origin TEXT NOT NULL DEFAULT 'board',
  repo_dir TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT DEFAULT '',
  review_agent TEXT DEFAULT '',
  delegated_by TEXT DEFAULT '',
  total_budget_tokens INTEGER DEFAULT 0,
  used_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_parallel_batches_ch ON parallel_batches(channel_name, status);

-- 3. Parallel Lanes table
CREATE TABLE IF NOT EXISTS parallel_lanes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES parallel_batches(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  agent TEXT NOT NULL,
  role TEXT DEFAULT 'implementer',
  task TEXT NOT NULL DEFAULT '',
  scope TEXT DEFAULT '',
  worktree_path TEXT DEFAULT '',
  branch TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT DEFAULT '',
  commit_hash TEXT DEFAULT '',
  reply TEXT DEFAULT '',
  diffstat TEXT DEFAULT '',
  changed_files TEXT DEFAULT '',
  attempts INTEGER DEFAULT 1,
  port INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  review_status TEXT DEFAULT '',
  reviewer TEXT DEFAULT '',
  review_notes TEXT DEFAULT '',
  review_info TEXT DEFAULT '',
  review_channel TEXT DEFAULT '',
  reviewed_commit TEXT DEFAULT '',
  review_started_at TEXT,
  profile TEXT DEFAULT '',
  mode TEXT DEFAULT '',
  model TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_parallel_lanes_batch ON parallel_lanes(batch_id, agent);

-- 4. Parallel Conflicts table
CREATE TABLE IF NOT EXISTS parallel_conflicts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES parallel_batches(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  conflicting_lanes_json TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parallel_conflicts_batch ON parallel_conflicts(batch_id);
