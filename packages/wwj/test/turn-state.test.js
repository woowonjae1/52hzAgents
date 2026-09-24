'use strict';

/*
  The agent reports its own turn state (running / idle / error) instead of the
  UI guessing from the message stream, and its message cursor survives a
  restart so messages posted while it was down are not silently lost.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseAdapter = require('../src/adapters/base');

class TurnAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.behaviour = opts.behaviour || (async () => {});
    this.handled = [];
  }
  async _handleMessage(msg) {
    this.handled.push(msg.content);
    await this.behaviour.call(this, msg);
  }
  async sendStatus() {}
  async _resolveKnowledgeMentions(c) { return c; }
  async _releaseStaleTodos() {}
  async _registerFilesTouchedSince() {}
}

function make({ behaviour, client: extra } = {}) {
  const turns = [];
  const client = {
    reportAgentTurn: async (ws, agent, turn) => { turns.push({ agent, ...turn }); return turn; },
    sendMessage: async () => ({}),
    ...(extra || {}),
  };
  const a = new TurnAdapter({ agentName: 'pi', workspaceId: 'ws-1', endpoint: 'http://x', token: 't', client, behaviour });
  a._log = () => {};
  a._reportStatus = () => {};
  return { a, turns, client };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a successful turn is reported running, then idle', async () => {
  const { a, turns } = make();
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'hello', metadata: {} });
  await settle();
  assert.deepEqual(turns, [
    { agent: 'pi', channel: 'ch-1', state: 'running' },
    { agent: 'pi', channel: 'ch-1', state: 'idle' },
  ]);
  assert.equal(a._runningTurns.size, 0);
});

test('a thrown turn is reported as error with its message', async () => {
  const { a, turns } = make({ behaviour: async () => { throw new Error('CLI exited 1'); } });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'boom', metadata: {} });
  await settle();
  assert.equal(turns.length, 2);
  assert.equal(turns[1].state, 'error');
  assert.match(turns[1].error, /CLI exited 1/);
});

test('a turn the adapter ends with sendError is an error too, and the next turn clears it', async () => {
  let fail = true;
  const { a, turns } = make({
    behaviour: async function () { if (fail) await this.sendError('ch-1', 'model quota exhausted'); },
  });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'one', metadata: {} });
  fail = false;
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'two', metadata: {} });
  await settle();
  assert.deepEqual(turns.map((t) => t.state), ['running', 'error', 'running', 'idle']);
  assert.equal(turns[1].error, 'model quota exhausted');
  assert.equal(turns[3].error, undefined);
});

test('queued messages drained by the worker are separate turns', async () => {
  const { a, turns } = make();
  a._channelQueues['ch-1'] = [{ sessionId: 'ch-1', content: 'queued', metadata: {} }];
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'first', metadata: {} });
  await settle();
  assert.deepEqual(a.handled, ['first', 'queued']);
  assert.deepEqual(turns.map((t) => t.state), ['running', 'idle', 'running', 'idle']);
});

test('a slow running report is never overtaken by the idle that follows it', async () => {
  const seen = [];
  const { a } = make({
    client: {
      reportAgentTurn: async (ws, agent, turn) => {
        if (turn.state === 'running') await new Promise((r) => setTimeout(r, 30));
        seen.push(turn.state);
      },
    },
  });
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'fast', metadata: {} });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, ['running', 'idle']);
});

test('reporting never delays or breaks a turn, even when the endpoint fails or hangs', async () => {
  const { a } = make({ client: { reportAgentTurn: () => new Promise(() => {}) } });
  const started = Date.now();
  await a._channelWorker('ch-1', { sessionId: 'ch-1', content: 'x', metadata: {} });
  assert.ok(Date.now() - started < 200, 'turn did not wait on the report');

  const { a: b } = make({ client: { reportAgentTurn: async () => { throw new Error('HTTP 500'); } } });
  await b._channelWorker('ch-1', { sessionId: 'ch-1', content: 'y', metadata: {} });
  assert.deepEqual(b.handled, ['y']);

  const { a: c } = make({ client: { reportAgentTurn: undefined } });
  await c._channelWorker('ch-1', { sessionId: 'ch-1', content: 'z', metadata: {} });
  assert.deepEqual(c.handled, ['z'], 'an older client without the method is fine');
});

test('stopping ends in-flight turns: idle on a clean stop, error otherwise', async () => {
  const { a, turns } = make();
  a._runningTurns.add('ch-1');
  a._runningTurns.add('ch-2');
  await a._endRunningTurns(null);
  assert.deepEqual(turns.map((t) => `${t.channel}:${t.state}`).sort(), ['ch-1:idle', 'ch-2:idle']);

  const { a: b, turns: bt } = make();
  b._runningTurns.add('ch-1');
  await b._endRunningTurns('Message polling loop crashed: boom');
  assert.deepEqual(bt, [{ agent: 'pi', channel: 'ch-1', state: 'error', error: 'Message polling loop crashed: boom' }]);
  assert.equal(b._runningTurns.size, 0);
});

test('a rejoin mid-turn re-asserts the turn so the backend does not read it as a restart', async () => {
  const { a, turns } = make({ client: { joinNetwork: async () => ({ session_id: 'sess-2' }) } });
  a._runningTurns.add('ch-1');
  assert.equal(await a._joinWorkspace(), true);
  await settle();
  assert.deepEqual(turns, [{ agent: 'pi', channel: 'ch-1', state: 'running' }]);
});

// ---------------------------------------------------------------------------
// Persisted cursor
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-cursor-'));
}

function cursorFile(dir) {
  return path.join(dir, 'ws-1_pi.json');
}

function writeCursor(dir, eventId, savedAt) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cursorFile(dir), JSON.stringify({ eventId, savedAt }));
}

test('the cursor is off by default under the test runner, so the suite never writes to ~/.wwj', () => {
  const { a } = make();
  assert.equal(a._cursorDir, null);
  a._lastEventId = 'evt-1';
  a._persistCursor(true); // no-op, no throw
});

test('the poll loop persists the cursor it advanced to', async () => {
  const dir = tmpDir();
  const { a } = make({
    client: {
      pollPending: async () => {
        a._running = false;
        return { messages: [{ messageId: 'm1', sessionId: 'ch-1', senderType: 'human', senderId: 'human:u', content: 'hi', metadata: {} }], cursor: 'evt-9' };
      },
    },
  });
  a._cursorDir = dir;
  a._sleep = async () => {};
  a._running = true;
  await a._pollLoop();
  await settle();
  const saved = JSON.parse(fs.readFileSync(cursorFile(dir), 'utf-8'));
  assert.equal(saved.eventId, 'evt-9');
  assert.ok(Date.now() - saved.savedAt < 5000);
  assert.deepEqual(a.handled, ['hi']);
});

test('a recent stored cursor is resumed from instead of skipping to head', async () => {
  const dir = tmpDir();
  writeCursor(dir, 'evt-5', Date.now() - 60_000);
  let headCalls = 0;
  const { a } = make({
    client: {
      getHeadEventId: async () => { headCalls++; return 'evt-head'; },
      listAgentEvents: async (ws, agent, token, opts) => {
        assert.equal(opts.after, 'evt-5');
        return { events: [{ id: 'evt-6' }, { id: 'evt-7' }], hasMore: false };
      },
    },
  });
  a._cursorDir = dir;
  await a._initEventCursor();
  assert.equal(a._lastEventId, 'evt-5');
  assert.equal(headCalls, 0);
  // The resumed file is left alone until the replay has actually been polled.
  assert.equal(JSON.parse(fs.readFileSync(cursorFile(dir), 'utf-8')).eventId, 'evt-5');
});

test('replay is capped: a cursor more than 50 events behind resumes from head minus 50', async () => {
  const dir = tmpDir();
  writeCursor(dir, 'evt-old', Date.now() - 3 * 3600_000);
  const tail = Array.from({ length: 51 }, (_, i) => ({ id: `evt-${1000 - i}` })); // newest first
  const logs = [];
  const { a } = make({
    client: {
      getHeadEventId: async () => 'evt-1000',
      listAgentEvents: async (ws, agent, token, opts) => {
        if (opts.sort === 'desc') {
          assert.equal(opts.limit, 51);
          return { events: tail, hasMore: true };
        }
        assert.equal(opts.after, 'evt-old');
        assert.equal(opts.limit, 50);
        return { events: tail.slice(0, 50), hasMore: true };
      },
    },
  });
  a._log = (m) => logs.push(m);
  a._cursorDir = dir;
  await a._initEventCursor();
  assert.equal(a._lastEventId, 'evt-950', 'the 51st newest, so exactly the newest 50 get polled');
  assert.ok(logs.some((l) => /more than 50 events behind/.test(l)), 'the skip is logged');
});

test('a cursor older than 24h is ignored and the adapter skips to head', async () => {
  const dir = tmpDir();
  writeCursor(dir, 'evt-ancient', Date.now() - 25 * 3600_000);
  const { a } = make({
    client: {
      getHeadEventId: async () => 'evt-head',
      listAgentEvents: async () => { throw new Error('should not probe a stale cursor'); },
    },
  });
  a._cursorDir = dir;
  await a._initEventCursor();
  assert.equal(a._lastEventId, 'evt-head');
  assert.equal(JSON.parse(fs.readFileSync(cursorFile(dir), 'utf-8')).eventId, 'evt-head', 'head written so the next start resumes from here');
});

test('no stored cursor, or a failing probe, falls back to head', async () => {
  const { a } = make({ client: { getHeadEventId: async () => 'evt-head' } });
  a._cursorDir = tmpDir();
  await a._initEventCursor();
  assert.equal(a._lastEventId, 'evt-head');

  const dir = tmpDir();
  writeCursor(dir, 'evt-5', Date.now() - 1000);
  const { a: b } = make({
    client: {
      getHeadEventId: async () => 'evt-head',
      listAgentEvents: async () => { throw new Error('HTTP 502'); },
    },
  });
  b._cursorDir = dir;
  await b._initEventCursor();
  assert.equal(b._lastEventId, 'evt-head');
  assert.equal(b._replayFloorMs, null);
});

test('on the first poll after resuming, messages older than the saved cursor are dropped and dedup still applies', async () => {
  const dir = tmpDir();
  const savedAt = Date.now() - 30 * 60_000;
  writeCursor(dir, 'evt-gone', savedAt); // e.g. the stored id no longer exists server-side
  const human = (id, at, content) => ({
    messageId: id, sessionId: `ch-${id}`, senderType: 'human', senderId: 'human:u', content, metadata: {},
    createdAt: new Date(at).toISOString(),
  });
  const batches = [
    [
      human('old', savedAt - 60 * 60_000, 'handled before the restart'),
      human('new', savedAt + 5 * 60_000, 'posted while down'),
    ],
    [
      human('new', savedAt + 5 * 60_000, 'posted while down'), // redelivered: dedup
      human('later', savedAt - 60 * 60_000, 'old timestamp, but the floor only guards the replay'),
    ],
  ];
  let polls = 0;
  const { a } = make({
    client: {
      listAgentEvents: async () => ({ events: [], hasMore: false }),
      pollPending: async () => {
        const messages = batches[polls++] || [];
        if (polls >= batches.length) a._running = false;
        return { messages, cursor: `evt-${polls}` };
      },
    },
  });
  a._cursorDir = dir;
  a._sleep = async () => {};
  await a._initEventCursor();
  assert.equal(a._lastEventId, 'evt-gone');
  a._running = true;
  await a._pollLoop();
  await settle();
  assert.deepEqual(a.handled, ['posted while down', 'old timestamp, but the floor only guards the replay']);
});
