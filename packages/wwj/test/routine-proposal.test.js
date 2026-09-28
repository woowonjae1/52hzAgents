'use strict';

/*
  A routine an agent creates is a PROPOSAL the user must approve: the backend
  stores it as pending_approval. Everything an agent is told -- the prompt, the
  MCP tool, the reply after antigravity mirrors a CLI cron -- has to say so, or
  the agent reports a schedule as running that never will (or, before this
  change, one nobody asked for that ran 139 times).
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { routineMirrorReply, routineMirrorFailureReply } = require('../src/adapters/antigravity');
const { McpServer, buildToolDefs } = require('../src/mcp-server');
const { buildApiSkillsPrompt, buildGuardrails, buildClaudeMcpToolBlock } = require('../src/adapters/workspace-prompt');

test('antigravity cron mirror: a pending_approval routine is reported as proposed, not scheduled', () => {
  const reply = routineMirrorReply({ id: 'r1', short_id: 'RTN-007', status: 'pending_approval' }, '每隔 30 分钟', 'summarise commits');
  assert.match(reply, /等待你批准/);
  assert.match(reply, /RTN-007/);
  assert.match(reply, /Automations/);
  assert.doesNotMatch(reply, /已自动登记|到期将自动执行/);
});

test('antigravity cron mirror: an active routine (user-created path) is reported as created', () => {
  const reply = routineMirrorReply({ id: 'r1', short_id: 'RTN-008', status: 'active' }, '每天 10:00', 'x');
  assert.match(reply, /已创建周期任务/);
  assert.doesNotMatch(reply, /等待你批准/);
});

test('antigravity cron mirror: a failed registration never claims the schedule is running', () => {
  const reply = routineMirrorFailureReply(new Error('interval_minutes must be at least 15'), '每隔 5 分钟', 'x');
  assert.match(reply, /未能登记/);
  assert.match(reply, /at least 15/);
  assert.doesNotMatch(reply, /开始监听/);
});

test('MCP workspace_create_routine: description limits it to user-requested recurring work', () => {
  const tool = buildToolDefs(new Set()).find((t) => t.name === 'workspace_create_routine');
  assert.ok(tool);
  assert.match(tool.description, /ONLY when the user asked/);
  assert.match(tool.description, /pending_approval/);
  assert.match(tool.description, /background tasks/);
  assert.match(tool.inputSchema.properties.interval_minutes.description, /15-1440/);
});

test('MCP workspace_create_routine: a pending result tells the agent it awaits approval', async () => {
  const calls = [];
  const wsClient = {
    createRoutine: async (...args) => { calls.push(args); return { id: 'r9', status: 'pending_approval', channel_name: 'routines:bot' }; },
  };
  const server = new McpServer({ wsClient, workspaceId: 'ws', channelName: 'general', agentName: 'bot', token: 't' });
  const out = await server._dispatch('workspace_create_routine', { name: 'Nightly', message: 'm', context: 'c', interval_minutes: 60 });
  const text = out.content[0].text;
  assert.match(text, /Routine proposed/);
  assert.match(text, /waiting for the user's approval/);
  assert.doesNotMatch(text, /Routine created/);
  // The agent's source is sent and no human requester is claimed.
  assert.equal(calls[0][3].source, '52hz:bot');
  assert.equal(calls[0][3].requested_by, undefined);
});

test('workspace prompt: routines section and schedule rule describe proposals', () => {
  const skills = buildApiSkillsPrompt({ endpoint: 'http://x', workspaceId: 'ws', token: 't', agentName: 'bot', channelName: 'general', disabledModules: new Set() });
  assert.match(skills, /Only when the USER asks for recurring work/);
  assert.match(skills, /pending_approval/);
  assert.match(skills, /one-off timer/);
  assert.match(skills, /`interval_minutes` \(15-1440\)/);
  assert.match(buildGuardrails(), /PROPOSAL that waits for the user's approval/);
  assert.match(buildClaudeMcpToolBlock(), /proposal the user must approve/);
});
