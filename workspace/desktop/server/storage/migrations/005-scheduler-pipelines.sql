-- Migration 005: Scheduled Routines, Routine Runs, Timers & Channel Pipelines

-- 1. Scheduled Routines table
CREATE TABLE IF NOT EXISTS scheduled_routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  session_id TEXT,
  channel_name TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  schedule_hour INTEGER DEFAULT 0,
  schedule_minute INTEGER DEFAULT 0,
  schedule_days_json TEXT,
  schedule_interval_minutes INTEGER,
  timezone TEXT DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active',
  next_fires_at TEXT,
  last_fired_at TEXT,
  run_count INTEGER DEFAULT 0,
  last_run_id TEXT,
  last_run_status TEXT,
  last_run_error TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  created_by TEXT DEFAULT 'human:user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routines_status ON scheduled_routines(status, next_fires_at);
CREATE INDEX IF NOT EXISTS idx_routines_channel ON scheduled_routines(channel_name);

-- 2. Routine Execution Runs history
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES scheduled_routines(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  channel_name TEXT NOT NULL,
  trigger_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  result TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id);

-- 3. Timers table
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  message TEXT NOT NULL,
  delay_seconds INTEGER NOT NULL,
  fires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT DEFAULT 'human:user',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timers_status ON timers(status, fires_at);

-- 4. Channel Pipelines table
CREATE TABLE IF NOT EXISTS channel_pipelines (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  current_index INTEGER NOT NULL DEFAULT 0,
  total_retries INTEGER NOT NULL DEFAULT 0,
  max_total_retries INTEGER NOT NULL DEFAULT 3,
  started_by TEXT DEFAULT 'human:user',
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_pipelines_active ON channel_pipelines(channel_id, active);
