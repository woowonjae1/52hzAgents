const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { createStorage } = require('./index');
const { startServer } = require('../index');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '52hz-orchestration-test-'));
}

describe('Milestone M7: Multi-Agent Orchestration & Work Profiles (Package N)', () => {
  let tmpDir;
  let storage;

  before(() => {
    tmpDir = makeTempDir();
    storage = createStorage({
      dbPath: path.join(tmpDir, 'orchestration-test.db'),
    });
  });

  after(() => {
    if (storage) storage.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('N1: Work Profiles & Controlled Roles', () => {
    let profileId;

    test('creates and retrieves specialized agent work profiles', () => {
      const profile = storage.orchestration.createProfile({
        name: 'Backend Architect',
        agent: 'architect',
        role: 'system-designer',
        model: 'gemini-1.5-pro',
        mode: 'plan',
        description: 'Designs schemas and architectural contracts',
        allowed_tools: ['search_knowledge', 'read_file'],
        budget_tokens: 50000,
        budget_cost_micros: 100000,
      });

      assert.ok(profile.id);
      profileId = profile.id;
      assert.equal(profile.name, 'Backend Architect');
      assert.equal(profile.agent, 'architect');
      assert.equal(profile.role, 'system-designer');
      assert.equal(profile.model, 'gemini-1.5-pro');
      assert.equal(profile.mode, 'plan');
      assert.deepEqual(profile.allowed_tools, ['search_knowledge', 'read_file']);
      assert.equal(profile.budget_tokens, 50000);

      const fetched = storage.orchestration.getProfile(profileId);
      assert.equal(fetched.id, profileId);
      assert.equal(fetched.name, 'Backend Architect');
    });

    test('updates work profile configuration and budgets', () => {
      const updated = storage.orchestration.updateProfile(profileId, {
        name: 'Lead Architect',
        budget_tokens: 80000,
      });

      assert.equal(updated.name, 'Lead Architect');
      assert.equal(updated.budget_tokens, 80000);
      assert.equal(updated.agent, 'architect'); // preserved
    });

    test('lists and deletes work profiles', () => {
      const list = storage.orchestration.listProfiles();
      assert.ok(list.length >= 1);
      assert.ok(list.some((p) => p.id === profileId));

      const deleted = storage.orchestration.deleteProfile(profileId);
      assert.equal(deleted, true);
      assert.equal(storage.orchestration.getProfile(profileId), null);
    });
  });

  describe('N2: Parallel Batches, Scope Conflicts & Isolation', () => {
    test('detects overlapping directory scopes in shared mode', () => {
      const workers = [
        { agent: 'frontend', scope: 'src/components' },
        { agent: 'auth', scope: 'src/components/auth' }, // conflict!
      ];

      const conflicts = storage.orchestration.detectScopeConflicts(workers);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].assignee_a, 'frontend');
      assert.equal(conflicts[0].assignee_b, 'auth');
      assert.ok(conflicts[0].reason.includes('overlaps'));
    });

    test('detects missing scopes in shared mode as global conflicts', () => {
      const workers = [
        { agent: 'worker-a', scope: '' },
        { agent: 'worker-b', scope: 'server' },
      ];

      const conflicts = storage.orchestration.detectScopeConflicts(workers);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0].reason.includes('lack an isolated directory scope'));
    });

    test('passes non-overlapping scopes cleanly', () => {
      const workers = [
        { agent: 'ui', scope: 'src/frontend' },
        { agent: 'api', scope: 'src/backend' },
        { agent: 'docs', scope: 'docs' },
      ];

      const conflicts = storage.orchestration.detectScopeConflicts(workers);
      assert.equal(conflicts.length, 0);
    });

    test('launches parallel batch with worktree isolation', () => {
      const result = storage.orchestration.createBatch({
        channel_name: 'feature-dev',
        isolation: 'worktree',
        base_branch: 'main',
        review_agent: 'code-reviewer',
        delegated_by: 'supervisor',
        workers: [
          { agent: 'coder-a', task: 'Implement auth controller', scope: 'src/auth' },
          { agent: 'coder-b', task: 'Implement billing service', scope: 'src/billing' },
        ],
      });

      assert.equal(result.state, 'running');
      assert.equal(result.isolated, true);
      assert.equal(result.review_agent, 'code-reviewer');
      assert.equal(result.total, 2);
      assert.equal(result.done, 0);
      assert.ok(result.run.batch.id);
      assert.equal(result.run.lanes.length, 2);
      assert.equal(result.run.lanes[0].status, 'running');
      assert.equal(result.run.lanes[1].status, 'running');
    });

    test('blocks batch start when shared directory mode has scope conflicts', () => {
      const blocked = storage.orchestration.createBatch({
        channel_name: 'shared-channel',
        isolation: 'shared',
        workers: [
          { agent: 'worker-1', task: 'Task 1', scope: 'controllers' },
          { agent: 'worker-2', task: 'Task 2', scope: 'controllers/user' },
        ],
      });

      assert.equal(blocked.state, 'blocked');
      assert.ok(blocked.conflicts.length > 0);
    });
  });

  describe('N3: Lane Completion, Review, Retry & Merging', () => {
    let batchId;

    before(() => {
      const created = storage.orchestration.createBatch({
        channel_name: 'test-lifecycle-channel',
        isolation: 'worktree',
        base_branch: 'main',
        review_agent: 'reviewer',
        workers: [
          { agent: 'agent-1', task: 'Task 1' },
          { agent: 'agent-2', task: 'Task 2' },
        ],
      });
      batchId = created.run.batch.id;
    });

    test('completing lanes updates status and transitions batch to review when all finish', () => {
      // 1. Complete lane 1
      const step1 = storage.orchestration.completeLane(batchId, 'agent-1', {
        status: 'done',
        reply: 'Task 1 completed successfully',
        commit_hash: 'abc1234',
        diffstat: '2 files changed, 10 insertions(+)',
        changed_files: 'src/a.js\nsrc/b.js',
      });

      assert.equal(step1.done, 1);
      assert.equal(step1.run.batch.status, 'running'); // lane 2 still running

      // 2. Complete lane 2
      const step2 = storage.orchestration.completeLane(batchId, 'agent-2', {
        status: 'done',
        reply: 'Task 2 completed successfully',
        commit_hash: 'def5678',
        diffstat: '1 file changed, 5 insertions(+)',
        changed_files: 'src/c.js',
      });

      assert.equal(step2.done, 2);
      assert.equal(step2.run.batch.status, 'review'); // all lanes finished -> review state
    });

    test('supports review workflow, notes, and send-back to author', () => {
      // Start review on lane 1
      storage.orchestration.retryLaneReview(batchId, 'agent-1');
      let batch = storage.orchestration.getParallelBatch('test-lifecycle-channel');
      const lane1 = batch.run.lanes.find((l) => l.agent === 'agent-1');
      assert.equal(lane1.review_status, 'running');

      // Complete review with changes requested
      storage.orchestration.completeLaneReview(batchId, 'agent-1', {
        status: 'changes_requested',
        notes: 'Please add unit tests for error cases',
        reviewer: 'reviewer',
      });

      // Send back lane to author
      storage.orchestration.sendBackParallelLane(batchId, 'agent-1');
      batch = storage.orchestration.getParallelBatch('test-lifecycle-channel');
      const sentBackLane = batch.run.lanes.find((l) => l.agent === 'agent-1');
      assert.equal(sentBackLane.status, 'running');
      assert.equal(sentBackLane.review_status, 'changes_requested');

      // Re-complete lane 1
      storage.orchestration.completeLane(batchId, 'agent-1', {
        status: 'done',
        reply: 'Added unit tests',
      });

      // Complete review with approval
      storage.orchestration.completeLaneReview(batchId, 'agent-1', {
        status: 'approved',
        notes: 'LGTM!',
      });
    });

    test('supports retrying a lane', () => {
      const retried = storage.orchestration.retryParallelLane(batchId, 'agent-2');
      const lane2 = retried.run.lanes.find((l) => l.agent === 'agent-2');
      assert.equal(lane2.status, 'running');
      assert.equal(lane2.attempts, 2);
      assert.equal(retried.run.batch.status, 'running');

      // Re-finish lane 2
      storage.orchestration.completeLane(batchId, 'agent-2', { status: 'done' });
    });

    test('merging batch marks lanes merged and batch done', () => {
      const merged = storage.orchestration.mergeParallelBatch(batchId);
      assert.equal(merged.run.batch.status, 'done');
      assert.ok(merged.run.lanes.every((l) => l.status === 'merged'));
    });

    test('stopping a batch cancels active lanes', () => {
      const runningBatch = storage.orchestration.createBatch({
        channel_name: 'cancel-test-channel',
        workers: [{ agent: 'worker-x', task: 'Long task' }],
      });
      const bId = runningBatch.run.batch.id;

      const stopped = storage.orchestration.stopParallelBatch(bId);
      assert.equal(stopped.run.batch.status, 'done');
      assert.equal(stopped.run.lanes[0].status, 'failed');
      assert.equal(stopped.run.lanes[0].error, 'Stopped by user');
    });
  });

  describe('N4: REST API Endpoints & Delegation Tooling', () => {
    let serverInstance;
    let serverPort;
    let serverDir;

    before(async () => {
      serverDir = makeTempDir();
      const started = await startServer({
        port: 0,
        userDataPath: serverDir,
      });
      serverInstance = started.server;
      serverPort = started.port;
    });

    after(async () => {
      if (serverInstance) {
        await serverInstance.shutdown();
      }
      if (serverDir && fs.existsSync(serverDir)) {
        fs.rmSync(serverDir, { recursive: true, force: true });
      }
    });

    function requestJson(method, reqPath, body = null) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${serverPort}${reqPath}`,
          {
            method,
            headers: {
              'Content-Type': 'application/json',
              Host: `127.0.0.1:${serverPort}`,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                resolve({ status: res.statusCode, data: parsed });
              } catch (_) {
                resolve({ status: res.statusCode, raw: data });
              }
            });
          }
        );
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    }

    test('REST API: Work profiles CRUD', async () => {
      // 1. Create Profile
      const createRes = await requestJson('POST', '/v1/workspaces/52hz/profiles', {
        name: 'API Tester',
        agent: 'tester',
        role: 'qa',
        mode: 'execute',
      });
      assert.equal(createRes.status, 200);
      const profId = createRes.data.id;
      assert.ok(profId);

      // 2. List Profiles
      const listRes = await requestJson('GET', '/v1/workspaces/52hz/profiles');
      assert.equal(listRes.status, 200);
      assert.ok(listRes.data.profiles.some((p) => p.id === profId));

      // 3. Patch Profile
      const patchRes = await requestJson('PATCH', `/v1/workspaces/52hz/profiles/${profId}`, {
        name: 'Senior QA',
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.data.name, 'Senior QA');

      // 4. Delete Profile
      const delRes = await requestJson('DELETE', `/v1/workspaces/52hz/profiles/${profId}`);
      assert.equal(delRes.status, 200);
      assert.equal(delRes.data.success, true);
    });

    test('REST API: Parallel batch complete lifecycle via HTTP', async () => {
      const channel = 'api-parallel-channel';

      // 1. GET parallel batch (idle)
      const initRes = await requestJson('GET', `/v1/parallel-batch?channel=${channel}`);
      assert.equal(initRes.status, 200);
      assert.equal(initRes.data.state, 'idle');

      // 2. Start batch
      const startRes = await requestJson('POST', '/v1/parallel-batch/start', {
        channel_name: channel,
        isolation: 'worktree',
        workers: [
          { agent: 'dev-1', task: 'Implement login' },
          { agent: 'dev-2', task: 'Implement logout' },
        ],
      });
      assert.equal(startRes.status, 200);
      assert.equal(startRes.data.state, 'running');
      const bId = startRes.data.run.batch.id;
      assert.ok(bId);

      // 3. Complete lane 1
      const c1Res = await requestJson('POST', `/v1/workspaces/52hz/parallel-batches/${bId}/lanes/dev-1/complete`, {
        status: 'done',
        reply: 'Login done',
      });
      assert.equal(c1Res.status, 200);

      // 4. Complete lane 2
      const c2Res = await requestJson('POST', `/v1/workspaces/52hz/parallel-batches/${bId}/lanes/dev-2/complete`, {
        status: 'done',
        reply: 'Logout done',
      });
      assert.equal(c2Res.status, 200);
      assert.equal(c2Res.data.run.batch.status, 'review');

      // 5. Review complete
      const revRes = await requestJson('POST', `/v1/workspaces/52hz/parallel-batches/${bId}/lanes/dev-1/review/complete`, {
        verdict: 'approved',
        notes: 'Great work',
      });
      assert.equal(revRes.status, 200);

      // 6. Merge batch
      const mergeRes = await requestJson('POST', `/v1/workspaces/52hz/parallel-batches/${bId}/merge`);
      assert.equal(mergeRes.status, 200);
      assert.equal(mergeRes.data.run.batch.status, 'done');
    });
  });
});
