'use strict';

/*
  Stranded to-dos are an every-adapter problem, so the fix lives on the base
  class and fires from `_channelWorker` — the one place all 17 adapters funnel
  through. These tests drive a bare subclass, not PiAdapter, because the point
  of the change is that it works for an adapter that knows nothing about it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const BaseAdapter = require('../src/adapters/base');

function makeClient(todos) {
  const puts = [];
  return {
    puts,
    getSession: async () => ({}),
    getTodos: async () => ({ todos }),
    putTodos: async (wsId, ch, token, next, opts) => { puts.push({ ch, next, opts }); },
  };
}

class TestAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.handled = [];
    this.errors = [];
    this._behaviour = opts.behaviour || (async () => {});
  }
  async _handleMessage(msg) {
    this.handled.push(msg);
    await this._behaviour(msg);
  }
  async sendError(channel, error) { this.errors.push({ channel, error }); }
  async sendStatus() {}
  async _resolveKnowledgeMentions(content) { return content; }
}

function makeAdapter(client, behaviour) {
  return new TestAdapter({
    agentName: 'test-agent',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
    behaviour,
  });
}

test('a crashed turn hands its in_progress rows back, for any adapter', async () => {
  const client = makeClient([
    { content: 'Fix command timeout', status: 'in_progress', priority: 'high' },
    { content: 'Fix stream queue hang', status: 'pending' },
  ]);
  const a = makeAdapter(client, async () => { throw new Error('upstream exploded'); });

  await a._channelWorker('ch-1', { content: 'do the thing' });

  assert.equal(a.errors.length, 1, 'the user still hears about the failure');
  assert.equal(client.puts.length, 1, 'and the board is corrected');
  assert.deepEqual(
    client.puts[0].next.map((t) => t.status),
    ['pending', 'pending'],
  );
});

test('a turn that forgot to close its own rows is corrected too', async () => {
  // No throw: the agent just finished and left a row claiming to be running.
  const client = makeClient([
    { content: 'Fix command timeout', status: 'in_progress' },
  ]);
  const a = makeAdapter(client, async () => {});

  await a._channelWorker('ch-1', { content: 'do the thing' });

  assert.equal(a.errors.length, 0);
  assert.equal(client.puts.length, 1);
  assert.equal(client.puts[0].next[0].status, 'pending');
});

test('a tidy turn is left completely alone', async () => {
  const client = makeClient([
    { content: 'Fix command timeout', status: 'completed' },
    { content: 'Fix stream queue hang', status: 'pending' },
  ]);
  const a = makeAdapter(client, async () => {});

  await a._channelWorker('ch-1', { content: 'do the thing' });

  assert.equal(client.puts.length, 0, 'no needless write');
});

test('every queued turn is swept, not just the first', async () => {
  const client = makeClient([{ content: 'Task', status: 'in_progress' }]);
  const a = makeAdapter(client, async () => { throw new Error('boom'); });
  a._channelQueues['ch-1'] = [{ content: 'second' }, { content: 'third' }];

  await a._channelWorker('ch-1', { content: 'first' });

  assert.equal(a.handled.length, 3, 'queue drained');
  assert.equal(client.puts.length, 3, 'swept after each turn');
});

test('a to-do API failure cannot take the turn down with it', async () => {
  const client = {
    getSession: async () => ({}),
    getTodos: async () => { throw new Error('backend offline'); },
  };
  const a = makeAdapter(client, async () => {});

  await a._channelWorker('ch-1', { content: 'do the thing' });

  assert.equal(a.handled.length, 1);
  assert.equal(a.errors.length, 0, 'a board problem is not a turn failure');
});

/*
  Parallel batches are the exception this demotion must not touch.

  The rule elsewhere is that nothing may end a turn in_progress, because agents
  write a board and then strand it. A parallel batch inverts that: the work
  legitimately stays in_progress across turns while other agents run beside it.
  A scope is what marks a task as part of such a batch.
*/

test('a scoped task survives the end of a turn', async () => {
  const client = makeClient([
    { content: 'rebuild the board', status: 'in_progress', assignee: 'pi', scope: 'workspace/frontend' },
    { content: 'add the endpoint', status: 'in_progress', assignee: 'pi', scope: 'workspace/backend' },
  ]);
  const adapter = makeAdapter(client);

  await adapter._releaseStaleTodos('general', 'turn ended');

  // Nothing to change means nothing is written at all — a needless rewrite of
  // the board is itself a way to lose fields.
  assert.equal(client.puts.length, 0, 'a fully scoped board is left alone');
});

test('an unscoped task is still released', async () => {
  const client = makeClient([
    { content: 'stranded', status: 'in_progress', assignee: 'pi' },
    { content: 'scoped', status: 'in_progress', assignee: 'pi', scope: 'workspace/backend' },
  ]);
  const adapter = makeAdapter(client);

  await adapter._releaseStaleTodos('general', 'turn ended');

  assert.equal(client.puts.length, 1);
  const written = client.puts[0].next;
  assert.equal(written[0].status, 'pending', 'the unscoped row is demoted');
  assert.equal(written[1].status, 'in_progress', 'the scoped row is not');
});

test('the scope survives a release, because PutTodos reinserts', async () => {
  const client = makeClient([
    { content: 'stranded', status: 'in_progress', assignee: 'pi' },
    { content: 'scoped', status: 'in_progress', assignee: 'pi', scope: 'workspace/backend' },
  ]);
  const adapter = makeAdapter(client);

  await adapter._releaseStaleTodos('general', 'turn ended');

  // A field not sent back is erased server-side. A lost scope would leave the
  // batch permanently "unscoped", which reads as an unresolvable conflict.
  assert.equal(client.puts[0].next[1].scope, 'workspace/backend');
});
