'use strict';

/*
  Files an agent writes during a turn must reach the workspace Files panel,
  for every adapter -- not only claude, which tracks its own tool calls.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseAdapter = require('../src/adapters/base');
const ClaudeAdapter = require('../src/adapters/claude');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-files-'));
  const uploads = [];
  const client = {
    uploadFile: async (ws, tok, name, b64, opts) => { uploads.push({ name, channel: opts.channelName }); },
  };
  return { dir, uploads, client };
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('files modified during the turn are registered; old, hidden, vendored and lock files are not', async () => {
  const { dir, uploads, client } = setup();
  write(path.join(dir, 'old.md'));
  const past = (Date.now() - 60_000) / 1000;
  fs.utimesSync(path.join(dir, 'old.md'), past, past);

  const turnStart = Date.now() - 10;
  write(path.join(dir, 'report.md'), '# result');
  write(path.join(dir, 'src', 'chart.py'), 'print(1)');
  write(path.join(dir, '.env'), 'SECRET=1');
  write(path.join(dir, 'node_modules', 'x', 'index.js'));
  write(path.join(dir, 'package-lock.json'), '{}');

  const a = new BaseAdapter({ agentName: 'pi', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  a._log = () => {};
  a._resolveWorkingDir = async () => dir;
  await a._registerFilesTouchedSince('ch-1', turnStart);

  assert.deepEqual(uploads.map((u) => u.name).sort(), ['chart.py', 'report.md']);
  assert.ok(uploads.every((u) => u.channel === 'ch-1'));

  // Same files, unchanged: not uploaded twice.
  await a._registerFilesTouchedSince('ch-1', turnStart);
  assert.equal(uploads.length, 2);
});

test('claude tracks its own writes, so the directory scan is skipped', async () => {
  const { dir, uploads, client } = setup();
  const turnStart = Date.now() - 10;
  write(path.join(dir, 'report.md'));
  const c = new ClaudeAdapter({ agentName: 'claude', workspaceId: 'ws', endpoint: 'http://x', token: 't', client });
  c._log = () => {};
  c._resolveWorkingDir = async () => dir;
  await c._registerFilesTouchedSince('ch-1', turnStart);
  assert.equal(uploads.length, 0);
});
