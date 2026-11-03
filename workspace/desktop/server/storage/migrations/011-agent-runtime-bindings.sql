-- Keep the v7 Pi-only identity column for compatibility with older SQL writers.
-- This binding is the authoritative execution adapter; identity/FKs stay intact.
ALTER TABLE agent_definitions ADD COLUMN runtime_binding_json TEXT NOT NULL
  DEFAULT '{"kind":"pi"}'
  CHECK(json_valid(runtime_binding_json) AND json_extract(runtime_binding_json, '$.kind') IN ('pi','codex','antigravity','gemini'));
