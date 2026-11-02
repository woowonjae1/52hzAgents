// Opt-in acceptance against the user's Pi default provider. Never part of test:server.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from './store.js';
import { AgentRunner } from './agent-runner.js';
import { Collaboration } from './collaboration.js';
import { ConfigManager } from './config-manager.js';
import { closeDatabasesUnder } from './storage/database.js';

const home = path.join(os.homedir(), '.pi', 'agent');
const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(home, 'models.json'), 'utf8'));
const provider = source.providers?.[settings.defaultProvider];
const model = provider?.models?.find(item => item.id === settings.defaultModel);
assert.ok(provider && model, 'Pi default provider/model must exist in models.json.');
assert.ok(['openai-completions', 'anthropic-messages'].includes(provider.api), 'Unsupported Pi provider protocol.');
assert.ok(!Object.keys(provider.headers || {}).length, 'Custom headers require explicit desktop adapter support.');
const reference = provider.apiKey || '';
const secret = process.env[reference] || (/^[A-Z_][A-Z0-9_]*$/.test(reference) ? '' : reference);
assert.ok(secret && !secret.startsWith('!'), 'Pi credential must be available without shell evaluation.');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-pi-live-')));
const project = path.join(root, 'project'); fs.mkdirSync(project);
const report = { provider: settings.defaultProvider, model: model.id, checks: [], startedAt: new Date().toISOString() };
let runner;
try {
  const git = (...args) => execFileSync('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', '52hz acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
  fs.writeFileSync(path.join(project, 'seed.txt'), '52hz-live-seed'); git('add', '.'); git('commit', '-m', 'acceptance base');
  // Ephemeral in-memory credential vault. No credentials copied to the fixture or report.
  const secrets = new Map();
  const vault = { has: id => secrets.has(id), get: id => secrets.get(id), set: (id, value) => secrets.set(id, value), delete: id => secrets.delete(id) };
  const manager = new ConfigManager(path.join(root, 'data'), vault, {});
  const connection = manager.saveConnection({ id: 'pi-live-default', name: 'Pi acceptance resource', protocol: provider.api === 'anthropic-messages' ? 'anthropic' : 'openai',
    baseUrl: provider.baseUrl, defaultModel: model.id, models: [model], confirmedContextWindow: model.contextWindow,
    credentialAction: 'replace', credentialValue: secret });
  const store = new Store(path.join(root, 'data'));
  store.updateChannel('general', { working_dir: project, runtime_config: { inheritAgent: true } });
  const bus = { broadcast() {}, broadcastComposing() {} };
  runner = new AgentRunner(store, bus, { configManager: manager, env: {}, timeoutMs: 90000 });
  const collaboration = new Collaboration(store, runner, bus); runner.collaboration = collaboration;
  const actor = store.storage.agentDefinitions.create({ name: 'Pi live verifier', instructions: 'Follow the bounded acceptance task exactly. Read the seed file before writing. Use file tools; do not run shell commands.',
    defaultMode: 'agent', maxMode: 'agent', modelResource: { connectionId: connection.id, modelId: model.id, maxOutputTokens: 1024 },
    permissions: { readFiles: true, writeFiles: true, executeCommands: false, mcp: false, delegate: false }, limits: { maxStepsPerRun: 6, maxDurationSeconds: 90 } });
  const batchId = collaboration.start('general', { total_budget_tokens: 24000, workers: [{ agent_id: actor.id,
    task: 'Read seed.txt using the read tool. Then create result.txt using the write tool with exactly the seed text followed by |verified (no newline). Finish with the text VERIFIED. Do not run commands or edit any other file.' }] }).run.batch.id;
  const until = Date.now() + 100000;
  while (collaboration.view(batchId).run.lanes[0].status === 'running' || runner.active.size) {
    if (Date.now() > until) throw new Error('Live acceptance timed out.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const lane = collaboration.view(batchId).run.lanes[0];
  if (lane.status !== 'done') {
    const record = store.data.runtime_runs.find(item => item.id === lane.run_id);
    throw new Error(`Live Agent failed: ${record?.error?.code || record?.outcome || lane.status}`);
  }
  assert.equal(fs.readFileSync(path.join(lane.worktree_path, 'result.txt'), 'utf8'), '52hz-live-seed|verified');
  assert.equal(fs.existsSync(path.join(project, 'result.txt')), false);
  const requests = store.storage.usage.listModelRequestsByRun(lane.run_id);
  assert.ok(requests.length > 0);
  report.checks.push('real Pi tool loop', 'isolated worktree', 'Agent-bound resource', 'real Git delivery', 'request usage ledger');
  report.requests = requests.length; report.tokens = lane.used_tokens;
  collaboration.humanReview(batchId, lane.id, { verdict: 'approved', notes: 'Acceptance verified exact file contents.' });
  collaboration.merge(batchId);
  assert.equal(fs.readFileSync(path.join(project, 'result.txt'), 'utf8'), '52hz-live-seed|verified');
  collaboration.cleanup(batchId);
  report.checks.push('human review', 'actual merge', 'clean worktree cleanup');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  // Do not emit raw provider responses, headers, URLs or credentials.
  report.error = String(error.message).split(secret).join('[redacted]').slice(0, 500);
  process.exitCode = 1;
} finally {
  if (runner) await runner.close();
  closeDatabasesUnder(root);
  const parent = fs.realpathSync.native(os.tmpdir());
  assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('52hz-pi-live-'));
  fs.rmSync(root, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}
