const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { closeDatabasesUnder } = require('./storage/database');
const { startServer } = require('./index');

function fixture(t, beforeCleanup = async () => {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-migration-')));
  t.after(async () => {
    await beforeCleanup();
    closeDatabasesUnder(root);
    const parent = fs.realpathSync.native(os.tmpdir());
    assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('52hz-migration-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('Legacy migration: strict validation, conservative permissions, idempotency, deprecate, real workflow run, active task 409 isolation, and in-memory config/store refresh', async (t) => {
  const root = fixture(t);

  // Set up pre-migration connections.json
  const connBefore = [
    { id: 'conn-test', name: 'Pre-Rollback Connection', protocol: 'openai', defaultModel: 'gpt-4-before', models: [{ id: 'gpt-4-before' }] }
  ];
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(connBefore, null, 2), 'utf8');

  // Start server with actual single-object parameter signature
  const instance = await startServer({ port: 0, userDataPath: root, staticDir: root });
  const server = instance.server;
  t.after(() => server.shutdown?.() || server.close());
  const baseUrl = `http://127.0.0.1:${instance.port}`;

  const store = server.store;
  const storage = store.storage;
  const runner = server.agentRunner;
  const configManager = server.configManager;

  // Verify initial in-memory connection loaded correctly
  assert.equal(configManager.getConnection('conn-test')?.defaultModel, 'gpt-4-before');

  // 1. Insert legacy work profile referencing old role "implementer"
  storage.db.prepare(`
    INSERT INTO work_profiles (id, workspace_id, name, agent, role, mode, description, created_at, updated_at)
    VALUES ('wp-legacy', '52hz', 'Legacy Profile', 'implementer', 'implementer', 'execute', 'Legacy implementer', '2026-10-30', '2026-10-30')
  `).run();

  // 2. Insert saved workflow referencing old agent "old-agent-role"
  storage.db.prepare(`
    INSERT INTO saved_workflows (id, workspace_id, name, description, steps_json, created_at, updated_at)
    VALUES ('wf-legacy', '52hz', 'Legacy Pipeline', 'Pipeline with old agent', ?, '2026-10-30', '2026-10-30')
  `).run(JSON.stringify([
    { id: 'step-1', title: 'Step 1', agent: 'old-agent-role', role: 'architect' }
  ]));

  // Step 1: Check legacy endpoint
  const checkRes = await fetch(`${baseUrl}/v1/migration/legacy-check`);
  assert.equal(checkRes.status, 200);
  const checkData = await checkRes.json();
  assert.equal(checkData.needsMigration, true);
  assert.ok(checkData.stats.workProfiles >= 1);
  assert.ok(checkData.stats.savedWorkflows >= 1);

  // Step 2: Test rejection of nonexistent agent
  const rejectRes = await fetch(`${baseUrl}/v1/migration/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resolutions: [
        {
          id: 'wp-legacy',
          targetType: 'work_profile',
          action: 'bind_agent',
          targetAgentId: 'does-not-exist',
        },
      ],
    }),
  });
  assert.equal(rejectRes.status, 400, 'Nonexistent agent binding must be rejected with 400');
  const rejectData = await rejectRes.json();
  assert.ok(rejectData.error.includes('does not exist'));

  // Step 3: Execute valid migration (bind + create_agent)
  const execRes = await fetch(`${baseUrl}/v1/migration/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resolutions: [
        {
          id: 'wp-legacy',
          targetType: 'work_profile',
          action: 'bind_agent',
          targetAgentId: 'agent-local',
        },
        {
          id: 'wf-legacy',
          targetType: 'saved_workflow',
          action: 'create_agent',
          newAgent: {
            name: 'Pipeline Architect Agent',
            role: 'architect',
            instructions: 'Analyze architecture requirements',
          },
          details: { stepIndex: 0 },
        },
      ],
    }),
  });

  assert.equal(execRes.status, 200);
  const execData = await execRes.json();
  assert.equal(execData.success, true);
  assert.equal(execData.migratedCount, 2);
  assert.ok(execData.backup.backupPath);
  assert.ok(fs.existsSync(execData.backup.backupPath));

  // Verify DB state after migration: wp-legacy is now agent-local
  const wpRow = storage.db.prepare('SELECT agent FROM work_profiles WHERE id = ?').get('wp-legacy');
  assert.equal(wpRow.agent, 'agent-local');

  const wfRow = storage.db.prepare('SELECT steps_json FROM saved_workflows WHERE id = ?').get('wf-legacy');
  const steps = JSON.parse(wfRow.steps_json);
  assert.notEqual(steps[0].agent, 'old-agent-role');
  assert.ok(steps[0].agent.startsWith('agent-'));

  // Verify created agent has CONSERVATIVE permissions (readFiles: true, writeFiles: false, executeCommands: false)
  const createdAgent = storage.agentDefinitions.get(steps[0].agent);
  assert.ok(createdAgent);
  assert.equal(createdAgent.name, 'Pipeline Architect Agent');
  assert.equal(createdAgent.permissions.readFiles, true);
  assert.equal(createdAgent.permissions.writeFiles, false, 'writeFiles must be false by default');
  assert.equal(createdAgent.permissions.executeCommands, false, 'executeCommands must be false by default');
  assert.equal(createdAgent.defaultMode, 'chat', 'defaultMode must be chat');

  // Verify idempotency: running create_agent again for the same item reuses the tagged ID
  const initialAgentsCount = storage.agentDefinitions.list().length;
  const reExecRes = await fetch(`${baseUrl}/v1/migration/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resolutions: [
        {
          id: 'wf-legacy',
          targetType: 'saved_workflow',
          action: 'create_agent',
          newAgent: {
            name: 'Pipeline Architect Agent',
          },
          details: { stepIndex: 0 },
        },
      ],
    }),
  });
  assert.equal(reExecRes.status, 200);
  const afterAgentsCount = storage.agentDefinitions.list().length;
  assert.equal(initialAgentsCount, afterAgentsCount, 'Idempotent migration must not create duplicate agent');

  // Step 4: Test deprecate action for saved workflow
  const deprecateRes = await fetch(`${baseUrl}/v1/migration/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resolutions: [
        {
          id: 'wf-legacy',
          targetType: 'saved_workflow',
          action: 'deprecate',
        },
      ],
    }),
  });
  assert.equal(deprecateRes.status, 200);
  const deprecateData = await deprecateRes.json();
  assert.equal(deprecateData.migratedCount, 1);
  const deletedWf = storage.db.prepare('SELECT id FROM saved_workflows WHERE id = ?').get('wf-legacy');
  assert.equal(deletedWf, undefined, 'Workflow must be deleted on deprecate');

  // Step 5: Simulate connection change post-migration (e.g. user updated to gpt-4-after)
  const connAfter = [
    { id: 'conn-test', name: 'Post-Rollback Connection', protocol: 'openai', defaultModel: 'gpt-4-after', models: [{ id: 'gpt-4-after' }] }
  ];
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(connAfter, null, 2), 'utf8');
  configManager.userConnections = connAfter;
  assert.equal(configManager.getConnection('conn-test')?.defaultModel, 'gpt-4-after');

  // Step 6: Test real workflow run on a valid workflow
  storage.agentDefinitions.update('agent-local', {
    modelResource: { connectionId: 'ollama', modelId: 'mock-model', maxOutputTokens: 1024 },
    expectedRevision: 1,
  });

  storage.pipelines.saveWorkflow('52hz', {
    id: 'wf-active-run',
    name: 'Real Automated Pipeline',
    steps: [
      { agent: 'agent-local', instruction: 'Automated step instruction' }
    ],
  });

  const runWfRes = await fetch(`${baseUrl}/v1/workspaces/52hz/workflows/wf-active-run/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'general' }),
  });
  assert.equal(runWfRes.status, 200);
  const runWfData = await runWfRes.json();
  assert.equal(runWfData.ok, true);
  assert.ok(runWfData.pipeline);
  assert.equal(runWfData.pipeline.active, true);
  assert.equal(runWfData.pipeline.steps[0].instruction, 'Automated step instruction');
  assert.ok(runWfData.pipeline.steps[0].actor_snapshot, 'Actor snapshot must be bound');

  // Step 7: Test Rollback blocked during active task - STRICT 409
  const busyRollbackRes = await fetch(`${baseUrl}/v1/migration/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPath: execData.backup.backupPath }),
  });
  assert.equal(busyRollbackRes.status, 409, 'Rollback during active pipeline task must strictly return 409');
  const busyData = await busyRollbackRes.json();
  assert.ok(busyData.error.includes('Cannot rollback while tasks'));

  // Step 8: Verify recovery lock blocks execution entrances
  assert.equal(runner.acquireRecoveryLock(), false, 'Acquire recovery lock must return false while active tasks exist');

  // Stop session properly using the real server's runner
  runner.stop('general');
  await new Promise(r => setTimeout(r, 200));
  runner.active.clear();
  runner.queues.clear();
  runner.workspaceOperations.clear();

  // Test recovery lock mutual exclusion when idle
  const acquired = runner.acquireRecoveryLock();
  assert.equal(acquired, true, 'Recovery lock must succeed when idle');
  assert.equal(runner.isRecoveryLocked(), true);

  // Workflow run blocked by recovery lock
  const wfLockedRes = await fetch(`${baseUrl}/v1/workspaces/52hz/workflows/wf-active-run/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'general' }),
  });
  assert.equal(wfLockedRes.status, 409, 'Workflow run must return 409 during recovery lock');

  // Events entry point blocked by recovery lock
  const eventLockedRes = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'workspace.message.posted',
      source: 'human:user',
      target: 'channel/general',
      payload: { content: 'test message during lock' },
    }),
  });
  assert.equal(eventLockedRes.status, 409, 'Event dispatch must return 409 during recovery lock');

  // Release lock for rollback execution
  runner.releaseRecoveryLock();
  assert.equal(runner.isRecoveryLocked(), false);

  // Step 8b: Verify that active checkpoint restore (runner.restoring) blocks rollback with 409
  runner.restoring.add('project-checkpoint-lock');
  assert.equal(runner.acquireRecoveryLock(), false, 'acquireRecoveryLock must return false when checkpoint restoration is active');
  const restoringRollbackRes = await fetch(`${baseUrl}/v1/migration/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPath: execData.backup.backupPath }),
  });
  assert.equal(restoringRollbackRes.status, 409, 'Rollback must strictly return 409 when checkpoint restore is active');
  runner.restoring.delete('project-checkpoint-lock');

  // Step 9: Clean Rollback
  const cleanRollbackRes = await fetch(`${baseUrl}/v1/migration/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPath: execData.backup.backupPath }),
  });
  assert.equal(cleanRollbackRes.status, 200);

  // Step 10: In-depth verification of database AND in-memory refresh
  // 1. SQLite DB must be reverted back to 'implementer'
  const wpRestored = storage.db.prepare('SELECT agent FROM work_profiles WHERE id = ?').get('wp-legacy');
  assert.equal(wpRestored.agent, 'implementer', 'SQLite database work profile agent must be restored to implementer');

  // 2. In-memory configManager.userConnections must be refreshed from restored disk snapshot (reverted to gpt-4-before)
  assert.equal(
    configManager.getConnection('conn-test')?.defaultModel,
    'gpt-4-before',
    'configManager getConnection must return gpt-4-before after rollback'
  );
  assert.equal(
    configManager.userConnections[0]?.defaultModel,
    'gpt-4-before',
    'configManager.userConnections memory array must be restored to gpt-4-before'
  );

  // 3. In-memory store.data must be reloaded
  assert.equal(store.data.workspace.id, '52hz');

  // Step 11: Verify production daemon bridge safeStorage reload & decryption replenishment
  const { CredentialVault } = require('./credential-vault');
  const mockBridge = {
    isBridge: true,
    isEncryptionAvailable: () => true,
    onReload: async () => ({
      'conn:bridge_key': 'decrypted-bridge-secret',
    }),
  };
  const bridgeVault = new CredentialVault(root, mockBridge);
  await bridgeVault.reload();
  assert.equal(bridgeVault.get('conn:bridge_key'), 'decrypted-bridge-secret');
  assert.equal(bridgeVault.has('conn:bridge_key'), true);

  // Verify that bridge reload failure strictly throws upwards instead of falsely succeeding
  const failingBridge = {
    isBridge: true,
    isEncryptionAvailable: () => true,
    onReload: async () => { throw new Error('Bridge timeout'); },
  };
  const failingBridgeVault = new CredentialVault(root, failingBridge);
  await assert.rejects(
    async () => { await failingBridgeVault.reload(); },
    /Failed to reload decrypted credentials via bridge: Bridge timeout/
  );

  // Step 12: Verify /v1/backups/restore reuses the unified recovery workflow (global lock, 409 on busy, in-memory refresh)
  // 12a. While recovery lock is held, /v1/backups/restore must return 409
  runner.acquireRecoveryLock();
  const backupRestoreLockedRes = await fetch(`${baseUrl}/v1/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPath: execData.backup.backupPath }),
  });
  assert.equal(backupRestoreLockedRes.status, 409, '/v1/backups/restore must return 409 when recovery lock is held');
  runner.releaseRecoveryLock();

  // 12b. While active checkpoint restoration exists, /v1/backups/restore must return 409
  runner.restoring.add('checkpoint-busy-test');
  const backupRestoreRestoringRes = await fetch(`${baseUrl}/v1/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPath: execData.backup.backupPath }),
  });
  assert.equal(backupRestoreRestoringRes.status, 409, '/v1/backups/restore must return 409 when checkpoint restoration is active');
  runner.restoring.delete('checkpoint-busy-test');

  // 12c. When idle, /v1/backups/restore succeeds with 200 and performs unified refresh
  const backupRestoreCleanRes = await fetch(`${baseUrl}/v1/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPath: execData.backup.backupPath }),
  });
  assert.equal(backupRestoreCleanRes.status, 200);
  assert.equal(runner.isRecoveryLocked(), false, 'Recovery lock must be released after restore');

  // Step 13: Verify new session creation retains custom mode and autoCompact without redundant agent reassignment
  const createChannelRes = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'network.channel.create',
      source: 'human:user',
      payload: {
        title: 'Plan Mode Session',
        agent_id: 'agent-local',
        runtime_config: { inheritAgent: true, mode: 'plan', autoCompact: false },
      },
    }),
  });
  assert.equal(createChannelRes.status, 200);
  const createChannelData = await createChannelRes.json();
  const createdChannel = store.getChannel(createChannelData.metadata.channel_name);
  assert.ok(createdChannel);
  assert.equal(createdChannel.runtime_config?.mode, 'plan', 'Custom mode plan must be preserved');
  assert.equal(createdChannel.runtime_config?.autoCompact, false, 'Custom autoCompact false must be preserved');
  assert.equal(createdChannel.agent_id, 'agent-local');
});

for (const route of ['/v1/backups/restore', '/v1/migration/rollback']) {
  test(`${route}: failed credential reload blocks execution, clears stale secrets and permits successful retry`, async t => {
    let server, fail = true, hold = false, release, entered, modelCalls = 0, reloadCalls = 0, receivedRestoredCredential = false;
    const root = fixture(t, async () => { release?.(); if (server) await server.shutdown(); });
    fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify([{ id: 'fixture', protocol: 'openai',
      baseUrl: 'https://example.invalid/v1', defaultModel: 'fixture-model', credentialRef: 'fixture-ref' }]));
    fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ 'fixture-ref': 'safe:Zml4dHVyZQ==' }));
    const started = await startServer({ port: 0, userDataPath: root, staticDir: root,
      runtimeOptions: { apiToken: 'fixture-token', env: {}, credentialsCache: { 'fixture-ref': 'fixture-before' },
        safeStorage: { isBridge: true, onReload: async () => {
          reloadCalls++;
          if (hold) { entered(); await new Promise(resolve => { release = resolve; }); }
          if (fail) throw new Error('simulated bridge timeout');
          return { 'fixture-ref': 'fixture-restored' };
        } },
        piRuntime: async options => { modelCalls++; receivedRestoredCredential = options.apiKey === 'fixture-restored'; return { content: 'Fixture completed without network access', usage: null }; },
      },
    });
    server = started.server;
    const runner = server.agentRunner, vault = server.credentialVault;
    const actor = server.store.storage.agentDefinitions.create({ name: 'Fixture Agent', defaultMode: 'chat', maxMode: 'chat',
      modelResource: { connectionId: 'fixture', modelId: 'fixture-model' } });
    server.store.updateChannel('general', { agent_id: actor.id, runtime_config: { inheritAgent: true } });
    const backup = await server.store.storage.backupManager.createBackup({ label: 'recovery-fixture' });
    vault.cache['fixture-ref'] = 'fixture-stale';
    const request = async (endpoint, body) => {
      const response = await fetch(`http://127.0.0.1:${started.port}${endpoint}`, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': 'fixture-token' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const input = { type: 'workspace.message.posted', source: 'human:user', target: 'channel/general', payload: { content: 'Execute fixture' } };
    const failed = await request(route, { backupPath: backup.backupPath });
    assert.equal(failed.status, 500); assert.equal(failed.body.code, 'RECOVERY_INCOMPLETE');
    assert.equal(runner.isRecoveryLocked(), false, 'physical mutex must be released for retry');
    assert.equal(runner.isRecoveryBlocked(), true);
    assert.equal(vault.get('fixture-ref'), null); assert.equal(vault.has('fixture-ref'), false);
    assert.equal(Object.keys(vault.cache).length, 0);
    assert.equal(server.configManager.getConnection('fixture').hasCredential, false);
    const denied = await request('/v1/events', input);
    assert.equal(denied.status, 409); assert.equal(denied.body.code, 'RECOVERY_INCOMPLETE');
    await assert.rejects(runner.handleUserMessage({ ...input, id: 'scheduled', source: 'scheduler:fixture' }), { code: 'RECOVERY_INCOMPLETE' });
    await assert.rejects(runner.run('general', input), { code: 'RECOVERY_INCOMPLETE' });
    assert.throws(() => runner.compact('general'), { status: 409 });
    assert.throws(() => runner.collaboration.startPipeline('general', { steps: [] }), { status: 409 });
    assert.equal(modelCalls, 0);
    assert.equal((await request('/v1/runtime/recovery?channel=general')).body.systemRecovery.code, 'RECOVERY_INCOMPLETE');
    // An invalid retry must neither clear the failure nor enable execution.
    assert.equal((await request(route, { backupPath: path.join(root, 'missing.sqlite') })).status, 500);
    assert.equal(runner.isRecoveryBlocked(), true);
    fail = false; hold = true;
    const reloading = new Promise(resolve => { entered = resolve; });
    const retry = request(route, { backupPath: backup.backupPath });
    await reloading;
    try {
      assert.equal(runner.isRecoveryLocked(), true);
      assert.equal((await request('/v1/events', input)).status, 409);
      assert.equal((await request(route, { backupPath: backup.backupPath })).status, 409);
      assert.equal(vault.get('fixture-ref'), null);
      assert.equal(modelCalls, 0);
    } finally { hold = false; release(); }
    assert.equal((await retry).status, 200);
    assert.equal(reloadCalls, 2, 'one IPC reload per physical restore, no duplicate refresh');
    assert.equal(runner.isRecoveryBlocked(), false); assert.equal(runner.recoveryFailure, null);
    assert.equal(vault.get('fixture-ref'), 'fixture-restored');
    assert.equal((await request('/v1/events', input)).status, 200);
    const until = Date.now() + 5000;
    while ((!modelCalls || runner.active.size) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(modelCalls, 1); assert.equal(receivedRestoredCredential, true);
    assert.equal((await request(route, { backupPath: path.join(root, 'missing.sqlite') })).status, 500);
    assert.equal(runner.isRecoveryBlocked(), false, 'preflight failure does not poison an unchanged healthy system');
  });
}
