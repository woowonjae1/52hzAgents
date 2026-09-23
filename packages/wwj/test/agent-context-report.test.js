'use strict';

/*
 * Each adapter reports how full ITS OWN context is in a channel, from what its
 * CLI measured on the last model call of the turn -- never a sum over the
 * turn, never a guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

const PiAdapter = require('../src/adapters/pi');
const ClaudeAdapter = require('../src/adapters/claude');
const { parseCodexRolloutTail } = require('../src/adapters/codex');

function createMockClient() {
  const contexts = [];
  return {
    contexts,
    getSession: async () => ({ workingDir: process.cwd() }),
    sendMessage: async () => ({ id: 'm' }),
    reportAgentUsage: async () => {},
    reportAgentContext: async (wsId, agent, payload) => { contexts.push({ agent, ...payload }); },
    postEvents: async () => {},
    sendControl: async () => {},
  };
}

function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.pid = 99999;
  return proc;
}

const line = (o) => JSON.stringify(o) + '\n';

test('pi reports the LAST assistant call, cache included, plus compaction', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({ agentName: 'pi', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  const proc = fakeProc();
  adapter._findPiBinary = () => 'node';
  adapter._resolveWorkingDir = async () => process.cwd();
  adapter._spawnProc = () => proc;
  adapter._piContextWindow = (ref) => (ref === 'atria/dawn' ? 256000 : 0);

  const run = adapter._runPi('p', 'ch-1');
  await delay(10);
  // First call (with a tool) is smaller; the second one is the context size.
  proc.stdout.push(line({ type: 'message_end', message: { role: 'assistant', provider: 'atria', model: 'dawn',
    content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }],
    usage: { input: 100, cacheRead: 9000, cacheWrite: 0, output: 20 } } }));
  proc.stdout.push(line({ type: 'auto_compaction_end' }));
  proc.stdout.push(line({ type: 'message_end', message: { role: 'assistant', provider: 'atria', model: 'dawn',
    content: [{ type: 'text', text: 'done' }],
    usage: { input: 300, cacheRead: 12000, cacheWrite: 500, output: 40 } } }));
  proc.stdout.push(null);
  proc.stderr.push(null);
  await delay(10);
  proc.emit('exit', 0);
  await run;
  await delay(5);

  assert.equal(client.contexts.length, 1);
  assert.deepEqual(client.contexts[0], {
    agent: 'pi', channel: 'ch-1', prompt_tokens: 12800, context_window: 256000, compacted: true, model: 'atria/dawn',
  });
});

test('claude uses the last main-thread usage and modelUsage.contextWindow, not the summed result usage', () => {
  const client = createMockClient();
  const adapter = new ClaudeAdapter({ agentName: 'claude', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  const pp = { msgChannel: 'general' };
  // What the assistant branch records: sub-agent and synthetic calls are skipped upstream.
  pp.lastUsage = { input_tokens: 5, cache_read_input_tokens: 40000, cache_creation_input_tokens: 1200, output_tokens: 300 };
  pp.lastModel = 'claude-sonnet-4-5';
  pp.compactedThisTurn = true;
  adapter._reportClaudeContext(pp, {
    type: 'result',
    usage: { input_tokens: 999999 }, // summed over the turn: must be ignored
    modelUsage: {
      'claude-haiku-4-5': { contextWindow: 200000 },
      'claude-sonnet-4-5': { contextWindow: 1000000 },
    },
  });
  assert.deepEqual(client.contexts[0], {
    agent: 'claude', channel: 'general', prompt_tokens: 41205, context_window: 1000000, compacted: true, model: 'claude-sonnet-4-5',
  });
  // State resets for the next turn.
  assert.equal(pp.lastUsage, null);
  assert.equal(pp.compactedThisTurn, false);
});

test('codex rollout: last token_count wins; compaction only counts inside the latest turn', () => {
  const tail = [
    { type: 'turn_context', payload: { model: 'gpt-5.4' } },
    { type: 'compacted', payload: {} },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5000 }, model_context_window: 272000 } } },
    { type: 'turn_context', payload: { model: 'gpt-5.4' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 81000, cached_input_tokens: 80000 }, model_context_window: 272000 } } },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.deepEqual(parseCodexRolloutTail(tail), { promptTokens: 81000, contextWindow: 272000, model: 'gpt-5.4', compacted: false });
  assert.equal(parseCodexRolloutTail('{"type":"event_msg","payload":{"type":"agent_message"}}'), null);
});

test('reportContext sends nothing when the CLI measured nothing', () => {
  const client = createMockClient();
  const adapter = new PiAdapter({ agentName: 'pi', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  adapter.reportContext('ch', { promptTokens: 0, contextWindow: 0 });
  adapter.reportContext('', { promptTokens: 10 });
  assert.equal(client.contexts.length, 0);
});
