'use strict';

/*
  `--env KEY=VALUE` on `wwj create` / `wwj connect`: how the workspace UI hands
  an ACP agent its command and permission mode. Values land in the agent's own
  `env` block (config.yaml), which the daemon merges into the adapter env.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { envFlagValues, parseEnvAssignments, missingRequired } = require('../src/agent-env-flags');
const { Config } = require('../src/config');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const ACP_FIELDS = [
  { name: 'ACP_COMMAND', required: true },
  { name: 'ACP_ARGS' },
  { name: 'ACP_PERMISSION_MODE', default: 'ask' },
];

function runCli(args, configDir) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--config', configDir], {
    encoding: 'utf-8',
    env: { ...process.env, WWJ_WORKSPACE_TOKEN: '', HZ_WORKSPACE_TOKEN: '', HZ_TOKEN: '' },
    timeout: 20000,
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wwj-envflag-'));
}

test('envFlagValues normalises absent, single, repeated and bare flags', () => {
  assert.deepEqual(envFlagValues(undefined), []);
  assert.deepEqual(envFlagValues('A=1'), ['A=1']);
  assert.deepEqual(envFlagValues(['A=1', 'B=2']), ['A=1', 'B=2']);
  assert.deepEqual(envFlagValues([true]), ['']);
});

test('parseEnvAssignments keeps declared keys and splits on the first =', () => {
  const { env, errors } = parseEnvAssignments(
    ['ACP_COMMAND=gemini --experimental-acp', 'ACP_PERMISSION_MODE=auto', 'ACP_ARGS=["--x=1"]'],
    ACP_FIELDS,
    'acp'
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(env, {
    ACP_COMMAND: 'gemini --experimental-acp',
    ACP_PERMISSION_MODE: 'auto',
    ACP_ARGS: '["--x=1"]',
  });
});

test('parseEnvAssignments rejects undeclared keys, bad names, multi-line values', () => {
  const { env, errors } = parseEnvAssignments(
    ['NODE_OPTIONS=--require evil.js', 'PATH=/tmp', '1BAD=x', 'noequals', 'ACP_COMMAND=a\nb'],
    ACP_FIELDS,
    'acp'
  );
  assert.deepEqual(env, {});
  assert.equal(errors.length, 5);
  assert.match(errors[0], /NODE_OPTIONS.*not a setting of agent type 'acp'/);
  assert.match(errors[2], /not a valid variable name/);
  assert.match(errors[3], /KEY=VALUE/);
  assert.match(errors[4], /single line/);
});

test('parseEnvAssignments rejects everything for a type with no env_config', () => {
  const { errors } = parseEnvAssignments(['ANY=1'], [], 'claude');
  assert.match(errors[0], /has no configurable settings/);
});

test('missingRequired reports only required fields without a value', () => {
  assert.deepEqual(missingRequired(ACP_FIELDS, {}), ['ACP_COMMAND']);
  assert.deepEqual(missingRequired(ACP_FIELDS, { ACP_COMMAND: '  ' }), ['ACP_COMMAND']);
  assert.deepEqual(missingRequired(ACP_FIELDS, { ACP_COMMAND: 'opencode acp' }), []);
});

test('wwj create --type acp --env stores the settings on that agent', () => {
  const dir = tmpConfigDir();
  const { code, out } = runCli(
    [
      'create', 'my-acp', '--type', 'acp',
      '--env', 'ACP_COMMAND=opencode acp',
      '--env=ACP_PERMISSION_MODE=deny',
      '--path', dir,
    ],
    dir
  );
  assert.equal(code, 0, out);
  const agent = new Config(dir).getAgent('my-acp');
  assert.equal(agent.type, 'acp');
  assert.deepEqual(agent.env, { ACP_COMMAND: 'opencode acp', ACP_PERMISSION_MODE: 'deny' });
  assert.doesNotMatch(out, /needs ACP_COMMAND/);
});

test('wwj create --type acp without ACP_COMMAND warns but still creates', () => {
  const dir = tmpConfigDir();
  const { code, out } = runCli(['create', 'bare-acp', '--type', 'acp', '--path', dir], dir);
  assert.equal(code, 0, out);
  assert.match(out, /needs ACP_COMMAND/);
  assert.ok(new Config(dir).getAgent('bare-acp'));
});

test('wwj create refuses an undeclared --env key and writes nothing', () => {
  const dir = tmpConfigDir();
  const { code, out } = runCli(
    ['create', 'evil', '--type', 'acp', '--env', 'NODE_OPTIONS=--require x', '--path', dir],
    dir
  );
  assert.equal(code, 1);
  assert.match(out, /NODE_OPTIONS/);
  assert.equal(new Config(dir).getAgent('evil'), null);
});

test('wwj connect validates --env against the explicit --type before resolving the token', () => {
  const dir = tmpConfigDir();
  // The name contains "gemini", but --type acp must win: ACP_COMMAND is an acp
  // setting, so it validates. The bogus key fails before any network call.
  const { code, out } = runCli(
    ['connect', 'my-gemini-acp', 'tok', '--type', 'acp',
      '--env', 'ACP_COMMAND=gemini --experimental-acp', '--env', 'BOGUS=1'],
    dir
  );
  assert.equal(code, 1);
  assert.match(out, /'BOGUS' is not a setting of agent type 'acp'/);
  assert.doesNotMatch(out, /ACP_COMMAND' is not/);
  assert.doesNotMatch(out, /Resolving workspace token/);
  assert.equal(new Config(dir).getAgent('my-gemini-acp'), null);
});
