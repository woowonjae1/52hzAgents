'use strict';

/*
  `wwj connect <agent> <token>` with no daemon running says it is
  "Auto-starting daemon with <agent>", but a booting daemon leaves every agent
  idle unless it is marked autostart -- so the agent just connected stayed
  offline. The cold path must queue start:<agent> for the daemon's first tick,
  the same way the warm path notifies a running daemon.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.WWJ_CLI_NO_MAIN = '1';
const { cmdConnect } = require('../src/cli');
const { Config } = require('../src/config');

function fakeConnector({ daemonPid = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-connect-'));
  const events = [];
  return {
    events,
    config: new Config(dir),
    workspace: { endpoint: 'http://127.0.0.1:1' },
    getEnvFields: () => [{ name: 'ACP_COMMAND', required: true }],
    resolveToken: async () => ({ workspace_id: 'ws-1', slug: 'ws', name: 'WS', endpoint: 'http://127.0.0.1:1' }),
    connectWorkspace: () => {},
    getDaemonPid: () => daemonPid,
    sendDaemonCommand: (cmd) => events.push(`cmd ${cmd}`),
    startDaemon: () => events.push('daemon started'),
  };
}

const quiet = async (fn) => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { await fn(); } finally { process.stdout.write = write; }
};

test('cold connect queues start:<agent> before starting the daemon', async () => {
  const c = fakeConnector();
  await quiet(() => cmdConnect(c, { type: 'acp', env: 'ACP_COMMAND=fake-acp' }, ['acp-x', 'ws_token']));
  assert.deepEqual(c.events, ['cmd start:acp-x', 'daemon started']);
  assert.equal(c.config.getAgent('acp-x').type, 'acp');
});

test('warm connect still notifies the running daemon', async () => {
  const c = fakeConnector({ daemonPid: 4242 });
  await quiet(() => cmdConnect(c, { type: 'acp', env: 'ACP_COMMAND=fake-acp' }, ['acp-y', 'ws_token']));
  assert.ok(c.events.includes('cmd start:acp-y'));
  assert.ok(!c.events.includes('daemon started'));
});
