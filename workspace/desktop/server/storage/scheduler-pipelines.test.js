const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { createStorage } = require('./index');
const { SchedulerEngine } = require('../scheduler');
const { startServer } = require('../index');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '52hz-scheduler-test-'));
}

describe('Milestone M6: Scheduler & Pipelines (Package M)', () => {
  let tmpDir;
  let storage;

  before(() => {
    tmpDir = makeTempDir();
    storage = createStorage({
      dbPath: path.join(tmpDir, 'scheduler-test.db'),
    });
  });

  after(() => {
    if (storage) storage.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('M1: Scheduled Routines Repository', () => {
    let testRoutineId;

    test('creates routine with interval calculation and proper defaults', () => {
      const routine = storage.routines.create({
        name: 'Hourly Sync',
        channel_name: 'general',
        message: 'Sync repository status',
        interval_minutes: 60,
        requested_by: 'human:user',
      });

      assert.ok(routine.id);
      testRoutineId = routine.id;
      assert.equal(routine.name, 'Hourly Sync');
      assert.equal(routine.channel_name, 'general');
      assert.equal(routine.message, 'Sync repository status');
      assert.equal(routine.schedule_interval_minutes, 60);
      assert.equal(routine.status, 'active');
      assert.ok(routine.next_fires_at, 'next_fires_at should be computed');

      const nextFires = new Date(routine.next_fires_at).getTime();
      const now = Date.now();
      assert.ok(nextFires > now + 50 * 60 * 1000, 'Next fire time should be ~60 mins in the future');
    });

    test('creates daily routine with specific hour and minute', () => {
      const daily = storage.routines.create({
        name: 'Daily Standup',
        channel_name: 'standup',
        message: 'Post yesterday updates',
        hour: 9,
        minute: 30,
        days: [1, 2, 3, 4, 5],
      });

      assert.ok(daily.id);
      assert.equal(daily.schedule_hour, 9);
      assert.equal(daily.schedule_minute, 30);
      assert.deepEqual(daily.schedule_days, [1, 2, 3, 4, 5]);
      assert.ok(daily.next_fires_at);

      const target = new Date(daily.next_fires_at);
      assert.equal(target.getUTCHours(), 9);
      assert.equal(target.getUTCMinutes(), 30);
    });

    test('toggles routine status between active and paused', () => {
      const paused = storage.routines.toggle(testRoutineId);
      assert.equal(paused.status, 'paused');
      assert.equal(paused.next_fires_at, null);

      const resumed = storage.routines.toggle(testRoutineId);
      assert.equal(resumed.status, 'active');
      assert.ok(resumed.next_fires_at);
    });

    test('handles agent proposed routine pending approval lifecycle', () => {
      const proposed = storage.routines.create({
        name: 'Agent Cleaning',
        channel_name: 'general',
        message: 'Clean build cache',
        interval_minutes: 120,
        requested_by: 'agent:pi-agent',
      });

      assert.equal(proposed.status, 'pending_approval');
      assert.equal(proposed.next_fires_at, null);

      // Rejection branch test
      const rejected = storage.routines.reject(proposed.id);
      assert.equal(rejected.status, 'cancelled');

      // Approving non-pending throws 409
      assert.throws(() => {
        storage.routines.approve(rejected.id);
      }, /not pending approval/);

      // New proposal for approve
      const proposed2 = storage.routines.create({
        name: 'Agent Sync 2',
        channel_name: 'general',
        message: 'Sync files',
        requested_by: 'agent:pi-agent',
      });
      assert.equal(proposed2.status, 'pending_approval');

      const approved = storage.routines.approve(proposed2.id);
      assert.equal(approved.status, 'active');
      assert.ok(approved.next_fires_at);
    });

    test('records and completes routine execution runs', () => {
      const runRecord = storage.routines.recordRun(testRoutineId, {
        channel_name: 'general',
        trigger_message: 'Sync repository status',
      });

      assert.ok(runRecord.id);
      assert.equal(runRecord.status, 'running');

      const updatedRoutine = storage.routines.get(testRoutineId);
      assert.equal(updatedRoutine.run_count, 1);
      assert.equal(updatedRoutine.last_run_status, 'running');

      const completedRun = storage.routines.completeRun(runRecord.id, {
        status: 'completed',
        result: 'Sync completed cleanly',
      });

      assert.equal(completedRun.status, 'completed');
      assert.equal(completedRun.result, 'Sync completed cleanly');
      assert.ok(completedRun.completed_at);

      const runs = storage.routines.listRuns(testRoutineId);
      assert.ok(runs.length >= 1);
      assert.equal(runs[0].id, runRecord.id);
    });

    test('recovers orphaned runs left in running state on crash', () => {
      const orphaned = storage.routines.recordRun(testRoutineId, {
        channel_name: 'general',
        trigger_message: 'Crash test',
      });
      assert.equal(orphaned.status, 'running');

      const count = storage.routines.recoverOrphanedRuns();
      assert.ok(count >= 1);

      const runs = storage.routines.listRuns(testRoutineId);
      const target = runs.find((r) => r.id === orphaned.id);
      assert.equal(target.status, 'failed');
      assert.ok(target.error.includes('Orphaned run'));
    });
  });

  describe('M2: Timers Repository', () => {
    test('creates timer, lists active timers, and detects due timers', () => {
      const timer = storage.timers.create({
        channel_name: 'general',
        message: 'Reminder: commit changes',
        delay_seconds: 0, // due immediately
      });

      assert.ok(timer.id);
      assert.equal(timer.channel_name, 'general');
      assert.equal(timer.message, 'Reminder: commit changes');
      assert.equal(timer.status, 'active');

      const activeList = storage.timers.list({ channel: 'general' });
      assert.ok(activeList.some((t) => t.id === timer.id));

      const due = storage.timers.getDueTimers(new Date(Date.now() + 1000));
      assert.ok(due.some((t) => t.id === timer.id));

      storage.timers.markFired(timer.id);
      const afterFired = storage.timers.get(timer.id);
      assert.equal(afterFired.status, 'fired');

      const activeListAfter = storage.timers.list({ channel: 'general' });
      assert.ok(!activeListAfter.some((t) => t.id === timer.id));
    });

    test('deletes timer cleanly', () => {
      const t = storage.timers.create({
        channel_name: 'general',
        message: 'Will be deleted',
        delay_seconds: 300,
      });

      assert.equal(storage.timers.delete(t.id), true);
      assert.equal(storage.timers.get(t.id), null);
    });
  });

  describe('M3: Channel Pipelines Repository', () => {
    const channelId = 'test-pipeline-channel';

    test('returns inactive pipeline when none exists', () => {
      const pl = storage.pipelines.get('non-existent');
      assert.equal(pl.active, false);
      assert.equal(pl.supported, true);
    });

    test('creates multi-step pipeline and advances through steps', () => {
      const saved = storage.pipelines.save(channelId, {
        steps: [
          { agent: 'architect', instruction: 'Design system schema' },
          { agent: 'coder', instruction: 'Implement schema & migrations' },
          { agent: 'tester', instruction: 'Run integration test suite' },
        ],
        started_by: 'human:user',
        max_total_retries: 3,
      });

      assert.equal(saved.active, true);
      assert.equal(saved.status, 'running');
      assert.equal(saved.current_index, 0);
      assert.equal(saved.steps.length, 3);
      assert.equal(saved.steps[0].status, 'running');
      assert.equal(saved.steps[1].status, 'pending');

      // Halt pipeline
      const halted = storage.pipelines.halt(channelId);
      assert.equal(halted.status, 'paused');

      // Resume pipeline
      const resumed = storage.pipelines.resume(channelId);
      assert.equal(resumed.status, 'running');

      // Advance step 1
      const advanced1 = storage.pipelines.advance(channelId, { summary: 'Architecture approved' });
      assert.equal(advanced1.current_index, 1);
      assert.equal(advanced1.steps[0].status, 'done');
      assert.equal(advanced1.steps[0].deliverable.summary, 'Architecture approved');
      assert.equal(advanced1.steps[1].status, 'running');

      // Step 2 fails with retry
      const retrying = storage.pipelines.failStep(channelId, 'Syntax error on line 42');
      assert.equal(retrying.steps[1].status, 'retrying');
      assert.equal(retrying.steps[1].retry_count, 1);
      assert.equal(retrying.status, 'running');

      // Advance step 2
      storage.pipelines.advance(channelId, { summary: 'Implementation complete' });

      // Advance step 3 (last step) completes pipeline
      const final = storage.pipelines.advance(channelId, { summary: 'All tests passed' });
      assert.equal(final.active, false);
      assert.equal(final.status, 'completed');
      assert.equal(final.steps[2].status, 'done');
    });
  });

  describe('M4: Scheduler Engine & Agent Dispatching', () => {
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

    async function requestJson(method, reqPath, body = null, retries = 2) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await new Promise((resolve, reject) => {
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
        } catch (err) {
          if (attempt < retries && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')) {
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }
          throw err;
        }
      }
    }

    test('Scheduler tick evaluates timers and dispatches events without crash', async () => {
      // Create a timer via API
      const res = await requestJson('POST', '/v1/timers', {
        channel: 'general',
        message: 'Engine test timer',
        delay_seconds: 0,
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.id);

      // Trigger scheduler tick
      await serverInstance.scheduler.tick(new Date(Date.now() + 5000));

      // Timer should now be fired
      const listRes = await requestJson('GET', '/v1/timers?channel=general');
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.data.timers.some((t) => t.id === res.data.id));
    });

    test('REST API: complete routine CRUD, toggle and manual run', async () => {
      // 1. Create routine
      const createRes = await requestJson('POST', '/v1/routines', {
        name: 'API Routine',
        channel: 'general',
        message: 'Check build',
        interval_minutes: 30,
      });
      assert.equal(createRes.status, 200);
      const rId = createRes.data.id;
      assert.ok(rId);

      // 2. List routines
      const listRes = await requestJson('GET', '/v1/routines');
      assert.equal(listRes.status, 200);
      assert.ok(listRes.data.routines.some((r) => r.id === rId));

      // 3. Toggle routine
      const toggleRes = await requestJson('PATCH', `/v1/routines/${rId}/toggle`);
      assert.equal(toggleRes.status, 200);
      assert.equal(toggleRes.data.status, 'paused');

      // 4. Toggle back
      const toggleRes2 = await requestJson('PATCH', `/v1/routines/${rId}/toggle`);
      assert.equal(toggleRes2.status, 200);
      assert.equal(toggleRes2.data.status, 'active');

      // 5. Trigger manual run
      const runRes = await requestJson('POST', `/v1/routines/${rId}/run`);
      assert.equal(runRes.status, 200);
      assert.equal(runRes.data.success, true);

      // 6. Query routine execution runs
      const runsRes = await requestJson('GET', `/v1/routine-runs?routine_id=${rId}`);
      assert.equal(runsRes.status, 200);
      assert.ok(runsRes.data.runs.length >= 1);
      assert.equal(runsRes.data.runs[0].routine_id, rId);

      // 7. Delete routine
      const delRes = await requestJson('DELETE', `/v1/routines/${rId}`);
      assert.equal(delRes.status, 200);
      assert.equal(delRes.data.success, true);
    });

    test('REST API requires existing sessions and saved Agent IDs for pipelines', async () => {
      const missing = await requestJson('POST', '/v1/channels/missing-session/pipeline', {
        steps: [{ agent: 'step1-agent', instruction: 'Collect specs' }],
      });
      assert.equal(missing.status, 404);
      serverInstance.store.updateChannel('legacy-pipeline-validation', { title: 'Validation' });
      const legacy = await requestJson('POST', '/v1/channels/legacy-pipeline-validation/pipeline', {
        steps: [{ agent: 'step1-agent', instruction: 'Collect specs' }],
      });
      assert.equal(legacy.status, 404);
      const state = await requestJson('GET', '/v1/channels/legacy-pipeline-validation/pipeline');
      assert.equal(state.data.active, false);
    });
  });
});
