'use strict';

/*
  Fix/Review travels with each message (metadata.agent_mode), not with the
  agent: one agent can review in one thread and fix in another, and the choice
  survives an adapter restart. Review is enforced by each CLI's own flags where
  the CLI has them. A parallel lane's port reaches the spawned CLI as PORT.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

const BaseAdapter = require('../src/adapters/base');
const ClaudeAdapter = require('../src/adapters/claude');
const CodexAdapter = require('../src/adapters/codex');
const PiAdapter = require('../src/adapters/pi');
const GeminiAdapter = require('../src/adapters/gemini');
const AcpAdapter = require('../src/adapters/acp');

const baseOpts = { workspaceId: 'ws', endpoint: 'http://x', token: 't' };

function quiet(a) {
  a._log = () => {};
  a.sendStatus = async () => {};
  a.sendError = async () => {};
  a.sendResponse = async () => {};
  a._resolveKnowledgeMentions = async (c) => c;
  a._releaseStaleTodos = async () => {};
  a._registerFilesTouchedSince = async () => {};
  a._autoTitleChannel = async () => {};
  return a;
}

function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.pid = 99999;
  proc.kill = () => {};
  return proc;
}

function laneMsg(agent, worktree, content = 'split the work') {
  return {
    sessionId: 'ch-1',
    content,
    metadata: {
      parallel_batch: {
        batch_id: 'b-1',
        isolation: 'worktree',
        lanes: { [agent]: { task: 'part', working_dir: worktree, branch: `parallel/b-1/${agent}`, port: 4101 } },
      },
    },
  };
}

// ── mode per message ─────────────────────────────────────────────────

class ModeProbe extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.seen = [];
    this.hold = null;
  }
  async _handleMessage(msg) {
    const ch = msg.sessionId;
    const before = this._mode;
    if (this.hold) await this.hold;
    await delay(1);
    // A bare read after awaits still resolves to THIS turn's channel.
    this.seen.push({ ch, before, after: this._mode, forChannel: this._modeFor(ch) });
  }
}

test('a message\'s agent_mode beats the adapter default for its turn and does not leak to the next', async () => {
  const a = quiet(new ModeProbe({ ...baseOpts, agentName: 'probe' }));
  assert.equal(a._mode, 'execute', 'default is execute');

  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'review this', metadata: { agent_mode: 'plan' } });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'plain', metadata: {} });

  assert.deepEqual(a.seen[0], { ch: 'ch-1', before: 'plan', after: 'plan', forChannel: 'plan' });
  assert.deepEqual(a.seen[1], { ch: 'ch-1', before: 'execute', after: 'execute', forChannel: 'execute' });
  assert.equal(a._modeFor('ch-1'), 'execute', 'nothing left behind after the turn');
  assert.equal(a._mode, 'execute', 'outside a turn, the default');
});

test('set_mode is only the fallback: an explicit message mode still wins, a bare one follows it', async () => {
  const a = quiet(new ModeProbe({ ...baseOpts, agentName: 'probe' }));
  a.client = { pollControl: async () => [{ id: 'c1', payload: { action: 'set_mode', mode: 'plan' } }] };
  await a._pollControl();
  assert.equal(a._defaultMode, 'plan');

  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'fix it', metadata: { agent_mode: 'execute' } });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'other client', metadata: {} });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'junk', metadata: { agent_mode: 'yolo' } });

  assert.equal(a.seen[0].after, 'execute');
  assert.equal(a.seen[1].after, 'plan');
  assert.equal(a.seen[2].after, 'plan', 'an unknown value is ignored, not trusted');
});

test('two threads run at the same time in different modes and each sees its own', async () => {
  const a = quiet(new ModeProbe({ ...baseOpts, agentName: 'probe' }));
  let release;
  a.hold = new Promise((r) => { release = r; });
  const t1 = a._channelWorker('ch-review', { sessionId: 'ch-review', content: 'x', metadata: { agent_mode: 'plan' } });
  const t2 = a._channelWorker('ch-fix', { sessionId: 'ch-fix', content: 'y', metadata: { agent_mode: 'execute' } });
  await delay(5);
  release();
  await Promise.all([t1, t2]);
  const by = Object.fromEntries(a.seen.map((s) => [s.ch, s.after]));
  assert.deepEqual(by, { 'ch-review': 'plan', 'ch-fix': 'execute' });
});

// ── claude: one long-lived process per channel ───────────────────────

function makeClaude() {
  const a = quiet(new ClaudeAdapter({ ...baseOpts, agentName: 'claude', client: { getSession: async () => ({}) } }));
  a._findClaudeBinary = () => 'claude';
  return a;
}

test('claude replaces its channel process when the turn\'s mode differs from the one it was spawned in', () => {
  const a = makeClaude();
  const pp = { alive: true, cwd: '/w', mode: 'execute', turnEnvKey: '' };

  a._enterTurnMode('ch-1', { metadata: { agent_mode: 'execute' } });
  assert.equal(a._persistentProcRestartReason(pp, 'ch-1', '/w'), null, 'same mode, same dir: reused');

  a._enterTurnMode('ch-1', { metadata: { agent_mode: 'plan' } });
  assert.match(a._persistentProcRestartReason(pp, 'ch-1', '/w'), /Mode changed \(execute -> plan\)/);

  a._exitTurnMode('ch-1');
  a._defaultMode = 'plan';
  assert.match(a._persistentProcRestartReason(pp, 'ch-1', '/w'), /Mode changed/, 'a set_mode default applies to bare messages');

  a._defaultMode = 'execute';
  assert.match(a._persistentProcRestartReason(pp, 'ch-1', '/other'), /Working directory changed/, 'still restarts on cwd change');
});

test('claude builds plan permission flags from the turn\'s mode, not the adapter default', () => {
  const a = makeClaude();
  a._enterTurnMode('ch-1', { metadata: { agent_mode: 'plan' } });
  const { cmd } = a._buildClaudeCmd('hi', 'ch-1', {});
  assert.ok(cmd.includes('--permission-mode') && cmd[cmd.indexOf('--permission-mode') + 1] === 'plan');
  assert.ok(!cmd.includes('--dangerously-skip-permissions'));

  const { cmd: other } = a._buildClaudeCmd('hi', 'ch-2', {});
  assert.ok(other.includes('--dangerously-skip-permissions'), 'another thread keeps execute');
  assert.ok(!other.includes('--permission-mode'));
});

test('claude: a lane\'s PORT is in the spawn env and forces a fresh process; a normal turn has neither', () => {
  const a = makeClaude();
  a.agentEnv = { PATH: '/bin', CLAUDECODE: '1' };
  const pp = { alive: true, cwd: '/w', mode: 'execute', turnEnvKey: '' };

  assert.equal(a._buildSpawnEnv('ch-1').PORT, undefined);
  assert.equal(a._persistentProcRestartReason(pp, 'ch-1', '/w'), null);

  a._turnEnvOverride['ch-1'] = { PORT: '4101' };
  const env = a._buildSpawnEnv('ch-1');
  assert.equal(env.PORT, '4101');
  assert.equal(env.CLAUDECODE, undefined, 'the usual scrubbing still applies');
  assert.equal(a._persistentProcRestartReason(pp, 'ch-1', '/w'), 'Turn env changed', 'even in the same folder (a scope-only lane)');
  assert.equal(a._buildSpawnEnv('ch-2').PORT, undefined, 'other channels are untouched');
});

// ── codex ────────────────────────────────────────────────────────────

function makeCodex() {
  const a = quiet(new CodexAdapter({ ...baseOpts, agentName: 'codex', client: { getSession: async () => ({}) } }));
  a._codexBin = 'codex';
  return a;
}

test('codex plan argv: --sandbox read-only before `resume`, and never the bypass flag', () => {
  const a = makeCodex();
  const plan = a._buildCodexCmd({ threadId: 'th-1', mode: 'plan', model: 'm' });
  assert.deepEqual(plan.slice(0, 6), ['codex', 'exec', '--sandbox', 'read-only', 'resume', 'th-1']);
  assert.ok(!plan.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(plan.includes('--json') && plan.includes('--skip-git-repo-check'));

  const fresh = a._buildCodexCmd({ mode: 'plan' });
  assert.deepEqual(fresh.slice(0, 4), ['codex', 'exec', '--sandbox', 'read-only']);

  const exec = a._buildCodexCmd({ threadId: 'th-1', mode: 'execute', effort: 'high' });
  assert.ok(exec.includes('--dangerously-bypass-approvals-and-sandbox'), 'execute is unchanged');
  assert.ok(!exec.includes('--sandbox'));
  assert.deepEqual(exec.slice(0, 4), ['codex', 'exec', 'resume', 'th-1']);
  assert.ok(exec.includes('model_reasoning_effort="high"'));
});

test('codex: PORT reaches the spawn env for a lane turn and not for the normal turn after it', async () => {
  const a = makeCodex();
  a._useCliMode = true;
  a._buildSystemContext = () => 'sys';
  a.client = {
    getSession: async () => ({}),
    completeParallelLane: async () => {},
  };
  const spawned = [];
  a._spawnCodex = async (cmd, env) => { spawned.push({ cmd, env }); return { responseText: 'ok', exitCode: 0 }; };
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-wt-'));

  await a._channelWorker('ch-1', { ...laneMsg('codex', worktree), metadata: { ...laneMsg('codex', worktree).metadata, agent_mode: 'plan' } });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'normal turn', metadata: {} });

  assert.equal(spawned[0].env.PORT, '4101');
  assert.ok(spawned[0].cmd.includes('read-only'), 'the lane message\'s own mode applied');
  assert.equal(spawned[1].env.PORT, undefined);
  assert.ok(spawned[1].cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(a._turnEnvOverride, {});
});

// ── pi ───────────────────────────────────────────────────────────────

function makePi() {
  const a = quiet(new PiAdapter({ ...baseOpts, agentName: 'pi', client: { getSession: async () => ({}) } }));
  a._piBin = 'pi';
  a._piJsPath = null;
  return a;
}

test('pi plan argv restricts tools to its documented read-only set; execute does not', () => {
  const a = makePi();
  a._enterTurnMode('ch-1', { metadata: { agent_mode: 'plan' } });
  const plan = a._buildPiCmd('review', 'ch-1');
  assert.equal(plan[plan.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.deepEqual(plan.slice(-2), ['-p', 'review'], '-p still last');

  const exec = a._buildPiCmd('fix', 'ch-2');
  assert.ok(!exec.includes('--tools'));
});

test('pi: PORT is in the spawn env only while the channel has a lane env', async () => {
  const a = makePi();
  a._resolveWorkingDir = async () => process.cwd();
  const envs = [];
  a._spawnProc = (bin, args, opts) => {
    envs.push(opts.env);
    const proc = fakeProc();
    setTimeout(() => { proc.stdout.push(null); proc.stderr.push(null); proc.emit('exit', 0); }, 5);
    return proc;
  };
  a._turnEnvOverride['ch-1'] = { PORT: '4101' };
  try { await a._runPi('p', 'ch-1'); } catch {}
  delete a._turnEnvOverride['ch-1'];
  try { await a._runPi('p', 'ch-1'); } catch {}
  assert.equal(envs[0].PORT, '4101');
  assert.equal(envs[1].PORT, (a.agentEnv || process.env).PORT);
});

// ── gemini ───────────────────────────────────────────────────────────

function makeGemini() {
  const a = quiet(new GeminiAdapter({ ...baseOpts, agentName: 'gemini', client: { getSession: async () => ({}) } }));
  a._ensureGeminiAuth = () => {};
  a._findGeminiBinary = () => 'gemini';
  a._resolveToNodeCmd = () => null;
  return a;
}

test('gemini plan argv uses --approval-mode default instead of -y; execute keeps -y', () => {
  const a = makeGemini();
  a._enterTurnMode('ch-1', { metadata: { agent_mode: 'plan' } });
  const { cmd: plan } = a._buildGeminiCmd('review', 'ch-1');
  assert.equal(plan[plan.indexOf('--approval-mode') + 1], 'default');
  assert.ok(!plan.includes('-y') && !plan.includes('--yolo'), 'never combined with yolo');

  const { cmd: exec } = a._buildGeminiCmd('fix', 'ch-2');
  assert.ok(exec.includes('-y'));
  assert.ok(!exec.includes('--approval-mode'));
});

test('gemini: PORT reaches the spawn env for a lane turn and not for a normal turn', async () => {
  const a = makeGemini();
  a._titledSessions.add('ch-1');
  const envs = [];
  a._spawnProc = (bin, args, opts) => {
    envs.push(opts.env);
    const proc = fakeProc();
    setTimeout(() => proc.emit('exit', 0), 5);
    return proc;
  };
  a._turnEnvOverride['ch-1'] = { PORT: '4101' };
  await a._handleMessage({ sessionId: 'ch-1', content: 'lane' });
  delete a._turnEnvOverride['ch-1'];
  await a._handleMessage({ sessionId: 'ch-1', content: 'normal' });
  assert.equal(envs[0].PORT, '4101');
  assert.equal(envs[1].PORT, (a.agentEnv || process.env).PORT);
});

// ── acp: one long-lived agent process per channel ────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-turnenv-'));
const fakeAcp = path.join(tmpRoot, 'fake-acp.js');
fs.writeFileSync(fakeAcp, `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-' + process.env.PORT } });
});
rl.on('close', () => process.exit(0));
`);

test('acp: a lane\'s PORT restarts the channel\'s agent process with it, and the next normal turn restarts without it', async (t) => {
  const a = quiet(new AcpAdapter({
    ...baseOpts, agentName: 'acp', client: {},
    agentEnv: { ...process.env, PORT: '' },
    acpCommand: process.execPath, acpArgs: [fakeAcp],
    sessionsFile: path.join(tmpRoot, 'sessions.json'),
  }));
  t.after(() => { for (const e of Object.values(a._conns)) { try { e.conn.kill(); } catch {} } });

  const first = await a._ensureSession('ch-1', tmpRoot);
  assert.equal(first.entry.conn.env.PORT, '');

  a._turnEnvOverride['ch-1'] = { PORT: '4101' };
  const lane = await a._ensureSession('ch-1', tmpRoot);
  assert.notEqual(lane.entry, first.entry, 'a new process');
  assert.equal(lane.entry.conn.env.PORT, '4101');
  assert.equal(lane.entry.sessionId, 's-4101', 'the agent process itself saw PORT');
  assert.equal(first.entry.conn.closed || first.entry.conn.proc.killed, true, 'the old one was stopped');

  const again = await a._ensureSession('ch-1', tmpRoot);
  assert.equal(again.entry, lane.entry, 'same env: reused');

  delete a._turnEnvOverride['ch-1'];
  const back = await a._ensureSession('ch-1', tmpRoot);
  assert.notEqual(back.entry, lane.entry);
  assert.equal(back.entry.conn.env.PORT, '');
});

test('acp refuses writes by the turn\'s mode, per channel', () => {
  const a = quiet(new AcpAdapter({ ...baseOpts, agentName: 'acp', client: {}, acpCommand: 'x', sessionsFile: path.join(tmpRoot, 's2.json') }));
  a._enterTurnMode('ch-review', { metadata: { agent_mode: 'plan' } });
  assert.throws(() => a._fsWrite({ channel: 'ch-review' }, { path: path.join(tmpRoot, 'x.txt'), content: 'x' }), /disabled in plan mode/);
  a._fsWrite({ channel: 'ch-fix' }, { path: path.join(tmpRoot, 'x.txt'), content: 'x' });
  assert.equal(fs.readFileSync(path.join(tmpRoot, 'x.txt'), 'utf-8'), 'x');
});

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });
