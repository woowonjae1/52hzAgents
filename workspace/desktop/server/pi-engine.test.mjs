import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runPiAgent } from './pi-engine.mjs';
import { createProjectTools, projectPath } from './pi-tools.mjs';
import { Store } from './store.js';
import { AgentRunner } from './agent-runner.js';
import { sessionUsage } from './usage.js';
import { startServer } from './index.js';

const commandTool = process.platform === 'win32' ? 'powershell' : 'bash';
const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '52hz-pi-test-'));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), '52hz-pi-test-'))); await fs.rm(root, { recursive: true, force: true }); });
  const faux = createFauxCore({ models: [{ id: 'fixture', contextWindow: 32000 }], tokensPerSecond: 1e9 });
  const controller = new AbortController();
  const events = [], patches = [], approvals = [];
  const options = { channel: 'general', userDataPath: root, projectDir: project, prompt: 'Fix the bug and check it.', history: [],
    config: { provider: 'ollama', model: 'fixture', mode: 'agent' }, model: faux.getModel(), streamFn: faux.streamSimple, signal: controller.signal,
    onDelta() {}, onTool: row => events.push(row), onMutation: row => patches.push(row),
    onApproval: async row => { approvals.push(row); return true; } };
  return { root, project, faux, controller, events, patches, approvals, options };
}

test('Pi runs real read/edit/check/retry tools, records usage and resumes raw tool context', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'app.cjs'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(f.project, 'check.cjs'), "require('node:assert/strict').equal(require('./app.cjs'), 3); console.log('CHECK PASSED');\n");
  f.faux.setResponses([
    tool('read', { path: 'app.cjs' }), tool('edit', { path: 'app.cjs', edits: [{ oldText: '= 1', newText: '= 2' }] }),
    tool(commandTool, { command: 'node check.cjs' }),
    context => { assert.ok(context.messages.some(message => message.role === 'toolResult' && message.isError)); return tool('edit', { path: 'app.cjs', edits: [{ oldText: '= 2', newText: '= 3' }] }); },
    tool(commandTool, { command: 'node check.cjs' }), fauxAssistantMessage('Fixed and checked.'),
  ]);
  const result = await runPiAgent(f.options);
  assert.equal(result.content, 'Fixed and checked.');
  assert.equal(await fs.readFile(path.join(f.project, 'app.cjs'), 'utf8'), 'module.exports = 3;\n');
  assert.equal(f.approvals.length, 2); assert.equal(f.patches.length, 2);
  const shellResults = f.events.filter(row => row.phase === 'end' && row.structuredContent?.exit_code !== undefined);
  assert.equal(shellResults[0].structuredContent.exit_code, 1); assert.equal(shellResults[1].structuredContent.exit_code, 0);
  assert.match(shellResults[1].output, /CHECK PASSED/);
  assert.ok(result.usage.total_tokens > 0); assert.ok(result.usage.prompt_tokens >= result.last_prompt_tokens);
  assert.equal(result.context_window, 0); // Unknown model: no manufactured capacity in the UI.
  f.faux.setResponses([context => {
    assert.equal(context.messages.filter(message => message.role === 'toolResult').length, 5);
    return fauxAssistantMessage('History preserved.');
  }]);
  assert.equal((await runPiAgent({ ...f.options, prompt: 'What did you do?' })).content, 'History preserved.');
  const other = path.join(f.root, 'other-project'); await fs.mkdir(other);
  f.faux.setResponses([context => { assert.equal(context.messages.filter(message => message.role === 'toolResult').length, 0); return fauxAssistantMessage('Other project.'); }]);
  assert.notEqual((await runPiAgent({ ...f.options, projectDir: other })).session_file, result.session_file);
});

test('Pi creates nested files and searches locally without downloading helper executables', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, '.gitignore'), 'ignored/\n');
  await fs.mkdir(path.join(f.project, 'ignored')); await fs.writeFile(path.join(f.project, 'ignored', 'hidden.cjs'), 'hidden');
  f.faux.setResponses([tool('write', { path: 'src/new.cjs', content: 'module.exports = 42;\n' }), tool('find', { pattern: '*.cjs' }), fauxAssistantMessage('Created.')]);
  await runPiAgent(f.options);
  assert.equal(await fs.readFile(path.join(f.project, 'src/new.cjs'), 'utf8'), 'module.exports = 42;\n');
  assert.match(f.patches[0].patch, /\+module.exports = 42/);
  const result = f.events.filter(row => row.phase === 'end').at(-1);
  assert.match(result.output, /src\/new.cjs/); assert.doesNotMatch(result.output, /hidden/);
});

test('real Pi OpenAI and Anthropic adapters use correct local HTTP paths, tools and measured usage', async t => {
  const f = await fixture(t), requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: new URL(req.url, 'http://localhost').pathname, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (new URL(req.url, 'http://localhost').pathname === '/v1/messages') {
      const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      send({ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 7, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Adapter verified.' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      send({ type: 'message_stop' }); res.end();
    } else {
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Adapter verified.' }, finish_reason: null }] });
      send({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ id: 'fixture', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  for (const provider of ['openai', 'claude']) {
    const result = await runPiAgent({ ...f.options, model: undefined, streamFn: undefined, channel: provider,
      config: { provider, model: 'fixture', mode: 'plan' }, baseUrl, apiKey: 'local-fixture-only' });
    assert.equal(result.content, 'Adapter verified.'); assert.equal(result.usage.total_tokens, 10);
    assert.equal(result.usage.cache_read_tokens, null); // SDK default zero is not proof of provider reporting.
    assert.equal(result.last_prompt_tokens, 7); assert.equal(requests.at(-1).body.tools.length, 4);
  }
  assert.deepEqual(requests.map(row => row.path), ['/v1/chat/completions', '/v1/messages']);
});

test('Plan has real inspection tools but cannot execute commands or mutate files', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.project, 'notes.txt'), 'hello');
  f.faux.setResponses([tool('read', { path: 'notes.txt' }), tool('write', { path: 'notes.txt', content: 'changed' }), fauxAssistantMessage('Write unavailable; here is a plan.')]);
  await runPiAgent({ ...f.options, config: { ...f.options.config, mode: 'plan' } });
  assert.equal(await fs.readFile(path.join(f.project, 'notes.txt'), 'utf8'), 'hello');
  assert.equal(f.patches.length, 0); assert.equal(f.approvals.length, 0);
  const tools = await createProjectTools({ root: f.project, mode: 'plan', signal: f.controller.signal });
  assert.deepEqual(tools.map(value => value.name), ['read', 'ls', 'find', 'search']);
  const search = await tools.find(value => value.name === 'search').execute('search', { text: 'hello' });
  assert.match(search.content[0].text, /notes.txt:1: hello/);
});

test('project tools reject traversal, Git internals and symlink escape for reads and new writes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'outside.txt'), 'private');
  await fs.symlink(f.root, path.join(f.project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['../outside.txt', path.join(f.root, 'outside.txt'), 'escape/outside.txt', '.git/config']) await assert.rejects(projectPath(f.project, name));
  await assert.rejects(projectPath(f.project, 'escape/new/file.txt', { create: true }));
  assert.equal(await projectPath(f.project, 'new/file.txt', { create: true }), path.join(await fs.realpath(f.project), 'new/file.txt'));
});

test('denied commands do not run and terminate the Pi tool loop', async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage([
    fauxToolCall('ls', {}),
    fauxToolCall(commandTool, { command: "node -e \"require('fs').writeFileSync('should-not-exist','bad')\"" }),
    fauxToolCall('write', { path: 'should-not-exist', content: 'Denied commands must terminate later queued tools too.' }),
  ], { stopReason: 'toolUse' }), fauxAssistantMessage('Should not run')]);
  const result = await runPiAgent({ ...f.options, onApproval: async () => false });
  assert.equal(result.denied, true); assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(fs.stat(path.join(f.project, 'should-not-exist')));
});

test('runner approval is bound to the session; stopping cancels pending commands and stale approvals', async t => {
  const f = await fixture(t), store = new Store(f.root);
  store.updateChannel('general', { working_dir: f.project, runtime_config: f.options.config });
  f.faux.setResponses([tool(commandTool, { command: 'node --version' })]);
  const runner = new AgentRunner(store, { broadcast() {}, broadcastComposing() {} }, { piRuntime: options => runPiAgent({ ...options, model: f.faux.getModel(), streamFn: f.faux.streamSimple }) });
  const task = runner.handleUserMessage(store.addEvent({ source: 'human:user', target: 'channel/general', payload: { content: 'Check' } }));
  const deadline = Date.now() + 10_000;
  while (!runner.tools.pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.tools.pending.size, 1);
  const id = [...runner.tools.pending.keys()][0];
  assert.throws(() => runner.tools.decide(id, 'other-session', true));
  runner.stop('general'); await task;
  assert.equal(runner.tools.list('general')[0].status, 'cancelled');
  assert.throws(() => runner.tools.decide(id, 'general', true));
  const restarted = new AgentRunner(new Store(f.root), { broadcast() {}, broadcastComposing() {} });
  assert.equal(restarted.tools.pending.size, 0); assert.equal(restarted.active.size, 0);
});

test('stopping an approved command kills its child process before it can write a delayed file', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'long.cjs'), "const fs=require('fs');fs.writeFileSync('child.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('late.txt','bad'),5000);setInterval(()=>{},1000);");
  f.faux.setResponses([tool(commandTool, { command: 'node long.cjs' })]);
  const task = runPiAgent(f.options);
  t.after(() => f.controller.abort());
  const deadline = Date.now() + 10_000;
  let pid;
  while (Date.now() < deadline) { try { pid = Number(await fs.readFile(path.join(f.project, 'child.pid'), 'utf8')); if (pid) break; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(pid); f.controller.abort(); await assert.rejects(task, /stopped/i);
  let alive = true;
  for (let n = 0; n < 100; n++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(alive, false); await assert.rejects(fs.stat(path.join(f.project, 'late.txt')));
});

test('HTTP approvals execute only after explicit consent, deny stale requests, and shutdown closes pending tools and SSE', async t => {
  const f = await fixture(t), store = new Store(f.root);
  store.updateChannel('general', { working_dir: f.project, runtime_config: f.options.config });
  const { server, port } = await startServer({ port: 0, userDataPath: f.root, staticDir: f.root,
    runtimeOptions: { piRuntime: options => runPiAgent({ ...options, model: f.faux.getModel(), streamFn: f.faux.streamSimple }) } });
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, body, method = 'POST') => fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rows = async () => (await (await fetch(base + '/v1/runtime/tools?channel=general')).json()).tools;
  const wait = async predicate => { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Condition did not complete.'); };
  const start = async () => {
    f.faux.setResponses([tool(commandTool, { command: 'node --version' }), fauxAssistantMessage('Checked.')]);
    await request('/v1/events', { source: 'human:user', target: 'channel/general', type: 'workspace.message.posted', payload: { content: 'Check Node' } });
    return wait(async () => (await rows()).find(row => row.status === 'pending'));
  };
  const first = await start();
  assert.equal(first.output, '');
  assert.equal((await request('/v1/runtime/session?channel=general', { provider: 'ollama', model: 'other', mode: 'chat' }, 'PATCH')).status, 409);
  assert.equal((await request('/v1/workspaces/52hz/channels/general', { working_dir: f.root }, 'PATCH')).status, 409);
  const decide = (row, channel, granted) => request('/v1/runtime/approvals/' + row.approval_id, { channel, granted });
  assert.equal((await decide(first, 'other', true)).status, 409);
  assert.equal((await decide(first, 'general', true)).status, 200);
  await wait(async () => !(await (await fetch(base + '/v1/runtime/session?channel=general')).json()).running);
  const completed = (await rows())[0];
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.exit_code, 0); assert.match(completed.output, /v\d+/);
  assert.equal((await decide(first, 'general', true)).status, 409);
  const denied = await start(); assert.equal((await decide(denied, 'general', false)).status, 200);
  await wait(async () => !(await (await fetch(base + '/v1/runtime/session?channel=general')).json()).running);
  assert.equal((await rows()).find(row => row.id === denied.id).status, 'denied');
  const pending = await start();
  const stream = await fetch(base + '/v1/events/stream?channel=general'), reader = stream.body.getReader();
  await reader.read();
  await server.shutdown();
  while (!(await reader.read()).done) {}
  const restarted = new Store(f.root);
  assert.equal(restarted.data.runtime_tools.find(row => row.id === pending.id).status, 'cancelled');
  assert.equal(restarted.data.events.find(event => event.metadata?.runtime_tool?.id === completed.id).metadata.runtime_tool.status, 'completed');
  assert.equal(restarted.data.events.find(event => event.metadata?.runtime_tool?.id === pending.id).metadata.runtime_tool.status, 'cancelled');
  assert.equal(sessionUsage(restarted.data.events, 'general').measured_turns, 3); // Interrupted model requests are billed too.
});
