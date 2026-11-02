-- Existing Agent identities retain their original execution capability.
-- New definitions use the safer defaults supplied by the repository.
ALTER TABLE agent_definitions ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT
'{"instructions":"","defaultMode":"chat","maxMode":"agent","modelResource":null,"permissions":{"readFiles":true,"writeFiles":true,"executeCommands":true,"mcp":true,"delegate":true,"knowledge":true},"limits":{}}'
CHECK(json_valid(execution_policy_json));
