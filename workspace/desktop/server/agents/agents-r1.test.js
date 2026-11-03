'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage');
const { NativeConfigService, sha256Hex, createMockSafeStorage } = require('./config/service');
const { MASK_PLACEHOLDER, parseJsonc, parseTomlDocument } = require('./config/formats');

function makeTempFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-r1-')));
  const binDir = path.join(root, 'bin');
  const piConfigDir = path.join(root, 'pi-agent');
  const codexConfigDir = path.join(root, 'codex-home');
  const userDataDir = path.join(root, 'userData');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(piConfigDir, { recursive: true });
  fs.mkdirSync(codexConfigDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const isWin = process.platform === 'win32';
  const fakePi = path.join(binDir, isWin ? 'pi.exe' : 'pi');
  const fakeCodex = path.join(binDir, isWin ? 'codex.exe' : 'codex');
  fs.writeFileSync(fakePi, 'fake-pi-binary');
  fs.writeFileSync(fakeCodex, 'fake-codex-binary');
  fs.chmodSync(fakePi, 0o755);
  fs.chmodSync(fakeCodex, 0o755);

  const env = {
    PATH: binDir,
    PI_CODING_AGENT_DIR: piConfigDir,
    CODEX_HOME: codexConfigDir,
    USERPROFILE: root,
    HOME: root,
  };

  const safeStorage = createMockSafeStorage();

  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  return { root, binDir, piConfigDir, codexConfigDir, userDataDir, env, safeStorage };
}

test('R1 / A01 & A02: register pre-configured native Pi without workbench provider, lossless JSONC edit preserves comments & unknown keys', async t => {
  const fx = makeTempFixture(t);
  const settingsPath = path.join(fx.piConfigDir, 'settings.json');
  const modelsPath = path.join(fx.piConfigDir, 'models.json');
  const authPath = path.join(fx.piConfigDir, 'auth.json');

  const initialSettingsText = [
    '// User top-level comment in settings.json',
    '{',
    '  /* Keep this block comment */',
    '  "defaultProvider": "anthropic",',
    '  "defaultModel": "claude-3-7-sonnet-latest",',
    '  "defaultThinkingLevel": "medium",',
    '  "customExtensionFlag": true,',
    '  "unknownNested": {',
    '    "keepMe": 42',
    '  },',
    '  "compaction": {',
    '    // Inner compaction comment',
    '    "enabled": true,',
    '    "reserveTokens": 16384',
    '  }',
    '}',
    '',
  ].join('\n');

  fs.writeFileSync(settingsPath, initialSettingsText, 'utf8');
  fs.writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          'my-proxy': {
            name: 'My Proxy',
            baseUrl: 'https://proxy.example.com/v1',
            apiKey: 'sk-super-secret-do-not-leak',
            models: [{ id: 'proxy-coder-1', name: 'Proxy Coder 1', reasoning: true, contextWindow: 128000 }],
          },
          'cmd-prov': {
            name: 'Command Provider',
            baseUrl: 'https://cmd.example.com/v1',
            apiKey: '!echo should-never-run',
            models: [{ id: 'cmd-model', name: 'Cmd Model' }],
          },
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    authPath,
    JSON.stringify({ anthropic: { type: 'oauth', access: 'oauth-secret-token-xyz' } }, null, 2) + '\n',
    'utf8'
  );

  const storage = createStorage({ dbPath: path.join(fx.userDataDir, 'workspace.db') });
  try {
    const service = new NativeConfigService({ storage, userDataPath: fx.userDataDir, env: fx.env, safeStorage: fx.safeStorage });
    const candidates = await service.discoverCandidates();
    const piCandidate = candidates.candidates.find(c => c.candidateKind === 'native-pi');
    assert.ok(piCandidate);
    assert.equal(piCandidate.statusBreakdown.installationDetected, true);
    assert.equal(piCandidate.statusBreakdown.configReadable, true);
    assert.equal(piCandidate.statusBreakdown.authConfigured, true);
    assert.equal(piCandidate.statusBreakdown.executionVerified, false);

    // Register native Pi without any workbench model connection.
    const { connection, member } = service.registerConnection({
      kind: 'native-pi',
      displayName: 'Local Pi',
      memberName: 'Pi Native Dev',
    });
    assert.equal(connection.kind, 'native-pi');
    assert.equal(member.connectionId, connection.id);
    assert.equal(member.execution.connectionKind, 'native-pi');
    assert.equal(member.execution.usesWorkbenchModelConnection, false);
    assert.equal(member.modelResource, null);

    // Inspect redacted config: no secret plaintext may appear anywhere in JSON output.
    const inspected = service.inspectConfig(connection.id);
    const serializedInspect = JSON.stringify(inspected);
    assert.ok(!serializedInspect.includes('sk-super-secret-do-not-leak'));
    assert.ok(!serializedInspect.includes('oauth-secret-token-xyz'));
    assert.ok(!serializedInspect.includes('should-never-run'));
    assert.equal(inspected.view.customProviders['my-proxy'].credential.kind, 'literal');
    assert.equal(inspected.view.customProviders['my-proxy'].credential.masked, MASK_PLACEHOLDER);
    assert.equal(inspected.view.customProviders['cmd-prov'].credential.kind, 'command');
    assert.equal(inspected.effective.defaultProvider, 'anthropic');
    assert.equal(inspected.effective.defaultModel, 'claude-3-7-sonnet-latest');
    assert.ok(inspected.view.settings.preservedKeys.includes('customExtensionFlag'));
    assert.ok(inspected.view.settings.preservedKeys.includes('unknownNested'));

    // Resource list merges Pi built-in catalog + custom models.json.
    const resources = service.listResources(connection.id);
    assert.ok(resources.providers.some(p => p.id === 'anthropic' && p.authenticated === true));
    assert.ok(resources.providers.some(p => p.id === 'my-proxy' && p.authenticated === true));
    assert.ok(resources.models.some(m => m.id === 'proxy-coder-1' && m.source === 'models.json'));

    // Apply field-level patch to settings.json.
    const applied = service.applyConfigChange(connection.id, {
      expectedVersions: inspected.versions,
      patch: {
        settings: {
          defaultModel: 'claude-sonnet-4-5',
          defaultThinkingLevel: 'high',
          compaction: { reserveTokens: 24576 },
        },
      },
    });
    assert.equal(applied.saveStatus, 'saved');
    assert.equal(applied.applicationStatus, 'next_run');
    assert.equal(applied.effective.defaultModel, 'claude-sonnet-4-5');
    assert.equal(applied.effective.defaultThinkingLevel, 'high');

    const diskText = fs.readFileSync(settingsPath, 'utf8');
    assert.ok(diskText.includes('// User top-level comment in settings.json'));
    assert.ok(diskText.includes('/* Keep this block comment */'));
    assert.ok(diskText.includes('// Inner compaction comment'));
    const parsedDisk = parseJsonc(diskText);
    assert.equal(parsedDisk.defaultProvider, 'anthropic');
    assert.equal(parsedDisk.defaultModel, 'claude-sonnet-4-5');
    assert.equal(parsedDisk.defaultThinkingLevel, 'high');
    assert.equal(parsedDisk.customExtensionFlag, true);
    assert.deepEqual(parsedDisk.unknownNested, { keepMe: 42 });
    assert.equal(parsedDisk.compaction.enabled, true);
    assert.equal(parsedDisk.compaction.reserveTokens, 24576);
  } finally {
    storage.close();
  }
});

test('R1 / A03, A04, A05 & A24: external conflict 409, credential preservation & mask rejection, multi-file fault rollback, and safe rollback check', async t => {
  const fx = makeTempFixture(t);
  const settingsPath = path.join(fx.piConfigDir, 'settings.json');
  const modelsPath = path.join(fx.piConfigDir, 'models.json');

  fs.writeFileSync(settingsPath, '{\n  "defaultProvider": "openai",\n  "defaultModel": "gpt-4.1"\n}\n', 'utf8');
  fs.writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          custom1: {
            name: 'Custom One',
            baseUrl: 'https://old.example.com/v1',
            apiKey: 'sk-preserve-me-123456',
            models: [{ id: 'm1', name: 'M1' }],
          },
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const storage = createStorage({ dbPath: path.join(fx.userDataDir, 'workspace.db') });
  try {
    const service = new NativeConfigService({ storage, userDataPath: fx.userDataDir, env: fx.env, safeStorage: fx.safeStorage });
    const { connection } = service.registerConnection({ kind: 'native-pi', createMember: false });
    const initial = service.inspectConfig(connection.id);

    // A05: Reject mask placeholder if submitted as a replacement secret.
    assert.throws(
      () =>
        service.applyConfigChange(connection.id, {
          expectedVersions: initial.versions,
          patch: {
            models: {
              providers: {
                custom1: {
                  credentialAction: 'replace',
                  apiKey: MASK_PLACEHOLDER,
                },
              },
            },
          },
        }),
      err => err.code === 'INVALID_CREDENTIAL_MASK' && err.status === 400
    );

    // A05: Updating non-credential field with credentialAction: 'keep' preserves original secret byte-for-byte.
    const updatedNonSecret = service.applyConfigChange(connection.id, {
      expectedVersions: initial.versions,
      patch: {
        models: {
          providers: {
            custom1: {
              baseUrl: 'https://new.example.com/v1',
              credentialAction: 'keep',
              apiKey: MASK_PLACEHOLDER,
            },
          },
        },
      },
    });
    const parsedModelsAfterKeep = parseJsonc(fs.readFileSync(modelsPath, 'utf8'));
    assert.equal(parsedModelsAfterKeep.providers.custom1.baseUrl, 'https://new.example.com/v1');
    assert.equal(parsedModelsAfterKeep.providers.custom1.apiKey, 'sk-preserve-me-123456');
    assert.ok(!JSON.stringify(updatedNonSecret.change).includes('sk-preserve-me-123456'));

    // A03: External modification triggers 409 CONFIG_CONFLICT and does not overwrite external change.
    const snapshotVersions = updatedNonSecret.versions;
    fs.writeFileSync(settingsPath, '{\n  "defaultProvider": "anthropic",\n  "defaultModel": "external-edit"\n}\n', 'utf8');
    assert.throws(
      () =>
        service.applyConfigChange(connection.id, {
          expectedVersions: snapshotVersions,
          patch: { settings: { defaultModel: 'should-not-overwrite' } },
        }),
      err => err.code === 'CONFIG_CONFLICT' && err.status === 409
    );
    assert.equal(parseJsonc(fs.readFileSync(settingsPath, 'utf8')).defaultModel, 'external-edit');

    // A04: Multi-file save failure after first file is written automatically restores the first file from backup.
    const freshInspect = service.inspectConfig(connection.id);
    const settingsBeforeFault = fs.readFileSync(settingsPath, 'utf8');
    const modelsBeforeFault = fs.readFileSync(modelsPath, 'utf8');

    assert.throws(
      () =>
        service.applyConfigChange(connection.id, {
          expectedVersions: freshInspect.versions,
          patch: {
            settings: { defaultModel: 'transient-model-before-crash' },
            models: {
              providers: {
                custom1: { baseUrl: 'https://crash.example.com/v1', credentialAction: 'keep' },
              },
            },
          },
          faultInjector: ({ step, index }) => {
            if (step === 'before-file-write' && index === 1) {
              throw new Error('simulated disk failure on second file');
            }
          },
        }),
      err => err.code === 'CONFIG_WRITE_FAILED' && err.autoRestored === true
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsBeforeFault);
    assert.equal(fs.readFileSync(modelsPath, 'utf8'), modelsBeforeFault);

    // Clear the failed journal entry via rollback so connection is healthy again.
    const failedChange = storage.agentConnections.listChanges(connection.id)[0];
    assert.equal(failedChange.state, 'apply_failed');
    service.rollbackConfigChange(connection.id, { changeId: failedChange.id });
    assert.equal(storage.agentConnections.getChange(failedChange.id).state, 'rolled_back');

    // A24: Normal rollback works, and external edit after apply blocks rollback from wiping user changes.
    const vBefore = service.inspectConfig(connection.id).versions;
    const change1 = service.applyConfigChange(connection.id, {
      expectedVersions: vBefore,
      patch: { settings: { defaultModel: 'model-v2' } },
    });
    assert.equal(parseJsonc(fs.readFileSync(settingsPath, 'utf8')).defaultModel, 'model-v2');

    // External user edit happens after change1:
    fs.writeFileSync(settingsPath, '{\n  "defaultProvider": "anthropic",\n  "defaultModel": "user-manual-v3"\n}\n', 'utf8');
    assert.throws(
      () => service.rollbackConfigChange(connection.id, { changeId: change1.change.id }),
      err => err.code === 'CONFIG_EXTERNAL_MODIFIED' && err.status === 409
    );
    assert.equal(parseJsonc(fs.readFileSync(settingsPath, 'utf8')).defaultModel, 'user-manual-v3');
  } finally {
    storage.close();
  }
});

test('R1 / A06 & A07: Codex session override vs global config.toml edit, shared members disclosure, and HTTP routes', async t => {
  const fx = makeTempFixture(t);
  const configTomlPath = path.join(fx.codexConfigDir, 'config.toml');
  const authJsonPath = path.join(fx.codexConfigDir, 'auth.json');

  const initialToml = [
    '# Codex global configuration',
    'model = "gpt-5-codex" # inline comment',
    'model_reasoning_effort = "medium"',
    '',
    '[projects."d:/code/demo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');
  fs.writeFileSync(configTomlPath, initialToml, 'utf8');
  fs.writeFileSync(authJsonPath, JSON.stringify({ tokens: { access_token: 'codex-secret-oauth-token' } }), 'utf8');

  const { startServer } = require('../index');
  const { server, port } = await startServer({
    port: 0,
    userDataPath: fx.userDataDir,
    staticDir: fx.userDataDir,
    apiToken: 'r1-test-token',
    runtimeOptions: { env: fx.env, safeStorage: fx.safeStorage },
  });
  t.after(async () => {
    await server.shutdown();
  });

  const base = `http://127.0.0.1:${port}`;
  const call = async (route, method = 'GET', body) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        'X-Workspace-Token': 'r1-test-token',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };

  // 1. Discover candidates over HTTP.
  const candRes = await call('/v1/agent-connections/candidates');
  assert.equal(candRes.status, 200);
  const codexCand = candRes.data.candidates.find(c => c.candidateKind === 'native-codex');
  assert.equal(codexCand.statusBreakdown.installationDetected, true);
  assert.equal(codexCand.statusBreakdown.authConfigured, true);

  // 2. Register Codex connection + first member.
  const regRes = await call('/v1/agent-connections', 'POST', {
    kind: 'native-codex',
    displayName: 'Local Codex',
    memberName: 'Codex Reviewer',
  });
  assert.equal(regRes.status, 201);
  const connId = regRes.data.connection.id;
  const member1 = regRes.data.member;

  // Create a second member sharing the same connection with a session/member-scoped model override (A06).
  const member2Res = await call('/v1/agent-definitions', 'POST', {
    name: 'Codex Fast Builder',
    connectionId: connId,
    runtimeModel: 'o4-mini',
    defaultMode: 'plan',
  });
  assert.equal(member2Res.status, 201);
  assert.equal(member2Res.data.runtimeModel, 'o4-mini');
  // Session/member override must NOT alter global config.toml!
  assert.equal(parseTomlDocument(fs.readFileSync(configTomlPath, 'utf8')).topLevel.model, 'gpt-5-codex');

  // 3. Inspect config & verify sharedMembers disclosure (A07) and secret redaction.
  const cfgRes = await call(`/v1/agent-connections/${connId}/config`);
  assert.equal(cfgRes.status, 200);
  assert.ok(!JSON.stringify(cfgRes.data).includes('codex-secret-oauth-token'));
  assert.equal(cfgRes.data.connection.sharedMembers.length, 2);
  assert.equal(cfgRes.data.effective.defaultModel, 'gpt-5-codex');

  // 4. Preview & apply global default change to config.toml, preserving comments and [projects] table.
  const prevRes = await call(`/v1/agent-connections/${connId}/config/preview`, 'POST', {
    expectedVersions: cfgRes.data.versions,
    patch: { config: { model: 'gpt-5.3-codex', model_reasoning_effort: 'high' } },
  });
  assert.equal(prevRes.status, 200);
  assert.equal(prevRes.data.scope, 'global');
  assert.equal(prevRes.data.sharedMembers.length, 2);

  const applyRes = await call(`/v1/agent-connections/${connId}/config/apply`, 'POST', {
    expectedVersions: cfgRes.data.versions,
    patch: { config: { model: 'gpt-5.3-codex', model_reasoning_effort: 'high' } },
  });
  assert.equal(applyRes.status, 200);
  assert.equal(applyRes.data.saveStatus, 'saved');
  assert.equal(applyRes.data.effective.defaultModel, 'gpt-5.3-codex');

  const updatedToml = fs.readFileSync(configTomlPath, 'utf8');
  assert.ok(updatedToml.includes('# Codex global configuration'));
  assert.ok(updatedToml.includes('# inline comment'));
  assert.ok(updatedToml.includes('[projects."d:/code/demo"]'));
  assert.ok(updatedToml.includes('trust_level = "trusted"'));

  // 5. Rollback global config change and verify restoration.
  const rbRes = await call(`/v1/agent-connections/${connId}/config/rollback`, 'POST', {
    changeId: applyRes.data.change.id,
  });
  assert.equal(rbRes.status, 200);
  assert.equal(rbRes.data.effective.defaultModel, 'gpt-5-codex');
  assert.equal(fs.readFileSync(configTomlPath, 'utf8'), initialToml);
  assert.ok(member1.id);

  // 6. A23: Recovery lock blocks all native config mutation endpoints.
  assert.equal(server.agentRunner.acquireRecoveryLock(), true);
  try {
    const blockedApply = await call(`/v1/agent-connections/${connId}/config/apply`, 'POST', {
      expectedVersions: rbRes.data.versions,
      patch: { config: { model: 'blocked-during-recovery' } },
    });
    assert.equal(blockedApply.status, 409);
  } finally {
    server.agentRunner.releaseRecoveryLock();
  }

  // 7. A04: Unrecovered apply_failed state blocks task execution on that connection.
  server.store.storage.agentConnections.createChange({
    id: 'cfgchg-broken-test',
    connectionId: connId,
    state: 'apply_failed',
    scope: 'global',
    redactedPatch: [],
    files: [],
    actor: 'test',
  });
  assert.throws(
    () => server.nativeConfigService.assertConnectionHealthyForExecution(connId),
    err => err.code === 'CONFIG_APPLY_INCOMPLETE' && err.status === 409
  );
});
