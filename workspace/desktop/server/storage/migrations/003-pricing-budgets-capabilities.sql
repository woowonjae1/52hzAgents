-- 003-pricing-budgets-capabilities.sql
-- Package G & F: Request Ledger, Pricing Catalog, Budget Limits & Model Capabilities

-- 1. Extend model_requests with purpose, cache tokens, cost estimation, currency and raw usage
ALTER TABLE model_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'generate';
ALTER TABLE model_requests ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE model_requests ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
ALTER TABLE model_requests ADD COLUMN estimated_cost REAL;
ALTER TABLE model_requests ADD COLUMN currency TEXT DEFAULT 'USD';
ALTER TABLE model_requests ADD COLUMN pricing_version TEXT;
ALTER TABLE model_requests ADD COLUMN raw_usage_json TEXT;

CREATE INDEX IF NOT EXISTS idx_model_req_session ON model_requests(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_req_purpose ON model_requests(purpose);

-- 2. Extend usage_records with estimated_cost and currency
ALTER TABLE usage_records ADD COLUMN estimated_cost REAL;
ALTER TABLE usage_records ADD COLUMN currency TEXT DEFAULT 'USD';

-- 3. Model Pricing Catalog Table (G2)
CREATE TABLE IF NOT EXISTS model_pricing (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_cost_per_million REAL NOT NULL,
  output_cost_per_million REAL NOT NULL,
  cache_read_cost_per_million REAL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'preset', -- 'preset' | 'user_custom' | 'override'
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricing_provider_model ON model_pricing(provider, model_id);

-- 4. Budget Limits Table (G3)
CREATE TABLE IF NOT EXISTS budget_limits (
  id TEXT PRIMARY KEY, -- 'global' or 'session:${sessionId}'
  target_type TEXT NOT NULL, -- 'global' | 'session' | 'project'
  target_id TEXT NOT NULL,
  max_tokens_per_run INTEGER,
  max_steps_per_run INTEGER DEFAULT 30,
  max_duration_seconds INTEGER DEFAULT 600,
  max_cost_per_session REAL,
  max_cost_per_day REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  action_on_exceed TEXT NOT NULL DEFAULT 'block', -- 'block' | 'warn'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_target ON budget_limits(target_type, target_id);

-- 5. Model Capabilities Catalog Table (F1)
CREATE TABLE IF NOT EXISTS model_capabilities (
  id TEXT PRIMARY KEY, -- '${connectionId}:${modelId}'
  connection_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  context_window INTEGER,
  max_output_tokens INTEGER,
  supports_tools INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  capability_status TEXT NOT NULL DEFAULT 'declared', -- 'unknown' | 'declared' | 'verified' | 'unsupported'
  verified_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cap_conn_model ON model_capabilities(connection_id, model_id);
