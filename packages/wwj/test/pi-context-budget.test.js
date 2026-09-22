'use strict';

/*
  The per-turn request budget, tested where it is decided.

  The failure this exists to prevent is measured, not hypothetical: the
  ~20.6k-character workspace context prefix was prepended to every user
  message, pi persists user messages in its session file, and pi re-sends the
  whole session every turn. A real 494KB session on the dev machine held TEN
  copies of the prefix — 42% of the file — and every one of them was uploaded
  again on each subsequent turn. That growth is what produced the
  `upstream_request_rejected` 422s that killed long tasks, and it is upstream
  of the retry policy: by the time a retry runs, the request is already too big.

  The prefix now goes to `--append-system-prompt` as a FILE. Verified against
  the real CLI (pi 'resolvePromptInput' reads the value when it is an existing
  path) and against real session files (no `role":"system"` line is ever
  written), so the prefix is rebuilt fresh each turn, sent exactly once per
  request, and never enters the conversation.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PiAdapter = require('../src/adapters/pi');

function makeAdapter(opts = {}) {
  return new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-ctx',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: { getSession: async () => ({}) },
    ...opts,
  });
}

// ── the context leaves the conversation ──────────────────────────────

test('the context is passed as a system-prompt file, not as the message', () => {
  const a = makeAdapter();
  const ctx = a._writeContextFile('general', 'WORKSPACE RULES\nline two');
  assert.ok(ctx, 'a path is returned');
  assert.equal(fs.readFileSync(ctx, 'utf-8'), 'WORKSPACE RULES\nline two');

  const args = a._buildPiCmd('what is 2+2?', 'general', ctx);

  const flagAt = args.indexOf('--append-system-prompt');
  assert.ok(flagAt >= 0, 'the flag is passed');
  assert.equal(args[flagAt + 1], ctx, 'and it points at the file, not the text');

  // The thing that actually matters: the message pi stores in its session is
  // the user's message and nothing else.
  assert.equal(args[args.length - 2], '-p');
  assert.equal(args[args.length - 1], 'what is 2+2?');
  assert.ok(!args.some((x) => String(x).includes('WORKSPACE RULES')), 'no prefix on argv');
});

test('no context file means no flag — nothing empty is passed', () => {
  const a = makeAdapter();
  const args = a._buildPiCmd('hello', 'general');
  assert.ok(!args.includes('--append-system-prompt'));
  assert.equal(args[args.length - 1], 'hello');
});

test('an unwritable context path falls back to null, never to a silent loss', () => {
  const a = makeAdapter();
  // A directory where a file must go: writeFileSync throws, and the caller's
  // contract is that it then inlines the prefix rather than dropping it.
  const dir = path.join(os.tmpdir(), `pi-ctx-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  a._contextPathFor = () => dir;
  assert.equal(a._writeContextFile('general', 'rules'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('empty context writes nothing', () => {
  const a = makeAdapter();
  assert.equal(a._writeContextFile('general', ''), null);
});

// ── the message survives pi's argv parser ────────────────────────────

/*
  A REGRESSION THIS CAUSED, AND THE REAL TURN THAT CAUGHT IT.

  Moving the prefix out of `-p` left the user's own text as the first token of
  argv, and pi reads a leading `@` as a file reference (cli/args.js:214) and a
  leading `-` as a flag (:234). The first live turn after the change was
  "@pi 你好", which came back as `File not found: D:\code\...\pi 你好`.
  `--` is not a fix: tokens after it are still @-scanned (args.js:24-31).
*/

test('a message starting with @ is not handed to pi as a file', () => {
  const a = makeAdapter();
  const args = a._buildPiCmd('@pi 你好', 'general', null);
  const sent = args[args.length - 1];
  assert.equal(args[args.length - 2], '-p');
  assert.ok(!sent.startsWith('@'), 'the token must not open with @');
  assert.ok(sent.includes('@pi 你好'), 'and the message is still all there');
});

test('a message starting with - is not read as a flag', () => {
  const a = makeAdapter();
  const sent = a._buildPiCmd('--help me debug this', 'general', null).pop();
  assert.ok(!sent.startsWith('-'));
  assert.ok(sent.includes('--help me debug this'));
});

test('an ordinary message is passed through verbatim', () => {
  const a = makeAdapter();
  assert.equal(a._buildPiCmd('你好', 'general', null).pop(), '你好');
  assert.equal(a._buildPiCmd('fix the build', 'general', null).pop(), 'fix the build');
});

// ── a dropped stream is not a dead end ───────────────────────────────

/*
  From daemon.log, the turn that prompted this: started 06:17:43, died
  06:31:40 with `Pi model error: terminated`, retried ZERO times. "terminated"
  is undici's error for a streaming response cut off mid-flight, and it matched
  none of the transient strings, so fourteen minutes of work was classified
  fatal and thrown away. The request was fine; the far end went away — which is
  precisely what resume exists for.
*/

test('a dropped stream retries instead of dying', () => {
  const a = makeAdapter();
  for (const m of ['terminated', 'TypeError: terminated', 'socket hang up',
    'other side closed', 'premature close']) {
    const err = new Error(m);
    err.piProducedChars = 50000;
    assert.equal(a._classifyFailure(err), 'resume', `${m} keeps the work`);
  }
});

test('a dropped stream with nothing produced restarts', () => {
  const a = makeAdapter();
  const err = new Error('terminated');
  err.piProducedChars = 0;
  assert.equal(a._classifyFailure(err), 'restart');
});

test('a user stop is never retried, whatever the message says', () => {
  const a = makeAdapter();
  // Deliberately wearing the most transient-looking text there is.
  const err = new Error('terminated: 503 connection reset, timeout');
  err.piUserStop = true;
  err.piProducedChars = 50000;
  assert.equal(a._classifyFailure(err), 'fatal');
});

// ── the hang has an upper bound ──────────────────────────────────────

test('a hung turn restarts, however much work it produced', () => {
  const a = makeAdapter();
  const err = new Error('pi timed out: no output for 900s, so the turn was treated as hung and the process killed.');
  err.piInactivityKill = true;
  err.piProducedChars = 50000; // far past PI_RESUME_MIN_CHARS
  err.piElapsedMs = 900000;

  // Resuming would re-send the session that just stopped responding.
  assert.equal(a._classifyFailure(err), 'restart');
});

test('the inactivity timeout is configurable, with a floor', () => {
  assert.equal(makeAdapter()._inactivityTimeout(), 900);
  assert.equal(makeAdapter({ agentEnv: { PI_INACTIVITY_TIMEOUT: '120' } })._inactivityTimeout(), 120);
  // Below the floor and non-numeric both fall back, so a typo cannot turn the
  // watchdog into a turn-killer.
  assert.equal(makeAdapter({ agentEnv: { PI_INACTIVITY_TIMEOUT: '5' } })._inactivityTimeout(), 900);
  assert.equal(makeAdapter({ agentEnv: { PI_INACTIVITY_TIMEOUT: 'soon' } })._inactivityTimeout(), 900);
});
