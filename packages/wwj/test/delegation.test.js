'use strict';

/*
  Delegation from the agent's side: the four MCP tools talk to the backend with
  the agent's own name and channel, a delegated lane runs in its profile's mode
  and model whatever the message around it says, its brief says whom the
  result goes to, and Review mode cannot start or stop lanes.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseAdapter = require('../src/adapters/base');
const ClaudeAdapter = require('../src/adapters/claude');
const { McpServer, buildToolDefs } = require('../src/mcp-server');
const { buildApiSkillsPrompt } = require('../src/adapters/workspace-prompt');

class LaneAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.seen = [];
  }
  async _handleMessage(msg) {
    this.seen.push({ content: msg.content, mode: this._mode, model: this._resolveModel(msg.sessionId, msg) });
  }
  async sendError() {}
  async sendStatus() {}
  async _resolveKnowledgeMentions(c) { return c; }
  async _releaseStaleTodos() {}
  async _registerFilesTouchedSince() {}
}

function makeLaneAdapter(name = 'carol') {
  const reports = [];
  const client = {
    completeParallelLane: async (ws, batchId, agent, result) => { reports.push({ batchId, agent, ...result }); },
    sendMessage: async () => ({}),
    getSession: async () => ({}),
  };
  const a = new LaneAdapter({ agentName: name, workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  a._log = () => {};
  return { a, reports };
}

function delegatedMsg(lanes, extra = {}) {
  return {
    sessionId: 'ch-1',
    content: '**@alice delegated 2 tasks**',
    metadata: {
      agent_mode: 'execute',
      ...extra,
      parallel_batch: { batch_id: 'b-42', isolation: 'worktree', delegated_by: 'alice', lanes },
    },
  };
}

test('a delegated Review lane runs read-only with its profile model, even inside a Fix message', async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-deleg-'));
  const { a, reports } = makeLaneAdapter();
  await a._channelWorker('ch-1', delegatedMsg({
    carol: { task: 'review the parser', working_dir: wt, branch: 'parallel/b-42/carol', mode: 'plan', model: 'strong-model', profile: 'reviewer' },
    bob: { task: 'fix the parser', working_dir: '/elsewhere', branch: 'parallel/b-42/bob', mode: 'execute' },
  }, { agent_models: { carol: 'cheap-model' } }));

  const seen = a.seen[0];
  assert.equal(seen.mode, 'plan', 'the lane mode beats the message agent_mode');
  assert.equal(seen.model, 'strong-model', 'the profile model beats the composer pick');
  assert.match(seen.content, /^\[Delegated\] @alice split work between 2 agents/);
  assert.match(seen.content, /This is a review: .*Do not modify any files/);
  assert.match(seen.content, /delivered to @alice automatically .* do not @mention anyone/);
  assert.equal(reports.length, 1, 'the lane still reports completion');

  // The next, ordinary turn is back to the message's own mode.
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'hi', metadata: { agent_mode: 'execute' } });
  assert.equal(a.seen[1].mode, 'execute');
});

test('a single delegated lane is told it works alone, not "one of 1 agents"', async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-deleg-'));
  const { a } = makeLaneAdapter('bob');
  await a._channelWorker('ch-1', delegatedMsg({ bob: { task: 'fix it', working_dir: wt, branch: 'parallel/b-42/bob', mode: 'execute' } }));
  assert.match(a.seen[0].content, /^\[Delegated\] @alice handed you this task to do on your own\./);
  assert.doesNotMatch(a.seen[0].content, /one of 1 agents|other agents are editing/);
  assert.match(a.seen[0].content, /The main checkout is not yours to change/);
});

test('a lane without a mode keeps the message mode (human and @mention batches)', async () => {
  const { a } = makeLaneAdapter('bob');
  const msg = delegatedMsg({ bob: { task: 'x' } });
  delete msg.metadata.parallel_batch.delegated_by;
  msg.metadata.agent_mode = 'plan';
  await a._channelWorker('ch-1', msg);
  assert.equal(a.seen[0].mode, 'plan');
  assert.match(a.seen[0].content, /^\[Parallel batch\]/);
  assert.match(a.seen[0].content, /Finish with a short summary of what you changed\./);
});

function fakeWs() {
  const calls = [];
  return {
    calls,
    listProfiles: async (ws, token) => {
      calls.push(['listProfiles', ws]);
      return {
        profiles: [
          { name: 'reviewer', agent: 'carol', mode: 'plan', model: 'strong-model', when_to_use: 'careful reviews' },
          { name: 'fixer', agent: 'bob', mode: 'execute', model: '', when_to_use: '' },
        ],
        agent_status: { carol: 'online', bob: 'offline' },
      };
    },
    delegate: async (ws, channel, token, body) => {
      calls.push(['delegate', ws, channel, body]);
      return {
        batch: { id: '1234abcd-0000-0000-0000-000000000000', isolation: 'worktree' },
        lanes: [{ agent: 'carol', profile: 'reviewer', mode: 'plan', branch: 'parallel/1234abcd/carol' }],
      };
    },
    getDelegation: async (ws, id) => {
      calls.push(['getDelegation', id]);
      return {
        batch: { id: '1234abcd-0000', status: 'review', delegated_by: 'alice' },
        lanes: [{ agent: 'carol', status: 'done', branch: 'parallel/1234abcd/carol', diffstat: '1 file changed', reply: 'found two\nissues' }],
      };
    },
    cancelDelegation: async (ws, id, token, body) => {
      calls.push(['cancelDelegation', id, body]);
      return { batch: { id: '1234abcd-0000', status: 'done' }, stopped: ['carol'] };
    },
  };
}

function server(ws) {
  return new McpServer({ wsClient: ws, workspaceId: 'W', channelName: 'thread-7', agentName: 'alice', token: 'T' });
}

test('workspace_delegate sends the caller\'s channel and name, and tells it to end the turn', async () => {
  const ws = fakeWs();
  const res = await server(ws)._dispatch('workspace_delegate', { tasks: [{ profile: 'reviewer', task: 'review the parser' }] });
  assert.deepEqual(ws.calls[0], ['delegate', 'W', 'thread-7', { source: '52hz:alice', tasks: [{ profile: 'reviewer', task: 'review the parser' }] }]);
  const out = res.content[0].text;
  assert.match(out, /batch 1234abcd/);
  assert.match(out, /- carol \[reviewer\] review \(read-only\) on parallel\/1234abcd\/carol/);
  assert.match(out, /end your turn\. Do not poll, wait or @mention/);
});

test('workspace_list_profiles shows mode, model, when to use and an offline agent', async () => {
  const res = await server(fakeWs())._dispatch('workspace_list_profiles', {});
  const out = res.content[0].text;
  assert.match(out, /- reviewer: agent carol, review \(read-only\), model strong-model\n {4}when: careful reviews/);
  assert.match(out, /- fixer: agent bob, fix \(may edit\) -- bob is offline/);
  assert.doesNotMatch(out, /@/, 'no @mentions an agent could echo');
});

test('status and cancel go by id and act as the caller', async () => {
  const ws = fakeWs();
  const s = server(ws);
  const status = (await s._dispatch('workspace_delegation_status', { id: '1234abcd' })).content[0].text;
  assert.match(status, /Batch 1234abcd: review \(delegated by alice\) -- waiting for the user/);
  assert.match(status, /- carol: done \| branch parallel\/1234abcd\/carol \| 1 file changed\n {4}reply: found two issues/);
  const cancel = (await s._dispatch('workspace_cancel_delegation', { id: '1234abcd' })).content[0].text;
  assert.deepEqual(ws.calls.at(-1), ['cancelDelegation', '1234abcd', { source: '52hz:alice' }]);
  assert.match(cancel, /Stopped carol of batch 1234abcd/);
});

test('a refused delegation reaches the agent as a tool error with the backend\'s reason', async () => {
  const ws = fakeWs();
  ws.delegate = async () => { const e = new Error('batch 9f8e7d6c is still running in this thread'); e.statusCode = 409; throw e; };
  const lines = [];
  const s = server(ws);
  s._write = (line) => lines.push(JSON.parse(line));
  await s._handleToolCall(1, { name: 'workspace_delegate', arguments: { tasks: [{ agent: 'bob', task: 'x' }] } });
  assert.equal(lines[0].result.isError, true);
  assert.match(lines[0].result.content[0].text, /still running in this thread/);
});

test('the delegation tools can be switched off as a module', () => {
  const on = buildToolDefs(new Set()).map((t) => t.name);
  const off = buildToolDefs(new Set(['delegation'])).map((t) => t.name);
  for (const name of ['workspace_list_profiles', 'workspace_delegate', 'workspace_delegation_status', 'workspace_cancel_delegation']) {
    assert.ok(on.includes(name), name);
    assert.ok(!off.includes(name), name);
  }
});

test('Review mode cannot start or stop lanes: skills docs and claude allow-list', () => {
  const opts = { endpoint: 'http://x', workspaceId: 'W', token: 'T', agentName: 'alice', channelName: 'C', disabledModules: new Set() };
  const exec = buildApiSkillsPrompt({ ...opts, mode: 'execute' });
  const plan = buildApiSkillsPrompt({ ...opts, mode: 'plan' });
  assert.match(exec, /\/v1\/workspaces\/W\/delegations -d '\{"channel":"C","source":"52hz:alice"/);
  assert.doesNotMatch(plan, /\/delegations -d/);
  assert.doesNotMatch(plan, /\/cancel -d/);
  assert.match(plan, /\/v1\/workspaces\/W\/profiles/, 'reading profiles is fine in Review');

  const claude = new ClaudeAdapter({ agentName: 'alice', workspaceId: 'W', endpoint: 'http://x', token: 'T' });
  claude._log = () => {};
  const toolsFor = (mode) => {
    claude._turnModeOverride = { C: mode };
    const cmd = [];
    claude._buildMcpCmd(cmd, 'C');
    const i = cmd.indexOf('--allowedTools');
    return cmd.slice(i + 1).filter((t) => t.startsWith('mcp__'));
  };
  const planTools = toolsFor('plan');
  const execTools = toolsFor('execute');
  assert.ok(execTools.includes('mcp__wwj-workspace__workspace_delegate'));
  assert.ok(!planTools.includes('mcp__wwj-workspace__workspace_delegate'));
  assert.ok(!planTools.includes('mcp__wwj-workspace__workspace_cancel_delegation'));
  assert.ok(planTools.includes('mcp__wwj-workspace__workspace_delegation_status'));
});
