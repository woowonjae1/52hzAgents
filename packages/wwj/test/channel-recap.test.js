'use strict';

/*
 * The shared channel recap (BaseAdapter._buildChannelContext), used by claude,
 * pi and hermes. It tells an agent what was said in the channel that its own
 * session has not seen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const PiAdapter = require('../src/adapters/pi');
const HermesAdapter = require('../src/adapters/hermes');

function withMessages(Adapter, messages) {
  const calls = [];
  const client = {
    getRecentMessages: async (wsId, channel, token, limit) => {
      calls.push({ wsId, channel, limit });
      return messages;
    },
    reportAgentUsage: async () => {},
  };
  const adapter = new Adapter({ agentName: 'pi', workspaceId: 'ws-1', endpoint: 'http://x', token: 't', client });
  return { adapter, calls, messages };
}

const M = (messageId, senderName, content, extra = {}) => ({
  messageId, senderName, content, senderType: senderName === 'user' ? 'human' : 'agent', messageType: 'chat', ...extra,
});

test('full recap: recent conversation with the intro, current message excluded, thinking dropped', async () => {
  const { adapter, calls } = withMessages(PiAdapter, [
    M('1', 'user', 'first question'),
    M('2', 'pi', 'my reply'),
    M('3', 'claude', 'musing', { messageType: 'thinking' }),
    M('4', 'user', 'pi, review it'),
  ]);
  const text = await adapter._buildChannelContext('ch-1', { full: true, currentMessageId: '4' });
  assert.deepEqual(calls[0], { wsId: 'ws-1', channel: 'ch-1', limit: 60 });
  assert.match(text, /^You previously worked in this channel/);
  assert.match(text, /\[user\] first question\n\[pi\] my reply$/);
});

test('incremental: only what others posted after the cursor, and the cursor advances', async () => {
  const msgs = [M('1', 'user', 'q'), M('2', 'pi', 'a')];
  const { adapter } = withMessages(PiAdapter, msgs);
  await adapter._buildChannelContext('ch-1', { full: true }); // cursor -> '2'

  msgs.push(M('3', 'claude', 'I refactored the router'), M('4', 'pi', 'noted'), M('5', 'user', 'pi, review it'));
  const text = await adapter._buildChannelContext('ch-1', { currentMessageId: '5' });
  assert.match(text, /^## Channel context you have not seen/);
  assert.match(text, /\[claude\] I refactored the router/);
  assert.doesNotMatch(text, /noted|review it/);

  // Nothing new since: no prefix at all.
  assert.equal(await adapter._buildChannelContext('ch-1', { currentMessageId: '5' }), null);
});

test('hermes uses a plain intro and the recap is not empty any more', async () => {
  const { adapter } = withMessages(HermesAdapter, [M('1', 'user', 'hello'), M('2', 'claude', 'hi')]);
  const text = await adapter._getRecentHistoryText('ch-1');
  assert.equal(text, '## Recent Workspace Messages\n\n[user] hello\n[claude] hi');
});
