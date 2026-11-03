'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { DatabaseManager } = require('../storage/database');
const { NativeSessionBindingsRepository } = require('../storage/repositories/native-session-bindings');
const { AgentConnectionsRepository } = require('../storage/repositories/agent-connections');
const {
  NativeConfigService,
  createMockSafeStorage,
  restrictFilePermissions,
  withVaultInitLock,
  withVaultInitLockSync,
  writeProtectedVaultFileExclusive,
  isProcessAlive,
} = require('./config/service');
const { listCodexResources } = require('./config/codex');
const { listPiResources } = require('./config/pi');
const { runNativePi } = require('./adapters/pi-native');
const { startServer } = require('../index');

function setupTestDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `r2-fixes-${prefix}-`));
  const piDir = path.join(root, 'pi-agent');
  const codexDir = path.join(root, 'codex-home');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(piDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const dbPath = path.join(root, 'database.sqlite');
  const dbManager = new DatabaseManager(dbPath);
  const safeStorage = createMockSafeStorage();

  return {
    root,
    piDir,
    codexDir,
    projectDir,
    dbManager,
    safeStorage,
    cleanup: () => {
      try {
        dbManager.close();
      } catch {}
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// 1. P0: Pi 命令未经过执行前审批时能力受限，拒绝回调不被绕过
// ---------------------------------------------------------------------------
test('R2 Fix P0: Pi executeCommands requires pre-execution approval bridge; without bridge bash is restricted, and approval denial halts execution', async t => {
  const fx = setupTestDir('p0-approval');
  t.after(fx.cleanup);

  // Fake Pi script that attempts to run bash tool
  const scriptPath = path.join(fx.root, 'fake-pi-approval.js');
  fs.writeFileSync(
    scriptPath,
    `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

    rl.on('line', line => {
      if (!line.trim()) return;
      const cmd = JSON.parse(line);
      if (cmd.type === 'get_state') {
        return send({
          id: cmd.id, type: 'response', command: 'get_state', success: true,
          data: { model: { id: 'test-model', provider: 'google' }, sessionId: 'sess-1' }
        });
      }
      if (cmd.type === 'prompt') {
        send({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        send({ type: 'agent_start' });
        // Emit a tool_execution_start for bash
        send({
          type: 'tool_execution_start',
          toolCallId: 'call_bash_1',
          toolName: 'bash',
          args: { command: 'echo attack' }
        });
      }
    });
    `,
    'utf8'
  );

  const fakeLaunch = {
    command: process.execPath,
    args: [scriptPath],
    env: {},
    path: scriptPath,
  };

  let approvalInvoked = 0;
  await assert.rejects(
    () =>
      runNativePi(
        {
          projectDir: fx.projectDir,
          config: { mode: 'agent' },
          agentPolicy: { permissions: { readFiles: true, executeCommands: true, writeFiles: true } },
          prompt: 'Do something',
          onApproval: async request => {
            approvalInvoked++;
            if (request.tool === 'bash') return false; // Explicitly decline
            return true;
          },
        },
        { launch: fakeLaunch }
      ),
    err => {
      assert.equal(err.code, 'COMMAND_DECLINED');
      return true;
    }
  );

  assert.equal(approvalInvoked, 1, 'Approval callback must be invoked before command is allowed');
});

// ---------------------------------------------------------------------------
// 2. P1: 能力查询接口返回 200 而不再报 500
// ---------------------------------------------------------------------------
test('R2 Fix P1: GET /v1/agent-connections/:id/capabilities returns 200 without runtimeEnv error', async t => {
  const fx = setupTestDir('p1-capabilities');
  t.after(fx.cleanup);

  const port = 59100 + Math.floor(Math.random() * 500);
  const { server, port: actualPort } = await startServer({
    port,
    userDataPath: fx.root,
    apiToken: 'test-token',
  });
  t.after(async () => {
    try { await server.shutdown(); } catch {}
  });

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Local',
    configDir: fx.piDir,
    createMember: false,
  });

  const res = await new Promise((resolve, reject) => {
    http.get(
      `http://127.0.0.1:${actualPort}/v1/agent-connections/${conn.id}/capabilities`,
      { headers: { Authorization: 'Bearer test-token' } },
      resp => {
        let body = '';
        resp.on('data', d => (body += d));
        resp.on('end', () => resolve({ status: resp.statusCode, json: JSON.parse(body) }));
      }
    ).on('error', reject);
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.connectionId, conn.id);
  assert.equal(res.json.kind, 'native-pi');
  assert.ok(res.json.capabilitySnapshot);
  assert.ok(res.json.capabilitySnapshot.capabilities);
});

// ---------------------------------------------------------------------------
// 3. P1: 会话累计用量不污染本次用量
// ---------------------------------------------------------------------------
test('R2 Fix P1: Resuming session reports only turn delta/message usage, not 1000 tokens cumulative total', async t => {
  const fx = setupTestDir('p1-usage');
  t.after(fx.cleanup);

  // Fake Pi script that reports 1000 tokens cumulative in get_session_stats,
  // but only 15 tokens in the assistant message.
  const scriptPath = path.join(fx.root, 'fake-pi-usage.js');
  fs.writeFileSync(
    scriptPath,
    `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

    rl.on('line', line => {
      if (!line.trim()) return;
      const cmd = JSON.parse(line);
      if (cmd.type === 'get_state') {
        return send({
          id: cmd.id, type: 'response', command: 'get_state', success: true,
          data: { model: { id: 'test-model', provider: 'google' }, sessionId: 'sess-history' }
        });
      }
      if (cmd.type === 'get_session_stats') {
        // Return 1000 tokens historical total
        return send({
          id: cmd.id, type: 'response', command: 'get_session_stats', success: true,
          data: {
            tokens: { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000 },
            cost: 0.15,
            contextUsage: { contextWindow: 128000 }
          }
        });
      }
      if (cmd.type === 'prompt') {
        send({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        send({ type: 'agent_start' });
        const msg = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Turn reply' }],
          stopReason: 'stop',
          usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.0003 } }
        };
        send({ type: 'message_end', message: msg });
        send({ type: 'agent_end', messages: [msg] });
      }
    });
    `,
    'utf8'
  );

  const fakeLaunch = {
    command: process.execPath,
    args: [scriptPath],
    env: {},
    path: scriptPath,
  };

  const res = await runNativePi(
    {
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { permissions: { readFiles: true } },
      prompt: 'Next turn in existing session',
    },
    { launch: fakeLaunch }
  );

  // Must report 15 tokens, NOT 1000 tokens!
  assert.equal(res.usage.total_tokens, 15, 'Turn usage must record 15 tokens, not cumulative 1000 tokens');
  assert.equal(res.estimatedCost, 0.0003, 'Turn cost must record 0.0003, not cumulative 0.15');
});

// ---------------------------------------------------------------------------
// 4. P1: 会话锁恢复与 broken 状态持久化
// ---------------------------------------------------------------------------
test('R2 Fix P1: Native session mismatch commits broken lock_state without rollback, and releaseAllActiveLocks preserves broken', async t => {
  const fx = setupTestDir('p1-lock-recovery');
  t.after(fx.cleanup);

  const repo = new NativeSessionBindingsRepository(fx.dbManager);
  const binding = repo.resolveOrCreate({
    channel: 'channel-test',
    agentId: 'agent-1',
    connectionId: 'conn-1',
    adapterKind: 'native-pi',
  });

  // Lock and set initial sessionId
  repo.acquireWriteLock(binding.id, { runId: 'run-init' });
  repo.recordSessionHandshake(binding.id, { runId: 'run-init', nativeSessionId: 'sess-original' });
  repo.releaseWriteLock(binding.id, { runId: 'run-init', nextState: 'idle' });

  // Attempt handshake with mismatch session ID
  repo.acquireWriteLock(binding.id, { runId: 'run-second' });
  assert.throws(
    () => repo.recordSessionHandshake(binding.id, { runId: 'run-second', nativeSessionId: 'sess-imposter' }),
    err => {
      assert.equal(err.code, 'NATIVE_SESSION_MISMATCH');
      return true;
    }
  );

  // Verify broken state is persisted in DB despite the exception
  const checked1 = repo.get(binding.id);
  assert.equal(checked1.lockState, 'broken', 'Broken state must survive transaction rollback');

  // Verify releaseWriteLock does not revert broken to idle
  repo.releaseWriteLock(binding.id, { runId: 'run-second', nextState: 'idle' });
  const checked2 = repo.get(binding.id);
  assert.equal(checked2.lockState, 'broken', 'releaseWriteLock must not reset broken state to idle');

  // Create another locked binding simulating a crashed process
  const binding2 = repo.resolveOrCreate({
    channel: 'channel-crashed',
    agentId: 'agent-2',
    connectionId: 'conn-1',
    adapterKind: 'native-pi',
  });
  repo.acquireWriteLock(binding2.id, { runId: 'run-crashed' });

  // Run startup lock recovery
  repo.releaseAllActiveLocks();
  const checkedCrashed = repo.get(binding2.id);
  assert.equal(checkedCrashed.lockState, 'idle', 'Orphaned locked state must be recovered to idle');

  // Verify broken binding was NOT recovered to idle
  const checkedBrokenStill = repo.get(binding.id);
  assert.equal(checkedBrokenStill.lockState, 'broken', 'Broken state must never be recovered to idle on restart');
});

// ---------------------------------------------------------------------------
// 5. P1: 配置写入前检查阻止覆盖外部并发修改
// ---------------------------------------------------------------------------
test('R2 Fix P1: Write-phase CAS check halts save when external edit occurs before write', async t => {
  const fx = setupTestDir('p1-cas-check');
  t.after(fx.cleanup);

  const settingsPath = path.join(fx.piDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-pro' }, null, 2), 'utf8');

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi CAS',
    configDir: fx.piDir,
    createMember: false,
  });

  const prepared = svc.prepareConfigChange(conn.id, {
    patch: { settings: { defaultModel: 'gemini-2.0-flash' } },
  });

  // Concurrent external edit: user modifies settings.json externally with a new field before apply
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-pro', externalField: 'keep-me' }, null, 2),
    'utf8'
  );

  // Apply should fail with CONFIG_CONFLICT
  assert.throws(
    () => svc.applyConfigChange(conn.id, { patch: { settings: { defaultModel: 'gemini-2.0-flash' } }, expectedVersions: prepared.currentVersions }),
    err => {
      assert.equal(err.code, 'CONFIG_CONFLICT');
      return true;
    }
  );

  // Verify external field was NOT overwritten
  const diskContent = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(diskContent.externalField, 'keep-me', 'External edit must be preserved');
});

// ---------------------------------------------------------------------------
// 6. P1: 配置备份不复制明文凭据（受保护密文备份）
// ---------------------------------------------------------------------------
test('R2 Fix P1: Config backup encrypts synthetic credentials and rollback decrypts cleanly', async t => {
  const fx = setupTestDir('p1-protected-backup');
  t.after(fx.cleanup);

  const modelsPath = path.join(fx.piDir, 'models.json');
  const secretToken = 'super-secret-auth-token-999';
  fs.writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        custom_ai: {
          name: 'Custom AI',
          apiKey: secretToken,
          models: [{ id: 'custom-model-1', name: 'Custom Model 1' }]
        }
      }
    }, null, 2),
    'utf8'
  );

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Backup',
    configDir: fx.piDir,
    createMember: false,
  });

  const prepared = svc.prepareConfigChange(conn.id, {
    patch: {
      models: {
        providers: {
          custom_ai: {
            models: [{ id: 'custom-model-1', name: 'Custom Model 1 Modified' }]
          }
        }
      }
    }
  });

  const applied = svc.applyConfigChange(conn.id, {
    patch: {
      models: {
        providers: {
          custom_ai: {
            models: [{ id: 'custom-model-1', name: 'Custom Model 1 Modified' }]
          }
        }
      }
    },
    expectedVersions: prepared.currentVersions
  });

  // Verify the .bak file does NOT contain the plaintext secret!
  const backupRef = applied.change.files[0].backupRef;
  assert.ok(fs.existsSync(backupRef));
  const rawBakBytes = fs.readFileSync(backupRef);
  assert.equal(rawBakBytes.includes(secretToken), false, 'Protected backup must NOT leak plaintext secrets');

  // Rollback should decrypt and restore cleanly
  const rolledBack = svc.rollbackConfigChange(conn.id, { changeId: applied.change.id });
  assert.equal(rolledBack.restoredStatus, 'rolled_back');

  const restoredJson = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.equal(restoredJson.providers.custom_ai.apiKey, secretToken, 'Rollback must decrypt and restore secret');
  assert.equal(restoredJson.providers.custom_ai.models[0].name, 'Custom Model 1');
});

// ---------------------------------------------------------------------------
// 7. P1: 父目录重解析点保护不可绕过
// ---------------------------------------------------------------------------
test('R2 Fix P1: Parent directory junction/symlink reparse is rejected against trusted registration base', async t => {
  const fx = setupTestDir('p1-reparse');
  t.after(fx.cleanup);

  const trustedDir = path.join(fx.root, 'trusted-config');
  fs.mkdirSync(trustedDir, { recursive: true });
  const targetFile = path.join(trustedDir, 'settings.json');
  fs.writeFileSync(targetFile, JSON.stringify({ defaultProvider: 'google' }), 'utf8');

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Reparse',
    configDir: trustedDir,
    createMember: false,
  });

  // Create an external folder and simulate a junction/symlink replacement of the parent dir
  const externalDir = path.join(fx.root, 'escaped-dir');
  fs.mkdirSync(externalDir, { recursive: true });
  const maliciousFile = path.join(externalDir, 'settings.json');
  fs.writeFileSync(maliciousFile, JSON.stringify({ defaultProvider: 'malicious' }), 'utf8');

  // Replace trustedDir with symlink or junction
  fs.rmSync(trustedDir, { recursive: true, force: true });
  try {
    fs.symlinkSync(externalDir, trustedDir, 'junction');
  } catch {
    // If junction not permitted, use dir symlink
    fs.symlinkSync(externalDir, trustedDir, 'dir');
  }

  // inspectConfig must reject with CONFIG_SYMLINK_REJECTED
  assert.throws(
    () => svc.inspectConfig(conn.id),
    err => {
      assert.equal(err.code, 'CONFIG_SYMLINK_REJECTED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 8. P1: 资源列表明确区分可靠性级别（verified, cached, configured, declared）
// ---------------------------------------------------------------------------
test('R2 Fix P1: Resource lists classify models by verification status (cached, declared, configured)', async t => {
  const fx = setupTestDir('p1-resource-status');
  t.after(fx.cleanup);

  // 1. Codex resources distinction
  const cachePath = path.join(fx.codexDir, 'models_cache.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      models: [{ slug: 'o3-mini', display_name: 'o3 Mini', default_reasoning_level: 'medium' }]
    }),
    'utf8'
  );
  const codexSnapshots = new Map([
    ['codex.config', { exists: true, rawText: 'model = "gpt-4o"\n', canonicalPath: path.join(fx.codexDir, 'config.toml') }],
    ['codex.auth', { exists: true, rawText: '{}', canonicalPath: path.join(fx.codexDir, 'auth.json') }]
  ]);

  const codexRes = listCodexResources(codexSnapshots, { configDir: fx.codexDir, env: {} });
  assert.ok(codexRes.cachedModels.some(m => m.id === 'o3-mini' && m.verificationStatus === 'cached'));
  assert.ok(codexRes.declaredModels.some(m => m.verificationStatus === 'declared'));

  // 2. Pi resources distinction
  const piSnapshots = new Map([
    ['pi.settings', { exists: true, rawText: '{"defaultProvider":"google","defaultModel":"gemini-1.5-pro"}', canonicalPath: path.join(fx.piDir, 'settings.json') }],
    [
      'pi.models',
      {
        exists: true,
        rawText: JSON.stringify({
          providers: {
            my_prov: {
              name: 'My Provider',
              models: [{ id: 'my-custom-model', name: 'My Custom' }]
            }
          }
        }),
        canonicalPath: path.join(fx.piDir, 'models.json')
      }
    ]
  ]);

  const piRes = listPiResources(piSnapshots, { env: {} });
  assert.ok(piRes.configuredModels.some(m => m.id === 'my-custom-model' && m.verificationStatus === 'configured'));
  assert.ok(piRes.declaredModels.some(m => m.verificationStatus === 'declared'));
});


// ---------------------------------------------------------------------------
// 9. P0: 初始化存储不清除正在运行的活跃会话锁
// ---------------------------------------------------------------------------
test('R2 Fix P0: Opening second Storage does NOT clear active lock of running turn', async t => {
  const fx = setupTestDir('p0-second-storage');
  t.after(fx.cleanup);

  const { Store } = require('../store');
  const store1 = new Store(fx.root);

  // Create an active session and run with status 'running'
  store1.storage.sessions.create({
    id: 'channel-active',
    title: 'Active Channel',
    mode: 'agent',
    status: 'active',
  });
  store1.storage.runs.create({
    id: 'run-active-1',
    sessionId: 'channel-active',
    agentName: 'pi-member',
    mode: 'agent',
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  const repo1 = store1.storage.nativeSessionBindings;
  const binding = repo1.resolveOrCreate({
    channel: 'channel-active',
    agentId: 'agent-1',
    connectionId: 'conn-1',
    adapterKind: 'native-pi',
  });
  repo1.acquireWriteLock(binding.id, { runId: 'run-active-1' });

  // Verify it is currently locked
  assert.equal(repo1.get(binding.id).lockState, 'locked');

  // Open a second Storage instance (e.g. reconnect or second worker)
  const store2 = new Store(fx.root);
  t.after(() => {
    try { store1.close(); } catch {}
    try { store2.close(); } catch {}
  });
  const repo2 = store2.storage.nativeSessionBindings;

  // Verify the lock was NOT cleared to idle
  const checked = repo2.get(binding.id);
  assert.equal(checked.lockState, 'locked', 'Second storage must NOT clear lock of running run');

  // A second writer must be rejected with NATIVE_SESSION_BUSY
  assert.throws(
    () => repo2.acquireWriteLock(binding.id, { runId: 'run-intruder' }),
    err => {
      assert.equal(err.code, 'NATIVE_SESSION_BUSY');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 10. P1: 备份加密密钥是真随机秘密，仅凭目录路径无法解密
// ---------------------------------------------------------------------------
test('R2 Fix P1: Backup key is truly random secret; path-derived key cannot decrypt backup', async t => {
  const fx = setupTestDir('p1-random-key');
  t.after(fx.cleanup);

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const realKey = svc.backupCipherKey;
  assert.equal(realKey.length, 32);

  // Path-derived deterministic key (the insecure pattern)
  const crypto = require('node:crypto');
  const pathDerivedKey = crypto.createHash('sha256').update(String(fx.root) + ':52hz-native-backup-protection:v1').digest();

  // The true key must NOT match path-derived key
  assert.notDeepEqual(realKey, pathDerivedKey, 'Backup key must be randomly generated, not derived from path');

  // Encrypt with real key
  const secretData = Buffer.from('{"secret":"super-token-123"}');
  const { encryptProtectedBackup, decryptProtectedBackup } = require('./config/service');
  // Read helpers through service or file
  const modelsPath = path.join(fx.piDir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { my_p: { apiKey: 'my-secret-key' } } }), 'utf8');

  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Key Test',
    configDir: fx.piDir,
    createMember: false,
  });

  const prep = svc.prepareConfigChange(conn.id, { patch: { models: { providers: { my_p: { models: [] } } } } });
  const applied = svc.applyConfigChange(conn.id, {
    patch: { models: { providers: { my_p: { models: [] } } } },
    expectedVersions: prep.currentVersions,
  });

  const bakPath = applied.change.files[0].backupRef;
  const bakCipher = fs.readFileSync(bakPath);

  // Attempt to decrypt with insecure path-derived key must fail (throw or mismatch)
  let pathDecryptionFailed = false;
  try {
    const magic = Buffer.from('52HZ_PROTECTED_BAK_V1:');
    const iv = bakCipher.subarray(magic.length, magic.length + 12);
    const tag = bakCipher.subarray(magic.length + 12, magic.length + 28);
    const enc = bakCipher.subarray(magic.length + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', pathDerivedKey, iv);
    decipher.setAuthTag(tag);
    decipher.update(enc);
    decipher.final();
  } catch {
    pathDecryptionFailed = true;
  }
  assert.equal(pathDecryptionFailed, true, 'Decrypting with path-derived key must fail');
});

// ---------------------------------------------------------------------------
// 11. P1: 原子 CAS 替换在 before-file-write 插入修改时依然被拦截
// ---------------------------------------------------------------------------
test('R2 Fix P1: CAS check at renameSync boundary halts overwrite when edit is inserted during before-file-write', async t => {
  const fx = setupTestDir('p1-cas-at-write');
  t.after(fx.cleanup);

  const settingsPath = path.join(fx.piDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-pro' }), 'utf8');

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Atomic CAS',
    configDir: fx.piDir,
    createMember: false,
  });

  const prep = svc.prepareConfigChange(conn.id, { patch: { settings: { defaultModel: 'gemini-2.0-flash' } } });

  // In before-file-write faultInjector, insert concurrent modification to settings.json
  assert.throws(
    () =>
      svc.applyConfigChange(conn.id, {
        patch: { settings: { defaultModel: 'gemini-2.0-flash' } },
        expectedVersions: prep.currentVersions,
        faultInjector: ({ step }) => {
          if (step === 'before-file-write') {
            fs.writeFileSync(
              settingsPath,
              JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-pro', injectedField: 'survive' }),
              'utf8'
            );
          }
        },
      }),
    err => {
      assert.equal(err.code, 'CONFIG_CONFLICT');
      return true;
    }
  );

  // Verify injectedField survived and was NOT overwritten
  const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(disk.injectedField, 'survive', 'Injected modification at before-file-write must survive');

  // Verify connection is NOT isolated in a broken unretryable state (Fix for P1)
  assert.equal(svc.repo.hasBrokenChangeState(conn.id), null, 'CAS conflict must NOT leave connection in broken state');
});

// ---------------------------------------------------------------------------
// 12. P1: 可信根上方的祖先目录被替换为 junction 依然被拦截
// ---------------------------------------------------------------------------
test('R2 Fix P1: Junction replacement of trusted base parent dir is caught and rejected', async t => {
  const fx = setupTestDir('p1-ancestor-junction');
  t.after(fx.cleanup);

  const parentDir = path.join(fx.root, 'sub-level');
  const trustedDir = path.join(parentDir, 'trusted-pi');
  fs.mkdirSync(trustedDir, { recursive: true });
  const settingsFile = path.join(trustedDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'google' }), 'utf8');

  const svc = new NativeConfigService({ storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Ancestor Test',
    configDir: trustedDir,
    createMember: false,
  });

  // Verify initial inspection works
  const inspect1 = svc.inspectConfig(conn.id);
  assert.ok(inspect1);

  // Now replace the parentDir with a junction to another folder
  const attackerDir = path.join(fx.root, 'attacker-controlled');
  fs.mkdirSync(path.join(attackerDir, 'trusted-pi'), { recursive: true });
  fs.writeFileSync(path.join(attackerDir, 'trusted-pi', 'settings.json'), JSON.stringify({ defaultProvider: 'hacked' }), 'utf8');

  fs.rmSync(parentDir, { recursive: true, force: true });
  try {
    fs.symlinkSync(attackerDir, parentDir, 'junction');
  } catch {
    fs.symlinkSync(attackerDir, parentDir, 'dir');
  }

  // inspectConfig must catch the ancestor junction and throw CONFIG_SYMLINK_REJECTED
  assert.throws(
    () => svc.inspectConfig(conn.id),
    err => {
      assert.equal(err.code, 'CONFIG_SYMLINK_REJECTED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 13. P1: 用量降级路径在初始统计失败且无消息 usage 时保持未知（不冒充 1000 tokens）
// ---------------------------------------------------------------------------
test('R2 Fix P1: Missing initial stats baseline with no assistant usage preserves unknown (does not charge 1000 tokens)', async t => {
  const fx = setupTestDir('p1-usage-fallback');
  t.after(fx.cleanup);

  // Fake Pi script where:
  // 1. Initial get_session_stats fails (returns error response)
  // 2. Assistant message has NO usage field
  // 3. Final get_session_stats reports 1000 cumulative tokens
  const scriptPath = path.join(fx.root, 'fake-pi-no-stats.js');
  fs.writeFileSync(
    scriptPath,
    `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

    let promptCount = 0;
    rl.on('line', line => {
      if (!line.trim()) return;
      const cmd = JSON.parse(line);
      if (cmd.type === 'get_state') {
        return send({
          id: cmd.id, type: 'response', command: 'get_state', success: true,
          data: { model: { id: 'test-model', provider: 'google' }, sessionId: 'sess-fallback' }
        });
      }
      if (cmd.type === 'get_session_stats') {
        if (promptCount === 0) {
          // Initial baseline fails!
          return send({ id: cmd.id, type: 'response', command: 'get_session_stats', success: false, error: 'Stats unavailable yet' });
        }
        // Final stats returns 1000 tokens / $2.5 cumulative
        return send({
          id: cmd.id, type: 'response', command: 'get_session_stats', success: true,
          data: {
            tokens: { input: 800, output: 200, total: 1000 },
            cost: 2.5
          }
        });
      }
      if (cmd.type === 'prompt') {
        promptCount++;
        send({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        send({ type: 'agent_start' });
        const msg = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reply without usage' }],
          stopReason: 'stop'
          // Notice: NO msg.usage!
        };
        send({ type: 'message_end', message: msg });
        send({ type: 'agent_end', messages: [msg] });
      }
    });
    `,
    'utf8'
  );

  const fakeLaunch = {
    command: process.execPath,
    args: [scriptPath],
    env: {},
    path: scriptPath,
  };

  const res = await runNativePi(
    {
      projectDir: fx.projectDir,
      config: { mode: 'plan' },
      agentPolicy: { permissions: { readFiles: true } },
      prompt: 'Test fallback',
    },
    { launch: fakeLaunch }
  );

  // MUST remain unknown, NEVER report 1000 tokens!
  assert.equal(res.usage, null, 'Usage must remain null (unknown), never 1000 tokens cumulative');
  assert.equal(res.costKnown, false, 'Cost must NOT be marked known');
  assert.equal(res.estimatedCost, null, 'Estimated cost must remain null');
});

// ---------------------------------------------------------------------------
// 14. P1: Electron safeStorage 保护备份保护密钥，磁盘不落明文
// ---------------------------------------------------------------------------
test('R2 Fix P1: Electron safeStorage encrypts backup protection key and prevents plaintext disk leak', async t => {
  const fx = setupTestDir('p1-safestorage-key');
  t.after(fx.cleanup);

  // Mock Electron safeStorage
  const mockSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: plain => {
      return Buffer.from('DPAPI_MOCK:' + Buffer.from(plain).toString('hex'));
    },
    decryptString: cipher => {
      const str = cipher.toString('utf8');
      if (!str.startsWith('DPAPI_MOCK:')) throw new Error('Decryption failed');
      const hex = str.slice('DPAPI_MOCK:'.length);
      return Buffer.from(hex, 'hex').toString('utf8');
    },
  };

  const svc = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: mockSafeStorage,
  });

  const key = svc.backupCipherKey;
  assert.equal(key.length, 32);

  // Read .vault/backup_protection.key from disk directly
  const keyFile = path.join(fx.root, '.vault', 'backup_protection.key');
  assert.ok(fs.existsSync(keyFile));
  const rawDisk = fs.readFileSync(keyFile);

  // Verify the disk content starts with SAFE_STORAGE_V1:
  assert.ok(rawDisk.toString('utf8').startsWith('SAFE_STORAGE_V1:'));
  // Verify disk content does NOT contain raw 32 bytes directly
  assert.equal(rawDisk.includes(key), false, 'Raw disk must not contain unencrypted 32-byte key');

  // Verify second instance with same safeStorage decrypts cleanly
  delete svc._cachedBackupCipherKey;
  const reloadedKey = svc.backupCipherKey;
  assert.deepEqual(reloadedKey, key);

  // An attacker without safeStorage cannot decrypt it
  const svcNoSafe = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: null,
  });
  assert.throws(
    () => svcNoSafe.backupCipherKey,
    err => {
      assert.equal(err.code, 'SAFE_STORAGE_UNAVAILABLE');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 15. P1: 损坏或异常的密钥文件绝不被静默替换，保留原文件并明确报错
// ---------------------------------------------------------------------------
test('R2 Fix P1: Corrupted backup key file is NOT overwritten, preserves original file and throws error', async t => {
  const fx = setupTestDir('p1-corrupted-key');
  t.after(fx.cleanup);

  const vaultDir = path.join(fx.root, '.vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const keyFile = path.join(vaultDir, 'backup_protection.key');
  const corruptedContent = Buffer.from('DAMAGED_CORRUPTED_KEY_DATA_DO_NOT_ERASE');
  fs.writeFileSync(keyFile, corruptedContent);

  const svc = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
  });

  // Attempting to access backupCipherKey must throw BACKUP_KEY_CORRUPTED
  assert.throws(
    () => svc.backupCipherKey,
    err => {
      assert.equal(err.code, 'BACKUP_KEY_CORRUPTED');
      return true;
    }
  );

  // CRITICAL: The corrupted file MUST NOT be overwritten or replaced with a new random key!
  const diskContentAfter = fs.readFileSync(keyFile);
  assert.deepEqual(diskContentAfter, corruptedContent, 'Corrupted key file must be preserved and not overwritten');
});

// ---------------------------------------------------------------------------
// 16. P1: 前置检查及备份期间外部修改纳入统一异常处理，解除连接卡死
// ---------------------------------------------------------------------------
test('R2 Fix P1: Modification before write loop enters unified conflict handler, avoids broken isolation and rolls back cleanly', async t => {
  const fx = setupTestDir('p1-unified-cas');
  t.after(fx.cleanup);

  const settingsPath = path.join(fx.piDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-pro' }), 'utf8');

  const repo = new AgentConnectionsRepository(fx.dbManager);
  const svc = new NativeConfigService({ storage: { agentConnections: repo }, userDataPath: fx.root, safeStorage: fx.safeStorage });
  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi CAS Unified',
    configDir: fx.piDir,
    createMember: false,
  });

  const prep = svc.prepareConfigChange(conn.id, { patch: { settings: { defaultModel: 'gemini-2.0-flash' } } });

  // Simulate an external edit occurring DURING BACKUP (before the pre-write CAS check):
  let thrownError = null;
  try {
    svc.applyConfigChange(conn.id, {
      patch: { settings: { defaultModel: 'gemini-2.0-flash' } },
      expectedVersions: prep.currentVersions,
      faultInjector: ({ step }) => {
        if (step === 'during-backup') {
          fs.writeFileSync(
            settingsPath,
            JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-pro', externalEdit: 'concurrent' }),
            'utf8'
          );
        }
      },
    });
  } catch (err) {
    thrownError = err;
  }
  assert.ok(thrownError);
  assert.equal(thrownError.code, 'CONFIG_CONFLICT');

  // Verify latest change state in DB is apply_failed with saveStatus: conflict
  const changes = repo.listChanges(conn.id, { limit: 1 });
  assert.equal(changes.length, 1);
  const lastChange = changes[0];
  assert.equal(lastChange.state, 'apply_failed');
  assert.equal(lastChange.applyResult?.saveStatus, 'conflict');
  assert.equal(lastChange.applyResult?.retryable, true);

  // Verify connection is NOT isolated in a broken state
  assert.equal(repo.hasBrokenChangeState(conn.id), null, 'Connection must not be isolated after CAS conflict');

  // Verify rollback on this change succeeds cleanly (does not throw CHANGE_NOT_ROLLBACKABLE)
  const rollbackRes = svc.rollbackConfigChange(conn.id, { changeId: lastChange.id });
  assert.equal(rollbackRes.restoredStatus, 'rolled_back');

  // Verify external modification was preserved on disk
  const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(disk.externalEdit, 'concurrent', 'External modification must be intact');
});

// ---------------------------------------------------------------------------
// 17. P1: 桌面子进程 safeStorageBridge 异步 IPC 加密与解密完整交互及密钥保护
// ---------------------------------------------------------------------------
test('R2 Fix P1: Daemon safeStorageBridge async encrypt/decrypt IPC works without BACKUP_KEY_SAVE_FAILED', async t => {
  const fx = setupTestDir('p1-bridge-ipc');
  t.after(fx.cleanup);

  // Exact shape of safeStorageBridge in daemon.js
  const mockBridge = {
    isBridge: true,
    isEncryptionAvailable: () => true,
    encryptString: async (plain) => {
      await new Promise(r => setTimeout(r, 10)); // IPC simulated latency
      return Buffer.from('BRIDGE_IPC_ENC:' + Buffer.from(plain).toString('hex'));
    },
    decryptString: async (cipher) => {
      await new Promise(r => setTimeout(r, 10)); // IPC simulated latency
      const str = Buffer.isBuffer(cipher) ? cipher.toString('utf8') : String(cipher);
      if (!str.startsWith('BRIDGE_IPC_ENC:')) throw new Error('Bridge decrypt failed');
      return Buffer.from(str.slice('BRIDGE_IPC_ENC:'.length), 'hex').toString('utf8');
    },
  };

  const svc = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: mockBridge,
  });

  // Verify async init / ensureBackupCipherKey resolves key without throwing BACKUP_KEY_SAVE_FAILED
  const key = await svc.ensureBackupCipherKey();
  assert.equal(key.length, 32);

  // Key on disk must be encrypted with SAFE_STORAGE_V1:
  const keyFile = path.join(fx.root, '.vault', 'backup_protection.key');
  assert.ok(fs.existsSync(keyFile));
  const rawDisk = fs.readFileSync(keyFile);
  assert.ok(rawDisk.toString('utf8').startsWith('SAFE_STORAGE_V1:'));
  assert.equal(rawDisk.includes(key), false, 'Raw disk must not contain plaintext key');

  // Register and apply config change using async bridge
  const settingsPath = path.join(fx.piDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-3-5-sonnet' }), 'utf8');

  const { connection: conn } = svc.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Bridge Test',
    configDir: fx.piDir,
    createMember: false,
  });

  const prep = svc.prepareConfigChange(conn.id, { patch: { settings: { defaultModel: 'claude-3-7-sonnet' } } });
  const applied = await svc.applyConfigChange(conn.id, {
    patch: { settings: { defaultModel: 'claude-3-7-sonnet' } },
    expectedVersions: prep.currentVersions,
  });
  assert.equal(applied.saveStatus, 'saved');

  // Verify encrypted backup file was created
  const bakPath = applied.change.files[0].backupRef;
  assert.ok(fs.existsSync(bakPath));

  // Second instance simulating restarted daemon with same bridge can reload and rollback
  const svc2 = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: mockBridge,
  });
  await svc2.init();
  const reloadedKey = svc2.backupCipherKey;
  assert.deepEqual(reloadedKey, key);

  const rollbackRes = await svc2.rollbackConfigChange(conn.id, { changeId: applied.change.id });
  assert.equal(rollbackRes.restoredStatus, 'rolled_back');
});

// ---------------------------------------------------------------------------
// 18. P1: 无 safeStorage 时拒绝明文回退，历史明文密钥强制安全迁移
// ---------------------------------------------------------------------------
test('R2 Fix P1: Refuses plaintext fallback without safeStorage; migrates legacy plaintext key only with safeStorage', async t => {
  const fx = setupTestDir('p1-no-plaintext-fallback');
  t.after(fx.cleanup);
  const crypto = require('node:crypto');

  // 1. Without safeStorage, first-time key generation MUST throw SAFE_STORAGE_UNAVAILABLE
  const svcNoSafe = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: null,
  });
  assert.throws(
    () => svcNoSafe.backupCipherKey,
    err => {
      assert.equal(err.code, 'SAFE_STORAGE_UNAVAILABLE');
      return true;
    }
  );
  const keyFile = path.join(fx.root, '.vault', 'backup_protection.key');
  assert.equal(fs.existsSync(keyFile), false, 'Key file must never be created in plaintext');

  // 2. restoreBackupCipherKey without safeStorage MUST throw SAFE_STORAGE_UNAVAILABLE
  assert.throws(
    () => svcNoSafe.restoreBackupCipherKey(crypto.randomBytes(32)),
    err => {
      assert.equal(err.code, 'SAFE_STORAGE_UNAVAILABLE');
      return true;
    }
  );
  assert.equal(fs.existsSync(keyFile), false, 'Restored key must not be written in plaintext');

  // 3. Legacy RAW_KEY_V1: file on disk without safeStorage MUST be rejected
  const vaultDir = path.join(fx.root, '.vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const rawKeyData = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, Buffer.concat([Buffer.from('RAW_KEY_V1:', 'utf8'), rawKeyData]));

  assert.throws(
    () => svcNoSafe.backupCipherKey,
    err => {
      assert.equal(err.code, 'SAFE_STORAGE_UNAVAILABLE');
      return true;
    }
  );

  // 4. Legacy RAW_KEY_V1: file with safeStorage MUST be automatically migrated to SAFE_STORAGE_V1:
  const mockSafe = createMockSafeStorage();
  const svcWithSafe = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: mockSafe,
  });
  const migratedKey = svcWithSafe.backupCipherKey;
  assert.deepEqual(migratedKey, rawKeyData);

  // Verify disk file has been updated to SAFE_STORAGE_V1:
  const onDisk = fs.readFileSync(keyFile);
  assert.ok(onDisk.toString('utf8').startsWith('SAFE_STORAGE_V1:'));
  assert.equal(onDisk.includes(rawKeyData), false, 'Migrated key must not leave plaintext on disk');

  // 5. Bare 32-byte legacy key without safeStorage MUST be rejected
  fs.writeFileSync(keyFile, rawKeyData);
  delete svcNoSafe._cachedBackupCipherKey;
  assert.throws(
    () => svcNoSafe.backupCipherKey,
    err => {
      assert.equal(err.code, 'SAFE_STORAGE_UNAVAILABLE');
      return true;
    }
  );

  // 6. Bare 32-byte legacy key with safeStorage MUST be migrated
  delete svcWithSafe._cachedBackupCipherKey;
  const migratedBareKey = svcWithSafe.backupCipherKey;
  assert.deepEqual(migratedBareKey, rawKeyData);
  const onDiskBare = fs.readFileSync(keyFile);
  assert.ok(onDiskBare.toString('utf8').startsWith('SAFE_STORAGE_V1:'));
});

// ---------------------------------------------------------------------------
// 19. P1: Windows ACL (icacls) 设置失败时立即终止保存，清理临时文件并不落盘密钥
// ---------------------------------------------------------------------------
test('R2 Fix P1: ACL permission setting failure immediately halts key save, cleans tmp file, and leaves no un-ACL file', async t => {
  const fx = setupTestDir('p1-acl-failure');
  t.after(fx.cleanup);

  // Inject hook into restrictFilePermissions
  restrictFilePermissions._mockHook = (target) => {
    throw new Error(`Injected icacls permission failure on ${target}`);
  };

  t.after(() => {
    delete restrictFilePermissions._mockHook;
  });

  const svc = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: fx.safeStorage,
  });

  // Attempting to generate key MUST fail with FILE_PERMISSIONS_FAILED
  assert.throws(
    () => svc.backupCipherKey,
    err => {
      assert.equal(err.code, 'FILE_PERMISSIONS_FAILED');
      assert.ok(err.message.includes('Injected icacls permission failure'));
      return true;
    }
  );

  const vaultDir = path.join(fx.root, '.vault');
  const keyFile = path.join(vaultDir, 'backup_protection.key');
  assert.equal(fs.existsSync(keyFile), false, 'Key file must NOT exist after ACL failure');
  assert.equal(fs.existsSync(keyFile + '.tmp'), false, 'Temporary key file must be cleaned up');

  // Reset hook, verify normal operation works and sets ACL properly
  delete restrictFilePermissions._mockHook;
  const validKey = svc.backupCipherKey;
  assert.equal(validKey.length, 32);
  assert.ok(fs.existsSync(keyFile));
});

// ---------------------------------------------------------------------------
// 20. P1: 异步密钥初始化并发保护：实例内 Promise 复用与跨实例排他锁，防止密钥覆盖
// ---------------------------------------------------------------------------
test('R2 Fix P1: Concurrent ensureBackupCipherKey() calls (in-instance & cross-instance) preserve single winner key without overwrite', async t => {
  const fx = setupTestDir('p1-concurrent-key-init');
  t.after(fx.cleanup);

  // 1. In-instance concurrent calls: Both calls must reuse the same Promise and return the exact same key
  const mockSafe = createMockSafeStorage();
  const repo1 = new AgentConnectionsRepository(fx.dbManager);
  const svc1 = new NativeConfigService({
    storage: { agentConnections: repo1 },
    userDataPath: fx.root,
    safeStorage: mockSafe,
  });

  const [inKey1, inKey2] = await Promise.all([
    svc1.ensureBackupCipherKey(),
    svc1.ensureBackupCipherKey(),
  ]);
  assert.equal(inKey1, inKey2, 'In-instance concurrent calls must resolve to the exact same key buffer');

  // 2. Cross-instance: create two separate NativeConfigService instances with artificial latency in safeStorage
  const fx2 = setupTestDir('p1-concurrent-cross-instance');
  t.after(fx2.cleanup);

  const slowSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: async (plain) => {
      await new Promise(r => setTimeout(r, 40)); // simulate slow IPC or DPAPI
      return Buffer.from('SLOW_SAFE:' + Buffer.from(plain).toString('hex'));
    },
    decryptString: async (buf) => {
      await new Promise(r => setTimeout(r, 20));
      const s = buf.toString('utf8');
      if (!s.startsWith('SLOW_SAFE:')) throw new Error('Decryption failed');
      return Buffer.from(s.slice('SLOW_SAFE:'.length), 'hex').toString('utf8');
    },
  };

  const cSvcA = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx2.dbManager) },
    userDataPath: fx2.root,
    safeStorage: slowSafeStorage,
  });
  const cSvcB = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx2.dbManager) },
    userDataPath: fx2.root,
    safeStorage: slowSafeStorage,
  });

  // Call ensureBackupCipherKey concurrently across instances
  const [crossKeyA, crossKeyB] = await Promise.all([
    cSvcA.ensureBackupCipherKey(),
    cSvcB.ensureBackupCipherKey(),
  ]);

  // Both instances MUST have the EXACT SAME 32-byte key!
  assert.deepEqual(crossKeyA, crossKeyB, 'Cross-instance concurrent init must read single winner key without overwrite');

  // Verify backup encryption and decryption across restarted instance
  const settingsPath = path.join(fx2.piDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'google', defaultModel: 'gemini-1.5-flash' }), 'utf8');

  const { connection: conn } = cSvcA.registerConnection({
    kind: 'native-pi',
    displayName: 'Pi Concurrency Test',
    configDir: fx2.piDir,
    createMember: false,
  });

  const prep = cSvcA.prepareConfigChange(conn.id, { patch: { settings: { defaultModel: 'gemini-2.0-flash' } } });
  const applied = await cSvcA.applyConfigChange(conn.id, {
    patch: { settings: { defaultModel: 'gemini-2.0-flash' } },
    expectedVersions: prep.currentVersions,
  });
  assert.equal(applied.saveStatus, 'saved');

  // Restart simulation: new instance cSvcC reads key from disk and successfully decrypts and rolls back
  const cSvcC = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx2.dbManager) },
    userDataPath: fx2.root,
    safeStorage: slowSafeStorage,
  });
  await cSvcC.init();
  const restartedKey = cSvcC.backupCipherKey;
  assert.deepEqual(restartedKey, crossKeyA, 'Restarted instance must read the winner key');

  // Rollback must cleanly decrypt the backup created by cSvcA
  const rollbackRes = await cSvcC.rollbackConfigChange(conn.id, { changeId: applied.change.id });
  assert.equal(rollbackRes.restoredStatus, 'rolled_back');
});

// ---------------------------------------------------------------------------
// 21. P1: 锁记录进程身份与唯一 ownerToken，存活进程锁不可抢占，释放/回收严格校验所有者
// ---------------------------------------------------------------------------
test('R2 Fix P1: Lock records pid and ownerToken; active owner lock is never reclaimed on expired mtime, and release checks owner token', async t => {
  const fx = setupTestDir('p1-lock-liveness');
  t.after(fx.cleanup);

  const vaultDir = path.join(fx.root, '.vault');
  const lockFile = path.join(vaultDir, 'backup_protection.lock');

  // 1. Verify lock data structure
  let insideLockToken = null;
  let simulatedStaleAttemptEntered = false;
  let contenderPromise;

  const lockPromise = withVaultInitLock(vaultDir, async () => {
    assert.ok(fs.existsSync(lockFile), 'Lock file must exist while held');
    const lockRaw = fs.readFileSync(lockFile, 'utf8');
    const lockData = JSON.parse(lockRaw);

    assert.equal(lockData.pid, process.pid, 'Lock must record current process.pid');
    assert.ok(typeof lockData.ownerToken === 'string' && lockData.ownerToken.startsWith('owner-'), 'Lock must record unique ownerToken');
    assert.ok(typeof lockData.createdAt === 'number', 'Lock must record createdAt timestamp');

    insideLockToken = lockData.ownerToken;

    // Simulate expired mtime by setting utimes to 30 seconds ago
    const pastSec = (Date.now() - 30000) / 1000;
    fs.utimesSync(lockFile, pastSec, pastSec);

    // Now, run a contender with a short timeout.
    // Even though mtime is > 15s ago, because process.pid is still ALIVE, contender MUST NOT reclaim or delete the lock!
    contenderPromise = withVaultInitLock(vaultDir, async () => {
      simulatedStaleAttemptEntered = true;
    });

    // Wait 150ms to ensure contender polls and checks liveness without reclaiming
    await new Promise(r => setTimeout(r, 150));

    // Lock file must STILL exist and STILL belong to the original owner!
    assert.ok(fs.existsSync(lockFile), 'Active owner lock must NOT be deleted despite expired mtime');
    const recheck = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(recheck.ownerToken, insideLockToken, 'Lock file must still belong to the original owner');
    assert.equal(simulatedStaleAttemptEntered, false, 'Contender must NOT have acquired the lock');

    return 'owner_success';
  });

  const res = await lockPromise;
  assert.equal(res, 'owner_success');
  await contenderPromise;
  assert.equal(simulatedStaleAttemptEntered, true, 'Contender proceeds only after owner releases its lock');
  // After normal exit, lock file was safely unlinked by verified owner
  assert.equal(fs.existsSync(lockFile), false, 'Lock must be cleanly released when owner exits');

  // 2. Dead process recovery: when PID is confirmed dead and mtime > 15s, zombie lock is safely reclaimed
  fs.mkdirSync(vaultDir, { recursive: true });
  const deadLockData = {
    pid: 9999999, // non-existent PID
    ownerToken: 'owner-dead-zombie',
    createdAt: Date.now() - 35000,
  };
  fs.writeFileSync(lockFile, JSON.stringify(deadLockData), 'utf8');
  const pastSec = (Date.now() - 30000) / 1000;
  fs.utimesSync(lockFile, pastSec, pastSec);

  assert.equal(isProcessAlive(9999999), false, 'Non-existent PID must be detected as dead');

  let reclaimedSuccess = false;
  await withVaultInitLock(vaultDir, async () => {
    reclaimedSuccess = true;
    const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(current.pid, process.pid, 'Zombie lock should be reclaimed by new process');
  });
  assert.ok(reclaimedSuccess, 'Contender must safely reclaim zombie lock from dead process');

  // 3. Ownership check on release: if lock file was modified/replaced with another ownerToken, releasing instance does NOT delete it
  for (const acquire of [withVaultInitLock, withVaultInitLockSync]) {
    const replacement = { pid: process.pid, ownerToken: 'other-owner-token', createdAt: Date.now() };
    await acquire(vaultDir, () => {
      fs.writeFileSync(lockFile, JSON.stringify(replacement), 'utf8');
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), replacement,
      'Releasing the original owner must preserve the replacement owner lock');
    fs.unlinkSync(lockFile);
  }
});

// ---------------------------------------------------------------------------
// 22. P1: 最终密钥排他落盘禁止覆盖，冲突收敛至胜出者密钥，彻底消除分歧与覆盖
// ---------------------------------------------------------------------------
test('R2 Fix P1: Key persistence strictly forbids overwrite; contender collision converges on winner key and disk file is preserved', async t => {
  const fx = setupTestDir('p1-no-overwrite-key');
  t.after(fx.cleanup);

  const vaultDir = path.join(fx.root, '.vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const keyFile = path.join(vaultDir, 'backup_protection.key');

  const mockSafe = createMockSafeStorage();
  const svcA = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: mockSafe,
  });
  const svcB = new NativeConfigService({
    storage: { agentConnections: new AgentConnectionsRepository(fx.dbManager) },
    userDataPath: fx.root,
    safeStorage: mockSafe,
  });

  // Step 1: svcB wins and writes KeyB to disk first
  const winnerKey = await svcB.ensureBackupCipherKey();
  assert.equal(winnerKey.length, 32);
  const diskBytesAfterB = fs.readFileSync(keyFile);

  // Step 2: Test writeProtectedVaultFileExclusive directly
  // Attempting to write a different payload to keyFile MUST throw EEXIST and NOT touch disk
  assert.throws(
    () => {
      writeProtectedVaultFileExclusive(keyFile, Buffer.from('ATTACK_OVERWRITE_PAYLOAD'));
    },
    (err) => err.code === 'EEXIST',
    'writeProtectedVaultFileExclusive must throw EEXIST when target file exists'
  );
  assert.deepEqual(fs.readFileSync(keyFile), diskBytesAfterB, 'Disk file must NOT be altered or overwritten by exclusive write');

  // Step 3: Now simulate delayed svcA executing _createAndSaveFreshKeyAsync (e.g. as if lock was hijacked)
  // svcA's _createAndSaveFreshKeyAsync MUST catch EEXIST, refuse to overwrite, and safely read & decrypt winnerKey!
  const svcAKey = await svcA._createAndSaveFreshKeyAsync(vaultDir, keyFile);

  // Key verification:
  assert.deepEqual(svcAKey, winnerKey, 'svcA must have converged on winnerKey without creating different keys');
  assert.deepEqual(svcA.backupCipherKey, winnerKey, 'svcA cached key must match winnerKey');
  assert.deepEqual(fs.readFileSync(keyFile), diskBytesAfterB, 'Disk file must remain the untouched winner key');

  // A fresh instance must decrypt the same persisted winner after the collision.
  const restarted = new NativeConfigService({ storage: svcA.storage, userDataPath: fx.root, safeStorage: mockSafe });
  assert.deepEqual(await restarted.ensureBackupCipherKey(), winnerKey);
  assert.deepEqual(fs.readFileSync(keyFile), diskBytesAfterB);
});

test('R2 Fix P1: Exclusive key publication leaves no final or temporary file when preparation or hard links fail', async t => {
  const fx = setupTestDir('p1-exclusive-publish-failure');
  t.after(fx.cleanup);
  const dir = path.join(fx.root, 'publication');
  fs.mkdirSync(dir);
  const keyFile = path.join(dir, 'backup_protection.key');
  const payload = Buffer.from('SYNTHETIC_ENCRYPTED_KEY');

  for (const failure of ['hard-link', 'acl', 'write', 'flush']) {
    const originalLink = fs.linkSync;
    const originalWrite = fs.writeFileSync;
    const originalFlush = fs.fsyncSync;
    const originalHook = restrictFilePermissions._mockHook;
    try {
      if (failure === 'hard-link') fs.linkSync = () => {
        throw Object.assign(new Error('Synthetic unsupported filesystem'), { code: 'ENOSYS' });
      };
      if (failure === 'acl') restrictFilePermissions._mockHook = () => { throw new Error('Synthetic ACL failure'); };
      if (failure === 'write') fs.writeFileSync = () => { throw new Error('Synthetic disk write failure'); };
      if (failure === 'flush') fs.fsyncSync = () => { throw new Error('Synthetic disk flush failure'); };

      assert.throws(() => writeProtectedVaultFileExclusive(keyFile, payload), err => {
        if (failure === 'hard-link') return err.code === 'VAULT_ATOMIC_PUBLISH_FAILED' && err.cause?.code === 'ENOSYS';
        if (failure === 'acl') return err.code === 'FILE_PERMISSIONS_FAILED';
        return err.message.includes(`Synthetic disk ${failure}`);
      });
    } finally {
      fs.linkSync = originalLink;
      fs.writeFileSync = originalWrite;
      fs.fsyncSync = originalFlush;
      if (originalHook) restrictFilePermissions._mockHook = originalHook;
      else delete restrictFilePermissions._mockHook;
    }
    assert.equal(fs.existsSync(keyFile), false, `${failure} must not publish an empty or unprotected final key`);
    assert.deepEqual(fs.readdirSync(dir), [], `${failure} must clean up its temporary file`);
  }

  writeProtectedVaultFileExclusive(keyFile, payload);
  assert.deepEqual(fs.readFileSync(keyFile), payload, 'Retry succeeds after the filesystem failure is resolved');
  assert.deepEqual(fs.readdirSync(dir), ['backup_protection.key']);
});

test('R2 Fix P1: A winner appearing at the publication boundary is never overwritten', t => {
  const fx = setupTestDir('p1-exclusive-boundary');
  t.after(fx.cleanup);
  const keyFile = path.join(fx.root, 'boundary.key');
  const winner = Buffer.from('SYNTHETIC_WINNER_KEY');
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = (source, target) => {
      fs.writeFileSync(target, winner, { flag: 'wx', mode: 0o600 });
      return originalLink(source, target);
    };
    assert.throws(() => writeProtectedVaultFileExclusive(keyFile, Buffer.from('SYNTHETIC_LOSER_KEY')),
      err => err.code === 'EEXIST');
  } finally {
    fs.linkSync = originalLink;
  }
  assert.deepEqual(fs.readFileSync(keyFile), winner);
  assert.equal(fs.readdirSync(fx.root).some(name => name.startsWith('boundary.key.') && name.endsWith('.tmp')), false);
});

test('R2 Fix P1: Sync and async services can retry initialization after unsupported key publication', async t => {
  const fx = setupTestDir('p1-exclusive-init-retry');
  t.after(fx.cleanup);
  for (const kind of ['sync', 'async']) {
    const root = path.join(fx.root, kind);
    const service = new NativeConfigService({ storage: {}, userDataPath: root, safeStorage: fx.safeStorage });
    const keyFile = path.join(root, '.vault', 'backup_protection.key');
    const originalLink = fs.linkSync;
    try {
      fs.linkSync = () => { throw Object.assign(new Error('Synthetic unsupported filesystem'), { code: 'ENOTSUP' }); };
      const isSaveFailure = err => err.code === 'BACKUP_KEY_SAVE_FAILED';
      if (kind === 'async') await assert.rejects(service.ensureBackupCipherKey(), isSaveFailure);
      else assert.throws(() => service.backupCipherKey, isSaveFailure);
    } finally {
      fs.linkSync = originalLink;
    }
    assert.equal(fs.existsSync(keyFile), false);
    assert.equal(fs.readdirSync(path.dirname(keyFile)).some(name => name.endsWith('.tmp')), false);
    const key = await service.ensureBackupCipherKey();
    const restarted = new NativeConfigService({ storage: {}, userDataPath: root, safeStorage: fx.safeStorage });
    assert.deepEqual(await restarted.ensureBackupCipherKey(), key, `${kind} retry persists a decryptable key`);
  }
});
