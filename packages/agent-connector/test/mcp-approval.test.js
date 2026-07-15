'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('../src/mcp-server');

// Mock WorkspaceClient
class MockWorkspaceClient {
  constructor() {
    this.sentEvents = [];
    this.messages = [];
  }

  async sendMessage(workspaceId, channelName, token, content, opts) {
    const msg = {
      messageId: 'msg_' + Math.random().toString(36).slice(2, 9),
      content,
      metadata: opts.metadata || {},
    };
    this.messages.push(msg);
    this.sentEvents.push({ type: 'sendMessage', content, opts });
    return msg;
  }

  async pollMessages(workspaceId, channelName, token, opts) {
    if (opts && opts.after) {
      const idx = this.messages.findIndex(m => m.messageId === opts.after);
      if (idx !== -1) return this.messages.slice(idx + 1);
    }
    return this.messages;
  }
}

test('MCP Server: local_execute_command execution without approval', async () => {
  const wsClient = new MockWorkspaceClient();
  const server = new McpServer({
    wsClient,
    workspaceId: 'ws-test',
    channelName: 'general',
    agentName: 'coder',
    token: 'test-token',
  });

  // Ensure requireApproval env var is disabled
  delete process.env.OA_REQUIRE_APPROVAL;

  const res = await server._dispatch('local_execute_command', { command: 'echo hello_world_no_appr' });
  assert.ok(res.content[0].text.includes('hello_world_no_appr'));
});

test('MCP Server: local_execute_command execution with approval approved', async () => {
  const wsClient = new MockWorkspaceClient();
  const server = new McpServer({
    wsClient,
    workspaceId: 'ws-test',
    channelName: 'general',
    agentName: 'coder',
    token: 'test-token',
  });

  process.env.OA_REQUIRE_APPROVAL = 'true';

  // Trigger dispatch in background
  const dispatchPromise = server._dispatch('local_execute_command', { command: 'echo hello_approved' });

  // Wait a bit for approval message to be sent
  await new Promise(resolve => setTimeout(resolve, 500));

  assert.equal(wsClient.sentEvents.length, 1);
  const reqEvent = wsClient.sentEvents[0];
  assert.ok(reqEvent.opts.metadata.tool_approval_request);
  const approvalId = reqEvent.opts.metadata.tool_approval_request.approval_id;

  // Mock user sending approval message
  wsClient.messages.push({
    messageId: 'resp_123',
    content: 'Approved',
    metadata: {
      tool_approval_response: {
        approval_id: approvalId,
        granted: true,
      }
    }
  });

  const res = await dispatchPromise;
  assert.ok(res.content[0].text.includes('hello_approved'));

  delete process.env.OA_REQUIRE_APPROVAL;
});

test('MCP Server: local_execute_command execution with approval rejected', async () => {
  const wsClient = new MockWorkspaceClient();
  const server = new McpServer({
    wsClient,
    workspaceId: 'ws-test',
    channelName: 'general',
    agentName: 'coder',
    token: 'test-token',
  });

  process.env.OA_REQUIRE_APPROVAL = 'true';

  // Trigger dispatch in background
  const dispatchPromise = server._dispatch('local_execute_command', { command: 'echo hello_rejected' });

  // Wait a bit for approval message to be sent
  await new Promise(resolve => setTimeout(resolve, 500));

  assert.equal(wsClient.sentEvents.length, 1);
  const reqEvent = wsClient.sentEvents[0];
  const approvalId = reqEvent.opts.metadata.tool_approval_request.approval_id;

  // Mock user sending rejection message
  wsClient.messages.push({
    messageId: 'resp_124',
    content: 'Denied',
    metadata: {
      tool_approval_response: {
        approval_id: approvalId,
        granted: false,
      }
    }
  });

  await assert.rejects(dispatchPromise, /Permission denied by user/);

  delete process.env.OA_REQUIRE_APPROVAL;
});
