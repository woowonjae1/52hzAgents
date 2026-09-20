'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

const PiAdapter = require('../src/adapters/pi');

function createMockClient() {
  const sentMessages = [];
  const statusUpdates = [];
  return {
    sentMessages,
    statusUpdates,
    getSession: async () => ({ workingDir: process.cwd() }),
    sendMessage: async (wsId, ch, token, content, opts) => {
      sentMessages.push({ wsId, ch, content, opts });
      return { id: 'msg-' + sentMessages.length };
    },
    reportAgentUsage: async () => {},
    postEvents: async () => {},
    sendControl: async () => {},
  };
}

function createFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.pid = 99999;
  return proc;
}

test('PiAdapter deduplicates thinking across toolcall_start and thinking_end', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
  });

  const fakeProc = createFakeProc();
  adapter._findPiBinary = () => 'node';
  adapter._resolveWorkingDir = async () => process.cwd();
  adapter._spawnProc = () => fakeProc;

  const runPromise = adapter._runPi('test prompt', 'ch-1');
  // Allow _runPi to resolve async pre-flight and attach listeners
  await delay(10);

  // Simulate Pi JSON Lines event stream
  // 1. Thinking starts and streams deltas
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 }
  }) + '\n');

  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Checking git status.' }
  }) + '\n');

  // 2. toolcall_start arrives BEFORE thinking_end
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'bash' }
  }) + '\n');

  // 3. thinking_end arrives with full content
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Checking git status.' }
  }) + '\n');

  // 4. message_end with tool call
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Checking git status.' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'git status' } }
      ]
    }
  }) + '\n');

  // 5. Final text response in next turn
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_start', contentIndex: 0 }
  }) + '\n');

  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Everything clean.' }
  }) + '\n');

  fakeProc.stdout.push(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Everything clean.' }]
    }
  }) + '\n');

  // End stream and exit cleanly
  fakeProc.stdout.push(null);
  fakeProc.stderr.push(null);
  await delay(10);
  fakeProc.emit('exit', 0);

  const result = await runPromise;
  assert.equal(result, 'Everything clean.');

  // Verify thinking messages: MUST be sent exactly once, NOT duplicated
    // Verify thinking messages: MUST be sent exactly once, NOT duplicated
    const thinkingMessages = client.sentMessages.filter(
      (m) => m.opts && m.opts.messageType === 'thinking' && !m.opts.metadata?.reply_preview
    );
    assert.equal(thinkingMessages.length, 1, `Expected 1 thinking message but found ${thinkingMessages.length}`);
    assert.equal(thinkingMessages[0].content, 'Checking git status.');

    // Verify reply preview was streamed
    const previewMessages = client.sentMessages.filter(
      (m) => m.opts && Boolean(m.opts.metadata?.reply_preview)
    );
    assert.equal(previewMessages.length, 1);
    assert.equal(previewMessages[0].content, 'Everything clean.');
});

test('PiAdapter captures 422 model error and surfaces it instead of empty response', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
  });

  const fakeProc = createFakeProc();
  adapter._findPiBinary = () => 'node';
  adapter._resolveWorkingDir = async () => process.cwd();
  adapter._spawnProc = () => fakeProc;

  const runPromise = adapter._runPi('test prompt', 'ch-1');
  await delay(10);

  // Thinking succeeded
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Analyzing commits.' }
  }) + '\n');

  // Next turn assistant message failed with 422 upstream error
  fakeProc.stdout.push(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: '422: {"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}'
    }
  }) + '\n');

  fakeProc.stdout.push(null);
  fakeProc.stderr.push(null);
  await delay(10);
  // CLI exited 0 in json mode despite error
  fakeProc.emit('exit', 0);

  await assert.rejects(
    async () => { await runPromise; },
    (err) => {
      assert.match(err.message, /422.*Inference request failed/);
      return true;
    }
  );
});

test('PiAdapter _handleMessage routes model error to sendError', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
    retryDelayMs: 0,
  });

  // Mock _runPi throwing an upstream error
  adapter._runPi = async () => {
    throw new Error('422: {"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}');
  };
  adapter._autoTitleChannel = async () => {};
  adapter.sendStatus = async () => {};

  await adapter._handleMessage({
    sessionId: 'ch-error-test',
    content: '@pi check recent commit',
  });

  const errorMessages = client.sentMessages.filter(
    (m) => m.opts && m.opts.messageType === 'error'
  );
  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0].content, /Pi error: 422: \{"message":"Inference request failed/);
  // Ensure "No response generated" was NOT sent as regular chat
  const chatMessages = client.sentMessages.filter(
    (m) => !m.opts?.messageType || m.opts?.messageType === 'chat'
  );
  assert.equal(chatMessages.length, 0);
});

test('PiAdapter retries on transient upstream 422 error and succeeds on subsequent attempt', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
    retryDelayMs: 0,
  });

  let callCount = 0;
  adapter._runPi = async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error('422: {"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}');
    }
    return 'Success after retry';
  };
  adapter._autoTitleChannel = async () => {};
  const statusUpdates = [];
  adapter.sendStatus = async (ch, status) => {
    statusUpdates.push(status);
  };

  await adapter._handleMessage({
    sessionId: 'ch-retry-success-test',
    content: '@pi check recent commit',
  });

  assert.equal(callCount, 2, 'Should have retried once and succeeded on second attempt');
  const chatMessages = client.sentMessages.filter(
    (m) => !m.opts?.messageType || m.opts?.messageType === 'chat'
  );
  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].content, 'Success after retry');

  // Ensure no error messages were sent to the user
  const errorMessages = client.sentMessages.filter(
    (m) => m.opts && m.opts.messageType === 'error'
  );
  assert.equal(errorMessages.length, 0);

  // Status should contain retry notification
  assert.ok(statusUpdates.some((s) => s.includes('retrying (1/2)')));
});

test('PiAdapter captures auto_retry_end failure', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
  });

  const fakeProc = createFakeProc();
  adapter._findPiBinary = () => 'node';
  adapter._resolveWorkingDir = async () => process.cwd();
  adapter._spawnProc = () => fakeProc;

  const runPromise = adapter._runPi('test prompt', 'ch-1');
  await delay(10);

  fakeProc.stdout.push(JSON.stringify({
    type: 'auto_retry_end',
    success: false,
    finalError: 'Rate limit exceeded on provider'
  }) + '\n');

  fakeProc.stdout.push(null);
  fakeProc.stderr.push(null);
  await delay(10);
  fakeProc.emit('exit', 0);

  await assert.rejects(
    async () => { await runPromise; },
    (err) => {
      assert.match(err.message, /Rate limit exceeded on provider/);
      return true;
    }
  );
});

test('PiAdapter passes userMessage to _resolveWorkingDir to support directory override', async () => {
  const client = createMockClient();
  const adapter = new PiAdapter({
    agentName: 'pi-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client,
  });

  let capturedMessageText = '';
  adapter._resolveWorkingDir = async (channel, messageText) => {
    capturedMessageText = messageText;
    return process.cwd();
  };
  adapter._spawnProc = () => {
    const fakeProc = createFakeProc();
    fakeProc.stdout.push(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] }
    }) + '\n');
    fakeProc.stdout.push(null);
    fakeProc.stderr.push(null);
    setImmediate(() => fakeProc.emit('exit', 0));
    return fakeProc;
  };
  adapter._autoTitleChannel = async () => {};
  adapter.sendStatus = async () => {};
  adapter.sendResponse = async () => {};

  await adapter._handleMessage({
    sessionId: 'ch-cwd-test',
    content: '工作目录 D:\\code\\override check recent commit',
  });

  assert.equal(capturedMessageText, '工作目录 D:\\code\\override check recent commit');
});

