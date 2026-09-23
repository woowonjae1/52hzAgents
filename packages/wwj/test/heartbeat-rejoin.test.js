'use strict';

/*
  An adapter whose first /v1/join failed must come back online by itself.

  daemon.log 2026-09-22: one join HTTP 500 at startup, then 168 heartbeat
  failures ("session_id is required") over 84 minutes against a healthy
  backend, because nothing ever joined again.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const BaseAdapter = require('../src/adapters/base');

function httpErr(statusCode, msg) {
  const e = new Error(msg);
  e.statusCode = statusCode;
  return e;
}

function makeAdapter(client) {
  const a = new BaseAdapter({ agentName: 'claude', workspaceId: 'ws-1', endpoint: 'http://x', token: 't', client });
  a._log = () => {};
  a._reportStatus = () => {};
  return a;
}

function makeClient({ joinResults, heartbeatResults = [] }) {
  const calls = { join: 0, heartbeat: [] };
  return {
    calls,
    joinNetwork: async () => {
      const r = joinResults[Math.min(calls.join, joinResults.length - 1)];
      calls.join++;
      if (r instanceof Error) throw r;
      return r;
    },
    heartbeat: async (wsId, agent, token, sessionId) => {
      const r = heartbeatResults[calls.heartbeat.length];
      calls.heartbeat.push(sessionId);
      if (r instanceof Error) throw r;
      return { ok: true };
    },
  };
}

test('a failed startup join is retried by the next heartbeat, which then goes through', async () => {
  const client = makeClient({ joinResults: [httpErr(500, 'HTTP 500'), { session_id: 'sess-2' }] });
  const a = makeAdapter(client);

  assert.equal(await a._joinWorkspace(), false);
  assert.equal(a._sessionId, null);

  await a._heartbeat();
  assert.equal(client.calls.join, 2, 'heartbeat joined again');
  assert.deepEqual(client.calls.heartbeat, ['sess-2'], 'and then sent a real heartbeat');
  assert.equal(a._heartbeatFailStreak, 0);
});

test('while join keeps failing, heartbeats count failures and send nothing', async () => {
  const client = makeClient({ joinResults: [httpErr(500, 'HTTP 500')] });
  const a = makeAdapter(client);
  await a._heartbeat();
  await a._heartbeat();
  assert.equal(client.calls.join, 2);
  assert.equal(client.calls.heartbeat.length, 0);
  assert.equal(a._heartbeatFailStreak, 2);
});

test('404 "member not registered" drops the session so the next heartbeat rejoins', async () => {
  const client = makeClient({
    joinResults: [{ session_id: 'sess-1' }, { session_id: 'sess-2' }],
    heartbeatResults: [httpErr(404, 'Agent member not registered')],
  });
  const a = makeAdapter(client);
  await a._joinWorkspace();
  await a._heartbeat(); // 404
  assert.equal(a._sessionId, null);
  await a._heartbeat(); // rejoin + heartbeat
  assert.deepEqual(client.calls.heartbeat, ['sess-1', 'sess-2']);
});

test('the client reads gin\'s `error` field and attaches statusCode', async () => {
  const { WorkspaceClient, SessionRevokedError } = require('../src/workspace-client');
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    const code = req.url.includes('revoked') ? 409 : 404;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: code === 409 ? 'session_revoked' : 'Agent member not registered' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new WorkspaceClient(base);
  try {
    await assert.rejects(client._post('/x', {}, {}), (e) => e.statusCode === 404 && e.message === 'Agent member not registered');
    await assert.rejects(client._post('/revoked', {}, {}), (e) => e instanceof SessionRevokedError && e.statusCode === 409);
  } finally {
    server.close();
  }
});

test('409 session_expired rejoins; 409 session_revoked stops (never fights over the name)', async () => {
  const { SessionRevokedError } = require('../src/workspace-client');
  const expired = httpErr(409, 'session_expired');
  const client = makeClient({
    joinResults: [{ session_id: 'sess-1' }, { session_id: 'sess-2' }],
    heartbeatResults: [expired, undefined, new SessionRevokedError('session_revoked')],
  });
  const a = makeAdapter(client);
  a._setExitInfo = () => {};
  a._running = true;
  await a._joinWorkspace();
  await a._heartbeat(); // expired -> drop session
  assert.equal(a._sessionId, null);
  await a._heartbeat(); // rejoin as sess-2, heartbeat ok
  assert.equal(a._sessionId, 'sess-2');
  assert.equal(a._running, true);
  await a._heartbeat(); // revoked -> stop
  assert.equal(a._running, false);
  assert.equal(client.calls.join, 2, 'revoked did not trigger a rejoin');
});

test('final reply is retried on a transient failure with ONE idempotency key; 4xx is not retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ids = [];
  let failures = 2;
  const client = {
    sendMessage: async (ws, ch, tok, body, opts) => {
      ids.push(opts.clientMessageId);
      if (failures-- > 0) throw new Error('socket hang up'); // no statusCode = network
      return {};
    },
  };
  const a = makeAdapter(client);
  const p = a.sendResponse('ch-1', 'the answer');
  for (let i = 0; i < 5; i++) { await Promise.resolve(); t.mock.timers.tick(10000); await new Promise((r) => setImmediate(r)); }
  await p;
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1, 'same client_message_id every attempt');

  const bad = { sendMessage: async () => { throw httpErr(400, 'bad request'); } };
  const b = makeAdapter(bad);
  await assert.rejects(b.sendResponse('ch-1', 'x'), /bad request/);
});
