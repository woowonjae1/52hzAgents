-- Migration 004: MCP Servers, Run Artifacts, Knowledge Entries & Knowledge FTS5

-- 1. MCP Servers registry
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT,
  args_json TEXT,
  env_json TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'stopped',
  error_message TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_start INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status, enabled);

-- 2. MCP Tools cache (discovered from active MCP servers)
CREATE TABLE IF NOT EXISTS mcp_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  input_schema_json TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(server_id, name)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id);

-- 3. Run Artifacts (Outputs produced by runs)
CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  artifact_type TEXT NOT NULL DEFAULT 'file',
  size_bytes INTEGER DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_session ON run_artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id);

-- 4. Knowledge Entries
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  content TEXT NOT NULL,
  content_size INTEGER DEFAULT 0,
  created_by TEXT DEFAULT 'human:user',
  updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_entries(status);

-- 5. Knowledge FTS5 (Trigram full-text index for Chinese + English search)
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  entry_id UNINDEXED,
  title,
  description,
  content,
  category,
  tokenize="trigram"
);

-- Triggers to keep knowledge_fts in sync
CREATE TRIGGER IF NOT EXISTS trg_knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts (entry_id, title, description, content, category)
  VALUES (new.id, new.title, COALESCE(new.description, ''), new.content, COALESCE(new.category, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
  DELETE FROM knowledge_fts WHERE entry_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
  DELETE FROM knowledge_fts WHERE entry_id = old.id;
  INSERT INTO knowledge_fts (entry_id, title, description, content, category)
  VALUES (new.id, new.title, COALESCE(new.description, ''), new.content, COALESCE(new.category, ''));
END;
