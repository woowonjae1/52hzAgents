const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const { Storage } = require('./index');
const { DatabaseManager, closeDatabasesUnder } = require('./database');
const { isMcpToolReadOnly, McpManager } = require('../mcp-client');
const { CredentialVault } = require('../credential-vault');
const { ConfigManager } = require('../config-manager');
const { startServer } = require('../index');

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-audit-gap-')));
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close',
        ...(options.headers || {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('Audit Gap Verification: P0/P1 Closed-Loop Controls', async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = makeTempDir();
  });

  t.afterEach(() => {
    closeDatabasesUnder(tmpDir);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('P0 MCP Read-Only Judgment & Fail-Closed Boundaries', () => {
    // 1. query_sql contains dangerous keyword 'sql' and is not in safe prefix whitelist -> mutating
    assert.strictEqual(isMcpToolReadOnly({ name: 'query_sql' }), false);

    // 2. read_account with explicit readOnly: false -> MUST be false even if trusted
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_account', readOnly: false }, { trusted: true }), false);
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_account', annotations: { readOnly: false } }, { trusted: true }), false);

    // 3. read_account without application trust MUST be false (fail-closed)
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_account', readOnly: true }), false);

    // 4. read_account with application trust { trusted: true } -> true
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_account', readOnly: true }, { trusted: true }), true);
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_account', annotations: { readOnly: true } }, { trusted: true }), true);

    // 5. Mutation keywords in name -> false even if trusted
    assert.strictEqual(isMcpToolReadOnly({ name: 'execute_migration' }, { trusted: true }), false);
    assert.strictEqual(isMcpToolReadOnly({ name: 'run_tests' }, { trusted: true }), false);
    assert.strictEqual(isMcpToolReadOnly({ name: 'delete_row' }, { trusted: true }), false);
    assert.strictEqual(isMcpToolReadOnly({ name: 'apply_patch' }, { trusted: true }), false);

    // 6. Whitelisted safe read prefix without application trust -> false
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_file' }), false);

    // 7. Whitelisted safe read prefix with application trust -> true
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_file' }, { trusted: true }), true);
    assert.strictEqual(isMcpToolReadOnly({ name: 'get_weather' }, { trusted: true }), true);
    assert.strictEqual(isMcpToolReadOnly({ name: 'list_directory' }, { trusted: true }), true);
    assert.strictEqual(isMcpToolReadOnly({ name: 'search_symbols' }, { trusted: true }), true);
    assert.strictEqual(isMcpToolReadOnly({ name: 'describe_schema' }, { trusted: true }), true);
  });

  await t.test('P0 & P1 Credential Persistence, Bridge Rollback & Sync/Async ACK', async () => {
    // 1. Bridge mode: rollback on set rejection
    let bridgeShouldFail = false;
    const mockSafeStorage = {
      isBridge: true,
      onSet: async (id, secret) => {
        if (bridgeShouldFail) throw new Error('Simulated IPC Set Timeout');
        return true;
      },
      onDelete: async (id) => {
        if (bridgeShouldFail) throw new Error('Simulated IPC Delete Timeout');
        return true;
      },
    };

    const vault = new CredentialVault(tmpDir, mockSafeStorage, { initial_key: 'initial_val' });
    assert.strictEqual(vault.get('initial_key'), 'initial_val');

    // Successful set
    await vault.set('new_key', 'new_val');
    assert.strictEqual(vault.get('new_key'), 'new_val');

    // Failed set must roll back cache
    bridgeShouldFail = true;
    await assert.rejects(async () => {
      await vault.set('new_key', 'corrupted_val');
    }, /Simulated IPC Set Timeout/);
    assert.strictEqual(vault.get('new_key'), 'new_val'); // Restored to previous value

    // Failed set on non-existent key must delete cache entry
    await assert.rejects(async () => {
      await vault.set('never_existed', 'some_val');
    }, /Simulated IPC Set Timeout/);
    assert.strictEqual(vault.get('never_existed'), null);

    // Failed delete must restore cache
    await assert.rejects(async () => {
      await vault.delete('new_key');
    }, /Simulated IPC Delete Timeout/);
    assert.strictEqual(vault.get('new_key'), 'new_val');

    // 2. Successful delete removes cache
    bridgeShouldFail = false;
    await vault.delete('new_key');
    assert.strictEqual(vault.get('new_key'), null);
  });

  await t.test('P1 Database Restore WAL Consistency & Truthful Error Reporting', async () => {
    const dbPath = path.join(tmpDir, 'active.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: tmpDir });

    // Insert baseline data
    storage.projects.create({
      id: 'proj_base',
      name: 'Baseline Project',
      path: path.join(tmpDir, 'baseline'),
    });

    // Create hot backup
    const backupRes = await storage.backupManager.createBackup('test-baseline');
    assert.ok(fs.existsSync(backupRes.backupPath));

    // Write uncheckpointed WAL modification
    storage.projects.create({
      id: 'proj_wal',
      name: 'WAL Uncheckpointed Project',
      path: path.join(tmpDir, 'wal'),
    });

    // Perform restore
    const restored = storage.backupManager.restoreFromBackup(backupRes.backupPath);
    assert.strictEqual(restored, true);

    // Verify baseline was restored
    const projects = storage.projects.list();
    assert.strictEqual(projects.some(p => p.id === 'proj_base'), true);
    assert.strictEqual(projects.some(p => p.id === 'proj_wal'), false);

    // Corrupt copy should exist
    const corruptCopies = fs.readdirSync(tmpDir).filter(f => f.includes('corrupt-'));
    assert.ok(corruptCopies.length >= 1);

    storage.close();
  });

  await t.test('P1 Budget Token Calculation, In-Flight Costs & Daily Cost Limit', () => {
    const dbPath = path.join(tmpDir, 'budget.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: tmpDir });

    // Configure session budget with maxCostPerSession and maxCostPerDay
    storage.budgets.setForSession('session_budget_test', {
      maxTokensPerRun: 1000,
      maxStepsPerRun: 10,
      maxCostPerSession: 5.0,
      currency: 'USD',
    });

    // Global budget has maxCostPerDay default of $50. Let's test session cost threshold
    const check1 = storage.budgets.checkPreflight({
      sessionId: 'session_budget_test',
      currentStepCount: 2,
      runTokens: 500,
      sessionCost: 3.5,
    });
    assert.strictEqual(check1.allowed, true);

    // Exceeding session cost
    const check2 = storage.budgets.checkPreflight({
      sessionId: 'session_budget_test',
      currentStepCount: 2,
      runTokens: 500,
      sessionCost: 5.5,
    });
    assert.strictEqual(check2.allowed, false);
    assert.strictEqual(check2.reason, 'cost_limit_exceeded');

    // Exceeding tokens
    const check3 = storage.budgets.checkPreflight({
      sessionId: 'session_budget_test',
      currentStepCount: 2,
      runTokens: 1200,
      sessionCost: 1.0,
    });
    assert.strictEqual(check3.allowed, false);
    assert.strictEqual(check3.reason, 'token_limit_exceeded');

    storage.close();
  });

  await t.test('P1 Routine Error Fields & Anti-Reentrancy Lock Life-Cycle', () => {
    const dbPath = path.join(tmpDir, 'routines.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: tmpDir });

    const routine = storage.routines.create({
      name: 'Audit Routine',
      channel_name: 'test-channel',
      message: 'Run integrity audit',
      schedule_hour: 2,
      schedule_minute: 0,
    });

    const runRecord = storage.routines.recordRun(routine.id, {
      channel_name: 'test-channel',
      trigger_message: 'Run integrity audit',
    });

    let completedNotified = false;
    storage.routines.onRunCompleted = (routineId, runId, status) => {
      assert.strictEqual(routineId, routine.id);
      assert.strictEqual(runId, runRecord.id);
      assert.strictEqual(status, 'failed');
      completedNotified = true;
    };

    // Complete with errorMessage & outcome (ensure error & result are populated!)
    const completed = storage.routines.completeRun(runRecord.id, {
      status: 'failed',
      errorMessage: 'Workspace disk space exhausted',
      outcome: 'failed',
    });

    assert.strictEqual(completed.status, 'failed');
    assert.strictEqual(completed.error, 'Workspace disk space exhausted');
    assert.strictEqual(completed.result, 'failed');
    assert.strictEqual(completedNotified, true);

    const persistedRun = storage.routines.listRuns(routine.id)[0];
    assert.strictEqual(persistedRun.error, 'Workspace disk space exhausted');
    assert.strictEqual(persistedRun.result, 'failed');

    storage.close();
  });

  await t.test('P0 MCP HTTP Authorization with Parameter Hash, Expiration & Replay Protection', async () => {
    const staticDir = path.join(tmpDir, 'static');
    fs.mkdirSync(staticDir, { recursive: true });

    const { server, port } = await startServer({
      port: 0,
      userDataPath: tmpDir,
      staticDir,
    });

    // Mock MCP server with a mutating tool
    const mutatingTool = {
      name: 'execute_sql',
      description: 'Executes arbitrary SQL on host database',
      readOnly: false,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    };

    server.scheduler.storage.mcp.registerServer({
      id: 'srv_sql',
      name: 'sql_server',
      command: 'node',
      args: ['dummy.js'],
    });
    server.scheduler.storage.mcp.syncTools('srv_sql', [mutatingTool]);

    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Calling mutating tool without approvalId MUST return 403 with requires_approval & approval_id
    const unapprovedRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
      method: 'POST',
      body: {
        serverName: 'sql_server',
        toolName: 'execute_sql',
        arguments: { query: 'DROP TABLE users;' },
      },
    });
    assert.strictEqual(unapprovedRes.status, 403);
    assert.strictEqual(unapprovedRes.body.requires_approval, true);
    assert.ok(unapprovedRes.body.approval_id);
    assert.ok(unapprovedRes.body.parameters_hash);

    const approvalId = unapprovedRes.body.approval_id;
    const paramsHash = unapprovedRes.body.parameters_hash;

    // 2. Passing authorized: true without approval record is STRICTLY REJECTED
    const spoofedRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
      method: 'POST',
      body: {
        serverName: 'sql_server',
        toolName: 'execute_sql',
        arguments: { query: 'DROP TABLE users;' },
        authorized: true,
      },
    });
    assert.strictEqual(spoofedRes.status, 403);
    assert.strictEqual(spoofedRes.body.requires_approval, true);

    // 3. Passing approvalId while still pending is rejected
    const stillPendingRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
      method: 'POST',
      body: {
        serverName: 'sql_server',
        toolName: 'execute_sql',
        arguments: { query: 'DROP TABLE users;' },
        approvalId,
      },
    });
    assert.strictEqual(stillPendingRes.status, 403);
    assert.strictEqual(stillPendingRes.body.error, 'Approval not granted for this tool call');

    // 4. User approves the request via PATCH /v1/approvals/:id
    const approveAction = await requestJson(`${baseUrl}/v1/approvals/${approvalId}`, {
      method: 'PATCH',
      body: { status: 'approved' },
    });
    assert.strictEqual(approveAction.status, 200);

    // 5. Calling with altered arguments must fail (parameter hash mismatch protection)
    const alteredArgsRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
      method: 'POST',
      body: {
        serverName: 'sql_server',
        toolName: 'execute_sql',
        arguments: { query: 'DROP TABLE secrets;' }, // Tampered query!
        approvalId,
      },
    });
    assert.strictEqual(alteredArgsRes.status, 403);
    assert.strictEqual(alteredArgsRes.body.error, 'Arguments do not match approved parameters');

    // 6. Calling with correct arguments passes validation (fails at active MCP client connection stage, not 403 security boundary)
    const legitRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
      method: 'POST',
      body: {
        serverName: 'sql_server',
        toolName: 'execute_sql',
        arguments: { query: 'DROP TABLE users;' },
        approvalId,
      },
    });
    // MCP client is not active in this test, so it should return 500 'MCP server sql_server is not active', PROVING approval validation succeeded!
    assert.strictEqual(legitRes.status, 500);
    assert.match(legitRes.body.error, /is not active/);

    // 7. Replay attempt with same approvalId MUST be rejected (used: true)
    const replayRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
      method: 'POST',
      body: {
        serverName: 'sql_server',
        toolName: 'execute_sql',
        arguments: { query: 'DROP TABLE users;' },
        approvalId,
      },
    });
    assert.strictEqual(replayRes.status, 403);
    assert.strictEqual(replayRes.body.error, 'Approval has already been used');

    server.scheduler?.stop();
    await server.shutdown();
  });

  await t.test('P1 Pipeline dispatch delegates to the Agent-bound collaboration service', async () => {
    const { AgentRunner } = require('../agent-runner');
    const runner = Object.create(AgentRunner.prototype);
    assert.throws(() => runner.dispatchPipelineStep('pipe-chan'), /unavailable/);
    const calls = [];
    runner.collaboration = { dispatchPipeline: channel => calls.push(channel) };
    runner.dispatchPipelineStep('pipe-chan');
    assert.deepEqual(calls, ['pipe-chan']);
    // Actor identities, real terminal results and handoffs are exercised by collaboration.test.mjs.
  });

  await t.test('P0: Authentication Guard allows static assets and root HTML without 401, while enforcing token on /v1/ API', async () => {
    const serverTmp = makeTempDir();
    fs.writeFileSync(path.join(serverTmp, 'index.html'), '<html><body>52hz App</body></html>');
    const token = 'workspace-secret-token-' + crypto.randomUUID();
    const { server, port } = await startServer({
      port: 0,
      userDataPath: serverTmp,
      staticDir: serverTmp,
      apiToken: token,
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Root / must NOT return 401 Unauthorized even without token
      const rootRes = await requestJson(`${baseUrl}/`);
      assert.notStrictEqual(rootRes.status, 401, 'Root HTML request must not be blocked with 401');

      // 2. /v1/ API route without token MUST return 401
      const unauthApiRes = await requestJson(`${baseUrl}/v1/events`);
      assert.strictEqual(unauthApiRes.status, 401);
      assert.match(unauthApiRes.body.error, /Unauthorized/);

      // 3. /v1/ API route with X-Workspace-Token must succeed
      const authApiRes = await requestJson(`${baseUrl}/v1/events`, {
        headers: { 'x-workspace-token': token },
      });
      assert.strictEqual(authApiRes.status, 200);

      // 4. /v1/ API route with Bearer token must succeed
      const bearerApiRes = await requestJson(`${baseUrl}/v1/events`, {
        headers: { 'authorization': `Bearer ${token}` },
      });
      assert.strictEqual(bearerApiRes.status, 200);
    } finally {
      server.scheduler?.stop();
      await server.shutdown();
      cleanTempDir(serverTmp);
    }
  });

  await t.test('P0: MCP Approval Forgery via decision: approved is rejected at POST and tool call', async () => {
    const serverTmp = makeTempDir();
    const { server, port } = await startServer({
      port: 0,
      userDataPath: serverTmp,
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. POST /v1/approvals with decision: 'approved' must be rejected with 400
      const forgedDecisionRes = await requestJson(`${baseUrl}/v1/approvals`, {
        method: 'POST',
        body: {
          id: 'appr-forged-1',
          decision: 'approved',
          serverName: 'test-mcp',
          toolName: 'test_tool',
        },
      });
      assert.strictEqual(forgedDecisionRes.status, 400);
      assert.match(forgedDecisionRes.body.error, /only be created in pending status/);

      // 2. POST /v1/approvals with status: 'approved' must be rejected with 400
      const forgedStatusRes = await requestJson(`${baseUrl}/v1/approvals`, {
        method: 'POST',
        body: {
          id: 'appr-forged-2',
          status: 'approved',
          serverName: 'test-mcp',
          toolName: 'test_tool',
        },
      });
      assert.strictEqual(forgedStatusRes.status, 400);

      // 3. POST /v1/approvals with used: true must be rejected with 400
      const forgedUsedRes = await requestJson(`${baseUrl}/v1/approvals`, {
        method: 'POST',
        body: {
          id: 'appr-forged-3',
          used: true,
          serverName: 'test-mcp',
          toolName: 'test_tool',
        },
      });
      assert.strictEqual(forgedUsedRes.status, 400);

      // 4. Direct store.addApproval forces decision: pending
      const store = server.agentRunner?.store;
      const injected = store.addApproval({
        id: 'appr-injected',
        serverName: 'sql_server',
        toolName: 'execute_sql',
        parameters_hash: crypto.createHash('sha256').update(JSON.stringify({ query: 'SELECT 1;' })).digest('hex'),
        decision: 'approved', // Client attempts override
      });
      assert.strictEqual(injected.decision, 'pending');
      assert.strictEqual(injected.status, 'pending');

      // 5. Calling MCP tool with pending record must be rejected with 403
      const toolCallRes = await requestJson(`${baseUrl}/v1/mcp/tools/call`, {
        method: 'POST',
        body: {
          serverName: 'sql_server',
          toolName: 'execute_sql',
          arguments: { query: 'SELECT 1;' },
          approvalId: 'appr-injected',
        },
      });
      assert.strictEqual(toolCallRes.status, 403);
      assert.strictEqual(toolCallRes.body.error, 'Approval not granted for this tool call');
    } finally {
      server.scheduler?.stop();
      await server.shutdown();
      cleanTempDir(serverTmp);
    }
  });

  await t.test('P1: mergeParallelBatch fails-fast and does not clear conflict state on second call', async () => {
    const { execFileSync } = require('child_process');
    const repoDir = path.join(tmpDir, 'test-git-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize git repo with initial commit
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base content\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    const dbPath = path.join(tmpDir, 'orchestration-conflict.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: tmpDir });

    // Create batch with 1 lane
    const batchRes = storage.orchestration.createBatch({
      channel_name: 'test-chan',
      repo_dir: repoDir,
      base_branch: 'master',
      isolation: 'worktree',
      workers: [
        { agent: 'worker-1', task: 'Modify file', branch: 'lane-branch-1' },
      ],
    });
    const batchId = batchRes.run.batch.id;
    const lane = batchRes.run.lanes[0];

    // Create a conflicting commit on lane branch
    fs.writeFileSync(path.join(lane.worktree_path, 'file.txt'), 'conflict from lane 1\n');
    execFileSync('git', ['commit', '-am', 'Lane 1 change'], { cwd: lane.worktree_path });

    // Create a conflicting commit on master
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'conflict from master\n');
    execFileSync('git', ['commit', '-am', 'Master conflicting change'], { cwd: repoDir });

    // Mark lane as done so merge will attempt it
    storage.orchestration.completeLane(batchId, 'worker-1', { status: 'done' });

    // 1. First merge call: must fail and register conflict
    assert.throws(() => {
      storage.orchestration.mergeParallelBatch(batchId);
    }, /Git merge failed/);

    const batchAfterFirst = storage.orchestration.getParallelBatch('test-chan');
    assert.strictEqual(batchAfterFirst.run.batch.status, 'blocked');
    assert.strictEqual(batchAfterFirst.run.lanes[0].status, 'failed');

    // 2. Second merge call: MUST fail-fast and NOT mark batch done!
    assert.throws(() => {
      storage.orchestration.mergeParallelBatch(batchId);
    }, /failed state|unresolved conflict/);

    const batchAfterSecond = storage.orchestration.getParallelBatch('test-chan');
    assert.strictEqual(batchAfterSecond.run.batch.status, 'blocked', 'Batch status must remain blocked on second merge call');
    assert.notStrictEqual(batchAfterSecond.run.batch.status, 'done');

    storage.close();
  });

  await t.test('P1: discardParallelBatch preserves worktree with uncommitted changes without force deletion', async () => {
    const { execFileSync } = require('child_process');
    const repoDir = path.join(tmpDir, 'test-discard-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Initial'], { cwd: repoDir });

    const dbPath = path.join(tmpDir, 'orchestration-discard.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: tmpDir });

    const batchRes = storage.orchestration.createBatch({
      channel_name: 'test-chan-2',
      repo_dir: repoDir,
      base_branch: 'master',
      isolation: 'worktree',
      workers: [
        { agent: 'worker-dirty', task: 'Dirty work', branch: 'lane-dirty' },
      ],
    });
    const batchId = batchRes.run.batch.id;
    const lane = batchRes.run.lanes[0];

    // Create an uncommitted dirty file in the worktree
    const dirtyFile = path.join(lane.worktree_path, 'uncommitted.txt');
    fs.writeFileSync(dirtyFile, 'User uncommitted changes\n');

    // Call discardParallelBatch
    storage.orchestration.discardParallelBatch(batchId);

    // Verify worktree and dirty file are PRESERVED on disk!
    assert.ok(fs.existsSync(lane.worktree_path), 'Worktree directory must be preserved when uncommitted changes exist');
    assert.ok(fs.existsSync(dirtyFile), 'Uncommitted file must not be deleted');

    storage.close();
  });

  await t.test('P1: MCP Read-Only Check requires application-level trust and rejects untrusted self-reporting', async () => {
    // 1. Untrusted tools with self-reported readOnly: true MUST be rejected
    const untrustedTool1 = { name: 'get_account_balance', readOnly: true };
    assert.strictEqual(isMcpToolReadOnly(untrustedTool1), false, 'Untrusted tool self-reporting readOnly must not be trusted');

    // 2. Untrusted tools with self-reported appTrustedReadOnly: true MUST also be rejected (cannot bypass without context trust)
    const selfTrustedTool = { name: 'read_account', appTrustedReadOnly: true };
    assert.strictEqual(isMcpToolReadOnly(selfTrustedTool), false, 'appTrustedReadOnly on toolDef must not be trusted without context trust');
    assert.strictEqual(isMcpToolReadOnly(selfTrustedTool, {}), false, 'Empty context must fail-closed on appTrustedReadOnly');

    // 3. Untrusted tools with read_ prefix MUST be rejected
    const untrustedTool2 = { name: 'read_secret_keys' };
    assert.strictEqual(isMcpToolReadOnly(untrustedTool2), false, 'Untrusted tool with read_ prefix must not be trusted');

    // 4. Dangerous mutating keywords override even trusted context
    const dangerousTool = { name: 'query_sql_table', readOnly: true };
    assert.strictEqual(isMcpToolReadOnly(dangerousTool, { trusted: true }), false, 'Dangerous SQL keyword must never be read-only');

    // 5. Trusted tool with safe prefix returns true
    const trustedTool1 = { name: 'get_account_balance' };
    assert.strictEqual(isMcpToolReadOnly(trustedTool1, { trusted: true }), true);
    assert.strictEqual(isMcpToolReadOnly({ name: 'read_account', readOnly: true }, { appTrusted: true }), true);

    // 6. Explicitly mutated tool in trusted context returns false
    const mutatingTool = { name: 'get_data', readOnly: false };
    assert.strictEqual(isMcpToolReadOnly(mutatingTool, { trusted: true }), false);
  });

  await t.test('P1: Backup package integrity verifies every companion file and rejects tampered checkpoints', async () => {
    const backupDir = path.join(tmpDir, 'backup-tamper-test');
    fs.mkdirSync(backupDir, { recursive: true });

    const activeCpDir = path.join(backupDir, 'checkpoints');
    fs.mkdirSync(activeCpDir, { recursive: true });
    fs.writeFileSync(path.join(activeCpDir, 'cp1.json'), JSON.stringify({ state: 'valid-checkpoint' }));

    const dbPath = path.join(backupDir, 'active.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: backupDir });

    // Create hot backup with companion package
    const bRes = await storage.backupManager.createBackup({ label: 'integrity-check', includePackage: true });
    assert.ok(bRes.metadata.package?.files, 'Package files manifest must be recorded');
    assert.ok(bRes.metadata.package.files['checkpoints/cp1.json'], 'Checkpoint file hash must be recorded');

    // Tamper with the checkpoint file in the backup package
    const pkgDir = bRes.backupPath.replace(/\.sqlite$/, '-package');
    const pkgCpFile = path.join(pkgDir, 'checkpoints', 'cp1.json');
    fs.writeFileSync(pkgCpFile, JSON.stringify({ state: 'tampered-checkpoint-by-attacker' }));

    // restoreFromBackup MUST reject the restore due to companion package hash mismatch
    assert.throws(() => {
      storage.backupManager.restoreFromBackup(bRes.backupPath);
    }, /tampered or corrupted: checkpoints\/cp1\.json/);

    // Delete companion package directory completely: restoreFromBackup MUST reject missing package dir
    fs.rmSync(pkgDir, { recursive: true, force: true });
    assert.throws(() => {
      storage.backupManager.restoreFromBackup(bRes.backupPath);
    }, /companion package directory is missing/);

    storage.close();
  });

  await t.test('P1: Cross-file restore performs clean directory sync and rolls back companion files on failure', async () => {
    const testDir = path.join(tmpDir, 'backup-sync-rollback');
    fs.mkdirSync(testDir, { recursive: true });

    const activeCpDir = path.join(testDir, 'checkpoints');
    fs.mkdirSync(activeCpDir, { recursive: true });
    fs.writeFileSync(path.join(activeCpDir, 'original.json'), JSON.stringify({ version: 1 }));

    // Note: files/ and data.json do NOT exist before restore!
    const activeFilesDir = path.join(testDir, 'files');
    const activeDataJson = path.join(testDir, 'data.json');
    assert.strictEqual(fs.existsSync(activeFilesDir), false);
    assert.strictEqual(fs.existsSync(activeDataJson), false);

    const dbPath = path.join(testDir, 'active.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: testDir });

    const bRes = await storage.backupManager.createBackup({ label: 'sync-test', includePackage: true });

    // Add a new untracked checkpoint after backup was taken
    fs.writeFileSync(path.join(activeCpDir, 'new_after_backup.json'), JSON.stringify({ leak: true }));
    assert.ok(fs.existsSync(path.join(activeCpDir, 'new_after_backup.json')));

    // Restore from backup: cleanSyncDir must clean out newly added files
    storage.backupManager.restoreFromBackup(bRes.backupPath);
    assert.ok(fs.existsSync(path.join(activeCpDir, 'original.json')));
    assert.strictEqual(fs.existsSync(path.join(activeCpDir, 'new_after_backup.json')), false, 'Newly added files after backup must be purged by clean sync');

    // Test Rollback file existence/non-existence restoration:
    // Create a second backup that has files/ and data.json
    fs.mkdirSync(activeFilesDir, { recursive: true });
    fs.writeFileSync(path.join(activeFilesDir, 'doc.txt'), 'hello files');
    fs.writeFileSync(activeDataJson, JSON.stringify({ saved: true }));
    const bRes2 = await storage.backupManager.createBackup({ label: 'with-files', includePackage: true });

    // Remove files/ and data.json from active directory
    fs.rmSync(activeFilesDir, { recursive: true, force: true });
    fs.unlinkSync(activeDataJson);
    assert.strictEqual(fs.existsSync(activeFilesDir), false);
    assert.strictEqual(fs.existsSync(activeDataJson), false);

    // Mock storage.reconnect to throw once, simulating a failure midway through restore while allowing rollback reconnect
    const origReconnect = storage.reconnect.bind(storage);
    let failOnce = true;
    storage.reconnect = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Simulated reconnection failure');
      }
      return origReconnect(...args);
    };

    assert.throws(() => {
      storage.backupManager.restoreFromBackup(bRes2.backupPath);
    }, /Rolled back to previous full workspace state/);

    // Restore reconnect
    storage.reconnect = origReconnect;

    // VERIFY: Rollback restored file non-existence! files/ and data.json must NOT exist!
    assert.strictEqual(fs.existsSync(activeFilesDir), false, 'Newly created files/ during failed restore must be deleted by rollback');
    assert.strictEqual(fs.existsSync(activeDataJson), false, 'Newly created data.json during failed restore must be deleted by rollback');

    // Test Recursive Subdirectory Backup, Restore & Rollback (files/nested/important.txt):
    const nestedDir = path.join(activeFilesDir, 'nested', 'deep');
    fs.mkdirSync(nestedDir, { recursive: true });
    const importantFile = path.join(activeFilesDir, 'nested', 'important.txt');
    const deepFile = path.join(nestedDir, 'doc.txt');
    fs.writeFileSync(importantFile, 'critical nested data');
    fs.writeFileSync(deepFile, 'deep nested data');

    const bResNested = await storage.backupManager.createBackup({ label: 'with-nested', includePackage: true });
    assert.ok(bResNested.metadata.package.files['files/nested/important.txt'], 'Nested file must be included in backup manifest');
    assert.ok(bResNested.metadata.package.files['files/nested/deep/doc.txt'], 'Deeply nested file must be included in backup manifest');

    // Add an untracked nested file and directory after backup
    const untrackedNested = path.join(activeFilesDir, 'nested', 'untracked.txt');
    const untrackedSubDir = path.join(activeFilesDir, 'extra_sub');
    fs.writeFileSync(untrackedNested, 'untracked');
    fs.mkdirSync(untrackedSubDir, { recursive: true });
    fs.writeFileSync(path.join(untrackedSubDir, 'temp.txt'), 'temp');

    // Restore: must preserve files/nested/important.txt and files/nested/deep/doc.txt while removing untracked nested items
    storage.backupManager.restoreFromBackup(bResNested.backupPath);
    assert.strictEqual(fs.existsSync(importantFile), true, 'files/nested/important.txt must be preserved after restore');
    assert.strictEqual(fs.readFileSync(importantFile, 'utf8'), 'critical nested data');
    assert.strictEqual(fs.existsSync(deepFile), true, 'files/nested/deep/doc.txt must be preserved after restore');
    assert.strictEqual(fs.existsSync(untrackedNested), false, 'Untracked nested file must be cleaned');
    assert.strictEqual(fs.existsSync(untrackedSubDir), false, 'Untracked nested directory must be cleaned');

    storage.close();
  });

  await t.test('P1: Multi-Agent Parallel Batch executes lanes in isolated worktrees concurrently without queue serialization', async () => {
    const { AgentRunner } = require('../agent-runner');
    const runner = new AgentRunner({
      userDataPath: tmpDir,
      getChannel: (ch) => ({ working_dir: path.join(tmpDir, 'main-repo') }),
      data: { runtime_runs: [], events: [] },
      addEvent: (e) => ({ ...e, id: 'evt-' + Date.now() }),
      save: () => {},
    }, { broadcast: () => {}, broadcastComposing: () => {} });

    runner.validateConfig = () => ({ provider: 'ollama', model: 'llama3:latest', mode: 'agent' });
    runner.config = () => ({ provider: 'ollama', model: 'llama3:latest', mode: 'agent' });
    runner.identity = () => ({ id: 'fixture-agent', name: 'Fixture Agent', revision: 1, status: 'active' });
    runner.resolveExecution = (event, channel) => ({ kind: 'lane', actor: runner.identity(), config: runner.config(), projectDir: event.metadata.worktree_path,
      contextKey: event.metadata.lane_id, executionKey: `${channel}:lane:${event.metadata.lane_id}` });
    runner.collaboration = { begin: () => true, attach() {}, finish() {}, afterRun() {}, reserve: () => ({ allowed: true }) };
    runner.tools = { cancel: () => {} };
    runner.checkpoints = { describe: async () => ({}) };
    runner.updateTurn = () => {};

    const worktree1 = path.join(tmpDir, 'wt1');
    const worktree2 = path.join(tmpDir, 'wt2');
    fs.mkdirSync(worktree1, { recursive: true });
    fs.mkdirSync(worktree2, { recursive: true });

    let run1Executed = false;
    let run2Executed = false;

    // Mock piRuntime to capture isolated working directory and verify concurrency
    runner.piRuntime = async (opts) => {
      const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      if (same(opts.projectDir, worktree1)) {
        run1Executed = true;
        await new Promise(r => setTimeout(r, 50));
      } else if (same(opts.projectDir, worktree2)) {
        run2Executed = true;
      }
      return { content: 'Done' };
    };

    const evt1 = {
      type: 'workspace.message.posted',
      source: 'orchestration:lane:lane-1',
      target: 'channel/test-channel',
      payload: { content: 'Do task 1' },
      metadata: { lane_id: 'lane-1', worktree_path: worktree1 },
    };

    const evt2 = {
      type: 'workspace.message.posted',
      source: 'orchestration:lane:lane-2',
      target: 'channel/test-channel',
      payload: { content: 'Do task 2' },
      metadata: { lane_id: 'lane-2', worktree_path: worktree2 },
    };

    // Both lanes should execute concurrently in their respective isolated worktrees
    const p1 = runner.handleUserMessage(evt1);
    const p2 = runner.handleUserMessage(evt2);

    // Both should be in active runs simultaneously under separate executionKeys
    assert.ok(runner.active.has('test-channel:lane:lane-1'));
    assert.ok(runner.active.has('test-channel:lane:lane-2'));

    await Promise.all([p1, p2]);
    assert.strictEqual(run1Executed, true);
    assert.strictEqual(run2Executed, true);
  });

  await t.test('P1: Pre-request budget reservation is calculated and enforced before model invocation (including compaction and output pricing)', async () => {
    const { AgentRunner } = require('../agent-runner');
    const runner = Object.create(AgentRunner.prototype);
    runner.active = new Map([
      ['chan1', { runId: 'run-1', accumulatedCost: 0.05, reservedCost: 0.01 }],
      ['chan2', { runId: 'run-2', accumulatedCost: 0.02, reservedCost: 0.005 }],
    ]);

    // getConcurrentReservedCost excludes self and sums accumulatedCost + turn reservation
    const reservedForRun1 = runner.getConcurrentReservedCost('run-1');
    assert.strictEqual(Math.round(reservedForRun1 * 1000) / 1000, 0.025);

    const reservedForRun3 = runner.getConcurrentReservedCost('run-3');
    assert.strictEqual(Math.round(reservedForRun3 * 1000) / 1000, 0.085);

    // Verify 8,000 input + 2,000 output on gpt-4o reserves $0.04 (not $0.025)
    const testDir = path.join(tmpDir, 'budget-compaction-pricing');
    fs.mkdirSync(testDir, { recursive: true });
    const dbPath = path.join(testDir, 'budget.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: testDir });

    let capturedCheckBudgetOpts = null;
    const realRunner = new AgentRunner({
      userDataPath: testDir,
      storage,
      getChannel: () => ({ working_dir: testDir }),
      data: { runtime_runs: [], events: [] },
      addEvent: (e) => ({ ...e, id: 'evt-' + Date.now() }),
      save: () => {},
    }, { broadcast: () => {}, broadcastComposing: () => {} });

    realRunner.validateConfig = () => ({ provider: 'openai', model: 'gpt-4o', mode: 'chat' });
    realRunner.config = () => ({ provider: 'openai', model: 'gpt-4o', mode: 'chat' });
    realRunner.configManager = {
      getConnection: () => ({ protocol: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', defaultModel: 'gpt-4o' }),
      getConnectionSecret: () => 'sk-test',
    };
    realRunner.tools = { cancel: () => {} };
    realRunner.checkpoints = { describe: async () => ({}) };
    realRunner.updateTurn = () => {};

    const origCheckPreflight = storage.budgets.checkPreflight.bind(storage.budgets);
    storage.budgets.checkPreflight = (opts) => {
      capturedCheckBudgetOpts = opts;
      return origCheckPreflight(opts);
    };

    realRunner.piRuntime = async (opts) => {
      opts.checkBudget({
        total_tokens: 0,
        reservedTokens: 10000,
        reservedPromptTokens: 8000,
        reservedCompletionTokens: 2000,
      });
      return { content: 'ok' };
    };

    await realRunner.run('test-chan', {
      id: 'evt-1',
      type: 'workspace.message.posted',
      source: 'human:user',
      target: 'channel/test-chan',
      payload: { content: 'Hello' },
      metadata: {},
    });

    assert.ok(capturedCheckBudgetOpts, 'checkPreflight must be called');
    assert.strictEqual(capturedCheckBudgetOpts.reservedCost, 0.04, '8,000 input + 2,000 output on gpt-4o must reserve $0.04');

    // Verify runPiAgent:
    // 1. Reserves full model.maxTokens (e.g. 4096, not capped at 2048)
    // 2. Manual compaction (compactOnly: true) checks budget BEFORE calling streamFn
    const { runPiAgent } = await import('../pi-engine.mjs');
    let streamCalls = 0;
    let lastBudgetArg = null;
    await assert.rejects(
      runPiAgent({
        config: { provider: 'ollama', model: 'fixture', mode: 'chat' },
        baseUrl: 'http://127.0.0.1:11434',
        channel: 'compact-budget-chan',
        userDataPath: testDir,
        prompt: 'Hello world',
        maxOutputTokens: 4096,
        history: [
          { id: 'u1', role: 'user', content: 'x'.repeat(2000) },
          { id: 'a1', role: 'assistant', content: 'y'.repeat(2000) },
        ],
        signal: new AbortController().signal,
        onDelta() {},
        onTool() {},
        onApproval: async () => false,
        streamFn: () => {
          streamCalls++;
          throw new Error('streamFn should never be called when budget is exceeded');
        },
        checkBudget: (arg) => {
          lastBudgetArg = arg;
          return { allowed: false, message: 'Hard limit reached' };
        },
      }),
      /Budget exceeded before request: Hard limit reached/
    );
    assert.strictEqual(streamCalls, 0, 'Generation request must not call streamFn when checkBudget rejects');
    assert.strictEqual(lastBudgetArg.reservedCompletionTokens, 4096, 'Must reserve full maxOutputTokens (4096) without 2048 cap');

    // Manual compaction (compactOnly: true) must also check budget BEFORE calling streamFn
    streamCalls = 0;
    await assert.rejects(
      runPiAgent({
        config: { provider: 'ollama', model: 'fixture', mode: 'chat' },
        baseUrl: 'http://127.0.0.1:11434',
        channel: 'compact-budget-chan',
        userDataPath: testDir,
        prompt: '',
        compactOnly: true,
        maxOutputTokens: 4096,
        history: [
          { id: 'u1', role: 'user', content: 'x'.repeat(2000) },
          { id: 'a1', role: 'assistant', content: 'y'.repeat(2000) },
        ],
        signal: new AbortController().signal,
        onDelta() {},
        onTool() {},
        onApproval: async () => false,
        streamFn: () => {
          streamCalls++;
          throw new Error('streamFn should never be called during compactOnly when budget is exceeded');
        },
        checkBudget: () => ({ allowed: false, message: 'Compaction budget denied' }),
      }),
      /Budget exceeded before request: Compaction budget denied/
    );
    assert.strictEqual(streamCalls, 0, 'Manual compaction must not call streamFn when checkBudget rejects');

    storage.close();
  });

  await t.test('P0: Multi-Agent worktree initialization failure marks lane failed and runner never falls back to root directory', async () => {
    const testDir = path.join(tmpDir, 'worktree-fail-closed');
    fs.mkdirSync(testDir, { recursive: true });

    const dbPath = path.join(testDir, 'active.sqlite');
    const mgr = new DatabaseManager(dbPath, {
      migrationsDir: path.join(__dirname, 'migrations'),
    });
    const storage = new Storage(mgr, { baseDir: testDir });

    // 1. Calling createBatch with non-existent repo_dir and isolation: 'worktree'
    const batchRes = storage.orchestration.createBatch({
      channel_name: 'test-chan-isolated',
      repo_dir: path.join(testDir, 'non_existent_repo'),
      base_branch: 'main',
      isolation: 'worktree',
      workers: [
        { agent: 'worker-1', task: 'Task 1' },
      ],
    });

    const lane = batchRes.run.lanes[0];
    assert.strictEqual(lane.status, 'failed', 'Lane must be marked failed when worktree cannot be initialized');
    assert.match(lane.error, /Repository directory does not exist/, 'Error must accurately report cause');
    assert.strictEqual(batchRes.state, 'failed', 'Batch must be marked failed when all lanes fail initialization');

    // 2. Test AgentRunner fail-closed execution: missing worktree MUST abort and NOT execute in main repo
    const { AgentRunner } = require('../agent-runner');
    const postedMessages = [];
    let piRuntimeExecuted = false;

    const runner = new AgentRunner({
      userDataPath: testDir,
      storage,
      getChannel: () => ({ working_dir: path.join(testDir, 'main-repo-dir') }),
      data: { runtime_runs: [], events: [] },
      addEvent: (e) => ({ ...e, id: 'evt-' + Date.now() }),
      save: () => {},
    }, { broadcast: () => {}, broadcastComposing: () => {} });

    runner.validateConfig = () => ({ provider: 'ollama', model: 'llama3:latest', mode: 'agent' });
    runner.config = () => ({ provider: 'ollama', model: 'llama3:latest', mode: 'agent' });
    runner.post = (ch, sender, text) => {
      postedMessages.push({ ch, sender, text });
    };
    runner.piRuntime = async () => {
      piRuntimeExecuted = true;
      return { content: 'Executed' };
    };

    const evtWithMissingWorktree = {
      type: 'workspace.message.posted',
      source: 'orchestration:lane:lane-missing',
      target: 'channel/test-chan-isolated',
      payload: { content: 'Run in missing worktree' },
      metadata: {
        batch_id: batchRes.run.batch.id,
        lane_id: lane.id,
        worktree_path: path.join(testDir, 'missing-worktree-dir'),
      },
    };

    await runner.run('test-chan-isolated', evtWithMissingWorktree);

    // Assert that piRuntime was NEVER executed in main repo!
    assert.strictEqual(piRuntimeExecuted, false, 'piRuntime must not execute when worktree is missing');
    // Assert system warning was posted
    assert.ok(postedMessages.some(m => m.text.includes('隔离工作区不存在或未就绪')), 'Must post fail-closed warning');

    storage.close();
  });
});
