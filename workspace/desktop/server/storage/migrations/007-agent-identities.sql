-- Agent identity is independent of model connections and delegation presets.
CREATE TABLE agent_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'assistant',
  runtime_kind TEXT NOT NULL DEFAULT 'pi' CHECK(runtime_kind = 'pi'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agent_definitions (id, name, description, role, built_in, created_at, updated_at)
VALUES ('agent-local', '52hz Agent', '本地工作助手；模型连接由任务配置单独指定。', 'assistant', 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agent_definitions(id) ON DELETE RESTRICT;
UPDATE sessions SET agent_id = 'agent-local' WHERE agent_id IS NULL;
CREATE INDEX idx_sessions_agent ON sessions(agent_id);

-- Legacy JSON imports and existing SQL writers also receive one default identity.
-- Do not create one Agent per provider, and do not rewrite historical messages.
CREATE TRIGGER sessions_default_agent AFTER INSERT ON sessions WHEN NEW.agent_id IS NULL
BEGIN
  UPDATE sessions SET agent_id = 'agent-local' WHERE id = NEW.id;
END;
