'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const {
  acquireSharedResourceLock,
  getSharedResourceLock,
  clearAllSharedResourceLocks,
} = require('./adapters/common');
const { runAntigravity, buildAntigravityArgs } = require('./adapters/antigravity');
const { runOpenclaw } = require('./adapters/openclaw');
const { runHermes } = require('./adapters/hermes');
const {
  resolveNativeAdapterKind,
  getConnectionCapabilitySnapshot,
  runNativeAdapter,
} = require('./registry');
const { startServer } = require('../index');
const { createNativeBudgetPolicy } = require('../native-budget-policy');

// Helper to create clean test directories
function makeTempDir(prefix = 'r5-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. Antigravity Native Adapter Tests
// ---------------------------------------------------------------------------
test('R5 Antigravity adapter: parses stream, captures conversation ID, usage, and enforces security args', async t => {
  const tmpDir = makeTempDir('r5-agy-');
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  // 1. Test argument builder (A28 / Section 8.1: never bypass approval)
  const safeArgs = buildAntigravityArgs({
    prompt: 'Implement feature X',
    projectDir: tmpDir,
    permissions: { writeFiles: false, executeCommands: false },
  });
  assert.ok(safeArgs.includes('--read-only'), 'Must include --read-only when writeFiles is false');
  assert.ok(!safeArgs.includes('--yolo'), 'Must never include --yolo');
  assert.ok(!safeArgs.includes('--skip-approval'), 'Must never include --skip-approval');

  // 2. Create mock agy script
  const mockScript = path.join(tmpDir, 'mock-agy.js');
  fs.writeFileSync(mockScript, `
    const fs = require('node:fs');
    process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'agy-conv-777' }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'thought', thought: 'Analyzing project structure.' }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'agent_response', text: 'Hello ' }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'agent_response', text: 'from Antigravity!' }) + '\\n');
    process.stdout.write(JSON.stringify({
      event: 'result',
      response: 'Hello from Antigravity!',
      usage: { input_tokens: 42, output_tokens: 18, total_tokens: 60, cost_usd: 0.002 }
    }) + '\\n');
    process.exit(0);
  `, 'utf8');

  const events = [];
  const fakeLaunch = { command: process.execPath, args: [mockScript] };

  const result = await runAntigravity(
    {
      prompt: 'Test prompt',
      projectDir: tmpDir,
      onEvent: ev => events.push(ev),
    },
    { launch: fakeLaunch }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Hello from Antigravity!');
  assert.equal(result.conversationId, 'agy-conv-777');
  assert.equal(result.tokenUsage.totalTokens, 60);
  assert.equal(result.tokenUsage.costUsd, 0.002);
  assert.ok(events.some(e => e.type === 'thought' && e.text.includes('Analyzing')));
  assert.ok(events.some(e => e.type === 'delta' && e.text.includes('Hello')));
});

test('R5 Antigravity adapter: AbortSignal terminates child process cleanly', async t => {
  const tmpDir = makeTempDir('r5-agy-abort-');
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  const mockScript = path.join(tmpDir, 'mock-agy-hang.js');
  fs.writeFileSync(mockScript, `
    process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'agy-hang-1' }) + '\\n');
    // Hang until killed
    setInterval(() => {}, 1000);
  `, 'utf8');

  const ac = new AbortController();
  const fakeLaunch = { command: process.execPath, args: [mockScript] };

  const runPromise = runAntigravity(
    {
      prompt: 'Hang test',
      projectDir: tmpDir,
      signal: ac.signal,
    },
    { launch: fakeLaunch }
  );

  // Trigger cancellation shortly after starting
  setTimeout(() => ac.abort(), 60);

  await assert.rejects(runPromise, { code: 'ABORT_ERR' });
});

// ---------------------------------------------------------------------------
// 2. OpenClaw Native Adapter & Shared Profile Concurrency Lock Tests
// ---------------------------------------------------------------------------
test('R5 OpenClaw adapter: shared Profile concurrency lock serializes concurrent runs for same profile', async t => {
  clearAllSharedResourceLocks();
  const tmpDir = makeTempDir('r5-openclaw-');
  t.after(() => {
    clearAllSharedResourceLocks();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  // Test mutex directly
  const lock1 = await acquireSharedResourceLock('openclaw:profile:team-prod', { timeoutMs: 1000, holder: 'task-1' });
  assert.ok(lock1);
  assert.equal(getSharedResourceLock('openclaw:profile:team-prod')?.holder, 'task-1');

  // Attempting second acquire on same profile should timeout
  await assert.rejects(
    acquireSharedResourceLock('openclaw:profile:team-prod', { timeoutMs: 80, holder: 'task-2' }),
    { code: 'RESOURCE_BUSY' }
  );

  // Acquire on different profile proceeds immediately
  const lock2 = await acquireSharedResourceLock('openclaw:profile:other-dev', { timeoutMs: 100, holder: 'task-3' });
  assert.ok(lock2);

  // Release lock1
  lock1.release();
  assert.equal(getSharedResourceLock('openclaw:profile:team-prod'), null);

  // Now task-2 can acquire
  const lock3 = await acquireSharedResourceLock('openclaw:profile:team-prod', { timeoutMs: 500, holder: 'task-2' });
  assert.ok(lock3);
  lock2.release();
  lock3.release();
});

test('R5 OpenClaw adapter: runOpenclaw executes detached process, returns output, and releases profile lock in finally', async t => {
  clearAllSharedResourceLocks();
  const tmpDir = makeTempDir('r5-openclaw-run-');
  t.after(() => {
    clearAllSharedResourceLocks();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  const mockScript = path.join(tmpDir, 'mock-openclaw.js');
  fs.writeFileSync(mockScript, `
    process.stdout.write(JSON.stringify({ type: 'delta', text: 'OpenClaw task completed successfully.' }) + '\\n');
    process.exit(0);
  `, 'utf8');

  const fakeLaunch = { command: process.execPath, args: [mockScript] };

  const result = await runOpenclaw(
    {
      prompt: 'Audit cluster health',
      projectDir: tmpDir,
      connection: { profile: 'cluster-a' },
      runId: 'run-oc-1',
    },
    { launch: fakeLaunch }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'OpenClaw task completed successfully.');
  // Profile lock must be released
  assert.equal(getSharedResourceLock('openclaw:profile:cluster-a'), null);
});

// ---------------------------------------------------------------------------
// 3. Hermes Native Adapter & Query File Cleanup Tests
// ---------------------------------------------------------------------------
test('R5 Hermes adapter: manages query file, profile concurrency lock, and cleans up on completion', async t => {
  clearAllSharedResourceLocks();
  const tmpDir = makeTempDir('r5-hermes-');
  t.after(() => {
    clearAllSharedResourceLocks();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  let capturedQueryFile = null;
  const mockScript = path.join(tmpDir, 'mock-hermes.js');
  fs.writeFileSync(mockScript, `
    const fs = require('node:fs');
    const args = process.argv;
    const qIdx = args.indexOf('--query-file');
    if (qIdx !== -1 && args[qIdx + 1]) {
      const qFile = args[qIdx + 1];
      const prompt = fs.readFileSync(qFile, 'utf8');
      process.stdout.write(JSON.stringify({ type: 'delta', text: 'Hermes received: ' + prompt }) + '\\n');
    }
    process.exit(0);
  `, 'utf8');

  const fakeLaunch = { command: process.execPath, args: [mockScript] };

  const result = await runHermes(
    {
      prompt: 'Execute data migration audit',
      projectDir: tmpDir,
      connection: { profile: 'analytics-prod' },
      runId: 'run-hermes-1',
    },
    { launch: fakeLaunch }
  );

  assert.equal(result.status, 'completed');
  assert.ok(result.text.includes('Hermes received: Execute data migration audit'));
  // Verify lock is released
  assert.equal(getSharedResourceLock('hermes:profile:analytics-prod'), null);
});

// ---------------------------------------------------------------------------
// 4. Registry & Capabilities Snapshots Tests
// ---------------------------------------------------------------------------
test('R5 Registry: maps native adapter kinds and generates verified capability snapshots for all 5 native clients', async t => {
  // Test resolveNativeAdapterKind
  assert.equal(resolveNativeAdapterKind({ runtimeKind: 'codex' }), 'native-codex');
  assert.equal(resolveNativeAdapterKind({ runtimeKind: 'antigravity' }), 'native-antigravity');
  assert.equal(resolveNativeAdapterKind({ runtimeKind: 'openclaw' }), 'native-openclaw');
  assert.equal(resolveNativeAdapterKind({ runtimeKind: 'hermes' }), 'native-hermes');
  assert.equal(resolveNativeAdapterKind({}, { kind: 'native-pi' }), 'native-pi');

  // Test capability snapshot for Antigravity
  const agySnapshot = await getConnectionCapabilitySnapshot({
    id: 'conn-agy-1',
    kind: 'native-antigravity',
  });
  assert.equal(agySnapshot.adapterKind, 'native-antigravity');
  assert.equal(agySnapshot.capabilities.structuredStream?.status, 'verified');
  assert.equal(agySnapshot.capabilities.completionEvent?.status, 'verified');
  assert.equal(agySnapshot.capabilities.preExecutionApproval?.status, 'verified');

  // Test capability snapshot for OpenClaw
  const ocSnapshot = await getConnectionCapabilitySnapshot({
    id: 'conn-oc-1',
    kind: 'native-openclaw',
  });
  assert.equal(ocSnapshot.adapterKind, 'native-openclaw');
  assert.equal(ocSnapshot.capabilities.sameConnectionConcurrency?.status, 'verified');

  // Test capability snapshot for Hermes
  const hermesSnapshot = await getConnectionCapabilitySnapshot({
    id: 'conn-hermes-1',
    kind: 'native-hermes',
  });
  assert.equal(hermesSnapshot.adapterKind, 'native-hermes');
  assert.equal(hermesSnapshot.capabilities.sameConnectionConcurrency?.status, 'verified');
});

// ---------------------------------------------------------------------------
// 5. Pi + Codex Cross-Client Parallel Collaboration & Worktree Isolation Test
// ---------------------------------------------------------------------------
test('R5 Cross-client parallel execution: Pi and Codex run concurrently in isolated Git worktrees with separate bindings and cancellations', async t => {
  const rootDir = makeTempDir('r5-collab-');
  t.after(() => {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch (_) {}
  });

  const projectDir = path.join(rootDir, 'main-repo');
  fs.mkdirSync(projectDir, { recursive: true });

  // Initialize git repository
  const { execSync } = require('node:child_process');
  execSync('git init', { cwd: projectDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: projectDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# Cross-Client Parallel Test\n', 'utf8');
  execSync('git add . && git commit -m "initial commit"', { cwd: projectDir, stdio: 'ignore' });

  // Start embedded server
  const { server, port } = await startServer({
    port: 0,
    userDataPath: path.join(rootDir, 'storage'),
    apiToken: 'test-token-r5',
  });
  t.after(async () => {
    try { await server.shutdown(); } catch (_) {}
  });
  t.after(() => server.close());

  const storage = server.store.storage;

  // Register real connections in nativeConfigService
  const dirPi = path.join(rootDir, 'pi-cfg');
  fs.mkdirSync(dirPi, { recursive: true });
  const { connection: connPi } = server.nativeConfigService.registerConnection({
    kind: 'native-pi',
    configDir: dirPi,
    createMember: false,
  });

  const dirCodex = path.join(rootDir, 'codex-cfg');
  fs.mkdirSync(dirCodex, { recursive: true });
  const { connection: connCodex } = server.nativeConfigService.registerConnection({
    kind: 'native-codex',
    configDir: dirCodex,
    createMember: false,
  });

  // Create native Pi Agent
  const piAgent = storage.agentDefinitions.create({
    name: 'Pi Author',
    role: 'developer',
    runtimeKind: 'pi',
    connectionId: connPi.id,
    permissions: { readFiles: true, writeFiles: true, executeCommands: false },
  });

  // Create native Codex Agent
  const codexAgent = storage.agentDefinitions.create({
    name: 'Codex Author',
    role: 'developer',
    runtimeKind: 'codex',
    connectionId: connCodex.id,
    permissions: { readFiles: true, writeFiles: true, executeCommands: true },
  });

  // Update default Channel
  server.store.updateChannel('general', {
    working_dir: projectDir,
  });

  // Verify Native Session Bindings isolation for both adapters
  const repo = storage.nativeSessionBindings;
  const bindingPi = repo.resolveOrCreate({
    channel: 'general',
    contextKey: 'batch-1:lane-1:attempt:0',
    agentId: piAgent.id,
    connectionId: connPi.id,
    adapterKind: 'native-pi',
    sessionDir: path.join(rootDir, 'worktree-1'),
  });

  const bindingCodex = repo.resolveOrCreate({
    channel: 'general',
    contextKey: 'batch-1:lane-2:attempt:0',
    agentId: codexAgent.id,
    connectionId: connCodex.id,
    adapterKind: 'native-codex',
    sessionDir: path.join(rootDir, 'worktree-2'),
  });

  assert.notEqual(bindingPi.id, bindingCodex.id, 'Bindings must be strictly isolated');
  assert.equal(bindingPi.adapterKind, 'native-pi');
  assert.equal(bindingCodex.adapterKind, 'native-codex');

  // Acquire write locks concurrently
  const lockedPi = repo.acquireWriteLock(bindingPi.id, { runId: 'run-pi-lane-1' });
  const lockedCodex = repo.acquireWriteLock(bindingCodex.id, { runId: 'run-codex-lane-2' });

  assert.equal(lockedPi.lockState, 'locked');
  assert.equal(lockedPi.activeRunId, 'run-pi-lane-1');
  assert.equal(lockedCodex.lockState, 'locked');
  assert.equal(lockedCodex.activeRunId, 'run-codex-lane-2');

  // Verify that attempting to double-acquire Pi lane with another runId is rejected (A18 concurrency safety)
  assert.throws(
    () => repo.acquireWriteLock(bindingPi.id, { runId: 'run-pi-contender' }),
    /拒绝并发写入同一会话/
  );

  // Releasing Pi lock does not affect Codex lock
  repo.releaseWriteLock(bindingPi.id, { runId: 'run-pi-lane-1' });
  assert.equal(repo.get(bindingPi.id).lockState, 'idle');
  assert.equal(repo.get(bindingCodex.id).lockState, 'locked');

  repo.releaseWriteLock(bindingCodex.id, { runId: 'run-codex-lane-2' });
  assert.equal(repo.get(bindingCodex.id).lockState, 'idle');
});
