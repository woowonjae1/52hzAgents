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
          PI: { task: 'rebuild the list', working_dir: worktree, branch: 'parallel/b-123/pi' },
          claude: { task: 'write the endpoint', working_dir: '/elsewhere', branch: 'parallel/b-123/claude' },
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
  assert.match(a.seen[0].content, /split the work$/);
  assert.deepEqual(reports, [{ batchId: 'b-123', agent: 'pi', status: 'done', error: '', reply: 'changed the list component' }]);

  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'normal turn', metadata: {} });
  assert.equal(a.seen[1].dir, home, 'the next turn is back in the channel folder');
  assert.equal(reports.length, 1, 'a normal turn reports nothing');
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
