'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { startServer } = require('../index');
const { createStorage } = require('../storage');
const { NativeConfigService } = require('./config/service');
const { stopChild } = require('./adapters/common');

function makeTempDir(prefix = '52hz-r7-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. WSL and Cross-Environment Path Validation (R7 / Section 5.2)
// ---------------------------------------------------------------------------
test('R7 WSL and Environment Boundary: rejects Windows paths for WSL, rejects WSL paths for local, and resolves WSL refs', t => {
  const root = makeTempDir('r7-wsl-');
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  const dbPath = path.join(root, 'db.sqlite');
  const storage = createStorage({ dbPath });
  t.after(() => storage.close());

  const configService = new NativeConfigService({
    userDataPath: root,
    storage,
    env: { ...process.env, PI_CODING_AGENT_DIR: root },
  });

  if (process.platform === 'win32') {
    // 1. A Windows drive path given to environment: 'wsl' MUST be rejected
    assert.throws(
      () => configService.registerConnection({
        kind: 'native-pi',
        environment: 'wsl',
        configDir: 'C:\\Users\\test\\.pi\\agent',
        createMember: false,
      }),
      /WSL 连接配置需指向 WSL 运行环境内的真实配置目录/
    );

    // 2. A bare POSIX path on Windows given to environment: 'wsl' without UNC distro prefix MUST be rejected
    assert.throws(
      () => configService.registerConnection({
        kind: 'native-pi',
        environment: 'wsl',
        configDir: '/home/user/.pi/agent',
        createMember: false,
      }),
      /WSL 环境下的 POSIX 路径需包含发行版网络路径/
    );

    // 3. A WSL UNC path given to environment: 'local' MUST be rejected
    assert.throws(
      () => configService.registerConnection({
        kind: 'native-pi',
        environment: 'local',
        configDir: '\\\\wsl$\\Ubuntu\\home\\user\\.pi\\agent',
        createMember: false,
      }),
      /本地连接配置不能使用 WSL 网络路径/
    );
  }

  // 4. WSL installationRef resolution
  const wslRef = configService.resolveInstallationRef('native-pi', null, 'wsl');
  assert.equal(wslRef, 'wsl:native-pi');

  const customWslRef = configService.resolveInstallationRef('native-pi', '/usr/local/bin/pi', 'wsl');
  assert.equal(customWslRef, '/usr/local/bin/pi');
});

// ---------------------------------------------------------------------------
// 2. Restart and Crash Recovery: Native Session Binding Locks (A18 / R7)
// ---------------------------------------------------------------------------
test('R7 Restart & Crash Recovery: orphan native session binding locks are automatically cleared on restart', async t => {
  const root = makeTempDir('r7-recover-');
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  const storageDir = path.join(root, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  // Phase 1: Start server, register native connection and agent, acquire session lock, then shut down abruptly
  let { server, port } = await startServer({
    port: 0,
    userDataPath: storageDir,
    apiToken: 'r7-token',
  });

  const piDir = path.join(root, 'pi-cfg');
  fs.mkdirSync(piDir, { recursive: true });
  const { connection } = server.nativeConfigService.registerConnection({
    kind: 'native-pi',
    configDir: piDir,
    createMember: false,
  });

  const agent = server.store.storage.agentDefinitions.create({
    name: 'Recover Agent',
    connectionId: connection.id,
    defaultMode: 'plan',
  });

  const repo = server.store.storage.nativeSessionBindings;
  const binding = repo.resolveOrCreate({
    channel: 'general',
    agentId: agent.id,
    connectionId: connection.id,
    adapterKind: 'native-pi',
  });

  // Lock binding to a simulated dead run
  const deadRunId = 'run-dead-123';
  repo.acquireWriteLock(binding.id, { runId: deadRunId, attemptId: 'att-1' });

  let locked = repo.get(binding.id);
  assert.equal(locked.lockState, 'locked');
  assert.equal(locked.activeRunId, deadRunId);

  // Shut down first server
  await server.shutdown();

  // Phase 2: Restart server (simulating app restart after unexpected crash)
  const restarted = await startServer({
    port: 0,
    userDataPath: storageDir,
    apiToken: 'r7-token',
  });
  t.after(async () => {
    try { await restarted.server.shutdown(); } catch (_) {}
  });

  // Verify that upon startup, AgentRunner ran releaseAllActiveLocks() and the lock is idle
  const restartedRepo = restarted.server.store.storage.nativeSessionBindings;
  const recoveredBinding = restartedRepo.get(binding.id);
  assert.equal(recoveredBinding.lockState, 'idle');
  assert.equal(recoveredBinding.activeRunId, null);

  // New run can immediately acquire the write lock without being blocked
  const newRunId = 'run-live-456';
  restartedRepo.acquireWriteLock(binding.id, { runId: newRunId, attemptId: 'att-2' });
  const reacquired = restartedRepo.get(binding.id);
  assert.equal(reacquired.lockState, 'locked');
  assert.equal(reacquired.activeRunId, newRunId);
  restartedRepo.releaseWriteLock(binding.id, { runId: newRunId });
});

// ---------------------------------------------------------------------------
// 3. Restart & Invalidation for Human Interactions (A08-A11 / R7)
// ---------------------------------------------------------------------------
test('R7 Human Interactions: in-flight questions from dead owner PIDs are invalidated on restart', t => {
  const root = makeTempDir('r7-interactions-');
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  const dbPath = path.join(root, 'db.sqlite');
  const storage = createStorage({ dbPath });
  t.after(() => storage.close());

  // Create human interaction
  const interaction = storage.humanInteractions.create({
    runId: 'run-r7-1',
    attemptId: 'att-1',
    channel: 'general',
    agentId: 'pi',
    agentName: 'Pi',
    nativeRequestId: 'req-1',
    kind: 'question',
    prompt: 'Should we proceed?',
    timeoutMs: 60000,
    questions: [{ id: 'target', title: '选择目标', allowFreeInput: true }],
  });

  assert.equal(interaction.state, 'waiting');

  // Simulate dead process by updating owner_pid to a dead PID
  storage.db.prepare('UPDATE human_interactions SET owner_pid = 99999999 WHERE id = ?').run(interaction.id);

  // Trigger recover on HumanInteractions service
  const { HumanInteractions } = require('./human-interactions');
  const service = new HumanInteractions(storage);
  service.recover();

  const recovered = storage.humanInteractions.get(interaction.id);
  assert.equal(recovered.state, 'invalidated');
  assert.match(recovered.receipt, /原执行进程已退出或系统已恢复/);
});

// ---------------------------------------------------------------------------
// 4. Native File Writing, Disk Failure, and CAS Conflict Feedback (A03, A14 / R7)
// ---------------------------------------------------------------------------
test('R7 Config CAS Conflict & Symlink Protection: rejects external modification and symlink targets', async t => {
  const root = makeTempDir('r7-cfg-');
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  const dbPath = path.join(root, 'db.sqlite');
  const storage = createStorage({ dbPath });
  t.after(() => storage.close());

  const piDir = path.join(root, 'pi-agent');
  fs.mkdirSync(piDir, { recursive: true });
  const settingsFile = path.join(piDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultModel: 'model-a' }, null, 2), 'utf8');

  const configService = new NativeConfigService({
    userDataPath: root,
    storage,
    env: { ...process.env, PI_CODING_AGENT_DIR: piDir },
  });
  await configService.init();

  const { connection } = configService.registerConnection({
    kind: 'native-pi',
    configDir: piDir,
    createMember: false,
  });

  // 1. Preview modification via prepareConfigChange
  const preview = configService.prepareConfigChange(connection.id, {
    patch: { settings: { defaultModel: 'model-b' } },
  });
  assert.ok(preview);
  assert.ok(preview.files.length > 0);

  // 2. Simulate concurrent external modification before apply
  const staleExpectedVersions = preview.currentVersions;
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultModel: 'model-external' }, null, 2), 'utf8');

  // Applying with outdated sha must fail with CONFIG_CONFLICT (409)
  assert.throws(
    () => configService.applyConfigChange(connection.id, {
      patch: { settings: { defaultModel: 'model-b' } },
      expectedVersions: staleExpectedVersions,
    }),
    err => {
      assert.equal(err.code, 'CONFIG_CONFLICT');
      assert.equal(err.status, 409);
      assert.match(err.message, /已在外部被修改/);
      return true;
    }
  );

  // 3. Symlink directory rejection on registerConnection
  const symlinkTarget = path.join(root, 'sym-target');
  const symlinkDir = path.join(root, 'sym-link');
  fs.mkdirSync(symlinkTarget, { recursive: true });
  try {
    fs.symlinkSync(symlinkTarget, symlinkDir, 'junction');
    assert.throws(
      () => configService.registerConnection({
        kind: 'native-pi',
        configDir: symlinkDir,
        createMember: false,
      }),
      /符号链接或重解析点/
    );
  } catch (err) {
    if (err.code !== 'EPERM') throw err; // Symlink creation may require admin on some Windows versions
  }
});

// ---------------------------------------------------------------------------
// 5. Desktop Lifecycle: Clean Stop & Process Tree Termination (A21 / R7)
// ---------------------------------------------------------------------------
test('R7 Desktop Lifecycle: stopChild terminates active process tree cleanly without orphans', async t => {
  // Spawn a long-running child process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    windowsHide: true,
  });

  assert.ok(child.pid);
  assert.equal(child.killed, false);

  // Terminate with stopChild
  await stopChild(child);

  // Verify process has exited
  let isAlive = true;
  try {
    process.kill(child.pid, 0);
  } catch (err) {
    isAlive = (err.code !== 'ESRCH');
  }
  assert.equal(isAlive, false, 'Child process must be dead after stopChild');
});
