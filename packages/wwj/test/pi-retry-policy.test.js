'use strict';

/*
  The retry policy, tested at the level it makes decisions at.

  The failure this exists to prevent is a real one from daemon.log: a turn
  that streamed 1m30s of reasoning, hit `422 upstream_error`, and was then
  re-run whole three more times over four minutes — each attempt discarding
  the previous attempt's work and re-sending the same oversized request —
  before surfacing a single red line that mentioned none of it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const PiAdapter = require('../src/adapters/pi');

function makeAdapter(opts = {}) {
  return new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: { getSession: async () => ({}) },
    ...opts,
  });
}

function failure(message, { producedChars = 0, elapsedMs = 0 } = {}) {
  const err = new Error(message);
  err.piProducedChars = producedChars;
  err.piElapsedMs = elapsedMs;
  return err;
}

const UPSTREAM_422 =
  '422: {"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}';

// ── classification ───────────────────────────────────────────────────

test('a non-transient error is fatal regardless of shape', () => {
  const a = makeAdapter();
  assert.equal(a._classifyFailure(failure('pi CLI not found')), 'fatal');
  assert.equal(
    a._classifyFailure(failure('ENOENT: no such file', { producedChars: 9999 })),
    'fatal',
  );
});

test('a fast failure with nothing produced restarts', () => {
  const a = makeAdapter();
  assert.equal(
    a._classifyFailure(failure(UPSTREAM_422, { producedChars: 0, elapsedMs: 800 })),
    'restart',
  );
  assert.equal(
    a._classifyFailure(failure('ECONNRESET', { producedChars: 0, elapsedMs: 200 })),
    'restart',
  );
});

test('a long 422 with nothing produced is fatal, not a fourth attempt', () => {
  // The observed case. Re-sending the identical oversized prompt fails
  // identically; the only thing three more attempts buy is three more minutes.
  const a = makeAdapter();
  assert.equal(
    a._classifyFailure(failure(UPSTREAM_422, { producedChars: 0, elapsedMs: 90_000 })),
    'fatal',
  );
});

test('a long 503 with nothing produced still restarts — it is a real blip', () => {
  const a = makeAdapter();
  assert.equal(
    a._classifyFailure(failure('503 <html>', { producedChars: 0, elapsedMs: 90_000 })),
    'restart',
  );
});

test('work worth keeping resumes instead of restarting', () => {
  const a = makeAdapter();
  // 4605 words of reasoning is not something to throw away and redo.
  assert.equal(
    a._classifyFailure(failure(UPSTREAM_422, { producedChars: 20_000, elapsedMs: 90_000 })),
    'resume',
  );
});

test('resume beats the fatal-overload rule', () => {
  // Partial work means the continuation prompt is smaller than the original,
  // which is exactly what a size-driven 422 needs — so it is worth an attempt.
  const a = makeAdapter();
  const verdict = a._classifyFailure(
    failure(UPSTREAM_422, { producedChars: 500, elapsedMs: 300_000 }),
  );
  assert.equal(verdict, 'resume');
});

test('output just under the bar is not treated as resumable', () => {
  const a = makeAdapter();
  assert.equal(
    a._classifyFailure(failure('429 rate limit', { producedChars: 399, elapsedMs: 5_000 })),
    'restart',
  );
});

// ── backoff ──────────────────────────────────────────────────────────

test('a configured retryDelayMs of 0 still waits', () => {
  // The old `(attempt + 1) * retryDelayMs` gave 0ms four times over; daemon.log
  // shows three attempts inside two milliseconds.
  const a = makeAdapter({ retryDelayMs: 0 });
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.ok(
      a._retryDelayFor(attempt) >= 700,
      `attempt ${attempt} waited ${a._retryDelayFor(attempt)}ms`,
    );
  }
});

test('backoff grows and is capped', () => {
  const a = makeAdapter({ retryDelayMs: 2000 });
  const first = a._retryDelayFor(0);
  const later = a._retryDelayFor(3);
  assert.ok(later > first, `${later} should exceed ${first}`);
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.ok(a._retryDelayFor(attempt) <= 45_000, 'cap holds with jitter');
  }
});

test('jitter actually varies the delay', () => {
  const a = makeAdapter({ retryDelayMs: 2000 });
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(a._retryDelayFor(2));
  assert.ok(seen.size > 1, 'delays should not all be identical');
});

// ── failure reporting ────────────────────────────────────────────────

test('a single-attempt failure reports plainly', () => {
  const a = makeAdapter();
  const err = failure('pi CLI not found');
  err.piAttemptLog = ['#1 after 0s: pi CLI not found'];
  assert.equal(a._formatTurnFailure(err), 'Pi error: pi CLI not found');
});

test('a multi-attempt failure accounts for every attempt', () => {
  const a = makeAdapter();
  const err = failure(UPSTREAM_422);
  err.piAttemptLog = [
    '#1 after 90s: ' + UPSTREAM_422,
    '#2 after 140s: 503 <html>',
    '#3 after 30s: 503 <html>',
    '#4 after 70s: ' + UPSTREAM_422,
  ];
  err.piTurnMs = 242_000;
  const out = a._formatTurnFailure(err);
  assert.match(out, /Failed after 4 attempts over 242s/);
  assert.match(out, /#2 after 140s: 503/);
  assert.match(out, /#4 after 70s/);
});

// ── stranded to-dos ──────────────────────────────────────────────────

function makeTodoClient(todos) {
  const puts = [];
  return {
    puts,
    getSession: async () => ({}),
    getTodos: async () => ({ todos }),
    putTodos: async (wsId, ch, token, next, opts) => { puts.push({ ch, next, opts }); },
  };
}

test('a failed turn hands back its in_progress rows', async () => {
  // The board screenshot: one task "In Progress" for 19 hours behind a process
  // that died. Nothing is running, so nothing may claim to be.
  const client = makeTodoClient([
    { content: 'Fix command timeout', status: 'in_progress', priority: 'high' },
    { content: 'Fix stream queue hang', status: 'pending' },
    { content: 'Write adapter tests', status: 'completed' },
  ]);
  const a = makeAdapter({ client });

  await a._releaseStaleTodos('ch-1', 'Pi error: 422');

  assert.equal(client.puts.length, 1, 'should have written the list back');
  const { next, opts } = client.puts[0];
  assert.equal(opts.source, '52hz:pi-test');
  assert.deepEqual(
    next.map((t) => t.status),
    ['pending', 'pending', 'completed'],
    'in_progress demoted; pending and completed untouched',
  );
  assert.equal(next[0].content, 'Fix command timeout', 'content is not rewritten');
  assert.equal(next[0].priority, 'high', 'priority survives');
});

test('a failed turn with nothing in flight writes nothing', async () => {
  const client = makeTodoClient([
    { content: 'Fix stream queue hang', status: 'pending' },
    { content: 'Write adapter tests', status: 'completed' },
  ]);
  const a = makeAdapter({ client });

  await a._releaseStaleTodos('ch-1', 'Pi error: 422');

  assert.equal(client.puts.length, 0, 'no needless overwrite of the board');
});

test('a to-do API failure cannot take the error report down with it', async () => {
  const a = makeAdapter({
    client: {
      getSession: async () => ({}),
      getTodos: async () => { throw new Error('backend offline'); },
    },
  });
  await a._releaseStaleTodos('ch-1', 'Pi error: 422');
});
