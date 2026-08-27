'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaseAdapter, OpenCodeAdapter, AntigravityAdapter, ClineAdapter, DeepSeekAdapter, ADAPTER_MAP } = require('../src/adapters');
const { buildClineArgs } = require('../src/adapters/cline-stream');
const { resolveAgentType } = require('../src/agent-types');

// Mock client
function createMockClient() {
  return {
    reportAgentUsage: async () => {},
    postEvents: async () => {},
    sendControl: async () => {},
  };
}

test('OpenCodeAdapter handles both stop and set_model without shadowing', async () => {
  const adapter = new OpenCodeAdapter({
    agentName: 'opencode-test',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: createMockClient(),
  });

  // The CLI probe is stubbed: what is under test is the matching and channel
  // isolation, not whether this machine happens to have `opencode` installed and
  // answering `opencode models` within the timeout. Without this the assertion
  // below silently depended on the local install and flaked.
  adapter._listModels = async () => ([
    { id: 'openai/gpt-4o', provider: 'openai', label: 'gpt-4o' },
    { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', label: 'claude-3-7-sonnet' },
  ]);

  // Test set_model - a bare id is promoted to the CLI's canonical provider/id.
  await adapter._onControlAction('set_model', { model: 'gpt-4o', channel: 'ch-1' });
  assert.equal(adapter._resolveModel('ch-1'), 'openai/gpt-4o');
  assert.equal(adapter._channelModels['ch-1'], 'openai/gpt-4o');
  // Verify channel model did NOT leak to global fallback
  assert.equal(adapter.model, undefined);
  assert.equal(adapter._resolveModel('ch-2'), '');

  // Test global set_model - also canonicalized against what the CLI reports.
  await adapter._onControlAction('set_model', { model: 'claude-3-7-sonnet' });
  assert.equal(adapter.model, 'anthropic/claude-3-7-sonnet');
  assert.equal(adapter._resolveModel('ch-2'), 'anthropic/claude-3-7-sonnet');

  // Test stop
  let stoppedCalled = false;
  adapter._channelProcesses['ch-1'] = { pid: 12345 };
  adapter._stopProcess = async () => { stoppedCalled = true; };
  adapter.sendResponse = async () => {};

  await adapter._onControlAction('stop', { channel: 'ch-1' });
  assert.equal(stoppedCalled, true);
  assert.equal(adapter._channelProcesses['ch-1'], undefined);
});

test('BaseAdapter _resolveModel supports case-insensitive agent_models in msg.metadata', () => {
  const adapter = new BaseAdapter({
    agentName: 'MyAgent',
    agentType: 'opencode',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: createMockClient(),
  });

  // Uppercase agentName matches lowercase key in metadata
  const msg1 = {
    content: 'hello',
    metadata: {
      agent_models: {
        myagent: 'custom-model-v1',
      },
    },
  };
  assert.equal(adapter._resolveModel('ch-1', msg1), 'custom-model-v1');

  // Matching by agentType lowercase
  const msg2 = {
    content: 'hello',
    metadata: {
      agent_models: {
        opencode: 'opencode-model-v2',
      },
    },
  };
  assert.equal(adapter._resolveModel('ch-1', msg2), 'opencode-model-v2');
});

test('AntigravityAdapter _resolveModel handles agy and antigravity aliases case-insensitively', () => {
  const adapter = new AntigravityAdapter({
    agentName: 'AgyBot',
    agentType: 'agy',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: createMockClient(),
  });

  const msg = {
    content: 'hello',
    metadata: {
      agent_models: {
        agy: 'Gemini 3.5 Flash (Medium)',
      },
    },
  };
  // Forwarded verbatim: there is no local catalog to rewrite the name against,
  // and inventing a canonical form would mean guessing at names Antigravity owns.
  assert.equal(adapter._resolveModel('ch-1', msg), 'Gemini 3.5 Flash (Medium)');
});

test('buildClineArgs unconditionally splits composite provider/model even when provider is pre-set', () => {
  const args = buildClineArgs({
    prompt: 'Fix this code',
    provider: 'openai',
    model: 'anthropic/claude-3-7-sonnet',
  });

  // Provider should be overridden to anthropic and model stripped to claude-3-7-sonnet
  const pIdx = args.indexOf('-P');
  const mIdx = args.indexOf('-m');
  assert.ok(pIdx >= 0, '-P flag must be present');
  assert.ok(mIdx >= 0, '-m flag must be present');
  assert.equal(args[pIdx + 1], 'anthropic');
  assert.equal(args[mIdx + 1], 'claude-3-7-sonnet');
});

test('ClineAdapter _resolveModel handles case-insensitive metadata', () => {
  const adapter = new ClineAdapter({
    agentName: 'MyClineBot',
    agentType: 'cline',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: createMockClient(),
  });

  const msg = {
    content: 'hello',
    metadata: {
      agent_models: {
        myclinebot: 'anthropic/claude-3-7-sonnet',
      },
    },
  };
  assert.equal(adapter._resolveModel('ch-1', msg), 'anthropic/claude-3-7-sonnet');
});

test('CodexAdapter direct API mode resolves channel-level model override in HTTP payload', async () => {
  const http = require('node:http');
  const { CodexAdapter } = require('../src/adapters');

  let requestedModel = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        requestedModel = parsed.model;
      } catch {}
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const adapter = new CodexAdapter({
      agentName: 'codex-agent',
      workspaceId: 'ws-1',
      endpoint: 'http://localhost:3000',
      token: 'test-token',
      client: createMockClient(),
      agentEnv: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_MODEL: 'gpt-4o',
      },
    });

    adapter._buildSystemContext = () => 'sys';
    adapter.sendResponse = async () => {};

    // 1. Channel 1 override via control action
    await adapter._onControlAction('set_model', { model: 'o3-mini', channel: 'ch-direct-1' });

    await adapter._handleViaDirectApi('Test prompt', 'ch-direct-1', {});
    assert.equal(requestedModel, 'o3-mini', 'Channel override model must be sent in API payload');

    // 2. Per-message metadata override
    await adapter._handleViaDirectApi('Test prompt 2', 'ch-direct-2', {
      metadata: {
        agent_models: { 'codex-agent': 'claude-3-7-sonnet' },
      },
    });
    assert.equal(requestedModel, 'claude-3-7-sonnet', 'Metadata model must be sent in API payload');

    // 3. Fallback unconfigured channel
    await adapter._handleViaDirectApi('Test prompt 3', 'ch-direct-default', {});
    assert.equal(requestedModel, 'gpt-4o', 'Unconfigured channel must fall back to default model in API payload');
  } finally {
    server.close();
  }
});

test('DeepSeekAdapter registers in ADAPTER_MAP and resolves default model', () => {
  assert.ok(ADAPTER_MAP.deepseek, 'DeepSeekAdapter must be in ADAPTER_MAP');
  assert.equal(resolveAgentType('kilo'), 'kilocode');
  assert.equal(resolveAgentType('agy'), 'antigravity');

  const adapter = new DeepSeekAdapter({
    agentName: 'deepseek-agent',
    workspaceId: 'ws-1',
    endpoint: 'http://localhost:3000',
    token: 'test-token',
    client: createMockClient(),
    agentEnv: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'deepseek-chat',
    },
  });

  assert.equal(adapter._resolveModel('ch-1'), 'deepseek-chat');
});


// ---------------------------------------------------------------------------
// Real-configuration discovery: every model these adapters report must come out
// of the CLI's own config on disk. A fixture dir stands in for the real one, so
// these assert the parsing rather than whatever happens to be installed here.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeFixtureDir(prefix, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf-8');
  }
  return dir;
}

test('PiAdapter reports the providers and active model from Pi own config, not a guess', async () => {
  const { PiAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-pi-', {
    'models.json': JSON.stringify({
      providers: {
        'custom-acme': { models: [{ id: 'acme-large', name: 'Acme Large' }, { id: 'acme-small' }] },
        'custom-other': { models: ['other-1'] },
      },
    }),
    'settings.json': JSON.stringify({ defaultProvider: 'custom-acme', defaultModel: 'acme-small' }),
  });

  const adapter = new PiAdapter({
    agentName: 'pi-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { PI_AGENT_DIR: dir },
  });

  let reported = null;
  adapter.client = { reportAgentUsage: async (_w, _a, d) => { reported = d; } };
  await adapter.fetchAndReportUsage();

  assert.equal(reported.current_model, 'custom-acme/acme-small');
  const ids = JSON.parse(reported.available_models).map((m) => m.id);
  assert.deepEqual(ids, ['custom-acme/acme-large', 'custom-acme/acme-small', 'custom-other/other-1']);
  assert.match(reported.raw_text, /model_source=pi-settings/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('PiAdapter reports nothing rather than inventing a model when Pi is unconfigured', async () => {
  const { PiAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-pi-empty-', {});

  const adapter = new PiAdapter({
    agentName: 'pi-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { PI_AGENT_DIR: dir },
  });

  let reported = null;
  adapter.client = { reportAgentUsage: async (_w, _a, d) => { reported = d; } };
  await adapter.fetchAndReportUsage();

  assert.equal(reported.current_model, null, 'must not fall back to a made-up model');
  assert.equal(reported.available_models, null, 'must not pad the list with a guess');
  assert.match(reported.raw_text, /model_source=unconfigured/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexAdapter reports models_cache.json and the config.toml model, not a guess', async () => {
  const { CodexAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-codex-', {
    'models_cache.json': JSON.stringify({
      models: [
        { slug: 'gpt-9-alpha', display_name: 'GPT 9 Alpha' },
        { slug: 'gpt-9-mini', display_name: 'GPT 9 Mini' },
      ],
    }),
    // A `model =` inside a provider table must never be read as the active one.
    'config.toml': [
      'model_provider = "custom"',
      'model = "gpt-9-mini"',
      '',
      '[model_providers.custom]',
      'model = "not-the-active-one"',
      'base_url = "https://example.invalid/v1"',
    ].join('\n'),
  });

  const adapter = new CodexAdapter({
    agentName: 'codex-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { CODEX_HOME: dir },
  });

  let reported = null;
  adapter.client = { reportAgentUsage: async (_w, _a, d) => { reported = d; } };
  await adapter.fetchAndReportUsage();

  assert.equal(reported.current_model, 'gpt-9-mini');
  const ids = JSON.parse(reported.available_models).map((m) => m.id);
  assert.deepEqual(ids, ['gpt-9-alpha', 'gpt-9-mini']);
  assert.match(reported.raw_text, /model_source=codex-config provider=custom/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexAdapter reports nothing rather than inventing a model when Codex is unconfigured', async () => {
  const { CodexAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-codex-empty-', {});

  const adapter = new CodexAdapter({
    agentName: 'codex-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { CODEX_HOME: dir },
  });

  let reported = null;
  adapter.client = { reportAgentUsage: async (_w, _a, d) => { reported = d; } };
  await adapter.fetchAndReportUsage();

  assert.equal(reported.current_model, null);
  assert.equal(reported.available_models, null);
  assert.match(reported.raw_text, /model_source=unconfigured/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('HermesAdapter reports no profile instead of the "default" sentinel when none exist', async () => {
  const { HermesAdapter } = require('../src/adapters');
  const adapter = new HermesAdapter({
    agentName: 'hermes-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: {},
  });
  adapter._listProfiles = () => [];

  let reported = null;
  adapter.client = { reportAgentUsage: async (_w, _a, d) => { reported = d; } };
  await adapter.fetchAndReportUsage();

  assert.equal(reported.current_model, null, "'default' is a no-flag sentinel, not a real profile");
  assert.equal(reported.available_models, null);
});

test('ClaudeAdapter reports the model picker cache and env pin from Claude Code own state', async () => {
  const { ClaudeAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-claude-', {
    '.claude.json': JSON.stringify({
      additionalModelOptionsCache: [
        { value: 'claude-fable-9', label: 'Fable', description: 'ignored here' },
        { value: 'claude-opus-9', label: 'Opus' },
      ],
      modelAccessCache: [],
    }),
    'settings.json': JSON.stringify({
      env: {
        // A credential sitting next to the model pins must never be picked up.
        ANTHROPIC_AUTH_TOKEN: 'sk-must-not-be-read',
        ANTHROPIC_MODEL: 'claude-opus-9-thinking',
      },
    }),
  });

  const adapter = new ClaudeAdapter({
    agentName: 'claude-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { CLAUDE_CONFIG_DIR: dir },
  });

  assert.equal(adapter._currentModelFromConfig(), 'claude-opus-9-thinking');
  const models = adapter._listModels();
  assert.deepEqual(models.map((m) => m.id), ['claude-fable-9', 'claude-opus-9', 'claude-opus-9-thinking']);
  assert.equal(models[0].label, 'Fable', 'the picker label the CLI cached must survive');
  assert.ok(
    !JSON.stringify(models).includes('sk-must-not-be-read'),
    'no value from the settings env block other than the model pins may be reported',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClaudeAdapter reports nothing rather than a catalog when Claude Code has no cached models', async () => {
  const { ClaudeAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-claude-empty-', {});

  const adapter = new ClaudeAdapter({
    agentName: 'claude-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { CLAUDE_CONFIG_DIR: dir },
  });

  assert.equal(adapter._currentModelFromConfig(), '');
  assert.deepEqual(adapter._listModels(), [], 'must not fall back to a hardcoded model list');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClaudeAdapter reads effort levels out of the CLI own --help, and rejects one it does not list', async () => {
  const { ClaudeAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-claude-effort-', {});
  const adapter = new ClaudeAdapter({
    agentName: 'claude-probe', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { CLAUDE_CONFIG_DIR: dir },
  });

  // Stand in for the real binary: the point under test is that the levels come
  // out of whatever this build's help text says, not a table in our source.
  adapter._findClaudeBinary = () => 'claude';
  adapter._runHelpText = async () => [
    '  --effort <level>                      Effort level for the current session',
    '                                        (low, medium, high, xhigh, max)',
    '  --fallback-model <model>              Enable automatic fallback',
  ].join('\n');

  const levels = await adapter._listEffortLevels();
  assert.deepEqual(levels.map((l) => l.id), ['low', 'medium', 'high', 'xhigh', 'max']);

  await adapter._onControlAction('set_effort', { effort: 'high', channel: 'ch-1' });
  assert.equal(adapter._currentEffort('ch-1'), 'high');

  await adapter._onControlAction('set_effort', { effort: 'ludicrous', channel: 'ch-1' });
  assert.equal(adapter._currentEffort('ch-1'), 'high', 'a level the CLI does not accept must be ignored');

  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.rmSync(adapter._effortsFile, { force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// CLI introspection parsers. The fixtures below are verbatim excerpts of what
// the real CLIs printed on a machine with each one installed, so a vendor
// changing its output shape breaks a test rather than silently emptying the
// model picker.
// ---------------------------------------------------------------------------

const introspect = require('../src/adapters/model-introspection');

test('parseHelpChoices reads every level-list convention the real CLIs use', () => {
  const cases = [
    // claude --help
    ['--effort', '  --effort <level>   Effort level for the current session\n     (low, medium, high, xhigh, max)\n  --fallback-model <model>  x', ['low', 'medium', 'high', 'xhigh', 'max']],
    // agy --help (pipe-separated, inside parens)
    ['--effort', '  --effort   Reasoning effort for the current CLI session (low|medium|high)\n  -i   alias', ['low', 'medium', 'high']],
    // amp --help
    ['--mode', '  --mode <mode>\n      Set the agent mode (low, medium, high, ultra)\n  --features <value>  x', ['low', 'medium', 'high', 'ultra']],
    // cline --help (bare pipe run, no parens)
    ['--thinking', '  --thinking <level>   Set reasoning effort:\n     none|low|medium|high|xhigh. Bare --thinking uses medium.\n  --compaction <mode>  x', ['none', 'low', 'medium', 'high', 'xhigh']],
  ];
  for (const [flag, help, expected] of cases) {
    assert.deepEqual(introspect.parseHelpChoices(help, flag), expected, `flag ${flag}`);
  }
});

test('parseHelpChoices returns nothing rather than inventing levels', () => {
  // Flag absent entirely.
  assert.deepEqual(introspect.parseHelpChoices('  --verbose  Show verbose output', '--effort'), []);
  // A parenthetical sentence is prose, not a value list.
  assert.deepEqual(
    introspect.parseHelpChoices('  --sandbox   Run in a sandbox (restricted terminal access is enforced)\n  --model <m> x', '--sandbox'),
    [],
  );
  // A flag with no values must not borrow the next flag's list.
  assert.deepEqual(
    introspect.parseHelpChoices('  --quiet  Suppress output\n  --effort <level>  Effort (low, high)', '--quiet'),
    [],
  );
  assert.deepEqual(introspect.parseHelpChoices('', '--effort'), []);
});

test('parseTabbedList reads `agy models` and skips its banner line', () => {
  const out = [
    'Fetching available models...',
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  ].join('\n');
  const models = introspect.toOptions(introspect.parseTabbedList(out), 'antigravity');
  assert.deepEqual(models.map((m) => m.id), [
    'gemini-3.7-flash-high', 'gemini-3.5-flash-medium', 'claude-opus-4-6-thinking',
  ]);
  // The label is the CLI's display name; the id is what --model accepts. The
  // hardcoded table this replaced shipped the display names AS ids.
  assert.equal(models[1].label, 'Gemini 3.5 Flash (Medium)');
});

test('amp model listing is scoped to the Models section, never the tool list', () => {
  const out = [
    'Models',
    '  anthropic/claude-opus-5 (Claude Opus 5)',
    '  openai/gpt-5.6-sol (GPT-5.6 Sol)',
    '',
    'Built-in tools',
    '  shell_command',
    '  read_web_page (some parenthetical)',
  ].join('\n');
  const section = introspect.sliceSection(out, 'Models');
  const models = introspect.toOptions(introspect.parseParenLabelledList(section), 'amp');
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-opus-5', 'openai/gpt-5.6-sol']);
  assert.equal(introspect.sliceSection(out, 'Nope'), '', 'a missing heading yields nothing');
});

test('CodexAdapter reads effort levels from the active model own cache entry', async () => {
  const { CodexAdapter } = require('../src/adapters');
  const dir = makeFixtureDir('wwj-codex-effort-', {
    'models_cache.json': JSON.stringify({
      models: [
        {
          slug: 'gpt-9-mini',
          display_name: 'GPT 9 Mini',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        },
        // A different model's levels must never leak into the active one's list.
        { slug: 'gpt-9-other', supported_reasoning_levels: [{ effort: 'ultra' }] },
      ],
    }),
    'config.toml': 'model = "gpt-9-mini"',
  });

  const adapter = new CodexAdapter({
    agentName: 'codex-effort', workspaceId: 'ws-1', endpoint: 'http://localhost:3000',
    token: 't', agentEnv: { CODEX_HOME: dir },
  });

  assert.deepEqual(adapter._listEffortLevels().map((l) => l.id), ['low', 'medium', 'high']);
  assert.equal(adapter._currentEffort(), 'medium', 'falls back to the model own default');

  await adapter._onControlAction('set_effort', { effort: 'high', channel: 'ch-1' });
  assert.equal(adapter._currentEffort('ch-1'), 'high');

  await adapter._onControlAction('set_effort', { effort: 'ultra', channel: 'ch-1' });
  assert.equal(adapter._currentEffort('ch-1'), 'high', 'another model level must be rejected');

  fs.rmSync(dir, { recursive: true, force: true });
});
