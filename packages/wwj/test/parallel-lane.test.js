'use strict';

/*
  A parallel lane runs one turn in its own worktree, knows what its part is,
  and reports back when the turn ends -- for every adapter, via the base class.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseAdapter = require('../src/adapters/base');

class LaneAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.seen = [];
    this.behaviour = opts.behaviour || (async () => {});
  }
  async _handleMessage(msg) {
    const dir = await this._resolveWorkingDir(msg.sessionId || 'ch-1');
    this.seen.push({ content: msg.content, dir });
    await this.behaviour(msg);
  }
  async sendError() {}
  async sendStatus() {}
  async _resolveKnowledgeMentions(c) { return c; }
  async _releaseStaleTodos() {}
  async _registerFilesTouchedSince() {}
}

function make(behaviour) {
  const reports = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-home-'));
  const client = {
    getSession: async () => ({ workingDir: home }),
    completeParallelLane: async (ws, batchId, agent, result) => { reports.push({ batchId, agent, ...result }); },
    sendMessage: async () => ({}),
  };
  const a = new LaneAdapter({ agentName: 'pi', workspaceId: 'ws', endpoint: 'http://x', token: 't', client, behaviour });
  a._log = () => {};
  return { a, reports, home };
}

function laneMsg(worktree) {
  return {
    sessionId: 'ch-1',
    content: 'split the work',
    metadata: {
      parallel_batch: {
        batch_id: 'b-123',
        isolation: 'worktree',
        lanes: {
          PI: { task: 'rebuild the list', working_dir: worktree, branch: 'parallel/b-123/pi', port: 4101 },
          claude: { task: 'write the endpoint', working_dir: '/elsewhere', branch: 'parallel/b-123/claude', port: 4102 },
        },
      },
    },
  };
}

test('the lane turn runs in its worktree with its brief, then the directory goes back and completion is reported', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-wt-'));
  const { a, reports, home } = make(async function () { await this.sendResponse('ch-1', 'changed the list component'); });
  a.client.sendMessage = async () => ({});
  a.behaviour = async () => { await a.sendResponse('ch-1', 'changed the list component'); };

  await a._channelWorker('ch-1', laneMsg(worktree));

  assert.equal(a.seen[0].dir, worktree, 'turn ran in the lane worktree (agent name matched case-insensitively)');
  assert.match(a.seen[0].content, /Your part:\nrebuild the list/);
  assert.match(a.seen[0].content, /Do not commit, merge/);
  assert.match(a.seen[0].content, /dev server or any listening process, use port 4101 /, 'the brief names this lane\'s own port');
  assert.doesNotMatch(a.seen[0].content, /4102/, 'not another lane\'s port');
  assert.match(a.seen[0].content, /split the work$/);
  assert.deepEqual(reports, [{ batchId: 'b-123', agent: 'pi', status: 'done', error: '', reply: 'changed the list component' }]);

  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'normal turn', metadata: {} });
  assert.equal(a.seen[1].dir, home, 'the next turn is back in the channel folder');
  assert.equal(reports.length, 1, 'a normal turn reports nothing');
});

test('a lane without a port gets no port line', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-wt-'));
  const { a } = make();
  const msg = laneMsg(worktree);
  delete msg.metadata.parallel_batch.lanes.PI.port;
  await a._channelWorker('ch-1', msg);
  assert.doesNotMatch(a.seen[0].content, /use port/);
});

test('a failed lane turn is reported as failed', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-wt-'));
  const { a, reports } = make(async () => { throw new Error('upstream exploded'); });
  await a._channelWorker('ch-1', laneMsg(worktree));
  assert.equal(reports[0].status, 'failed');
});

test('a message whose batch has no lane for this agent is an ordinary turn', async () => {
  const { a, reports, home } = make();
  const msg = laneMsg('/x');
  delete msg.metadata.parallel_batch.lanes.PI;
  await a._channelWorker('ch-1', msg);
  assert.equal(a.seen[0].dir, home);
  assert.equal(a.seen[0].content, 'split the work');
  assert.equal(reports.length, 0);
});

test('a lane that pauses itself stays open, and its wake-up resumes it in the worktree', async () => {
  // Antigravity's `schedule` tool ends the CLI run mid-task ("check tsc again
  // at 10:00"). That turn ending is not the lane ending.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-wt-'));
  const { a, reports, home } = make();
  let seenLane = null;
  a.behaviour = async () => {
    seenLane = a.activeParallelLane('ch-1');
    a._deferParallelLane('ch-1');
  };
  await a._channelWorker('ch-1', laneMsg(worktree));

  assert.equal(seenLane && seenLane.batchId, 'b-123', 'the turn can see which lane it is running');
  assert.equal(reports.length, 0, 'a paused lane is not reported done');
  assert.equal(a.activeParallelLane('ch-1'), null, 'nothing lingers after the turn');

  // The timer fires with the lane (the backend's ParallelResumeMetadata).
  a.behaviour = async () => { await a.sendResponse('ch-1', 'tsc is clean; notes page optimised'); };
  const wake = laneMsg(worktree);
  wake.content = '⏰ Timer fired (set by @pi): check the tsc task';
  wake.metadata.parallel_batch.resume = true;
  await a._channelWorker('ch-1', wake);

  assert.equal(a.seen[1].dir, worktree, 'the wake-up runs in the lane worktree, not the channel folder');
  assert.match(a.seen[1].content, /^\[Parallel batch\] Resuming your part/);
  assert.match(a.seen[1].content, /Do not commit, merge/, 'the rules come back with it');
  assert.deepEqual(reports, [{ batchId: 'b-123', agent: 'pi', status: 'done', error: '', reply: 'tsc is clean; notes page optimised' }]);

  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'normal turn', metadata: {} });
  assert.equal(a.seen[2].dir, home);
});
