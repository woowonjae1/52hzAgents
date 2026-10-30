const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createStorage, closeDatabasesUnder } = require('./index');
const { RunsRepository, PHASES, OUTCOMES } = require('./repositories/runs');
const { startServer } = require('../index');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Task State Machine & Event Recovery (Package C)', () => {
  let storage;

  before(() => {
    storage = createStorage({ dbPath: ':memory:' });
    // Create baseline session
    storage.sessions.create({ id: 'sess_c_test', title: 'Package C Session' });
  });

  after(() => {
    if (storage) storage.close();
  });

  describe('C1: State Machine & Deterministic Transitions', () => {
    it('progresses through permitted lifecycle phases and reaches terminal outcome', () => {
      const run = storage.runs.create({
        id: 'run_sm_1',
        sessionId: 'sess_c_test',
        agentName: 'pi-agent',
        mode: 'agent',
        phase: PHASES.QUEUED,
      });

      assert.equal(run.phase, PHASES.QUEUED);
      assert.equal(run.version, 1);

      // queued -> preparing
      const prep = storage.runs.transition('run_sm_1', {
        expectedPhase: PHASES.QUEUED,
        nextPhase: PHASES.PREPARING,
      });
      assert.equal(prep.phase, PHASES.PREPARING);
      assert.equal(prep.version, 2);

      // preparing -> generating
      const gen = storage.runs.transition('run_sm_1', {
        nextPhase: PHASES.GENERATING,
      });
      assert.equal(gen.phase, PHASES.GENERATING);

      // generating -> executing
      const exec = storage.runs.transition('run_sm_1', {
        nextPhase: PHASES.EXECUTING,
      });
      assert.equal(exec.phase, PHASES.EXECUTING);

      // executing -> waiting_approval
      const wait = storage.runs.transition('run_sm_1', {
        nextPhase: PHASES.WAITING_APPROVAL,
      });
      assert.equal(wait.phase, PHASES.WAITING_APPROVAL);

      // waiting_approval -> executing
      const exec2 = storage.runs.transition('run_sm_1', {
        nextPhase: PHASES.EXECUTING,
      });
      assert.equal(exec2.phase, PHASES.EXECUTING);

      // executing -> finished
      const fin = storage.runs.transition('run_sm_1', {
        nextPhase: PHASES.FINISHED,
        outcome: OUTCOMES.SUCCEEDED,
        evidence: { files_modified: ['index.js'] },
      });
      assert.equal(fin.phase, PHASES.FINISHED);
      assert.equal(fin.outcome, OUTCOMES.SUCCEEDED);
      assert.ok(fin.endedAt);
      assert.deepEqual(fin.evidence, { files_modified: ['index.js'] });
    });

    it('rejects invalid phase jumps and prohibits transitions from finished', () => {
      const run = storage.runs.create({
        id: 'run_sm_invalid',
        sessionId: 'sess_c_test',
        phase: PHASES.QUEUED,
      });

      // queued -> executing is not permitted
      assert.throws(() => {
        storage.runs.transition('run_sm_invalid', { nextPhase: PHASES.EXECUTING });
      }, /Invalid phase transition/);

      // Finish the run
      storage.runs.finish('run_sm_invalid', { outcome: OUTCOMES.CANCELLED });
      assert.equal(storage.runs.get('run_sm_invalid').phase, PHASES.FINISHED);

      // Transitioning from finished must throw
      assert.throws(() => {
        storage.runs.transition('run_sm_invalid', { nextPhase: PHASES.GENERATING });
      }, /Cannot transition run run_sm_invalid from terminal phase 'finished'/);
    });

    it('handles cancellation arbitration and race condition protection', () => {
      const run = storage.runs.create({
        id: 'run_sm_race',
        sessionId: 'sess_c_test',
        phase: PHASES.GENERATING,
      });

      // Cancellation
      const cancelled = storage.runs.cancel('run_sm_race');
      assert.equal(cancelled.phase, PHASES.FINISHED);
      assert.equal(cancelled.outcome, OUTCOMES.CANCELLED);

      // Idempotent cancel should succeed without error
      const cancelledAgain = storage.runs.cancel('run_sm_race');
      assert.equal(cancelledAgain.outcome, OUTCOMES.CANCELLED);
    });
  });

  describe('C2: Persistent Queue & Lease Heartbeat', () => {
    it('creates runs with clientMessageId and tracks heartbeats/leases', () => {
      const clientMsgId = 'client_msg_1001';
      const run = storage.runs.create({
        id: 'run_heartbeat_1',
        sessionId: 'sess_c_test',
        clientMessageId: clientMsgId,
        phase: PHASES.QUEUED,
      });

      assert.equal(run.clientMessageId, clientMsgId);

      // Lookup by clientMessageId
      const found = storage.runs.getByClientMessageId(clientMsgId);
      assert.ok(found);
      assert.equal(found.id, 'run_heartbeat_1');

      // Heartbeat lease update
      storage.runs.heartbeat('run_heartbeat_1', 60000);
      const updated = storage.runs.get('run_heartbeat_1');
      assert.ok(updated.heartbeatAt > 0);
      assert.ok(updated.leaseExpiresAt > Date.now());
    });
  });

  describe('C3: Event Sequence Replay & SSE Reconnection', () => {
    it('assigns monotonic seq to events and replays missed events by afterSeq', () => {
      const e1 = storage.events.append({
        sessionId: 'sess_c_test',
        type: 'step.1',
        target: 'channel/sess_c_test',
      });
      const e2 = storage.events.append({
        sessionId: 'sess_c_test',
        type: 'step.2',
        target: 'channel/sess_c_test',
      });
      const e3 = storage.events.append({
        sessionId: 'sess_c_test',
        type: 'step.3',
        target: 'channel/sess_c_test',
      });

      assert.ok(e1.seq < e2.seq && e2.seq < e3.seq);

      // Replay events after e1.seq
      const replayed = storage.events.list({
        sessionId: 'sess_c_test',
        afterSeq: e1.seq,
      });

      assert.equal(replayed.length, 2);
      assert.equal(replayed[0].seq, e2.seq);
      assert.equal(replayed[1].seq, e3.seq);
    });

    it('replays missed events over SSE stream when Last-Event-ID or after_seq is sent', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-sse-test-'));
      const instance = await startServer({ port: 0, userDataPath: tempDir });
      const server = instance.server;
      const port = instance.port;

      try {
        // Post 2 events to channel
        const postEvent = async (content) => {
          return new Promise((resolve, reject) => {
            const req = http.request({
              hostname: '127.0.0.1',
              port,
              path: '/v1/events',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            }, res => {
              let body = '';
              res.on('data', d => body += d);
              res.on('end', () => resolve(JSON.parse(body)));
            });
            req.on('error', reject);
            req.write(JSON.stringify({
              type: 'workspace.event',
              target: 'channel/general',
              payload: { content, sender_name: 'System', sender_type: 'system' },
            }));
            req.end();
          });
        };

        const ev1 = await postEvent('First SSE event');
        const ev2 = await postEvent('Second SSE event');

        // Connect SSE with after_seq = 0
        const sseOutput = await new Promise((resolve, reject) => {
          let buffer = '';
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/v1/events/stream?channel=general&after_seq=0',
            method: 'GET',
            headers: { 'Accept': 'text/event-stream' },
          }, res => {
            res.on('data', chunk => {
              buffer += chunk.toString();
              if (buffer.includes('First SSE event') || buffer.includes('Second SSE event')) {
                req.destroy();
                resolve(buffer);
              }
            });
          });
          req.on('error', err => {
            if (req.destroyed) resolve(buffer);
            else reject(err);
          });
          req.end();
        });

        assert.ok(sseOutput.includes('Second SSE event') || sseOutput.includes('id:'));
      } finally {
        server.close();
        closeDatabasesUnder(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('C4: Interrupted Execution Recovery & Unknown Outcome Verification', () => {
    it('detects uncompleted runs on crash/restart and flags unverified tools', () => {
      // Simulate crashed run
      const crashedRun = storage.runs.create({
        id: 'run_crashed_101',
        sessionId: 'sess_c_test',
        agentName: 'pi-agent',
        phase: PHASES.EXECUTING,
      });

      // Simulate tool call that was in progress when process died
      storage.tools.recordStart({
        id: 'tc_crashed_tool',
        runId: 'run_crashed_101',
        sessionId: 'sess_c_test',
        toolName: 'execute_command',
        args: { command: 'npm install' },
        status: 'running',
        path: 'package.json',
      });

      assert.equal(storage.runs.get('run_crashed_101').phase, PHASES.EXECUTING);
      assert.equal(storage.tools.get('tc_crashed_tool').status, 'running');

      // Run recovery (simulating app restart)
      const recovered = storage.runs.recoverInterrupted();
      assert.ok(recovered.some(r => r.id === 'run_crashed_101'));

      const postRecoverRun = storage.runs.get('run_crashed_101');
      assert.equal(postRecoverRun.phase, PHASES.FINISHED);
      assert.equal(postRecoverRun.outcome, OUTCOMES.INTERRUPTED);
      assert.equal(postRecoverRun.evidence.requires_verification, true);
      assert.equal(postRecoverRun.evidence.unverified_tools.length, 1);
      assert.equal(postRecoverRun.evidence.unverified_tools[0].id, 'tc_crashed_tool');

      const postRecoverTool = storage.tools.get('tc_crashed_tool');
      assert.equal(postRecoverTool.status, 'unknown_outcome');
    });
  });
});
