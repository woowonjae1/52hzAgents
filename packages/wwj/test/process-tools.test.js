'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { McpServer, buildToolDefs } = require('../src/mcp-server');

test('Process tools: buildToolDefs includes process management tools', () => {
  const tools = buildToolDefs(new Set());
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('workspace_process_start'));
  assert.ok(names.has('workspace_process_status'));
  assert.ok(names.has('workspace_process_logs'));
  assert.ok(names.has('workspace_process_stop'));
});

test('Process tools: start, check status, inspect logs, and stop', async () => {
  const server = new McpServer({
    workspaceId: 'ws-123',
    channelName: 'ch-1',
    agentName: 'alice',
    token: 'tok-1',
  });

  // 1. Start a process that outputs something
  const cmd = process.platform === 'win32'
    ? 'cmd.exe /c "echo hello_process & ping 127.0.0.1 -n 5 > nul"'
    : 'echo hello_process && sleep 4';

  const startRes = await server._dispatch('workspace_process_start', {
    name: 'test-proc',
    command: cmd,
    port: 9876,
  });
  assert.ok(startRes.content[0].text.includes('test-proc'));
  assert.ok(startRes.content[0].text.includes('PID:'));

  // 2. Check status
  const statusRes = await server._dispatch('workspace_process_status', { name: 'test-proc' });
  const statusJson = JSON.parse(statusRes.content[0].text);
  assert.equal(statusJson.name, 'test-proc');
  assert.equal(statusJson.port, 9876);
  assert.ok(statusJson.pid > 0);

  // Allow some time for output to buffer
  await new Promise((r) => setTimeout(r, 600));

  // 3. Read logs
  const logsRes = await server._dispatch('workspace_process_logs', { name: 'test-proc', tail: 10 });
  assert.ok(logsRes.content[0].text.includes('hello_process'));

  // 4. Stop process
  const stopRes = await server._dispatch('workspace_process_stop', { name: 'test-proc' });
  assert.ok(stopRes.content[0].text.includes('stopped successfully'));

  // 5. Status reflects stopped
  const afterStatus = await server._dispatch('workspace_process_status', { name: 'test-proc' });
  const afterJson = JSON.parse(afterStatus.content[0].text);
  assert.equal(afterJson.running, false);
});
