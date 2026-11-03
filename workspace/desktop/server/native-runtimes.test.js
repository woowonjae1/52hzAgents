const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { locate, listRuntimes, assertNativePolicy, safeFileChanges, runCodex } = require('./native-runtimes');
const { createStorage } = require('./storage');

function fixture(t, beforeCleanup = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-native-test-'));
  t.after(async () => {
    await beforeCleanup();
    const target = path.resolve(root);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('52hz-native-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}
const script = String.raw`
const fs=require('node:fs'),readline=require('node:readline');
const write=x=>process.stdout.write(JSON.stringify(x)+'\n');
const notify=(method,params)=>write({method,params});
const mode=process.argv[2], trace=process.argv[3];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(trace,JSON.stringify(m)+'\n');
 const answer=result=>write({id:m.id,result});
 if(m.method==='initialize') answer({});
 if(m.method==='config/read') answer({config:{mcp_servers:{external:{command:'should-not-run'},'external.with.dots':{command:'never-run'}}}});
 if(m.method==='thread/start') answer({thread:{id:'thread-1'},model:'native-test',sandbox:{type:mode==='wrong-policy'?'dangerFullAccess':m.params.sandbox==='read-only'?'readOnly':'workspaceWrite'},approvalPolicy:'untrusted',approvalsReviewer:'user'});
 if(m.method==='turn/start') {
  answer({turn:{id:'turn-1'}});
  if(mode==='hang') return;
  if(mode==='exit') return process.exit(0);
  if(mode==='approval') return write({id:400,method:'item/commandExecution/requestApproval',params:{itemId:'tool-1',command:'dangerous-command',threadId:'thread-1',turnId:'turn-1'}});
  if(mode==='file-approval') {
   notify('item/started',{item:{id:'file-1',type:'fileChange',changes:[{path:'inside.txt',kind:{type:'add'},diff:'+approved content'}],status:'inProgress'}});
   return write({id:400,method:'item/fileChange/requestApproval',params:{itemId:'file-1',threadId:'thread-1',turnId:'turn-1'}});
  }
  if(mode==='failure') return notify('turn/completed',{turn:{id:'turn-1',status:'failed',error:{message:'secret-value-should-never-leak',codexErrorInfo:'other'}}});
  notify('item/agentMessage/delta',{itemId:'message-1',delta:'Thinking'});
  notify('item/completed',{item:{id:'message-1',type:'agentMessage',text:'Commentary',phase:'commentary'}});
  notify('item/completed',{item:{id:'message-2',type:'agentMessage',text:'{"verdict":"approved","notes":"checked"}',phase:'final_answer'}});
  notify('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:12,outputTokens:8,cachedInputTokens:2,totalTokens:20}}});
  notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
 }
 if(m.id===400 && m.result) {
  if(m.result.decision!==(mode==='file-approval'?'accept':'decline')) throw Error('unsafe approval');
  if(mode==='file-approval') fs.writeFileSync('inside.txt','approved content');
  notify('item/completed',{item:{id:'message-final',type:'agentMessage',text:'Request denied',phase:'final_answer'}});
  notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
 }
});
`;

function harness(t, mode = 'success') {
  const root = fixture(t), file = path.join(root, 'fake-client.cjs'), trace = path.join(root, 'trace.jsonl');
  fs.writeFileSync(file, script);
  const controller = new AbortController();
  const launch = { command: process.execPath, args: [file, mode, trace] };
  const options = { projectDir: root, config: { mode: 'plan' }, agentPolicy: { instructions: 'Act as reviewer.' },
    prompt: 'Review this task', history: [{ role: 'user', content: 'Earlier context' }], signal: controller.signal };
  const readTrace = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, options, launch, controller, readTrace };
}

test('runtime detection does not advertise missing or unverified clients as usable', t => {
  const root = fixture(t), env = { PATH: root };
  assert.equal(locate('codex', env), null);
  const statuses = listRuntimes(env);
  assert.equal(statuses.find(r => r.kind === 'pi').installed, true);
  for (const kind of ['antigravity', 'gemini']) {
    const status = statuses.find(r => r.kind === kind);
    assert.equal(status.installed, false); assert.equal(status.supported, false);
  }
});

test('runtime bindings survive reopening and do not require model resources or change session identity', t => {
  const root = fixture(t), dbPath = path.join(root, 'database.sqlite');
  let storage = createStorage({ dbPath });
  const agent = storage.agentDefinitions.create({ name: 'Native Codex', runtimeKind: 'codex', defaultMode: 'plan' });
  assert.equal(agent.runtimeKind, 'codex'); assert.equal(agent.modelResource, null);
  assert.equal(storage.agentDefinitions.get('agent-local').runtimeKind, 'pi');
  assert.throws(() => storage.agentDefinitions.create({ name: 'Bad', runtimeKind: 'custom-command' }), /Unsupported/);
  assert.throws(() => storage.agentDefinitions.update('agent-local', { expectedRevision: 1, runtimeKind: 'codex' }), /separate Agent/);
  assert.throws(() => storage.agentDefinitions.update(agent.id, { expectedRevision: 1, modelResource: { connectionId: 'x', modelId: 'y' } }), /client configuration/);
  storage.close(); storage = createStorage({ dbPath });
  assert.equal(storage.agentDefinitions.get(agent.id).runtimeKind, 'codex');
  storage.agentDefinitions.update(agent.id, { expectedRevision: 1, runtimeKind: 'pi' });
  assert.equal(storage.agentDefinitions.get(agent.id).runtimeKind, 'pi'); storage.close();
});

test('Codex protocol uses local configuration, task cwd, restrictive policies, native aggregate usage and final answer', async t => {
  const h = harness(t);
  const result = await runCodex(h.options, { launch: h.launch });
  assert.deepEqual(JSON.parse(result.content), { verdict: 'approved', notes: 'checked' });
  assert.equal(result.usage.total_tokens, 20); assert.equal(result.usageScope, 'native-turn'); assert.equal(result.costKnown, false);
  const trace = h.readTrace(), start = trace.find(m => m.method === 'thread/start').params;
  assert.equal(start.cwd, h.root); assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only');
  assert.equal(start.config.mcp_servers.external.enabled, false);
  assert.equal(start.config.mcp_servers['external.with.dots'].enabled, false);
  assert.equal(start.config.features.multi_agent, false);
  assert.equal(start.config.features.hooks, false);
  assert.equal(trace.find(m => m.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
  assert.equal(trace.find(m => m.method === 'turn/start').params.sandboxPolicy.networkAccess, false);
  assert.ok(!JSON.stringify(trace).includes('apiKey'));
});

test('unsafe policy, abnormal exit and failed terminal state never become successful replies', async t => {
  for (const mode of ['wrong-policy', 'failure', 'exit']) {
    const h = harness(t, mode);
    await assert.rejects(runCodex(h.options, { launch: h.launch }), error => !error.message.includes('secret-value') && /Codex/.test(error.message));
  }
});

test('Codex escalation is denied even when an injected host callback would approve it', async t => {
  const h = harness(t, 'approval'); let approvals = 0;
  const result = await runCodex({ ...h.options, onApproval: () => { approvals++; return true; } }, { launch: h.launch });
  assert.equal(result.content, 'Request denied'); assert.equal(approvals, 0);
  assert.equal(result.denied, true);
  assert.equal(h.readTrace().find(m => m.id === 400 && m.result).result.decision, 'decline');
});

test('abort terminates the owned process before the task promise settles', async t => {
  const h = harness(t, 'hang'); let child;
  const promise = runCodex(h.options, { launch: h.launch, spawnImpl: (...args) => { child = require('node:child_process').spawn(...args); return child; } });
  await once(child, 'spawn');
  h.controller.abort();
  await assert.rejects(promise, /cancelled/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('initialization failure does not finalize a checkpoint that never began', async t => {
  const h = harness(t, 'wrong-policy'); let begin = 0, end = 0;
  await assert.rejects(runCodex({ ...h.options, config: { mode: 'agent' }, beforeCommand: () => { begin++; }, afterCommand: () => { end++; } }, { launch: h.launch }));
  assert.equal(begin, 0); assert.equal(end, 0);
});

test('unsupported native hard budgets, tools and modes are rejected before any client is spawned', () => {
  const agent = { runtimeKind: 'codex', permissions: { readFiles: true, executeCommands: true, writeFiles: true, mcp: false, knowledge: false, delegate: false }, limits: {} };
  const runtime = { installed: true, supported: true, modes: ['plan', 'agent'] };
  assert.doesNotThrow(() => assertNativePolicy(agent, { mode: 'plan' }, { runtime }));
  for (const budgets of [{ maxTokensPerRun: 1000 }, { maxStepsPerRun: 30 }, { maxCostPerSession: 10 }, { maxCostPerDay: 50 }]) {
    assert.throws(() => assertNativePolicy(agent, { mode: 'plan' }, { runtime, budgets }), { code: 'RUNTIME_BUDGET_UNSUPPORTED' });
  }
  assert.throws(() => assertNativePolicy(agent, { mode: 'agent' }, { runtime, execution: { kind: 'lane' } }), { code: 'RUNTIME_BUDGET_UNSUPPORTED' });
  assert.throws(() => assertNativePolicy(agent, { mode: 'chat' }, { runtime }), { code: 'RUNTIME_CAPABILITY' });
  assert.throws(() => assertNativePolicy({ ...agent, permissions: { ...agent.permissions, mcp: true } }, { mode: 'plan' }, { runtime }), { code: 'RUNTIME_CAPABILITY' });
});

test('native file approvals reject external paths, Git internals, moves and symlink escapes', t => {
  const root = fixture(t), project = path.join(root, 'project'), outside = path.join(root, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  const patch = (file, move_path) => ({ type: 'fileChange', changes: [{ path: file, kind: { type: 'update', move_path }, diff: '' }] });
  assert.equal(safeFileChanges(patch('inside.txt'), project), true);
  assert.equal(safeFileChanges(patch('../outside/file.txt'), project), false);
  assert.equal(safeFileChanges(patch('.git/config'), project), false);
  assert.equal(safeFileChanges(patch('inside.txt', '../outside/moved.txt'), project), false);
  assert.equal(safeFileChanges(patch('inside.txt'), project, outside), false);
  fs.symlinkSync(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(safeFileChanges(patch('linked/file.txt'), project), false);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(project, 'missing-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(safeFileChanges(patch('missing-link/file.txt'), project), false);
  if (process.platform === 'win32') {
    assert.equal(safeFileChanges(patch('.git./config'), project), false);
    assert.equal(safeFileChanges(patch('.git::$DATA'), project), false);
  }
  assert.equal(safeFileChanges({ type: 'fileChange', changes: [] }, project), false);
  assert.equal(safeFileChanges({ type: 'fileChange', changes: [{ path: 'inside.txt', kind: { type: 'add' }, diff: 'x'.repeat(128 * 1024) }] }, project), false);
});

test('bounded native file approval exposes the proposed patch before approval and brackets the whole turn with a checkpoint', async t => {
  const h = harness(t, 'file-approval'), events = [], checkpoints = [];
  let approvals = 0;
  const result = await runCodex({ ...h.options, config: { mode: 'agent' },
    agentPolicy:{...h.options.agentPolicy,permissions:{readFiles:true,writeFiles:true,executeCommands:true}},
    beforeCommand: () => checkpoints.push('before'), afterCommand: () => checkpoints.push('after'),
    onTool: value => events.push(value), onApproval: async request => {
      approvals++;
      assert.equal(request.tool, 'write');
      assert.equal(events.filter(value => value.phase === 'start' && value.toolCallId === 'file-1').length, 1, 'approval must not reset the tool record or discard its proposed diff');
      assert.ok(events.some(value => value.toolCallId === 'file-1' && value.patch?.includes('+approved content') && value.args.path === 'inside.txt'));
      assert.equal(fs.existsSync(path.join(h.root, 'inside.txt')), false, 'file must not be written before approval');
      return true;
    },
  }, { launch: h.launch });
  assert.equal(result.denied, false); assert.equal(approvals, 1);
  assert.deepEqual(checkpoints, ['before', 'after']);
  assert.equal(fs.readFileSync(path.join(h.root, 'inside.txt'), 'utf8'), 'approved content');
});

test('runtime HTTP discovery requires authentication and native binding remains independent of model connections', async t => {
  let server;
  const root = fixture(t, async () => { if (server) await server.shutdown(); });
  const result = await require('./index').startServer({ port: 0, userDataPath: root, staticDir: root, apiToken: 'native-test-token' });
  server = result.server;
  const base = `http://127.0.0.1:${result.port}`;
  assert.equal((await fetch(base + '/v1/agent-runtimes')).status, 401);
  const call = (route, method = 'GET', body) => fetch(base + route, { method, headers: { 'X-Workspace-Token': 'native-test-token', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const catalog = await (await call('/v1/agent-runtimes')).json();
  const native = catalog.runtimes.find(item => item.kind === 'codex');
  assert.equal(native.budgetBlocked, true);
  assert.equal(catalog.runtimes.find(item => item.kind === 'antigravity').supported, false);
  const created = await call('/v1/agent-definitions', 'POST', { name: 'Native HTTP actor', runtimeKind: 'codex', runtimeModel: 'client-resource', defaultMode: 'plan',
    permissions: { readFiles: true, executeCommands: true, knowledge: false, mcp: false, delegate: false } });
  assert.equal(created.status, 201); const agent = await created.json();
  assert.equal(agent.modelResource, null);
  assert.equal((await call('/v1/runtime/session/agent', 'PATCH', { channel: 'general', agentId: agent.id })).status, 200);
  const runtime = await (await call('/v1/runtime/session?channel=general')).json();
  assert.equal(runtime.agent.runtimeKind, 'codex'); assert.equal(runtime.config.provider, 'native:codex'); assert.equal(runtime.config.model, 'client-resource');
  assert.equal((await call('/v1/runtime/session?channel=general', 'PATCH', { inheritAgent: true, mode: 'chat' })).status, 400);
  assert.equal((await call('/v1/runtime/session?channel=general', 'PATCH', { provider: 'ollama', model: 'resource', mode: 'plan' })).status, 400);
  assert.equal((await call('/v1/runtime/session?channel=general', 'PATCH', { inheritAgent: true, mode: 'plan' })).status, 200);
  assert.equal((await call('/v1/workspaces/52hz/channels/general', 'PATCH', { runtime_config: { inheritAgent: true, mode: 'plan' } })).status, 200);
});
