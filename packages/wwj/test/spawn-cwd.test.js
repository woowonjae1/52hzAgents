'use strict';

/*
  codex and gemini used to spawn in `this.workingDir` (the agent's default
  folder), ignoring the thread's folder and a parallel lane's worktree -- so a
  lane's isolation did not hold for them. _cwdFor is what their spawn sites use.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const BaseAdapter = require('../src/adapters/base');

function make() {
  const a = new BaseAdapter({ agentName: 'codex', workspaceId: 'ws', endpoint: 'http://x', token: 't', client: {}, workingDir: '/agent/home' });
  a._log = () => {};
  return a;
}

test('lane worktree beats the thread folder, which beats the agent default', () => {
  const a = make();
  assert.equal(a._cwdFor('ch-1'), '/agent/home');

  a._workingDirCache = new Map([['ch-1', { value: '/projects/app', at: Date.now() }]]);
  assert.equal(a._cwdFor('ch-1'), '/projects/app');
  assert.equal(a._cwdFor('ch-2'), '/agent/home', 'other channels unaffected');

  a._turnDirOverride = { 'ch-1': '/tmp/worktrees/lane-codex' };
  assert.equal(a._cwdFor('ch-1'), '/tmp/worktrees/lane-codex');
});
