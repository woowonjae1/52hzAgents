// Opt-in real Pi -> Codex pipeline. All workspace/database changes stay in a temp directory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { AgentRunner } from './agent-runner.js';
import { Collaboration } from './collaboration.js';
import { ConfigManager } from './config-manager.js';
import { closeDatabasesUnder } from './storage/database.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-native-live-')));
const report = { startedAt: new Date().toISOString(), checks: [], status: 'failed' };
let runner;
try {
  const home = path.join(os.homedir(), '.pi', 'agent');
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(home, 'models.json'), 'utf8'));
  const provider = source.providers?.[settings.defaultProvider];
  const model = provider?.models?.find(item => item.id === settings.defaultModel);
  assert.ok(provider && model && typeof provider.apiKey === 'string' && provider.apiKey);
  const secret = provider.apiKey;
  const secrets = new Map();
  const vault = { has: id => secrets.has(id), get: id => secrets.get(id), set: (id, value) => secrets.set(id, value), delete: id => secrets.delete(id) };
  const manager = new ConfigManager(path.join(root, 'data'), vault, {});
  const connection = manager.saveConnection({ id: 'pi-native-test', name: 'Temporary Pi resource', protocol: provider.api === 'anthropic-messages' ? 'anthropic' : 'openai',
    baseUrl: provider.baseUrl, defaultModel: model.id, models: [model], confirmedContextWindow: model.contextWindow,
    credentialAction: 'replace', credentialValue: secret });
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const store = new Store(path.join(root, 'data'));
  store.updateChannel('general', { working_dir: project, runtime_config: { inheritAgent: true } });
  // Test fixture only. Native clients cannot promise per-request hard budgets.
  // Never clear limits in the user's database or production launch path.
  store.storage.db.exec('UPDATE budget_limits SET max_tokens_per_run=NULL,max_steps_per_run=NULL,max_cost_per_session=NULL,max_cost_per_day=NULL');
  const bus = { broadcast(event) {
    const row = event.type === 'workspace.runtime.tool.updated' && event.payload;
    if (row?.status === 'pending') queueMicrotask(() => {
      const changes = row.args?.changes || [];
      const bounded = row.tool === 'write' && changes.length === 1 && changes[0].kind?.type === 'add'
        && path.resolve(project, changes[0].path) === path.join(project, 'native-result.txt')
        && row.patch?.includes('NATIVE_FILE_VERIFIED') && !fs.existsSync(path.join(project, 'native-result.txt'));
      runner.tools.decide(row.approval_id, 'general', Boolean(bounded));
    });
  }, broadcastComposing() {} };
  runner = new AgentRunner(store, bus, { configManager: manager, env: {}, timeoutMs: 90000 });
  const collaboration = new Collaboration(store, runner, bus); runner.collaboration = collaboration;
  const pi = store.storage.agentDefinitions.create({ name: 'Pi handoff', defaultMode: 'chat', maxMode: 'chat', instructions: 'Follow the acceptance instruction exactly.',
    modelResource: { connectionId: connection.id, modelId: model.id, maxOutputTokens: 256 }, limits: { maxDurationSeconds: 60 } });
  const codex = store.storage.agentDefinitions.create({ name: 'Codex verifier', runtimeKind: 'codex', runtimeModel: process.env.CODEX_ACCEPTANCE_MODEL || null,
    defaultMode: 'plan', maxMode: 'plan', instructions: 'Verify the prior deliverable; do not call tools.',
    permissions: { readFiles: true, executeCommands: true, writeFiles: false, knowledge: false, mcp: false, delegate: false }, limits: { maxDurationSeconds: 60 } });
  collaboration.startPipeline('general', { steps: [
    { agent_id: pi.id, instruction: 'Respond exactly HANDOFF_52HZ. Do not use tools.' },
    { agent_id: codex.id, instruction: 'If the prior deliverable contains HANDOFF_52HZ, respond exactly VERIFIED_52HZ. Otherwise respond FAILED_52HZ. Do not use tools.' },
  ] });
  const until = Date.now() + 150000;
  while (runner.active.size || store.storage.pipelines.get('general').status === 'running') {
    if (Date.now() > until) throw new Error('LIVE_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const pipeline = store.storage.pipelines.get('general');
  assert.ok(pipeline.steps[0].deliverable?.includes('HANDOFF_52HZ'));
  assert.ok(pipeline.steps[1].deliverable?.includes('VERIFIED_52HZ'));
  const runs = store.data.runtime_runs;
  assert.equal(runs.length, 2); assert.ok(runs.every(row => row.outcome === 'finished'));
  assert.deepEqual(runs.map(row => row.snapshot.agent.runtimeKind), ['pi', 'codex']);
  const native = runs.find(row => row.snapshot.agent.runtimeKind === 'codex');
  assert.equal(store.storage.usage.listModelRequestsByRun(native.id).length, 0);
  report.checks.push('real Pi generation', 'real Codex app-server', 'Agent-bound client', 'pipeline deliverable handoff', 'actual terminal states', 'no fabricated native HTTP request ledger');
  const writer = store.storage.agentDefinitions.create({ name: 'Codex file acceptance', runtimeKind: 'codex', runtimeModel: process.env.CODEX_ACCEPTANCE_MODEL || null,
    defaultMode: 'agent', maxMode: 'agent', instructions: 'Only perform the bounded file acceptance task. Do not run commands or use network.',
    permissions: { readFiles: true, executeCommands: true, writeFiles: true, knowledge: false, mcp: false, delegate: false }, limits: { maxDurationSeconds: 60 } });
  store.updateChannel('general', { agent_id: writer.id, runtime_config: { inheritAgent: true } });
  await runner.run('general', { id: 'native-file-acceptance', payload: { content: 'Create only native-result.txt in the current project using apply_patch. Its content must be NATIVE_FILE_VERIFIED followed by a newline. Do not execute shell commands. Finish with FILE_CREATED.' } });
  assert.equal(store.data.runtime_runs.at(-1).outcome, 'finished');
  assert.equal(fs.readFileSync(path.join(project, 'native-result.txt'), 'utf8').replace(/\r\n/g, '\n'), 'NATIVE_FILE_VERIFIED\n');
  const checkpoint = await runner.checkpoints.load(store.data.runtime_runs.at(-1).id);
  assert.ok(checkpoint.entries.some(item => item.path === 'native-result.txt'));
  await runner.restore('general', store.data.runtime_runs.at(-1).id);
  assert.equal(fs.existsSync(path.join(project, 'native-result.txt')), false);
  report.status = 'passed';
  report.checks.push('native bounded file approval with proposed diff before execution', 'native sandbox file write', 'full-turn checkpoint capture and restore');
} catch {
  // Provider responses and secrets never enter the report.
  report.error = 'Real pipeline acceptance failed; inspect task outcomes locally.';
  if (runner) report.outcomes = runner.store.data.runtime_runs.map(row => ({ runtime: row.snapshot.agent.runtimeKind, outcome: row.outcome, code: row.error?.code }));
  process.exitCode = 1;
} finally {
  if (runner) await runner.close();
  closeDatabasesUnder(root);
  assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep) && path.basename(root).startsWith('52hz-native-live-'));
  fs.rmSync(root, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); console.log(JSON.stringify(report, null, 2));
}
