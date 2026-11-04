import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Store } from './store.js';
import { AgentRunner } from './agent-runner.js';
import { Collaboration } from './collaboration.js';
import { runPiAgent } from './pi-engine.mjs';
import { closeDatabasesUnder } from './storage/database.js';
import { startServer } from './index.js';

const waitFor = async predicate => {
  // Real Git worktree creation and delivery capture are part of these integration tests.
  const end = Date.now() + 60000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for collaboration'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function fixture(t, runtime) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-collaboration-')));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(project, 'shared.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  const store = new Store(path.join(root, 'data'));
  store.updateChannel('general', { working_dir: project, runtime_config: { provider: 'ollama', model: 'coordinator-model', mode: 'chat' } });
  const bus = { broadcast() {}, broadcastComposing() {} }, calls = [];
  const runner = new AgentRunner(store, bus, { env: {}, timeoutMs: 30000,
    piRuntime: async options => { calls.push(options); return runtime(options, calls); },
  });
  const collaboration = new Collaboration(store, runner, bus); runner.collaboration = collaboration;
  const cleanup = [];
  t.after(async () => {
    for (const action of cleanup) await action();
    await runner.close(); closeDatabasesUnder(root);
    const parent = fs.realpathSync.native(os.tmpdir());
    assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('52hz-collaboration-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const actor = (name, writer = false) => store.storage.agentDefinitions.create({ name, instructions: `ROLE_${name}`, role: name,
    modelResource: { connectionId: 'ollama', modelId: `${name}-model`, maxOutputTokens: 128 },
    defaultMode: writer ? 'agent' : 'plan', maxMode: writer ? 'agent' : 'plan', permissions: { writeFiles: writer, executeCommands: false },
  });
  return { root, project, store, runner, collaboration, git, actor, calls, cleanup };
}
async function actualPi(options, responses) {
  const faux = createFauxCore({ models: [{ id: options.config.model }], tokensPerSecond: 1e9 });
  faux.setResponses(responses);
  return runPiAgent({ ...options, model: { ...faux.getModel() }, streamFn: faux.streamSimple });
}
const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const deliveryVersion = lane => ({ expected_commit:lane.commit_hash, expected_version:lane.delivery_version });

test('authenticated HTTP dispatch, real completion, human review, merge, cleanup and pipeline use saved Agents', async t => {
  const f = fixture(t, async () => ({ content: 'unused' }));
  const { server, port } = await startServer({ port: 0, userDataPath: f.store.userDataPath, staticDir: f.root,
    runtimeOptions: { apiToken: 'collaboration-test-token', env: {}, timeoutMs: 30000,
      piRuntime: options => actualPi(options, options.contextKey.includes(':step:')
        ? [fauxAssistantMessage(`Pipeline handoff from ${options.agentPolicy.name}`)]
        : [tool('write', { path: 'http-delivery.txt', content: 'verified HTTP delivery' }), fauxAssistantMessage('HTTP delivery complete')]),
    },
  });
  f.cleanup.push(() => server.shutdown());
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': 'collaboration-test-token' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/parallel-batch`)).status, 401);
  const created = await request('/v1/agent-definitions', 'POST', { name: 'HTTP Author', defaultMode: 'agent', maxMode: 'agent',
    modelResource: { connectionId: 'ollama', modelId: 'author-http-model', maxOutputTokens: 128 }, permissions: { writeFiles: true },
  });
  assert.equal(created.status, 201);
  const actor = created.body;
  const started = await request('/v1/parallel-batch/start', 'POST', { channel: 'general', workers: [{ agent_id: actor.id, task: 'Write HTTP delivery' }] });
  assert.equal(started.status, 200);
  const batchId = started.body.run.batch.id, lane = started.body.run.lanes[0];
  const base = `/v1/workspaces/52hz/parallel-batches/${batchId}`;
  assert.equal((await request(`${base}/lanes/${lane.id}/complete`, 'POST', { status: 'done' })).status, 409);
  await waitFor(() => server.agentRunner.active.size === 0 && server.agentRunner.collaboration.view(batchId).run.lanes[0].status === 'done');
  const polled = await request('/v1/parallel-batch?channel=general');
  assert.equal(polled.body.run.lanes[0].agent_name, 'HTTP Author');
  assert.equal(polled.body.run.lanes[0].agent_id, actor.id);
  const recovery = await request('/v1/runtime/recovery?channel=general');
  const recoverable = recovery.body.runs.find(run => run.id === polled.body.run.lanes[0].run_id);
  assert.equal(recoverable.checkpoint.worktree, true);
  assert.equal(recoverable.checkpoint.root_matches, true);
  const wrongWorkspace = await request(`/v1/workspaces/other/parallel-batches/${batchId}/lanes/${lane.id}/review/complete`, 'POST', { verdict: 'approved' });
  assert.equal(wrongWorkspace.status, 404);
  const review = await request(`${base}/lanes/${lane.id}/review/complete`, 'POST', { verdict: 'approved', notes: 'Reviewed', reviewer: 'forged-agent',...deliveryVersion(polled.body.run.lanes[0]) });
  assert.equal(review.status, 200); assert.equal(review.body.run.lanes[0].reviewer, 'human:user');
  assert.equal((await request(`${base}/merge`, 'POST',{expected_deliveries:review.body.run.lanes.map(l=>({id:l.id,commit:l.commit_hash,version:l.delivery_version}))})).status, 200);
  assert.equal((await request('/v1/runtime/restore', 'POST', { channel: 'general', run_id: lane.run_id || recoverable.id })).status, 409);
  assert.equal(fs.readFileSync(path.join(f.project, 'http-delivery.txt'), 'utf8'), 'verified HTTP delivery');
  const diffBeforeCleanup = await request(`${base}/lanes/${lane.id}/diff`);
  assert.equal(diffBeforeCleanup.status, 200);
  assert.equal(diffBeforeCleanup.body.available, true);
  assert.ok(diffBeforeCleanup.body.files.some(file => file.path === 'http-delivery.txt'));
  assert.match(diffBeforeCleanup.body.diff, /verified HTTP delivery/);
  assert.equal((await request(`${base}/cleanup`, 'POST')).status, 200);
  assert.equal(fs.existsSync(lane.worktree_path), false);
  const diffAfterCleanup = await request(`${base}/lanes/${lane.id}/diff`);
  assert.equal(diffAfterCleanup.status, 200);
  assert.equal(diffAfterCleanup.body.available, true);
  assert.ok(diffAfterCleanup.body.files.some(file => file.path === 'http-delivery.txt'));
  assert.equal((await request(`${base}/cleanup`, 'POST')).status, 200);
  assert.equal(server.agentRunner.collaboration.view(batchId).run.lanes[0].status, 'merged');
  const pipeline = await request('/v1/channels/general/pipeline', 'POST', {
    steps: [{ agent_id: actor.id, instruction: 'Check delivery' }, { agent_id: actor.id, instruction: 'Summarize prior check' }],
  });
  assert.equal(pipeline.status, 200);
  await waitFor(() => server.store.storage.pipelines.get('general').status === 'completed' && server.agentRunner.active.size === 0);
  const completed = await request('/v1/channels/general/pipeline');
  assert.ok(completed.body.steps.every(step => step.agent_id === actor.id && step.run_id && step.deliverable));
});

test('two saved Agents use independent resources, contexts, worktrees and read-only reviewer before real merge', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async options => {
    assert.equal(options.history.length, 0);
    assert.ok(!options.prompt.includes('PRIVATE_MAIN_HISTORY'));
    if (options.contextKey.includes(':review:')) {
      assert.equal(options.config.model, 'reviewer-model'); assert.equal(options.config.mode, 'plan');
      assert.equal(options.agentPolicy.permissions.writeFiles, false); assert.equal(options.agentPolicy.permissions.mcp, false);
      return actualPi(options, [fauxAssistantMessage(JSON.stringify({ verdict: 'approved', notes: 'Checked delivery.' }))]);
    }
    await gate;
    const name = options.config.model.startsWith('alpha') ? 'alpha' : 'beta';
    assert.match(options.agentPolicy.instructions, new RegExp(`ROLE_${name}`));
    return actualPi(options, [tool('write', { path: `${name}.txt`, content: `${name} delivery` }), fauxAssistantMessage(`${name} completed`)]);
  });
  const alpha = f.actor('alpha', true), beta = f.actor('beta', true), reviewer = f.actor('reviewer');
  f.store.addEvent({ type: 'workspace.message.posted', source: 'human:fixture', target: 'channel/general', payload: { content: 'PRIVATE_MAIN_HISTORY' } });
  const initial = f.collaboration.start('general', { workers: [{ agent_id: alpha.id, task: 'Write alpha' }, { agent_id: beta.id, task: 'Write beta' }], review_agent: reviewer.id });
  const id = initial.run.batch.id;
  await waitFor(() => f.calls.length === 2);
  assert.equal(f.runner.active.size, 2);
  assert.notEqual(f.calls[0].projectDir, f.calls[1].projectDir);
  assert.notEqual(f.calls[0].contextKey, f.calls[1].contextKey);
  assert.equal(fs.existsSync(path.join(f.project, 'alpha.txt')), false);
  release();
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(id).run.lanes.every(lane => lane.review_status === 'approved'));
  let view = f.collaboration.view(id);
  assert.equal(view.run.batch.status, 'review');
  assert.deepEqual(new Set(view.run.lanes.map(lane => lane.agent_id)), new Set([alpha.id, beta.id]));
  assert.ok(view.run.lanes.every(lane => lane.run_id && lane.delivery?.commit && lane.reviewed_commit === lane.delivery.commit));
  for (const lane of view.run.lanes) {
    const record = f.store.storage.runs.get(lane.run_id);
    assert.equal(record.agentId, lane.agent_id); assert.equal(record.configSnapshot.collaboration.contextKey, lane.context_key);
  }
  assert.ok(view.run.batch.used_tokens > 0);
  // Provenance is server-owned; forged metadata cannot choose a worker directory or identity.
  assert.throws(() => f.collaboration.resolve({ id: 'forged', metadata: { lane_id: view.run.lanes[0].id } }, 'general'), /provenance/);
  const count = f.calls.length;
  const original = f.store.data.events.find(event => event.metadata?.lane_id === view.run.lanes[0].id && event.source.startsWith('orchestration:lane:'));
  await f.runner.handleUserMessage(original); assert.equal(f.calls.length, count, 'completed dispatch cannot replay');
  view = f.collaboration.merge(id); assert.equal(view.run.batch.status, 'done');
  assert.equal(fs.readFileSync(path.join(f.project, 'alpha.txt'), 'utf8'), 'alpha delivery');
  assert.equal(fs.readFileSync(path.join(f.project, 'beta.txt'), 'utf8'), 'beta delivery');
  assert.ok(view.run.lanes.every(lane => lane.status === 'merged'));
});

test('merge conflicts and dirty source never erase worker deliveries or mutate source HEAD', async t => {
  const f = fixture(t, options => actualPi(options, [tool('write', { path: 'shared.txt', content: options.config.model + '\n' }), fauxAssistantMessage('Changed shared file')]));
  const a = f.actor('conflict-a', true), b = f.actor('conflict-b', true), originalHead = f.git('rev-parse', 'HEAD').trim();
  const id = f.collaboration.start('general', { workers: [{ agent: a.id, task: 'Change shared file A' }, { agent: b.id, task: 'Change shared file B' }] }).run.batch.id;
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(id).run.batch.status === 'review');
  for(const lane of f.collaboration.view(id).run.lanes)f.collaboration.humanReview(id,lane.id,{verdict:'approved',...deliveryVersion(lane)});
  fs.writeFileSync(path.join(f.project, 'user-unsaved.txt'), 'preserve user work');
  assert.throws(() => f.collaboration.merge(id), /uncommitted/);
  assert.equal(fs.readFileSync(path.join(f.project, 'user-unsaved.txt'), 'utf8'), 'preserve user work');
  fs.unlinkSync(path.join(f.project, 'user-unsaved.txt'));
  assert.throws(() => f.collaboration.merge(id), /Integration failed/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), originalHead);
  assert.equal(fs.readFileSync(path.join(f.project, 'shared.txt'), 'utf8'), 'base\n');
  const view = f.collaboration.view(id);
  assert.equal(view.run.batch.status, 'blocked');
  for (const lane of view.run.lanes) assert.equal(fs.readFileSync(path.join(lane.worktree_path, 'shared.txt'), 'utf8'), `${lane.agent_name}-model\n`);
  assert.throws(() => f.collaboration.merge(id), /Complete all/);
});

test('stop aborts real active lanes, preserves partial files and retry takes a fresh Agent snapshot', async t => {
  let first = true;
  const f = fixture(t, async options => {
    if (first) {
      first = false; fs.writeFileSync(path.join(options.projectDir, 'partial.txt'), 'partial work');
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    return actualPi(options, [fauxAssistantMessage('Recovered partial task')]);
  });
  const actor = f.actor('resumable', true);
  const id = f.collaboration.start('general', { workers: [{ agent: actor.id, task: 'Long task' }] }).run.batch.id;
  await waitFor(() => f.calls.length === 1);
  await f.collaboration.stop(id);
  const lane = f.collaboration.view(id).run.lanes[0];
  assert.equal(f.runner.active.size, 0); assert.equal(lane.status, 'failed');
  assert.equal(fs.readFileSync(path.join(lane.worktree_path, 'partial.txt'), 'utf8'), 'partial work');
  await assert.rejects(f.collaboration.discard(id), /retained/);
  assert.equal(fs.existsSync(lane.worktree_path), true);
  // Retry is the explicit acknowledgement to resume a stopped, retained task.
  f.store.storage.agentDefinitions.update(actor.id, { expectedRevision: 1, instructions: 'REVISED_RETRY_INSTRUCTIONS' });
  f.collaboration.retry(id, lane.id);
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(id).run.lanes[0].status === 'done');
  const resumed = f.collaboration.view(id).run.lanes[0];
  assert.equal(resumed.attempts, 2); assert.notEqual(resumed.context_key, lane.context_key);
  assert.match(f.calls.at(-1).agentPolicy.instructions, /REVISED_RETRY/);
});

test('pipeline uses each saved Agent, hands off deliverables and waits at pause boundary', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async options => {
    assert.equal(options.history.length, 0);
    if (options.config.model === 'author-model') { await gate; return { content: 'AUTHOR_DELIVERABLE', model: options.config.model, usage: null }; }
    assert.match(options.prompt, /AUTHOR_DELIVERABLE/);
    return { content: 'REVIEW_DELIVERABLE', model: options.config.model, usage: null };
  });
  const author = f.actor('author'), reviewer = f.actor('pipeline-reviewer');
  const pipeline = f.collaboration.startPipeline('general', { steps: [{ agent: author.id, instruction: 'Produce design' }, { agent: reviewer.id, instruction: 'Review prior design' }] });
  await waitFor(() => f.calls.length === 1);
  f.store.storage.pipelines.halt('general'); release();
  await waitFor(() => f.runner.active.size === 0);
  assert.equal(f.store.storage.pipelines.get('general').status, 'paused'); assert.equal(f.calls.length, 1);
  f.collaboration.resumePipeline('general');
  await waitFor(() => f.store.storage.pipelines.get('general').status === 'completed' && f.runner.active.size === 0);
  assert.deepEqual(f.calls.map(call => call.config.model), ['author-model', 'pipeline-reviewer-model']);
  assert.notEqual(f.calls[0].contextKey, f.calls[1].contextKey);
  assert.equal(f.store.storage.pipelines.get('general').steps[1].deliverable, 'REVIEW_DELIVERABLE');
  assert.equal(f.store.getChannel('general').agent_id, 'agent-local', 'pipeline does not replace the session owner');
  assert.equal(f.store.storage.pipelines.get('general').id, pipeline.id);
});

test('same Agent has separate concurrent task states, reviewer obeys chat cap and early pipeline pause resumes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async options => {
    if (options.contextKey.includes(':review:')) {
      assert.equal(options.config.mode, 'chat');
      assert.equal(options.agentPolicy.maxMode, 'chat');
      return { content: '{"verdict":"approved","notes":"Reviewed supplied diff"}', usage: null };
    }
    await gate;
    return { content: 'Delivered', usage: null };
  });
  const worker = f.actor('shared-actor'), reviewer = f.actor('chat-reviewer');
  f.store.storage.agentDefinitions.update(reviewer.id, { expectedRevision: 1, defaultMode: 'chat', maxMode: 'chat' });
  const batchId = f.collaboration.start('general', { workers: [{ agent_id: worker.id, task: 'Task A' }, { agent_id: worker.id, task: 'Task B' }], review_agent: reviewer.id }).run.batch.id;
  await waitFor(() => f.runner.active.size === 2);
  assert.equal([...f.runner.turns.values()].filter(row => row.agent_id === worker.id && row.state === 'running').length, 2);
  assert.throws(() => f.store.storage.agentDefinitions.delete(worker.id, 1), /unfinished collaboration/);
  release();
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(batchId).run.lanes.every(lane => lane.review_status === 'approved'));
  f.collaboration.startPipeline('general', { steps: [{ agent_id: worker.id, instruction: 'Immediate pause' }] });
  f.store.storage.pipelines.halt('general');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runner.active.size, 0);
  f.collaboration.resumePipeline('general');
  await waitFor(() => f.store.storage.pipelines.get('general').status === 'completed' && f.runner.active.size === 0);
});

test('worker checkpoint restoration targets the owned worktree and invalidates its delivery and approval', async t => {
  const f = fixture(t, options => actualPi(options, [tool('write', { path: 'result.txt', content: 'worker delivery' }), fauxAssistantMessage('Done')]));
  const worker = f.actor('restore-worker', true);
  const batchId = f.collaboration.start('general', { workers: [{ agent_id: worker.id, task: 'Write result' }] }).run.batch.id;
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(batchId).run.lanes[0].status === 'done');
  let lane = f.collaboration.view(batchId).run.lanes[0];
  f.collaboration.humanReview(batchId, lane.id, { verdict: 'approved',...deliveryVersion(lane) });
  const run = f.store.data.runtime_runs.find(row => row.id === lane.run_id);
  const checkpoint = await f.runner.recoveryCheckpoint('general', run);
  assert.equal(checkpoint.worktree, true); assert.equal(checkpoint.root_matches, true);
  const before = f.git('rev-parse', 'HEAD');
  await assert.rejects(f.runner.restore('other-session', lane.run_id), /此会话/);
  fs.writeFileSync(path.join(lane.worktree_path, 'result.txt'), 'later user change');
  await assert.rejects(f.runner.restore('general', lane.run_id), /后续改动/);
  assert.equal(f.collaboration.view(batchId).run.lanes[0].review_status, 'approved');
  fs.writeFileSync(path.join(lane.worktree_path, 'result.txt'), 'worker delivery');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalRestore = f.runner.checkpoints.restore.bind(f.runner.checkpoints);
  f.runner.checkpoints.restore = async (...args) => { await gate; return originalRestore(...args); };
  const restoring = f.runner.restore('general', lane.run_id);
  try {
    assert.throws(() => f.collaboration.merge(batchId), /executing or restoring/);
    assert.throws(() => f.collaboration.retry(batchId, lane.id), /executing or restoring/);
    assert.throws(() => f.collaboration.humanReview(batchId, lane.id, { verdict: 'approved' }), /executing or restoring/);
  } finally { release(); await restoring; f.runner.checkpoints.restore = originalRestore; }
  assert.equal(fs.existsSync(path.join(lane.worktree_path, 'result.txt')), false);
  assert.equal(fs.existsSync(path.join(f.project, 'result.txt')), false);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  const restored = f.collaboration.view(batchId);
  assert.equal(restored.run.batch.status, 'blocked');
  assert.equal(restored.run.lanes[0].status, 'failed');
  assert.equal(restored.run.lanes[0].delivery, null); assert.equal(restored.run.lanes[0].review_status, '');
  assert.throws(() => f.collaboration.merge(batchId), /Complete all lanes/);
  const oldRun = run.id;
  f.collaboration.retry(batchId, lane.id);
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(batchId).run.lanes[0].status === 'done');
  await assert.rejects(f.runner.restore('general', oldRun), /older task attempt/);
  lane = f.collaboration.view(batchId).run.lanes[0];
  f.collaboration.humanReview(batchId,lane.id,{verdict:'approved',...deliveryVersion(lane)});
  f.collaboration.merge(batchId);
  await assert.rejects(f.runner.restore('general', lane.run_id), /integrated deliveries/);
});

test('unknown legacy actors reject, shared batch reservation blocks before model calls and restart preserves worktrees', async t => {
  const f = fixture(t, options => actualPi(options, [fauxAssistantMessage('must not call model')]));
  assert.throws(() => f.collaboration.start('general', { workers: [{ agent: 'old-provider-name', task: 'legacy task' }] }), /Agent not found/);
  const actor = f.actor('budget');
  const id = f.collaboration.start('general', { total_budget_tokens: 1, workers: [{ agent: actor.id, task: 'Budget task' }] }).run.batch.id;
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(id).run.lanes[0].status === 'failed');
  const lane = f.collaboration.view(id).run.lanes[0];
  assert.equal(f.store.storage.usage.listModelRequestsByRun(lane.run_id).length, 0);
  assert.match(lane.error, /Collaboration Token budget/);
  fs.writeFileSync(path.join(lane.worktree_path, 'restart-evidence.txt'), 'preserve');
  f.store.storage.db.prepare("UPDATE parallel_lanes SET status = 'running', reserved_tokens = 100 WHERE id = ?").run(lane.id);
  f.store.storage.db.prepare("UPDATE parallel_batches SET status = 'running' WHERE id = ?").run(id);
  f.collaboration.recover();
  assert.equal(f.collaboration.view(id).run.lanes[0].status, 'failed');
  assert.equal(fs.readFileSync(path.join(lane.worktree_path, 'restart-evidence.txt'), 'utf8'), 'preserve');
  assert.equal(f.store.storage.db.prepare('SELECT reserved_tokens FROM parallel_lanes WHERE id = ?').get(lane.id).reserved_tokens, 0);
});

test('directory isolation supports materials analysis with citations and deliverable handoff', async t => {
  const f = fixture(t, options => actualPi(options, [
    fauxAssistantMessage('分析视频字幕与关键画面：在 00:15 采样点发现交互反馈延迟。依据 §2.1 规范原文，响应时间应小于 100ms。'),
  ]));
  const researcher = f.actor('Researcher', false);
  const result = f.collaboration.start('general', {
    isolation: 'directory',
    workers: [{ agent_id: researcher.id, task: '分析视频字幕与关键画面，比对规范要求' }],
  });
  const batchId = result.run.batch.id;
  await waitFor(() => f.runner.active.size === 0 && f.collaboration.view(batchId).run.lanes[0].status === 'done');
  const lane = f.collaboration.view(batchId).run.lanes[0];
  assert.equal(lane.status, 'done');
  assert.ok(lane.delivery, 'Delivery should be captured');
  assert.ok(lane.delivery.citations.length >= 2, 'Should extract video and doc citations');
  const videoCite = lane.delivery.citations.find(c => c.type === 'video');
  const docCite = lane.delivery.citations.find(c => c.type === 'doc');
  assert.equal(videoCite.timestamp, '00:15');
  assert.equal(docCite.section, '§2.1');

  // Test handoff to codex
  const handoffRes = f.collaboration.handoff(batchId, lane.id, {
    target_agent: 'codex',
    notes: '请基于 00:15 证据优化实现',
    citations: [videoCite],
  });
  assert.equal(handoffRes.success, true);
  assert.equal(handoffRes.handoff.targetAgent, 'codex');
  assert.equal(handoffRes.handoff.status, 'sent');

  // Check persisted handoff in lane view
  const updatedLane = f.collaboration.view(batchId).run.lanes[0];
  assert.equal(updatedLane.delivery.latestHandoff.targetAgent, 'codex');
  assert.equal(updatedLane.delivery.latestHandoff.version, 1);

  // Complete batch merge in non-worktree mode
  f.collaboration.humanReview(batchId, lane.id, {
    verdict: 'approved',
    expected_commit: lane.commit_hash,
    expected_version: lane.delivery_version,
  });
  const merged = f.collaboration.merge(batchId);
  assert.equal(merged.run.batch.status, 'done');
});
