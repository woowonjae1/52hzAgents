const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStorage } = require('./storage');
const { closeDatabasesUnder } = require('./storage/database');
const { Store } = require('./store');
const { AgentRunner } = require('./agent-runner');
const { startServer } = require('./index');

function fixture(t, beforeCleanup = async () => {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-agent-identities-')));
  t.after(async () => {
    await beforeCleanup();
    closeDatabasesUnder(root);
    const parent = fs.realpathSync.native(os.tmpdir());
    assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('52hz-agent-identities-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('v6 upgrade assigns one independent Agent without changing legacy models or messages', t => {
  const root = fixture(t), migrationsDir = path.join(root, 'v6-migrations'), dbPath = path.join(root, 'database.sqlite');
  fs.mkdirSync(migrationsDir);
  const source = path.join(__dirname, 'storage', 'migrations');
  for (const file of fs.readdirSync(source).filter(file => /^00[1-6]-/.test(file))) {
    fs.copyFileSync(path.join(source, file), path.join(migrationsDir, file));
  }
  const old = createStorage({ dbPath, migrationsDir });
  const config = { provider: 'custom-connection', model: 'legacy-model', mode: 'plan' };
  old.db.prepare(`INSERT INTO sessions (id, title, runtime_config_json, created_at, updated_at)
    VALUES ('legacy', 'Legacy', ?, '2026-10-30', '2026-10-30')`).run(JSON.stringify(config));
  old.db.prepare(`INSERT INTO messages (id, session_id, role, sender_name, sender_type, content, timestamp, created_at)
    VALUES ('old-message', 'legacy', 'assistant', 'old-provider', 'agent', 'Historical reply', 1, '2026-10-30')`).run();
  old.close();
  const upgraded = createStorage({ dbPath });
  assert.equal(upgraded.sessions.get('legacy').agentId, 'agent-local');
  assert.deepEqual(upgraded.sessions.get('legacy').runtimeConfig, config);
  assert.equal(upgraded.agentDefinitions.list().length, 1);
  assert.equal(upgraded.db.prepare("SELECT sender_name FROM messages WHERE id = 'old-message'").get().sender_name, 'old-provider');
  // Also cover legacy SQL import writers which do not know about agent_id.
  upgraded.db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('imported', 'Imported', 'now', 'now')`).run();
  assert.equal(upgraded.sessions.get('imported').agentId, 'agent-local');
  upgraded.close();
  const reopened = createStorage({ dbPath });
  assert.equal(reopened.agentDefinitions.list().length, 1, 'migration is idempotent');
  assert.deepEqual(reopened.sessions.get('legacy').runtimeConfig, config);
  reopened.close();
});

test('identity revisions, assignments and deletion guards survive reopening independently of models', t => {
  const root = fixture(t), store = new Store(root), repo = store.storage.agentDefinitions;
  const first = repo.create({ name: '开发助手', role: 'developer' });
  const second = repo.create({ name: '审阅员', role: 'reviewer' });
  assert.notEqual(first.id, second.id);
  const config = { provider: 'ollama', model: 'same-model', mode: 'chat' };
  store.updateChannel('general', { agent_id: first.id, runtime_config: config });
  store.updateChannel('other', { agent_id: second.id, runtime_config: config });
  assert.throws(() => repo.delete(first.id, 1), /assigned/);
  assert.throws(() => repo.create({ name: 'invalid', model: 'not-an-agent' }), /Unsupported/);
  assert.throws(() => repo.create({ name: ' '.repeat(3) }), /Invalid/);
  const renamed = repo.update(first.id, { name: '实现助手', expectedRevision: 1 });
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.revision, 2);
  assert.throws(() => repo.update(first.id, { name: 'stale', expectedRevision: 1 }), /Reload/);
  assert.throws(() => repo.delete('agent-local', 1), /default Agent/);
  repo.update(second.id, { status: 'disabled', expectedRevision: 1 });
  assert.throws(() => store.updateChannel('general', { agent_id: second.id }), /disabled/);
  assert.equal(store.getChannel('general').agent_id, first.id, 'failed assignment does not mutate the session');
  store.storage.close();
  const reopened = new Store(root);
  assert.equal(reopened.getChannel('general').agent_id, first.id);
  assert.deepEqual(reopened.getChannel('general').runtime_config, config);
  assert.equal(reopened.storage.agentDefinitions.get(first.id).name, '实现助手');
  reopened.storage.close();
});

test('new runs and streaming use pinned Agent identities while model changes leave identity intact', async t => {
  const root = fixture(t), store = new Store(root), repo = store.storage.agentDefinitions;
  const agent = repo.create({ name: '代码审阅员', role: 'reviewer' });
  store.updateChannel('general', { agent_id: agent.id, working_dir: null, runtime_config: { provider: 'ollama', model: 'first-model', mode: 'chat' } });
  const broadcasts = [];
  let runner, attempts = 0;
  runner = new AgentRunner(store, { broadcast: event => broadcasts.push(event), broadcastComposing() {} }, {
    env: {}, piRuntime: async options => {
      attempts++;
      if (attempts === 1) {
        repo.update(agent.id, { name: '改名后的审阅员', expectedRevision: 1 });
        options.onDelta('stream fixture');
        assert.equal(runner.snapshot('general').payload.sender_name, '代码审阅员');
      }
      return { content: 'Verified fixture', model: options.config.model, usage: null, sdk: 'fixture' };
    },
  });
  t.after(() => runner.close());
  const send = async id => runner.handleUserMessage(store.addEvent({ id, type: 'workspace.message.posted', source: 'human:fixture', target: 'channel/general', payload: { content: 'Inspect fixture' } }));
  await send('first-message');
  const reply = store.data.events.find(event => event.metadata?.in_reply_to === 'first-message');
  assert.equal(reply.source, `52hz:${agent.id}`);
  assert.equal(reply.payload.sender_name, '代码审阅员');
  assert.equal(reply.metadata.agent_identity.revision, 1);
  const firstRun = store.storage.runs.list('general').find(run => run.clientMessageId === 'first-message');
  assert.equal(firstRun.agentId, agent.id);
  assert.equal(firstRun.configSnapshot.agent.name, '代码审阅员');
  store.updateChannel('general', { runtime_config: { provider: 'ollama', model: 'second-model', mode: 'chat' } });
  await send('second-message');
  const next = store.data.events.find(event => event.metadata?.in_reply_to === 'second-message');
  assert.equal(next.source, reply.source);
  assert.equal(next.payload.sender_name, '改名后的审阅员');
  assert.equal(next.metadata.model, 'second-model');
  assert.equal(firstRun.configSnapshot.agent.revision, 1);
  repo.update(agent.id, { status: 'disabled', expectedRevision: 2 });
  await assert.rejects(send('disabled-message'), /disabled/);
  assert.equal(attempts, 2);
});

test('HTTP Agent management, assignment and discovery are independent of provider count', async t => {
  let release, started, server;
  const root = fixture(t, async () => { release?.(); if (server) await server.shutdown(); });
  const waiting = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const result = await startServer({ port: 0, userDataPath: root, staticDir: root,
    runtimeOptions: { apiToken: 'fixture-token', piRuntime: async () => { started(); await waiting; return { content: 'fixture', model: 'fixture', usage: null }; } },
  });
  server = result.server;
  const port = result.port;
  const request = async (route, method = 'GET', body) => {
    const result = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': 'fixture-token' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, body: await result.json() };
  };
  assert.equal((await request('/v1/agent-definitions')).body.agents.length, 1);
  const created = await request('/v1/agent-definitions', 'POST', { name: '测试助手', role: 'tester' });
  assert.equal(created.status, 201);
  const agent = created.body;
  const assigned = await request('/v1/runtime/session/agent', 'PATCH', { channel: 'general', agentId: agent.id });
  assert.equal(assigned.body.agent.id, agent.id);
  assert.equal((await request('/v1/runtime/session?channel=general')).body.agent.id, agent.id);
  assert.equal((await request(`/v1/agent-definitions/${agent.id}`, 'DELETE', { expectedRevision: 1 })).status, 409);
  assert.equal((await request('/v1/workspaces/52hz/channels/general', 'PATCH', { agent_id: 'agent-local' })).status, 400);
  assert.equal((await request('/v1/runtime/session/agent', 'PATCH', { channel: 'missing', agentId: agent.id })).status, 404);
  assert.equal((await request('/v1/runtime/session/agent', 'PATCH', { channel: 'general', agentId: 'missing' })).status, 404);
  const discovery = (await request('/v1/discover')).body;
  assert.deepEqual(new Set(discovery.agents.map(agent => agent.agent_id)), new Set(['agent-local', agent.id]));
  assert.equal(discovery.agents.find(row => row.agent_id === agent.id).display_name, '测试助手');
  const delivered = { type: 'workspace.message.posted', source: 'fixture:seed', target: 'channel/general', payload: { content: 'Already delivered' }, client_message_id: 'delivered-before-disable' };
  assert.equal((await request('/v1/events', 'POST', delivered)).status, 200);
  assert.equal((await request(`/v1/agent-definitions/${agent.id}`, 'PATCH', { status: 'disabled', expectedRevision: 1 })).status, 200);
  assert.equal((await request('/v1/events', 'POST', { payload: { content: 'Do not run a disabled Agent' } })).status, 409);
  const retried = await request('/v1/events', 'POST', { ...delivered, source: 'human:fixture' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.duplicate, true, 'a delivered message stays acknowledged after its Agent is disabled');
  assert.equal((await request(`/v1/agent-definitions/${agent.id}`, 'PATCH', { status: 'active', expectedRevision: 2 })).status, 200);
  await request('/v1/runtime/session?channel=general', 'PATCH', { provider: 'ollama', model: 'fixture', mode: 'chat' });
  await request('/v1/events', 'POST', { type: 'workspace.message.posted', source: 'human:fixture', target: 'channel/general', payload: { content: 'fixture' } });
  await Promise.race([running, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('run did not start')), 3000); timer.unref(); })]);
  assert.equal((await request('/v1/runtime/session/agent', 'PATCH', { channel: 'general', agentId: 'agent-local' })).status, 409);
  release();
});
