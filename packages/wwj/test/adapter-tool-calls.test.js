'use strict';

/*
  The tool-call contract, pinned to what the frontend actually reads.

  `parseMessageStep` in workspace/frontend/components/chat/intermediate-steps.tsx
  renders a tool card only when `metadata.tool_name` (or `.tool` / `.tool_call`)
  is a non-empty string, and then reads `tool_args`, `tool_status` and
  `tool_summary`. Nothing in wwj ever set any of them: all seventeen adapters
  parsed the tool call out of their CLI stream, discarded the structure and
  sent a sentence, so every tool call fell through to the branch the frontend's
  own comment calls "legacy text".

  These tests assert the metadata keys by their literal names on purpose. They
  are a cross-repo contract, and renaming one silently on either side is
  exactly the failure this is meant to catch.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const BaseAdapter = require('../src/adapters/base');

function makeAdapter() {
  const sent = [];
  const adapter = new BaseAdapter({
    agentName: 'tool-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 't',
    client: {
      getSession: async () => ({}),
      sendMessage: async (wsId, ch, token, content, opts) => {
        sent.push({ ch, content, opts });
      },
    },
  });
  return { adapter, sent };
}

test('a tool call carries the keys the frontend reads', async () => {
  const { adapter, sent } = makeAdapter();

  await adapter.sendToolCall('ch-1', {
    name: 'bash',
    args: { command: 'git status' },
    status: 'running',
    id: 'call_1',
  });

  assert.equal(sent.length, 1);
  const { content, opts } = sent[0];
  assert.equal(opts.messageType, 'thinking');
  assert.equal(opts.metadata.tool_name, 'bash');
  assert.deepEqual(opts.metadata.tool_args, { command: 'git status' });
  assert.equal(opts.metadata.tool_status, 'running');
  assert.equal(opts.metadata.tool_call_id, 'call_1');
  // The body stays human-readable: it is what a client ignoring the metadata
  // shows, and what lands in exports and the daemon log.
  assert.equal(content, 'bash git status');
});

test('args survive whole — the sentence is a summary, not the payload', async () => {
  // amp used to `JSON.stringify(...).slice(0, 200)` before sending, so the
  // arguments were lossy before they ever left the adapter.
  const { adapter, sent } = makeAdapter();
  const big = { command: 'x'.repeat(500), cwd: '/tmp', env: { A: '1' } };

  await adapter.sendToolCall('ch-1', { name: 'bash', args: big });

  assert.deepEqual(sent[0].opts.metadata.tool_args, big, 'args are not truncated');
  assert.ok(sent[0].content.length < 200, 'the readable line still is');
});

test('optional fields are omitted, not sent empty', async () => {
  // An absent field must stay distinguishable from an asserted one, the same
  // rule sendThinking follows for reply_preview.
  const { adapter, sent } = makeAdapter();

  await adapter.sendToolCall('ch-1', { name: 'read_file' });

  const md = sent[0].opts.metadata;
  assert.equal(md.tool_name, 'read_file');
  assert.ok(!('tool_args' in md), 'tool_args omitted');
  assert.ok(!('tool_status' in md), 'tool_status omitted');
  assert.ok(!('tool_call_id' in md), 'tool_call_id omitted');
  assert.ok(!('tool_summary' in md), 'tool_summary omitted');
  assert.equal(sent[0].content, 'read_file');
});

test('a nameless call is dropped rather than sent as "tool"', async () => {
  const { adapter, sent } = makeAdapter();
  await adapter.sendToolCall('ch-1', { name: '' });
  await adapter.sendToolCall('ch-1', { name: '   ' });
  await adapter.sendToolCall('ch-1', {});
  assert.equal(sent.length, 0);
});

test('the readable detail picks the field that identifies the call', async () => {
  const { adapter, sent } = makeAdapter();
  const cases = [
    [{ command: 'ls -la' }, 'bash ls -la'],
    [{ file_path: '/etc/hosts' }, 'bash /etc/hosts'],
    [{ url: 'https://example.com' }, 'bash https://example.com'],
    [{ pattern: 'TODO' }, 'bash TODO'],
    [{ unknown: 'x' }, 'bash'],
    ['raw string', 'bash raw string'],
  ];
  for (const [args, expected] of cases) {
    sent.length = 0;
    await adapter.sendToolCall('ch-1', { name: 'bash', args });
    assert.equal(sent[0].content, expected, JSON.stringify(args));
  }
});

test('a long detail is truncated in the sentence only', async () => {
  const { adapter, sent } = makeAdapter();
  const long = 'y'.repeat(400);
  await adapter.sendToolCall('ch-1', { name: 'bash', args: { command: long } });
  assert.ok(sent[0].content.length <= 130, 'sentence bounded');
  assert.equal(sent[0].opts.metadata.tool_args.command, long, 'metadata intact');
});

test('a failed call reports its status', async () => {
  const { adapter, sent } = makeAdapter();
  await adapter.sendToolCall('ch-1', { name: 'bash', status: 'failed', id: 'c1' });
  assert.equal(sent[0].opts.metadata.tool_status, 'failed');
});

/*
  The goose stream parser is the one place upstream of an adapter where the
  arguments were being dropped rather than merely unused: `_toolEvent` reduced
  them to a one-field summary string, so goose.js had nothing structured left to
  send even once it wanted to. These pin the parser's half of the contract.
*/
const { GooseStreamParser } = require('../src/adapters/goose-stream');

function gooseEvents(line) {
  const parser = new GooseStreamParser();
  return parser.feed(line + '\n');
}

test('goose: a tool request keeps its arguments, not just the preview', () => {
  const args = { command: 'ls -la', cwd: '/srv', timeout: 30 };
  const events = gooseEvents(JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{
        type: 'toolRequest',
        id: 'req_1',
        toolCall: { status: 'success', value: { name: 'developer__shell', arguments: args } },
      }],
    },
  }));

  const tool = events.find((e) => e.kind === 'tool');
  assert.ok(tool, 'a tool event is emitted');
  assert.equal(tool.name, 'developer__shell');
  assert.deepEqual(tool.args, args, 'arguments survive the parser');
  assert.equal(tool.summary, 'ls -la', 'the summary is still one field out of them');
});

test('goose: an unreadable tool call is flagged, not silently "running"', () => {
  const events = gooseEvents(JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolRequest', id: 'req_2', toolCall: { status: 'error', error: 'bad json' } }],
    },
  }));

  const tool = events.find((e) => e.kind === 'tool');
  assert.ok(tool);
  assert.equal(tool.ok, false, 'the adapter can map this to status failed');
  assert.ok(!('args' in tool) || tool.args === undefined, 'no arguments to report');
});
