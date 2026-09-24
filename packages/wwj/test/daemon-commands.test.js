'use strict';

/*
  The daemon command file (daemon.cmd) is how `wwj start/stop/restart` and the
  launcher talk to a running daemon; the daemon drains it every 200ms. Two
  commands sent inside one tick must both arrive: writeCommand used to
  overwrite the file, so `wwj start a; wwj start b` started only b.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Config } = require('../src/config');
const { Daemon } = require('../src/daemon');

function tmpConfig() {
  return new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-cmd-')));
}

// Just enough of a daemon for _processCommands: records what it was told.
function fakeDaemon(config) {
  const calls = [];
  return {
    calls,
    config,
    _adapters: {},
    _processes: {},
    _log: () => {},
    restartAgent: (name) => calls.push(`restart:${name}`),
    stopAgent: (name) => calls.push(`stop:${name}`),
    _reload: () => calls.push('reload'),
  };
}

test('commands written inside one daemon tick are all kept', () => {
  const config = tmpConfig();
  config.writeCommand('start:a');
  config.writeCommand('start:b');
  config.writeCommand('stop:c');
  assert.deepEqual(fs.readFileSync(config.cmdFile, 'utf-8').trim().split('\n'), ['start:a', 'start:b', 'stop:c']);

  const d = fakeDaemon(config);
  Daemon.prototype._processCommands.call(d);
  assert.deepEqual(d.calls, ['restart:a', 'restart:b', 'stop:c']);
  assert.equal(fs.existsSync(config.cmdFile), false, 'the drained file is gone');
});

test('a command written after the daemon claimed the file waits for the next tick', () => {
  const config = tmpConfig();
  config.writeCommand('start:a');
  const d = fakeDaemon(config);
  // Simulate a writer landing while the daemon handles the claimed batch.
  d.restartAgent = (name) => {
    d.calls.push(`restart:${name}`);
    if (name === 'a') config.writeCommand('start:late');
  };
  Daemon.prototype._processCommands.call(d);
  assert.deepEqual(d.calls, ['restart:a']);
  Daemon.prototype._processCommands.call(d);
  assert.deepEqual(d.calls, ['restart:a', 'restart:late'], 'the late command was not deleted unseen');
});
