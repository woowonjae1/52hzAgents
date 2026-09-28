'use strict';

/*
  Machine-written messages (a timer firing, a parallel summary) are not
  questions: implicit knowledge retrieval is skipped for them. And a tool call
  in Antigravity's argument shape still reaches the transcript with its detail.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const BaseAdapter = require('../src/adapters/base');

class Probe extends BaseAdapter {
  constructor(opts) { super(opts); this.seen = []; }
  async _handleMessage(msg) { this.seen.push(msg.content); }
  async sendError() {}
  async sendStatus() {}
  async _releaseStaleTodos() {}
  async _registerFilesTouchedSince() {}
}

function make() {
  const searches = [];
  const sent = [];
  const client = {
    searchKnowledge: async (ws, token, q) => {
      searches.push(q.query);
      return { results: [{ title: 'MQTT API', section: 'systemLogs', slug: 'mqtt', snippet: 'unrelated' }] };
    },
    sendMessage: async (ws, ch, token, content, opts) => { sent.push({ content, opts }); return {}; },
  };
  const a = new Probe({ agentName: 'antigravity', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  a._log = () => {};
  return { a, searches, sent };
}

test('a timer firing gets no auto-retrieved knowledge', async () => {
  const { a, searches } = make();
  const content = '⏰ Timer fired (set by @antigravity): Check the tsc task status and view the log output.';
  await a._channelWorker('ch', { sessionId: 'ch', senderName: 'system:timer', content, metadata: {} });
  assert.equal(searches.length, 0);
  assert.equal(a.seen[0], content);
});

test('a person asking still gets auto-retrieved knowledge', async () => {
  const { a, searches } = make();
  await a._channelWorker('ch', { sessionId: 'ch', senderName: 'songtao', senderType: 'human', content: 'how do I read the system logs?', metadata: {} });
  assert.equal(searches.length, 1);
  assert.match(a.seen[0], /相关知识库参考: MQTT API/);
});

test('Antigravity-shaped tool arguments keep their detail in the message body', async () => {
  const { a, sent } = make();
  await a.sendToolCall('ch', { name: 'run_command', args: { CommandLine: 'npx tsc --noEmit' } });
  await a.sendToolCall('ch', { name: 'view_file', args: { AbsolutePath: 'D:/app/notes/page.tsx' } });
  assert.deepEqual(sent.map((s) => s.content), ['run_command npx tsc --noEmit', 'view_file D:/app/notes/page.tsx']);
  assert.equal(sent[0].opts.metadata.tool_name, 'run_command');
});
