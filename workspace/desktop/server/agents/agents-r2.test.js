'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Readable } = require('node:stream');

const { createStorage } = require('../storage');
const { NativeConfigService, createMockSafeStorage } = require('./config/service');
const { attachJsonlLineReader, serializeJsonLine } = require('./transports/jsonl');
const { buildSanitizedNativeEnv } = require('./adapters/common');
const { runNativePi, parseNativeModelSpec, buildAllowedPiTools } = require('./adapters/pi-native');
const { Store } = require('../store');
const { AgentRunner } = require('../agent-runner');

function createTempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-r2-'));
  const piDir = path.join(root, '.pi', 'agent');
  const codexDir = path.join(root, '.codex');
  const binDir = path.join(root, 'bin');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(piDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const isWin = process.platform === 'win32';
  fs.writeFileSync(path.join(binDir, isWin ? 'pi.exe' : 'pi'), 'stub', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, isWin ? 'codex.exe' : 'codex'), 'stub', { mode: 0o755 });

  const env = {
    PATH: binDir,
    USERPROFILE: root,
    HOME: root,
    PI_CODING_AGENT_DIR: piDir,
    CODEX_HOME: codexDir,
  };

  let storage = createStorage({
    dbPath: path.join(root, 'workbench.sqlite'),
    baseDir: root,
  });

  t.after(() => {
    try {
      if (storage) storage.close();
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    piDir,
    codexDir,
    binDir,
    projectDir,
    env,
    get storage() {
      return storage;
    },
  };
}

// Fake Pi RPC child script that speaks strict JSONL over stdin/stdout
const FAKE_PI_RPC_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const mode = process.argv[2] || 'normal';
const traceFile = process.argv[3];

const cliArgs = process.argv.slice(4);
function getFlag(name) {
  const idx = cliArgs.indexOf(name);
  return idx >= 0 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : null;
}

const agentDir = process.env.PI_CODING_AGENT_DIR || '';
let settings = {};
try {
  const raw = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
  const clean = raw.replace(/\/\/.*$/gm, '');
  settings = JSON.parse(clean);
} catch {}

const resolvedProvider = getFlag('--provider') || settings.defaultProvider || 'anthropic';
const resolvedModel = getFlag('--model') || settings.defaultModel || 'claude-sonnet-4-20250514';
const resolvedThinking = getFlag('--thinking') || settings.defaultThinkingLevel || 'medium';
const sessionArg = getFlag('--session');
const sessionDirArg = getFlag('--session-dir');

let sessionId = 'pi-sess-default';
let sessionFile = sessionArg || (sessionDirArg ? path.join(sessionDirArg, 'session-1.jsonl') : null);
if (sessionArg && fs.existsSync(sessionArg)) {
  try {
    const hdr = JSON.parse(fs.readFileSync(sessionArg, 'utf8').split('\n')[0]);
    sessionId = hdr.sessionId || 'pi-sess-resumed';
  } catch {}
} else if (sessionFile) {
  sessionId = 'pi-sess-' + path.basename(path.dirname(sessionFile));
}

if (mode === 'mismatch-session') {
  sessionId = 'pi-sess-unexpected-other';
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const decoder = new StringDecoder('utf8');
let buf = '';
process.stdin.on('data', chunk => {
  buf += decoder.write(chunk);
  while (true) {
    const idx = buf.indexOf('\n');
    if (idx === -1) break;
    let line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    if (traceFile) {
      fs.appendFileSync(traceFile, JSON.stringify({ cmd, cliArgs, envKeys: Object.keys(process.env) }) + '\n');
    }
    handleCommand(cmd);
  }
});

function handleCommand(cmd) {
  if (cmd.type === 'get_state') {
    if (mode === 'no-model') {
      return send({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { model: null } });
    }
    const modelId = mode === 'wrong-model' ? 'unexpected-fallback-model' : resolvedModel;
    return send({
      id: cmd.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        model: {
          id: modelId,
          name: modelId,
          provider: resolvedProvider,
          contextWindow: 200000,
          reasoning: true,
        },
        thinkingLevel: resolvedThinking,
        isStreaming: false,
        isCompacting: false,
        sessionFile,
        sessionId,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
  }

  if (cmd.type === 'prompt') {
    send({ id: cmd.id, type: 'response', command: 'prompt', success: true });
    if (mode === 'hang-after-accept') {
      return;
    }
    if (mode === 'exit-after-accept') {
      process.exit(0);
      return;
    }
    if (mode === 'turn-error') {
      send({ type: 'agent_start' });
      const errMsg = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'error',
        errorMessage: '401 Unauthorized: invalid native API key',
      };
      send({ type: 'message_end', message: errMsg });
      send({ type: 'agent_end', messages: [errMsg] });
      return;
    }

    if (sessionFile) {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({ sessionId, prompt: cmd.message }) + '\n');
    }

    send({ type: 'agent_start' });
    send({ type: 'turn_start' });

    if (mode === 'with-write-tool') {
      send({
        type: 'tool_execution_start',
        toolCallId: 'call_write_1',
        toolName: 'write',
        args: { path: 'created-by-pi.txt' },
      });
      fs.writeFileSync(path.join(process.cwd(), 'created-by-pi.txt'), 'hello from native pi\n', 'utf8');
      send({
        type: 'tool_execution_end',
        toolCallId: 'call_write_1',
        toolName: 'write',
        args: { path: 'created-by-pi.txt' },
        result: { content: [{ type: 'text', text: 'Wrote created-by-pi.txt' }] },
        isError: false,
      });
    }

    const replyText = 'Reply from ' + resolvedProvider + '/' + resolvedModel + ' (U+2028:\u2028ok)';
    send({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: replyText },
    });
    const finalMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      provider: resolvedProvider,
      model: resolvedModel,
      stopReason: 'stop',
      usage: {
        input: 25,
        output: 15,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 45,
        cost: { total: 0.0012 },
      },
    };
    send({ type: 'message_end', message: finalMsg });
    send({ type: 'turn_end', message: finalMsg, toolResults: [] });
    send({ type: 'agent_end', messages: [finalMsg] });
    return;
  }

  if (cmd.type === 'get_session_stats') {
    return send({
      id: cmd.id,
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        sessionFile,
        sessionId,
        tokens: { input: 25, output: 15, cacheRead: 5, cacheWrite: 0, total: 45 },
        cost: 0.0012,
        contextUsage: { tokens: 45, contextWindow: 200000, percent: 1 },
      },
    });
  }

  if (cmd.type === 'abort') {
    send({ id: cmd.id, type: 'response', command: 'abort', success: true });
    process.exit(0);
  }
}
`;

function createFakePiLauncher(root, mode = 'normal') {
  const scriptPath = path.join(root, `fake-pi-${mode}-${Date.now()}.cjs`);
  const tracePath = path.join(root, `trace-pi-${mode}-${Date.now()}.jsonl`);
  fs.writeFileSync(scriptPath, FAKE_PI_RPC_SCRIPT, 'utf8');
  return {
    launch: { command: process.execPath, args: [scriptPath, mode, tracePath] },
    readTrace: () =>
      fs.existsSync(tracePath)
        ? fs
            .readFileSync(tracePath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
        : [],
  };
}

test('R2 / JSONL transport: splits strictly on LF, preserves U+2028/U+2029 inside JSON strings, and rejects oversized lines', () => {
  const stream = new PassThrough();
  const lines = [];
  const errors = [];
  attachJsonlLineReader(stream, line => lines.push(line), {
    maxLineBytes: 256,
    onError: err => errors.push(err),
  });

  const payloadWithUnicodeSeparators = {
    type: 'message_update',
    delta: 'line1\u2028line2\u2029line3',
  };
  const serialized = serializeJsonLine(payloadWithUnicodeSeparators);
  // Write in chunks and with CRLF
  stream.write(Buffer.from(serialized.slice(0, 15), 'utf8'));
  stream.write(Buffer.from(serialized.slice(15).replace(/\n$/, '\r\n'), 'utf8'));

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.delta, 'line1\u2028line2\u2029line3');
  assert.equal(errors.length, 0);

  // Oversized line should trigger JSONL_LINE_TOO_LONG
  stream.write('{"huge":"' + 'x'.repeat(300) + '"}\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'JSONL_LINE_TOO_LONG');
});

test('R2 / A02 & A06: Native Pi reads updated settings.json, supports per-task CLI model override without touching settings.json, and rejects silent model fallback', async t => {
  const fx = createTempFixture(t);
  const settingsPath = path.join(fx.piDir, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    '{\n  // comment preserved\n  "defaultProvider": "anthropic",\n  "defaultModel": "claude-sonnet-4-20250514",\n  "customKeep": 42\n}\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(fx.piDir, 'auth.json'),
    JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-real-secret-123456' } }),
    'utf8'
  );

  const service = new NativeConfigService({ storage: fx.storage, userDataPath: fx.root, env: fx.env, safeStorage: createMockSafeStorage() });
  const { connection } = service.registerConnection({ adapterKind: 'native-pi', name: 'Local Pi' });

  // 1. Run with native default model
  const h1 = createFakePiLauncher(fx.root, 'normal');
  const res1 = await runNativePi(
    {
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { instructions: 'Check files.', permissions: { readFiles: true } },
      prompt: 'Hello Pi',
      connection,
      env: fx.env,
    },
    { launch: h1.launch }
  );
  assert.equal(res1.model, 'anthropic/claude-sonnet-4-20250514');
  assert.ok(res1.content.includes('anthropic/claude-sonnet-4-20250514'));
  assert.ok(res1.content.includes('U+2028:\u2028ok'));
  assert.equal(res1.usage.total_tokens, 45);
  assert.equal(res1.costKnown, true);
  assert.equal(res1.estimatedCost, 0.0012);

  // 2. A06: Per-task / per-member override via nativeModel does NOT modify settings.json on disk
  const beforeDisk = fs.readFileSync(settingsPath, 'utf8');
  const h2 = createFakePiLauncher(fx.root, 'normal');
  const res2 = await runNativePi(
    {
      projectDir: fx.projectDir,
       nativeModel: 'openai/gpt-5.4:high',
      config: { mode: 'plan' },
      agentPolicy: { instructions: '', permissions: { readFiles: true } },
      prompt: 'Override test',
      connection,
      env: fx.env,
    },
    { launch: h2.launch }
  );
  assert.equal(res2.model, 'openai/gpt-5.4');
  assert.equal(res2.thinkingLevel, 'high');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), beforeDisk);

  // 3. Rejects if native client falls back to a different model than requested
  const hWrong = createFakePiLauncher(fx.root, 'wrong-model');
  await assert.rejects(
    () =>
      runNativePi(
        {
          projectDir: fx.projectDir,
          nativeModel: 'openai/gpt-5.4',
          config: { mode: 'plan' },
          agentPolicy: { instructions: '', permissions: { readFiles: true } },
          prompt: 'Should fail on fallback',
          connection,
          env: fx.env,
        },
        { launch: hWrong.launch }
      ),
    err => err.code === 'RUNTIME_MODEL_UNAVAILABLE'
  );

  // 4. A02: Modify defaultModel via NativeConfigService, then verify new Pi session reads the updated value
  const inspected = service.inspectConfig(connection.id);
  const expectedSha = Object.fromEntries(inspected.sources.map(s => [s.sourceKey, s.sha256]));
  service.applyConfigChange(connection.id, {
    expectedVersions: expectedSha,
    patch: {
      settings: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.4-mini',
      },
    },
  });

  const h3 = createFakePiLauncher(fx.root, 'normal');
  const res3 = await runNativePi(
    {
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { instructions: '', permissions: { readFiles: true } },
      prompt: 'Read updated default',
      connection,
      env: fx.env,
    },
    { launch: h3.launch }
  );
  assert.equal(res3.model, 'openai/gpt-5.4-mini');
  assert.ok(fs.readFileSync(settingsPath, 'utf8').includes('"customKeep": 42'));
});

test('R2 / Completion & Stop Semantics (A21, A28): prompt acceptance never fakes completion, premature exit and turn error fail, abort kills process tree, and workbench tokens are stripped', async t => {
  const fx = createTempFixture(t);
  fs.writeFileSync(
    path.join(fx.piDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' }),
    'utf8'
  );

  // Premature exit after prompt acceptance must fail
  const hExit = createFakePiLauncher(fx.root, 'exit-after-accept');
  await assert.rejects(
    () =>
      runNativePi(
        {
          projectDir: fx.projectDir,
          config: { mode: 'plan' },
          agentPolicy: { permissions: { readFiles: true } },
          prompt: 'Exit early',
          env: fx.env,
        },
        { launch: hExit.launch }
      ),
    err => err.code === 'RUNTIME_PREMATURE_EXIT'
  );

  // Assistant stopReason='error' must fail
  const hErr = createFakePiLauncher(fx.root, 'turn-error');
  await assert.rejects(
    () =>
      runNativePi(
        {
          projectDir: fx.projectDir,
          config: { mode: 'plan' },
          agentPolicy: { permissions: { readFiles: true } },
          prompt: 'Trigger error',
          env: fx.env,
        },
        { launch: hErr.launch }
      ),
    err => err.code === 'RUNTIME_TURN_FAILED' && /401 Unauthorized/.test(err.message)
  );

  // Abort terminates child process before promise settles (A21)
  const hHang = createFakePiLauncher(fx.root, 'hang-after-accept');
  const controller = new AbortController();
  let spawnedChild = null;
  const runPromise = runNativePi(
    {
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { permissions: { readFiles: true } },
      prompt: 'Hang until abort',
      signal: controller.signal,
      env: fx.env,
    },
    {
      launch: hHang.launch,
      spawnImpl: (...args) => {
        spawnedChild = require('node:child_process').spawn(...args);
        return spawnedChild;
      },
    }
  );
  await once(spawnedChild, 'spawn');
  await new Promise(r => setTimeout(r, 80));
  controller.abort();
  await assert.rejects(runPromise, err => err.code === 'ABORT_ERR');
  assert.ok(spawnedChild.exitCode !== null || spawnedChild.signalCode !== null);

  // A28: Environment sanitization strips workbench tokens
  const sanitized = buildSanitizedNativeEnv(
    {
      ...fx.env,
      OPENAGENTS_API_TOKEN: 'secret-token',
      WORKBENCH_ADMIN_KEY: 'secret-admin',
      '52HZ_INTERNAL_TOKEN': 'secret-52hz',
      VAULT_MASTER_KEY: 'secret-vault',
      API_AUTH_TOKEN: 'secret-auth',
      ANTHROPIC_API_KEY: 'keep-provider-key',
    },
    { command: 'C:\\bin\\pi.exe', args: [] }
  );
  assert.equal(sanitized.OPENAGENTS_API_TOKEN, undefined);
  assert.equal(sanitized.WORKBENCH_ADMIN_KEY, undefined);
  assert.equal(sanitized['52HZ_INTERNAL_TOKEN'], undefined);
  assert.equal(sanitized.VAULT_MASTER_KEY, undefined);
  assert.equal(sanitized.API_AUTH_TOKEN, undefined);
  assert.equal(sanitized.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(sanitized.ANTHROPIC_API_KEY, 'keep-provider-key');
});

test('R2 / Session Bindings & Isolation (A18): isolates parallel sessions, resumes same channel session, blocks concurrent writers, and detects session mismatch', async t => {
  const fx = createTempFixture(t);
  fs.writeFileSync(
    path.join(fx.piDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' }),
    'utf8'
  );
  const bindings = fx.storage.nativeSessionBindings;

  // 1. First turn in channel-A creates and records a session file
  const h1 = createFakePiLauncher(fx.root, 'normal');
  const turn1 = await runNativePi(
    {
      runId: 'run-a1',
      channel: 'channel-A',
      agentId: 'agent-pi-1',
      userDataPath: fx.root,
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { permissions: { readFiles: true } },
      prompt: 'Turn 1 in channel A',
      sessionBindings: bindings,
      env: fx.env,
    },
    { launch: h1.launch }
  );
  assert.ok(turn1.nativeSessionId);
  assert.ok(turn1.nativeSessionFile && fs.existsSync(turn1.nativeSessionFile));

  // 2. Second turn in channel-A resumes the exact same nativeSessionFile & nativeSessionId
  const h2 = createFakePiLauncher(fx.root, 'normal');
  const turn2 = await runNativePi(
    {
      runId: 'run-a2',
      channel: 'channel-A',
      agentId: 'agent-pi-1',
      userDataPath: fx.root,
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { permissions: { readFiles: true } },
      prompt: 'Turn 2 in channel A',
      sessionBindings: bindings,
      env: fx.env,
    },
    { launch: h2.launch }
  );
  assert.equal(turn2.nativeSessionId, turn1.nativeSessionId);
  assert.equal(turn2.nativeSessionFile, turn1.nativeSessionFile);
  const trace2 = h2.readTrace();
  assert.ok(trace2[0].cliArgs.includes('--session'));
  assert.ok(trace2[0].cliArgs.includes(turn1.nativeSessionFile));

  // 3. Same Agent in channel-B gets a completely separate session file and ID (A18)
  const hB = createFakePiLauncher(fx.root, 'normal');
  const turnB = await runNativePi(
    {
      runId: 'run-b1',
      channel: 'channel-B',
      agentId: 'agent-pi-1',
      userDataPath: fx.root,
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { permissions: { readFiles: true } },
      prompt: 'Turn 1 in channel B',
      sessionBindings: bindings,
      env: fx.env,
    },
    { launch: hB.launch }
  );
  assert.notEqual(turnB.nativeSessionId, turn1.nativeSessionId);
  assert.notEqual(turnB.nativeSessionFile, turn1.nativeSessionFile);

  // 4. Concurrent write to the same session binding is rejected with 409 NATIVE_SESSION_BUSY
  const bindingA = bindings.listByChannel('channel-A')[0];
  bindings.acquireWriteLock(bindingA.id, { runId: 'run-holding-lock' });
  await assert.rejects(
    () =>
      runNativePi(
        {
          runId: 'run-concurrent-intruder',
          channel: 'channel-A',
          agentId: 'agent-pi-1',
          userDataPath: fx.root,
          projectDir: fx.projectDir,
          config: { mode: 'plan' },
          agentPolicy: { permissions: { readFiles: true } },
          prompt: 'Concurrent write attempt',
          sessionBindings: bindings,
          env: fx.env,
        },
        { launch: h2.launch }
      ),
    err => err.status === 409 && err.code === 'NATIVE_SESSION_BUSY'
  );
  bindings.releaseWriteLock(bindingA.id, { runId: 'run-holding-lock', nextState: 'idle' });

  // 5. Session ID mismatch on resume triggers NATIVE_SESSION_MISMATCH and marks binding broken
  const hMismatch = createFakePiLauncher(fx.root, 'mismatch-session');
  await assert.rejects(
    () =>
      runNativePi(
        {
          runId: 'run-mismatch',
          channel: 'channel-A',
          agentId: 'agent-pi-1',
          userDataPath: fx.root,
          projectDir: fx.projectDir,
          config: { mode: 'plan' },
          agentPolicy: { permissions: { readFiles: true } },
          prompt: 'Should detect cross-wired session ID',
          sessionBindings: bindings,
          env: fx.env,
        },
        { launch: hMismatch.launch }
      ),
    err => err.status === 409 && err.code === 'NATIVE_SESSION_MISMATCH'
  );
});

test('R2 / Full AgentRunner integration: Native Pi member executes plan & agent tasks end-to-end without any workbench model provider', async t => {
  const fx = createTempFixture(t);
  fs.writeFileSync(
    path.join(fx.piDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(fx.piDir, 'auth.json'),
    JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-real-secret-123456' } }),
    'utf8'
  );

  const storeDir = path.join(fx.root, 'store-data');
  fs.mkdirSync(storeDir, { recursive: true });
  const store = new Store(storeDir);
  try {
    const events = [];
    const broadcaster = {
      broadcast: ev => events.push(ev),
      broadcastComposing: () => {},
    };

    const fakePi = createFakePiLauncher(fx.root, 'with-write-tool');
    const runner = new AgentRunner(store, broadcaster, {
      env: fx.env,
      nativeRuntime: (agentIdentity, opts) => runNativePi(opts, { launch: fakePi.launch }),
    });
    const nativeConfigService = new NativeConfigService({
      storage: store.storage,
      userDataPath: storeDir,
      agentRunner: runner,
      env: fx.env,
    });
    runner.nativeConfigService = nativeConfigService;

    // Register Native Pi connection and create an Agent bound to it (no workbench modelResource!)
    const { connection } = nativeConfigService.registerConnection({
      adapterKind: 'native-pi',
      name: 'Local Pi CLI',
    });
    const piAgent = store.storage.agentDefinitions.create({
      name: 'Pi 原生实施成员',
      role: 'developer',
      runtimeKind: 'pi',
      connectionId: connection.id,
      defaultMode: 'agent',
      maxMode: 'agent',
      permissions: {
        readFiles: true,
        writeFiles: true,
        executeCommands: false,
        knowledge: false,
        mcp: false,
        delegate: false,
      },
    });
    assert.equal(piAgent.execution.connectionKind, 'native-pi');
    assert.equal(piAgent.modelResource, null);

    // Bind channel 'general' to this Native Pi Agent and set project working_dir
    store.updateChannel('general', {
      agent_id: piAgent.id,
      working_dir: fx.projectDir,
      runtime_config: { inheritAgent: true, mode: 'agent' },
    });

    // 1. Default global hard budget blocks native execution until explicitly relaxed
    const blockedEvent = store.addEvent({
      type: 'workspace.message.posted',
      source: 'human:user',
      target: 'channel/general',
      payload: { content: 'Blocked while hard request budget is active' },
    });
    await runner.handleUserMessage(blockedEvent);
    const blockedReply = events.find(
      e => e.type === 'workspace.message.posted' && e.metadata?.interrupted === true
    );
    assert.ok(blockedReply);
    assert.equal(blockedReply.metadata.interrupted, true);
    assert.ok(blockedReply.payload.content.includes('硬预算'));

    // 2. Relax hard request budgets (retaining duration limit) and run Native Pi end-to-end
    store.storage.db.prepare(`
      UPDATE budget_limits
      SET max_tokens_per_run = NULL, max_steps_per_run = NULL, max_cost_per_session = NULL, max_cost_per_day = NULL
      WHERE id = 'global'
    `).run();

    const userEvent = store.addEvent({
      type: 'workspace.message.posted',
      source: 'human:user',
      target: 'channel/general',
      payload: { content: 'Create a file using native Pi' },
    });

    const runResult = await runner.handleUserMessage(userEvent);
    assert.equal(runResult.outcome, 'finished');
    assert.ok(runResult.content.includes('anthropic/claude-sonnet-4-20250514'));
    assert.ok(fs.existsSync(path.join(fx.projectDir, 'created-by-pi.txt')));

    const replyEvent = events.find(
      e => e.type === 'workspace.message.posted' && e.metadata?.in_reply_to === userEvent.id && !e.metadata?.runtime_intermediate
    );
    assert.ok(replyEvent);
    assert.equal(replyEvent.metadata.engine, 'pi-native-rpc');
    assert.equal(replyEvent.metadata.model, 'anthropic/claude-sonnet-4-20250514');
    assert.ok(replyEvent.metadata.execution_evidence.files_modified.includes('created-by-pi.txt'));
  } finally {
    store.storage.close();
  }
});

test('R2 / Real local Pi CLI RPC handshake (isolated temp PI_CODING_AGENT_DIR): detects unknown model without auth and reads NativeConfigService updates via real get_state', async t => {
  const { locate, stopChild } = require('./adapters/common');
  const { spawn } = require('node:child_process');
  const realLaunch = locate('pi', process.env);
  if (!realLaunch) {
    t.skip('Local pi CLI not installed on PATH');
    return;
  }

  const fx = createTempFixture(t);
  const realEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: fx.piDir,
    PI_OFFLINE: '1',
    USERPROFILE: fx.root,
    HOME: fx.root,
  };
  // Strip any ambient provider API keys so only our temp auth.json controls availability
  for (const key of Object.keys(realEnv)) {
    if (/_API_KEY$|_TOKEN$/i.test(key)) delete realEnv[key];
  }

  // 1. Without auth.json, real Pi 0.85.1 returns model={id:'unknown',provider:'unknown'}, which runNativePi rejects with RUNTIME_MODEL_UNAVAILABLE
  fs.writeFileSync(
    path.join(fx.piDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5' }),
    'utf8'
  );
  await assert.rejects(
    () =>
      runNativePi(
        {
          projectDir: fx.projectDir,
          config: { mode: 'plan' },
          agentPolicy: { permissions: { readFiles: true } },
          prompt: 'Should fail before prompt when model is unknown',
          env: realEnv,
        },
        { launch: realLaunch }
      ),
    err => err.code === 'RUNTIME_MODEL_UNAVAILABLE'
  );

  // 2. With auth.json present, query real Pi RPC get_available_models and verify NativeConfigService update is read by real Pi get_state
  fs.writeFileSync(
    path.join(fx.piDir, 'auth.json'),
    JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-temp-test-key' } }),
    'utf8'
  );

  const queryRealPiState = async () => {
    const child = spawn(realLaunch.command, [...realLaunch.args, '--mode', 'rpc', '--no-session', '--no-extensions'], {
      cwd: fx.projectDir,
      env: buildSanitizedNativeEnv(realEnv, realLaunch),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const responses = new Map();
      let resolveBoth;
      const done = new Promise(resolve => {
        resolveBoth = resolve;
      });
      attachJsonlLineReader(child.stdout, line => {
        const msg = JSON.parse(line);
        if (msg.type === 'response' && msg.id) {
          responses.set(msg.id, msg);
          if (responses.has('s1') && responses.has('m1')) resolveBoth();
        }
      });
      child.stdin.write(serializeJsonLine({ id: 's1', type: 'get_state' }));
      child.stdin.write(serializeJsonLine({ id: 'm1', type: 'get_available_models' }));
      await done;
      return {
        state: responses.get('s1').data,
        models: responses.get('m1').data.models,
      };
    } finally {
      await stopChild(child);
    }
  };

  const firstProbe = await queryRealPiState();
  assert.ok(Array.isArray(firstProbe.models) && firstProbe.models.length >= 2);
  const targetModel = firstProbe.models[firstProbe.models.length - 1];

  const service = new NativeConfigService({
    storage: fx.storage,
    userDataPath: fx.root,
    env: realEnv,
    safeStorage: createMockSafeStorage(),
  });
  const { connection } = service.registerConnection({ kind: 'native-pi', name: 'Real Local Pi' });
  const inspected = service.inspectConfig(connection.id);
  const expectedVersions = Object.fromEntries(inspected.sources.map(s => [s.sourceKey, s.sha256]));

  service.applyConfigChange(connection.id, {
    expectedVersions,
    patch: {
      settings: {
        defaultProvider: targetModel.provider,
        defaultModel: targetModel.id,
        defaultThinkingLevel: 'high',
      },
    },
  });

  const secondProbe = await queryRealPiState();
  assert.equal(secondProbe.state.model.provider, targetModel.provider);
  assert.equal(secondProbe.state.model.id, targetModel.id);
  assert.equal(secondProbe.state.thinkingLevel, 'high');
});
