'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeExecution, EXECUTION_KINDS, RESERVED_CONNECTION_KINDS } = require('./legacy-mapping');
const { probeClients, CAPABILITY_KEYS, readVersion } = require('./capabilities');

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-r0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('stored runtimeKind pi always maps to the built-in Pi SDK assistant, never a native Pi connection', () => {
  const pi = describeExecution('pi');
  assert.equal(pi.connectionKind, 'builtin-pi-sdk');
  assert.equal(pi.compatibility, 'legacy-builtin');
  assert.equal(pi.nativeConnection, null);
  assert.equal(pi.usesWorkbenchModelConnection, true);
  for (const entry of Object.values(EXECUTION_KINDS)) assert.ok(!RESERVED_CONNECTION_KINDS.includes(entry.connectionKind));
  assert.equal(describeExecution('gemini').compatibility, 'deferred');
  assert.throws(() => describeExecution('pi-native'), { code: 'UNKNOWN_RUNTIME_KIND' });
});

test('repository exposes a derived execution view; default Agent stays a compatible Pi SDK member', async t => {
  const root = tempDir(t);
  const { createStorage } = require('../storage');
  const storage = createStorage({ dbPath: path.join(root, 'database.sqlite') });
  try {
    const builtIn = storage.agentDefinitions.get('agent-local');
    assert.equal(builtIn.runtimeKind, 'pi');
    assert.equal(builtIn.execution.connectionKind, 'builtin-pi-sdk');
    const codex = storage.agentDefinitions.create({ name: 'Codex member', runtimeKind: 'codex', defaultMode: 'plan' });
    assert.equal(codex.execution.connectionKind, 'native-codex');
    // The derived view is not an accepted write field.
    assert.throws(() => storage.agentDefinitions.update(codex.id, { expectedRevision: 1, execution: { connectionKind: 'native-pi' } }), /Unsupported Agent field/);
  } finally { storage.close(); }
});

test('probe is read-only: detects a local pi without mapping it, stats config files without reading or changing them', async t => {
  const root = tempDir(t);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi');
  fs.writeFileSync(fake, ''); fs.chmodSync(fake, 0o755);
  const agentDir = path.join(root, 'pi-agent'); fs.mkdirSync(agentDir);
  const settings = path.join(agentDir, 'settings.json');
  fs.writeFileSync(settings, '{ "defaultModel": "keep" // comment\n}');
  const before = fs.statSync(settings);
  const env = { PATH: bin, PI_CODING_AGENT_DIR: agentDir, USERPROFILE: root, HOME: root, CODEX_HOME: path.join(root, 'codex') };
  let spawned = 0;
  const result = await probeClients({ env, versions: false, spawnImpl: () => { spawned++; throw new Error('must not spawn'); } });
  assert.equal(spawned, 0);
  const pi = result.clients.find(c => c.kind === 'pi-native');
  assert.equal(pi.installation.detected, true);
  assert.equal(pi.stage, 'planned-r1');
  assert.deepEqual(pi.configSources.map(s => [s.id, s.exists]), [['pi.settings', true], ['pi.models', false], ['pi.auth', false]]);
  assert.equal(pi.configSources.find(s => s.id === 'pi.auth').secret, true);
  assert.ok(!('content' in pi.configSources[0]));
  const after = fs.statSync(settings);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ "defaultModel": "keep" // comment\n}');
  assert.equal(result.clients.find(c => c.kind === 'builtin-pi-sdk').installation.bundled, true);
  assert.equal(result.clients.find(c => c.kind === 'codex').installation.detected, false);
  assert.equal(result.clients.find(c => c.kind === 'gemini').stage, 'deferred');
  for (const client of result.clients) {
    assert.deepEqual(Object.keys(client.capabilities), [...CAPABILITY_KEYS]);
    for (const value of Object.values(client.capabilities)) assert.ok(['verified', 'declared', 'unsupported', 'unknown'].includes(value.status));
  }
  // Clients with unverified config layouts must not get guessed paths.
  assert.deepEqual(result.clients.find(c => c.kind === 'openclaw').configSources, []);
  assert.deepEqual(result.clients.find(c => c.kind === 'hermes').configSources, []);
});

test('readVersion strips ELECTRON_RUN_AS_NODE for external binaries and sets it only for process.execPath scripts', async () => {
  const { EventEmitter } = require('node:events');
  const seen = [];
  const fakeSpawn = (cmd, args, opts) => {
    seen.push({ cmd, args, electronRunAsNode: opts.env.ELECTRON_RUN_AS_NODE });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('1.4.12\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const prev = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const ext = await readVersion({ command: 'C:\\agy\\agy.exe', args: [] }, { spawnImpl: fakeSpawn });
    assert.equal(ext.version, '1.4.12');
    assert.equal(seen[0].electronRunAsNode, undefined);
    const nodeScript = await readVersion({ command: process.execPath, args: ['cli.js'] }, { spawnImpl: fakeSpawn });
    assert.equal(nodeScript.version, '1.4.12');
    assert.equal(seen[1].electronRunAsNode, '1');
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prev;
  }
});
