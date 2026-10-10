'use strict';

/*
  A lane review runs one read-only turn in the review copy of another agent's
  lane, with the backend's brief as the message, and reports the reply (with
  its verdict block) when the turn ends -- for every adapter, via the base class.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseAdapter = require('../src/adapters/base');

class ReviewAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.seen = [];
    this.released = [];
    this.behaviour = async () => {};
  }
  async _handleMessage(msg) {
    const channel = msg.sessionId || 'review:b-123:claude';
    const dir = await this._resolveWorkingDir(channel);
    this.seen.push({ content: msg.content, dir, mode: this._mode });
    await this.behaviour(msg, channel);
  }
  async _releaseLaneProcess(channel) { this.released.push(channel); }
  async sendError() {}
  async sendStatus() {}
  async _resolveKnowledgeMentions(c) { return c; }
  async _releaseStaleTodos() {}
  async _registerFilesTouchedSince() {}
}

function make() {
  const reports = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-home-'));
  const client = {
    getSession: async () => ({ workingDir: home }),
    completeLaneReview: async (ws, batchId, lane, result) => { reports.push({ batchId, lane, ...result }); },
    completeParallelLane: async () => { throw new Error('a review is not a lane'); },
    sendMessage: async () => ({}),
  };
  const a = new ReviewAdapter({ agentName: 'codex', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  a._log = () => {};
  return { a, reports, home };
}

const THREAD = 'review:b-123:claude';

function reviewMsg(copy, target = 'codex') {
  return {
    sessionId: THREAD,
    content: '[Review before merge] Review @claude\'s part ...',
    metadata: {
      agent_mode: 'plan',
      target_agents: [target],
      parallel_review: { batch_id: 'b-123', lane: 'claude', working_dir: copy },
    },
  };
}

const VERDICT = 'b.txt lacks a test.\n\n```verdict\n{"verdict": "changes_requested"}\n```';

test('the review turn runs read-only in the copy and reports its whole reply, verdict block included', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-review-'));
  const { a, reports, home } = make();
  a.behaviour = async (_msg, channel) => { await a.sendResponse(channel, VERDICT); };

  await a._channelWorker(THREAD, reviewMsg(copy));

  assert.equal(a.seen[0].dir, copy, 'turn ran in the review copy');
  assert.equal(a.seen[0].mode, 'plan', 'turn ran read-only');
  assert.equal(a.seen[0].content, reviewMsg(copy).content, 'the brief is the message, with no lane brief prepended');
  assert.deepEqual(a.released, [THREAD], 'the process in the copy is released before reporting');
  assert.deepEqual(reports, [{ batchId: 'b-123', lane: 'claude', reviewer: 'codex', status: 'done', error: '', reply: VERDICT }]);

  await a._channelWorker(THREAD, { sessionId: THREAD, content: 'why?', metadata: {} });
  assert.equal(a.seen[1].dir, home, 'a follow-up question is not a review: back in the thread folder');
  assert.equal(reports.length, 1, 'and reports nothing');
});

test('a failed review turn is reported as failed with its error', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-review-'));
  const { a, reports } = make();
  a.behaviour = async () => { throw new Error('cli crashed'); };

  await a._channelWorker(THREAD, reviewMsg(copy));

  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'failed');
  assert.match(reports[0].error, /cli crashed/);
});

test('a review addressed to another agent is not this agent\'s review', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-review-'));
  const { a, reports, home } = make();

  await a._channelWorker(THREAD, reviewMsg(copy, 'pi'));

  assert.equal(a.seen[0].dir, home);
  assert.equal(reports.length, 0);
});

test('a long reply keeps its end, where the verdict block is', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-review-'));
  const { a, reports } = make();
  const long = 'x'.repeat(20000) + '\n' + VERDICT;
  a.behaviour = async (_msg, channel) => { await a.sendResponse(channel, long); };

  await a._channelWorker(THREAD, reviewMsg(copy));

  assert.equal(reports[0].reply.length, 16000);
  assert.ok(reports[0].reply.endsWith('```'), 'the verdict block survives the cut');
});
