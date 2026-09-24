'use strict';

/*
  The generic ACP adapter, driven end to end against a FAKE ACP agent: a small
  Node script (spawned with process.execPath) that speaks JSON-RPC 2.0 over
  stdio the way the spec describes -- initialize, session/new, session/load,
  session/prompt with session/update notifications, session/request_permission
  and fs/* requests back to the client, session/cancel.

  No real ACP CLI is exercised here; these tests pin the adapter's half of the
  protocol and its workspace-side behaviour.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AcpAdapter = require('../src/adapters/acp');
const { splitCommandLine, resolveCommandConfig } = require('../src/adapters/acp');
const { createAdapter } = require('../src/adapters');

// ---------------------------------------------------------------------------
// The fake agent. Serialised with Function.prototype.toString into a temp file.
// ---------------------------------------------------------------------------

function fakeAgent() {
  const fsm = require('fs');
  const pathm = require('path');
  const readline = require('readline');
  const mode = process.argv[2] || 'happy';
  let nextId = 1000;
  const waiting = new Map();
  const cwds = {};
  let sessionCount = 0;
  let loaded = null;
  let activePrompt = null;

  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
  const ask = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (t) => ({ type: 'text', text: t });

  // Not JSON: the client must skip it, not choke on it.
  process.stdout.write('fake-acp agent starting (banner, not json)\n');

  async function handlePrompt(msg) {
    const sid = msg.params.sessionId;
    const promptText = (msg.params.prompt || []).map((b) => b.text || '').join('');
    if (mode === 'crash') {
      update(sid, { sessionUpdate: 'agent_message_chunk', content: text('partial ') });
      await sleep(30);
      process.stderr.write('boom: fake agent crashed\n');
      process.exit(3);
    }
    if (mode === 'hang') {
      activePrompt = msg.id;
      update(sid, { sessionUpdate: 'agent_message_chunk', content: text('working...') });
      return; // resolved by session/cancel
    }
    if (mode === 'load') {
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: text(`loaded=${loaded || 'none'}`) });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: text('fresh reply') });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    // happy / auto
    const cwd = cwds[sid];
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: text(`session cwd: ${cwd}; prompt has user text: ${promptText.includes('please read')}`) });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: text('Hello ') });
    // A notification split across two writes, with CRLF: framing must cope.
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: text('world') } } });
    process.stdout.write(line.slice(0, 25));
    await sleep(40);
    process.stdout.write(line.slice(25) + '\r\n');

    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Read notes.txt', kind: 'read', status: 'pending', rawInput: { path: pathm.join(cwd, 'notes.txt') } });
    const perm = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'call_1', title: 'Read notes.txt', kind: 'read' },
      options: [
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const o = (perm.result && perm.result.outcome) || {};
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: text(`permission outcome: ${o.outcome} ${o.optionId || ''}`.trim()) });

    const target = pathm.join(cwd, 'notes.txt');
    await ask('fs/write_text_file', { sessionId: sid, path: target, content: 'line1\nline2\nline3' });
    const read = await ask('fs/read_text_file', { sessionId: sid, path: target, line: 2, limit: 1 });
    const term = await ask('terminal/create', { sessionId: sid, command: 'ls' });
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: text(`fs read: ${read.result && read.result.content}; terminal error: ${term.error && term.error.code}; on disk: ${fsm.existsSync(target)}`) });

    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
    update(sid, { sessionUpdate: 'usage_update', used: 1234, size: 200000 });
    update(sid, { sessionUpdate: 'plan', entries: [
      { content: 'Read the notes', priority: 'high', status: 'completed' },
      { content: 'Summarise', priority: 'medium', status: 'in_progress' },
    ] });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const resolve = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (resolve) resolve(msg);
      return;
    }
    const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        reply({ protocolVersion: 1, agentCapabilities: { loadSession: mode === 'load' }, authMethods: [], agentInfo: { name: 'fake-acp', version: '0.0.1' } });
        break;
      case 'session/new': {
        sessionCount++;
        const sid = `sess_${sessionCount}`;
        cwds[sid] = msg.params.cwd;
        reply({ sessionId: sid });
        break;
      }
      case 'session/load':
        loaded = msg.params.sessionId;
        cwds[loaded] = msg.params.cwd;
        // History replay: the client must NOT post this.
        update(loaded, { sessionUpdate: 'agent_message_chunk', content: text('OLD HISTORY') });
        reply({});
        break;
      case 'session/prompt':
        handlePrompt(msg);
        break;
      case 'session/cancel':
        if (activePrompt !== null) {
          send({ jsonrpc: '2.0', id: activePrompt, result: { stopReason: 'cancelled' } });
          activePrompt = null;
        }
        break;
      default:
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
    }
  });
  rl.on('close', () => process.exit(0));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-acp-test-'));
const fakeScript = path.join(tmpRoot, 'fake-acp-agent.js');
fs.writeFileSync(fakeScript, `(${fakeAgent.toString()})();\n`);

const adapters = [];
test.after(() => {
  for (const a of adapters) { try { a.stop(); } catch {} }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function makeAdapter(mode, { env = {}, sessionsFile, onSend } = {}) {
  const sent = [];
  const todos = [];
  const contexts = [];
  const workingDir = fs.mkdtempSync(path.join(tmpRoot, 'wd-'));
  let adapter;
  const client = {
    sendMessage: async (ws, ch, tok, content, opts) => {
      const rec = { ch, content, opts: opts || {} };
      sent.push(rec);
      if (onSend) onSend(rec, adapter);
    },
    getSession: async () => ({}),
    updateSession: async () => ({}),
    getRecentMessages: async () => [],
    getTodos: async () => ({ todos: [] }),
    putTodos: async (ws, ch, tok, list) => { todos.push(list); },
    reportAgentContext: async (ws, name, payload) => { contexts.push(payload); },
  };
  adapter = new AcpAdapter({
    workspaceId: 'ws-1',
    channelName: 'general',
    token: 't',
    agentName: 'acp-test',
    agentType: 'acp',
    workingDir,
    client,
    agentEnv: { ...process.env, ...env },
    acpCommand: process.execPath,
    acpArgs: [fakeScript, mode],
    sessionsFile: sessionsFile || path.join(tmpRoot, `sessions-${Math.random().toString(36).slice(2)}.json`),
    acpOptions: { previewIntervalMs: 0, initTimeoutMs: 15000, cancelGraceMs: 3000 },
  });
  adapters.push(adapter);
  return { adapter, sent, todos, contexts, workingDir };
}

const message = (content = 'please read the notes') => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  sessionId: 'ch-1',
  content,
  senderType: 'human',
  senderName: 'user',
});

const previews = (sent) => sent.filter((m) => m.opts.messageType === 'thinking' && m.opts.metadata && m.opts.metadata.reply_preview);
const thoughts = (sent) => sent.filter((m) => m.opts.messageType === 'thinking' && m.opts.metadata && !m.opts.metadata.reply_preview && !m.opts.metadata.tool_name);
const toolLines = (sent) => sent.filter((m) => m.opts.metadata && m.opts.metadata.tool_name);
const replies = (sent) => sent.filter((m) => !m.opts.messageType);
const errors = (sent) => sent.filter((m) => m.opts.messageType === 'error');
const approvals = (sent) => sent.filter((m) => m.opts.metadata && m.opts.metadata.tool_approval_request);

// ---------------------------------------------------------------------------

test('a full turn: previews, thought, tool call, approval, fs, plan, usage, one reply', async () => {
  const { adapter, sent, todos, contexts, workingDir } = makeAdapter('happy', {
    // Answer the approval card the way the workspace UI does.
    onSend: (rec, a) => {
      const req = rec.opts.metadata && rec.opts.metadata.tool_approval_request;
      if (req) {
        setImmediate(async () => {
          const handled = await a._handleApprovalResponse({
            metadata: { tool_approval_response: { approval_id: req.approval_id, granted: true } },
          });
          assert.equal(handled, true, 'the adapter consumes its own approval response');
        });
      }
    },
  });

  await adapter._handleMessage(message());

  const previewText = previews(sent).map((m) => m.content);
  assert.deepEqual(previewText, ['Hello ', 'world'], 'reply chunks are streamed as reply previews');

  const thoughtText = thoughts(sent).map((m) => m.content).join('\n');
  assert.ok(thoughtText.includes(`session cwd: ${workingDir}`), 'session/new got cwd = the resolved working dir');
  assert.ok(thoughtText.includes('prompt has user text: true'));
  assert.ok(thoughtText.includes('permission outcome: selected allow-once'), 'granted -> allow_once, never allow_always');
  assert.ok(thoughtText.includes('fs read: line2'), 'fs/read_text_file honours line/limit');
  assert.ok(thoughtText.includes('on disk: true'), 'fs/write_text_file wrote the file');
  assert.ok(thoughtText.includes('terminal error: -32601'), 'terminal/* is refused (not advertised)');

  const approval = approvals(sent);
  assert.equal(approval.length, 1, 'one approval card');
  assert.equal(approval[0].opts.metadata.tool_approval_request.tool, 'Read notes.txt');

  const tools = toolLines(sent);
  assert.equal(tools.length, 1, 'one line per tool call; completion does not add a second');
  assert.equal(tools[0].opts.metadata.tool_name, 'read');
  assert.equal(tools[0].opts.metadata.tool_status, 'running');
  assert.equal(tools[0].opts.metadata.tool_call_id, 'call_1');
  assert.equal(tools[0].opts.metadata.tool_summary, 'Read notes.txt');

  const finals = replies(sent);
  assert.equal(finals.length, 1, 'exactly one final response');
  assert.equal(finals[0].content, 'Hello world');
  assert.equal(finals[0].ch, 'ch-1');

  assert.deepEqual(todos.at(-1), [
    { content: 'Read the notes', status: 'completed' },
    { content: 'Summarise', status: 'in_progress' },
  ]);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].prompt_tokens, 1234);
  assert.equal(contexts[0].context_window, 200000);
  assert.equal(errors(sent).length, 0);

  // Order: previews and the tool line are posted before the final reply.
  const idxFinal = sent.indexOf(finals[0]);
  assert.ok(sent.indexOf(previews(sent)[1]) < idxFinal);
  assert.ok(sent.indexOf(tools[0]) < idxFinal);

  // The process is reused for the next turn, on the same session.
  const pid = adapter._conns['ch-1'].conn.proc.pid;
  await adapter._handleMessage(message('please read again'));
  assert.equal(adapter._conns['ch-1'].conn.proc.pid, pid, 'same process');
  assert.equal(adapter._conns['ch-1'].sessionId, 'sess_1', 'same session');
  assert.equal(replies(sent).length, 2);
});

test('ACP_PERMISSION_MODE=auto selects allow_once without posting a card', async () => {
  const { adapter, sent } = makeAdapter('happy', { env: { ACP_PERMISSION_MODE: 'auto' } });
  await adapter._handleMessage(message());
  assert.equal(approvals(sent).length, 0);
  assert.ok(thoughts(sent).some((m) => m.content.includes('permission outcome: selected allow-once')));
  assert.equal(replies(sent).length, 1);
});

test('a declined approval answers reject_once', async () => {
  const { adapter, sent } = makeAdapter('happy', {
    onSend: (rec, a) => {
      const req = rec.opts.metadata && rec.opts.metadata.tool_approval_request;
      if (req) setImmediate(() => a._handleApprovalResponse({ metadata: { tool_approval_response: { approval_id: req.approval_id, granted: false } } }));
    },
  });
  await adapter._handleMessage(message());
  assert.ok(thoughts(sent).some((m) => m.content.includes('permission outcome: selected reject-once')));
});

test('the agent process dying mid-prompt fails the turn with a clear error', async () => {
  const { adapter, sent } = makeAdapter('crash');
  await adapter._handleMessage(message());

  const errs = errors(sent);
  assert.equal(errs.length, 1, 'one error posted');
  assert.match(errs[0].content, /exited/);
  assert.match(errs[0].content, /code 3/);
  assert.match(errs[0].content, /boom: fake agent crashed/, 'stderr tail is included');
  assert.ok(adapter._turnFailed && adapter._turnFailed.has('ch-1'), 'turn marked failed');
  assert.equal(replies(sent).length, 0, 'no final response');
  assert.equal(adapter._conns['ch-1'], undefined, 'dead connection dropped; next turn respawns');
  assert.equal(adapter._activeTurns['ch-1'], undefined);
});

test('stop sends session/cancel; the cancelled turn posts no reply and no error', async () => {
  const { adapter, sent } = makeAdapter('hang');
  const turn = adapter._handleMessage(message());

  const deadline = Date.now() + 10000;
  while (!previews(sent).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(previews(sent)[0].content, 'working...');

  await adapter._onControlAction('stop', { channel: 'ch-1' });
  await turn;

  assert.ok(sent.some((m) => m.opts.messageType === 'status' && m.content === 'Execution stopped by user'));
  assert.equal(errors(sent).length, 0);
  assert.equal(replies(sent).length, 0);
  assert.ok(!(adapter._turnFailed && adapter._turnFailed.has('ch-1')), 'a user stop is not a failure');
  assert.ok(adapter._conns['ch-1'] && !adapter._conns['ch-1'].conn.closed, 'the agent honoured session/cancel, so it was not killed');
});

test('a restarted adapter uses session/load and drops the replayed history', async () => {
  const sessionsFile = path.join(tmpRoot, 'sessions-load.json');
  const first = makeAdapter('load', { sessionsFile });
  await first.adapter._handleMessage(message());
  assert.equal(replies(first.sent).length, 1);
  first.adapter.stop();

  const saved = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
  assert.equal(saved['ch-1'].sessionId, 'sess_1');

  // Same channel, same cwd, fresh adapter + fresh process.
  const second = makeAdapter('load', { sessionsFile });
  second.adapter.workingDir = first.workingDir;
  await second.adapter._handleMessage(message());

  assert.ok(thoughts(second.sent).some((m) => m.content === 'loaded=sess_1'), 'session/load was used');
  assert.ok(!second.sent.some((m) => String(m.content).includes('OLD HISTORY')), 'history replay is not re-posted');
  assert.equal(replies(second.sent).length, 1);
  assert.equal(replies(second.sent)[0].content, 'fresh reply');
});

test('no command configured: preflight refuses and a turn reports why', async () => {
  const sent = [];
  const adapter = new AcpAdapter({
    workspaceId: 'ws-1', token: 't', agentName: 'acp-none', agentEnv: {},
    sessionsFile: path.join(tmpRoot, 'none.json'),
    client: { sendMessage: async (ws, ch, tok, content, opts) => sent.push({ content, opts }) },
  });
  const pf = adapter.preflight();
  assert.equal(pf.ok, false);
  assert.equal(pf.reason, 'runtime_missing');
  await adapter._handleMessage(message());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.messageType, 'error');
  assert.match(sent[0].content, /ACP_COMMAND/);
});

test('command configuration sources and parsing', () => {
  assert.deepEqual(splitCommandLine('gemini --experimental-acp'), ['gemini', '--experimental-acp']);
  assert.deepEqual(splitCommandLine('"C:/Program Files/x/agent.exe" acp --flag "a b"'), ['C:/Program Files/x/agent.exe', 'acp', '--flag', 'a b']);
  assert.deepEqual(resolveCommandConfig({}, { ACP_COMMAND: 'opencode acp' }), { command: 'opencode', args: ['acp'] });
  assert.deepEqual(resolveCommandConfig({}, { ACP_COMMAND: 'claude-code-acp', ACP_ARGS: '["--x", "y z"]' }), { command: 'claude-code-acp', args: ['--x', 'y z'] });
  assert.deepEqual(resolveCommandConfig({ customCommand: 'copilot', customArgs: ['--acp'] }, { ACP_COMMAND: 'ignored' }), { command: 'copilot', args: ['--acp'] });
  const a = createAdapter('acp', { workspaceId: 'w', agentName: 'x', token: 't', client: {}, agentEnv: { ACP_COMMAND: 'gemini --experimental-acp' }, sessionsFile: path.join(tmpRoot, 'x.json') });
  assert.ok(a instanceof AcpAdapter, 'registered as type acp');
});

test('a finished parallel lane stops its agent process before reporting, so the worktree can be removed', async () => {
  // The process is spawned with cwd = the lane worktree and would otherwise
  // outlive the lane; on Windows a live process's cwd cannot be deleted, so
  // the merge left the worktree directory behind.
  const { adapter } = makeAdapter('happy', { env: { ACP_PERMISSION_MODE: 'auto' } });
  await adapter._handleMessage(message());
  const proc = adapter._conns['ch-1'].conn.proc;
  let atReport = null;
  adapter.client.completeParallelLane = async () => {
    atReport = { exitCode: proc.exitCode, signalCode: proc.signalCode, conn: adapter._conns['ch-1'] };
  };

  await adapter._exitParallelLane('ch-1', { batchId: 'b-1' });

  assert.ok(atReport, 'the lane was reported');
  assert.ok(atReport.exitCode !== null || atReport.signalCode !== null, 'the process had exited before the report');
  assert.equal(atReport.conn, undefined, 'the dead connection is dropped; the next turn respawns');
});
