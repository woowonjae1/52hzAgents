/**
 * Claude Code adapter for OpenAgents workspace.
 *
 * Bridges Claude Code to an OpenAgents workspace via:
 * - Polling loop for incoming messages
 * - Claude CLI subprocess (stream-json) for task execution
 * - MCP server for workspace tool access
 *
 * Direct port of Python: sdk/src/openagents/adapters/claude.py
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { formatAttachmentsForPrompt, SESSION_DEFAULT_RE, generateSessionTitle } = require('./utils');
const { buildClaudeSystemPrompt, buildClaudeSkillMd } = require('./workspace-prompt');
const { defaultAgentWorkdir, whichBinary, whereBinary } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';

// Tools whose target path becomes a user-facing artifact worth surfacing in the
// workspace Files panel. Read-only tools (Read/Grep/Glob) and Bash are excluded:
// Bash's side effects are not knowable from its command string.
const FILE_WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Max transcript lines in a channel-context prefix.
const RECAP_TAIL_LINES = 20;

// The env keys Claude Code uses to pin which model runs. Read from
// ~/.claude/settings.json's `env` block; nothing else in that block is touched
// (it also carries credentials).
const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

// `claude --help` is cheap but not free, and the answer only changes when the
// CLI is upgraded, so it is cached well past the heartbeat interval.
const EFFORT_CACHE_TTL_MS = 30 * 60 * 1000;

// The account's model catalog changes rarely, and this is a network call off
// the heartbeat, so it is cached hard.
const API_MODELS_CACHE_TTL_MS = 15 * 60 * 1000;

// Treat an OAuth token that is about to lapse as absent: refreshing it belongs
// to Claude Code, and a probe fired into the gap returns a 401 that reads like
// a broken account.
const OAUTH_EXPIRY_SKEW_MS = 60 * 1000;

class ClaudeAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {Set} [opts.disabledModules]
   * @param {string} [opts.workingDir]
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();
    /** @type {'mcp' | 'skills'} Tool integration mode */
    this.toolMode = opts.toolMode || 'skills';
    this._channelSessions = {}; // channel → Claude CLI session_id
    // channel → messageId of the last channel message already accounted for in
    // the CLI session. Anything newer is pushed in as a context prefix on the
    // next turn. In-memory only: after a restart the session may resume but we
    // no longer know what it saw, so the first turn falls back to a full recap.
    this._recapCursor = {};
    this._channelProcesses = {}; // channel → child process
    this._stoppingChannels = new Set();
    // Channels that have already announced "Execution stopped by user." for the
    // current stop. Two paths race to post it (the control-action handler that
    // kills the process, and the in-flight message handler that sees
    // pp.userStopped after exit), so this dedups to a single notice. Reset when
    // a new message starts processing in the channel.
    this._stopNoticeSent = new Set();
    this._persistentProcs = {}; // channel → { proc, lineBuffer, pendingLines, idleTimer, messageResolve }
    this._IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
    this._WATCHDOG_INTERVAL_MS = 15_000; // 15s between checks
    this._WATCHDOG_MAX_TIMEOUTS = parseInt(process.env.WWJ_CLAUDE_WATCHDOG_TIMEOUTS || '80', 10); // 80 * 15s = 20 min of silence before watchdog kill
    this._sessionsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}.json`
    );
    // Per-channel model overrides set from the UI. Persisted in their own file
    // rather than folded into the sessions file, which is a bare channel→id map
    // that older builds read with Object.assign.
    this._modelsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}.models.json`
    );
    this._channelModels = {};
    // Per-channel reasoning-effort overrides, alongside the model ones and
    // persisted the same way so a daemon bounce cannot silently revert them.
    this._effortsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}.efforts.json`
    );
    this._channelEfforts = {};
    this._effortCache = null;
    this._effortInFlight = null;
    this._apiModelsCache = null;
    this._apiModelsInFlight = null;
    this._apiModelsInFlightFor = '';
    this._helpCache = null;
    this._apiModelsError = '';
    this._loadSessions();
    this._loadChannelModels();
    this._loadChannelEfforts();
  }

  _loadChannelModels() {
    try {
      if (fs.existsSync(this._modelsFile)) {
        const data = JSON.parse(fs.readFileSync(this._modelsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelModels, data);
          this._log(`Loaded ${Object.keys(data).length} channel model override(s)`);
        }
      }
    } catch {
      this._log('Could not load channel models file, starting fresh');
    }
  }

  _saveChannelModels() {
    try {
      fs.mkdirSync(path.dirname(this._modelsFile), { recursive: true });
      fs.writeFileSync(this._modelsFile, JSON.stringify(this._channelModels));
    } catch {}
  }

  _loadChannelEfforts() {
    try {
      if (fs.existsSync(this._effortsFile)) {
        const data = JSON.parse(fs.readFileSync(this._effortsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelEfforts, data);
          this._log(`Loaded ${Object.keys(data).length} channel effort override(s)`);
        }
      }
    } catch {
      this._log('Could not load channel efforts file, starting fresh');
    }
  }

  _saveChannelEfforts() {
    try {
      fs.mkdirSync(path.dirname(this._effortsFile), { recursive: true });
      fs.writeFileSync(this._effortsFile, JSON.stringify(this._channelEfforts));
    } catch {}
  }

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelSessions, data);
          this._log(`Loaded ${Object.keys(data).length} session(s)`);
        }
      }
    } catch {
      this._log('Could not load sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      const dir = path.dirname(this._sessionsFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelSessions));
    } catch {}
  }

  _runHiddenCli(bin, args, timeoutMs = 10000) {
    return new Promise((resolve) => {
      try {
        const proc = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,
          env: { ...(this.agentEnv || process.env), CLAUDE_CODE_SAFE_MODE: '1' },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
          resolve(null);
        }, timeoutMs);

        if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d; });
        if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('close', () => {
          clearTimeout(timer);
          const all = (stdout + '\n' + stderr).trim();
          const match = all.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const parsed = JSON.parse(match[0]);
              resolve(parsed);
              return;
            } catch {}
          }
          if (all) {
            resolve({ result: all });
            return;
          }
          resolve(null);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Claude Code's own on-disk state. `~/.claude.json` is where the CLI caches
   * the model picker's options and the account's model access; `~/.claude/
   * settings.json` holds the env block that pins which model actually runs.
   * Strictly read-only, and no value from the settings `env` block other than
   * the model names is ever read or reported (it also holds credentials).
   */
  /**
   * Claude Code's config locations, honouring its own CLAUDE_CONFIG_DIR: when
   * that is set the CLI keeps both files under it, otherwise they are
   * ~/.claude.json and ~/.claude/settings.json.
   */
  _claudeConfigPaths() {
    const env = this.agentEnv || process.env;
    const dir = (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) || '';
    if (dir) {
      return {
        json: path.join(dir, '.claude.json'),
        settings: path.join(dir, 'settings.json'),
        credentials: path.join(dir, '.credentials.json'),
      };
    }
    return {
      json: path.join(os.homedir(), '.claude.json'),
      settings: path.join(os.homedir(), '.claude', 'settings.json'),
      credentials: path.join(os.homedir(), '.claude', '.credentials.json'),
    };
  }

  _readClaudeJson() {
    try {
      const file = this._claudeConfigPaths().json;
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  _readClaudeSettingsEnv() {
    try {
      const file = this._claudeConfigPaths().settings;
      if (!fs.existsSync(file)) return {};
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const env = (cfg && cfg.env) || {};
      // Only the model pins and the endpoint. The auth token in this same block
      // is read solely to call the endpoint below and is never logged, reported,
      // or written anywhere.
      const picked = {};
      for (const key of [...MODEL_ENV_KEYS, 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
        if (typeof env[key] === 'string' && env[key].trim()) picked[key] = env[key].trim();
      }
      return picked;
    } catch {
      return {};
    }
  }

  /**
   * The model this install will actually run, in the CLI's own precedence:
   * process env pin first, then the settings.json env pin. Returns '' when
   * neither is set - that means "Claude Code picks its own default", which is
   * reported as unknown rather than guessed at.
   */
  _currentModelFromConfig() {
    const env = this.agentEnv || process.env;
    if (env.ANTHROPIC_MODEL && env.ANTHROPIC_MODEL.trim()) return env.ANTHROPIC_MODEL.trim();
    const pinned = this._readClaudeSettingsEnv();
    return pinned.ANTHROPIC_MODEL || '';
  }

  /**
   * Every model this install can actually pick, from Claude Code's own caches:
   *   - `additionalModelOptionsCache` is the model picker's entries (what
   *     `/model` lists), cached by the CLI itself
   *   - `modelAccessCache` is what the account is entitled to
   *   - the `ANTHROPIC_*_MODEL` pins in settings.json name models this install
   *     is configured against even when no cache mentions them
   * There is no hardcoded catalog: an install the CLI has not populated yet
   * reports nothing, and the UI shows that as "not configured".
   */
  async _listModels() {
    const out = [];
    const seen = new Set();
    const push = (id, label) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, provider: 'anthropic', label: label || id });
    };

    const cfg = this._readClaudeJson();
    for (const key of ['additionalModelOptionsCache', 'modelAccessCache']) {
      const entries = cfg && Array.isArray(cfg[key]) ? cfg[key] : [];
      for (const e of entries) {
        if (typeof e === 'string') push(e);
        else if (e) push(e.value || e.model || e.id, e.label || e.name);
      }
    }

    // Tier aliases first: this is what the `/model` picker leads with, and what
    // a user means when they say "switch to Opus". Each is labelled with what it
    // resolves to on THIS install, because ANTHROPIC_DEFAULT_<TIER>_MODEL can
    // repoint it (all three point at one model on a relay-backed setup, and the
    // label is the only thing that makes that visible).
    const pins = this._readClaudeSettingsEnv();
    const envAll = this.agentEnv || process.env;
    for (const tier of await this._listAliasTiers()) {
      const pinKey = `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;
      const target = (envAll[pinKey] || pins[pinKey] || '').trim();
      const name = tier.charAt(0).toUpperCase() + tier.slice(1);
      push(tier, target ? `${name} → ${target}` : name);
    }

    // The account's real catalog, straight from the endpoint this install is
    // pointed at. `additionalModelOptionsCache` is only the EXTRA options the
    // CLI cached on top of its built-in tiers, so on its own it under-reports
    // badly - one entry on an account with a dozen models.
    for (const m of await this._listApiModels()) {
      push(m.id, m.label);
    }

    const pinned = this._readClaudeSettingsEnv();
    for (const key of MODEL_ENV_KEYS) {
      if (pinned[key]) push(pinned[key]);
    }
    const current = this._currentModelFromConfig();
    if (current) push(current);

    return out;
  }

  /**
   * The tier aliases this build accepts for `--model` - `opus`, `sonnet`,
   * `haiku`, `fable`. These are what the interactive `/model` picker offers and
   * what most people actually choose, and they are NOT in any config file: the
   * picker's list lives inside the native binary.
   *
   * They are still not hardcoded here. Two live sources on this install declare
   * them, and the union is taken:
   *   - `claude --help` quotes them on its own `--model` line
   *   - Claude Code defines ANTHROPIC_DEFAULT_<TIER>_MODEL env vars; those key
   *     names are the CLI stating which tiers exist
   * An alias is a stable indirection - it keeps meaning "the latest model of
   * that tier" when Anthropic ships a new one - so unlike a list of concrete
   * ids, this cannot go stale into something the CLI rejects.
   */
  async _listAliasTiers() {
    const tiers = new Set();

    // Source 1: the tier names Claude Code itself declares via its env vars.
    for (const key of MODEL_ENV_KEYS) {
      const m = key.match(/^ANTHROPIC_DEFAULT_(.+)_MODEL$/);
      if (m) tiers.add(m[1].toLowerCase());
    }

    // Source 2: the aliases quoted on this build's own --help --model line.
    const help = await this._helpText();
    if (help) {
      const flat = help.replace(/\s+/g, ' ');
      const at = flat.indexOf('--model <model>');
      if (at >= 0) {
        let seg = flat.slice(at);
        const next = seg.search(/\s-[a-zA-Z-]+[,\s]+--/);
        if (next > 0) seg = seg.slice(0, next);
        for (const q of seg.match(/'([^']+)'/g) || []) {
          const value = q.slice(1, -1).trim();
          // The same sentence also quotes a full model name as an example of
          // the OTHER accepted form; aliases are bare words.
          if (/^[a-z]+$/.test(value)) tiers.add(value);
        }
      }
    }

    return [...tiers].sort();
  }

  /** `claude --help`, cached alongside the effort levels it also feeds. */
  async _helpText() {
    if (this._helpCache && Date.now() - this._helpCache.at < EFFORT_CACHE_TTL_MS) {
      return this._helpCache.text;
    }
    const bin = this._findClaudeBinary();
    if (!bin) return '';
    const text = await this._runHelpText(bin);
    if (text) this._helpCache = { at: Date.now(), text };
    return text;
  }

  /**
   * `GET {ANTHROPIC_BASE_URL}/v1/models` - the authoritative list of what this
   * account can actually run, and the only source that stays correct when
   * Anthropic ships a new model. Follows the documented `has_more`/`last_id`
   * pagination.
   *
   * Returns [] on any failure and records why in `_apiModelsError`, which the
   * usage report surfaces: a relay that 500s on this endpoint (or an offline
   * machine) must read as "could not ask", never as "this account has one
   * model".
   */
  async _listApiModels() {
    const now = Date.now();
    // Keyed by endpoint, not just by time. Provider switchers (cc-switch and
    // friends) rewrite settings.json's env block underneath a running adapter,
    // and a purely time-based cache would keep serving the previous provider's
    // catalog for the rest of the TTL - offering models the account it is now
    // pointed at cannot run.
    const endpoint = this._resolveApiEndpoint().base;
    if (this._apiModelsCache
      && this._apiModelsCache.endpoint === endpoint
      && now - this._apiModelsCache.at < API_MODELS_CACHE_TTL_MS) {
      return this._apiModelsCache.models;
    }
    if (this._apiModelsInFlight && this._apiModelsInFlightFor === endpoint) {
      return this._apiModelsInFlight;
    }

    this._apiModelsInFlightFor = endpoint;
    this._apiModelsInFlight = this._fetchApiModels()
      .then((models) => {
        if (models.length) this._apiModelsCache = { at: Date.now(), endpoint, models };
        return models;
      })
      .catch(() => [])
      .finally(() => { this._apiModelsInFlight = null; });
    return this._apiModelsInFlight;
  }

  /**
   * Endpoint and credential, resolved as a PAIR from the same source. Mixing
   * them - a relay URL from settings.json with an unrelated ANTHROPIC_API_KEY
   * that happens to be in the process env - sends the wrong token to the right
   * host, comes back 401, and reads as "this account has no models".
   */
  _resolveApiEndpoint() {
    const env = this.agentEnv || process.env;
    const pinned = this._readClaudeSettingsEnv();
    const explicit = [
      { key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY, base: env.ANTHROPIC_BASE_URL },
      { key: pinned.ANTHROPIC_AUTH_TOKEN || pinned.ANTHROPIC_API_KEY, base: pinned.ANTHROPIC_BASE_URL },
    ].find((c) => c.key && String(c.key).trim());

    if (explicit) {
      const rawBase = (explicit.base || 'https://api.anthropic.com').trim();
      return {
        base: rawBase.endsWith('/') ? rawBase.slice(0, rawBase.length - 1) : rawBase,
        key: String(explicit.key).trim(),
        kind: 'key',
      };
    }

    // Last resort: the OAuth session Claude Code itself holds, which is the
    // only credential a plain `claude login` install has. Its base URL is FIXED
    // to Anthropic and deliberately ignores ANTHROPIC_BASE_URL - a provider
    // switcher can leave a third-party relay URL in settings.json with no key
    // of its own, and pairing that host with the user's Anthropic session token
    // would hand their credential to a third party.
    const oauth = this._readOAuthCredential();
    if (oauth) return { base: 'https://api.anthropic.com', key: oauth, kind: 'oauth' };

    return { base: '', key: '', kind: '' };
  }

  /**
   * The access token from Claude Code's own OAuth session, or '' when there is
   * none or it has expired. Read solely to call `/v1/models` below; it is never
   * logged, reported, cached to disk, or sent anywhere but api.anthropic.com.
   * Refreshing is Claude Code's job - an expired token is treated as absent so
   * the probe reports "no-credential" instead of a confusing 401.
   */
  _readOAuthCredential() {
    try {
      const file = this._claudeConfigPaths().credentials;
      if (!fs.existsSync(file)) return '';
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const oauth = cfg && cfg.claudeAiOauth;
      const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
      if (!token) return '';
      const expiresAt = Number(oauth.expiresAt) || 0;
      if (expiresAt && expiresAt <= Date.now() + OAUTH_EXPIRY_SKEW_MS) return '';
      return token;
    } catch {
      return '';
    }
  }

  async _fetchApiModels() {
    const { base, key, kind } = this._resolveApiEndpoint();
    if (!key) {
      this._apiModelsError = 'no-credential';
      return [];
    }

    const collected = [];
    let after = '';
    // Bounded: the endpoint pages at 1000, so a handful of rounds covers any
    // real account and a broken `has_more` cannot spin forever.
    for (let page = 0; page < 5; page++) {
      const res = await this._getJson(`${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, key, kind);
      if (!res.ok) {
        this._apiModelsError = `http-${res.status}`;
        return [];
      }
      const list = Array.isArray(res.body && res.body.data) ? res.body.data : [];
      for (const m of list) {
        const id = typeof m === 'string' ? m : (m && m.id);
        if (id) collected.push({ id, label: (m && m.display_name) || id });
      }
      if (!res.body || !res.body.has_more || !list.length) break;
      after = res.body.last_id || (list[list.length - 1] && list[list.length - 1].id) || '';
      if (!after) break;
    }
    this._apiModelsError = collected.length ? '' : 'empty';
    return collected;
  }

  /**
   * One authenticated GET, resolved as {ok, status, body}. Never rejects.
   *
   * The header set depends on the credential kind, and this is not cosmetic:
   * api.anthropic.com prefers `x-api-key` when both are present, so sending
   * both alongside an OAuth token is rejected 401 ("API key is invalid") even
   * though the same token succeeds on `Authorization` alone. Verified against
   * the live endpoint.
   */
  _getJson(url, key, kind) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(url); } catch { resolve({ ok: false, status: 0 }); return; }
      const lib = u.protocol === 'http:' ? require('http') : require('https');
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'GET',
          headers: kind === 'oauth'
            ? {
              'Authorization': `Bearer ${key}`,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'oauth-2025-04-20',
            }
            : {
              // API keys and relay tokens: both headers, since relays differ on
              // which one they read.
              'Authorization': `Bearer ${key}`,
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
            },
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.on('data', (d) => { body += d.toString('utf-8'); });
          res.on('end', () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            let parsed = null;
            try { parsed = JSON.parse(body); } catch {}
            resolve({ ok, status: res.statusCode, body: parsed });
          });
        }
      );
      req.on('error', () => resolve({ ok: false, status: 0 }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
      req.end();
    });
  }

  /**
   * The reasoning-effort levels this build accepts, read out of `claude --help`
   * - the CLI states them itself on the `--effort <level>` line, so the list
   * tracks the installed version instead of a table that drifts. Costs no API
   * call. Cached because it is called off the heartbeat; [] means "could not
   * ask", never "this build has no effort levels".
   */
  async _listEffortLevels() {
    const now = Date.now();
    if (this._effortCache && now - this._effortCache.at < EFFORT_CACHE_TTL_MS) {
      return this._effortCache.levels;
    }
    if (this._effortInFlight) return this._effortInFlight;

    this._effortInFlight = (async () => {
      try {
        const bin = this._findClaudeBinary();
        if (!bin) return [];
        const help = await this._runHelpText(bin);
        if (!help) return [];
        // The option and its parenthesised value list can wrap across lines, so
        // the whole help text is flattened before matching.
        const flat = help.replace(/\s+/g, ' ');
        const m = flat.match(/--effort <level>\s*([^(]*)\(([^)]*)\)/);
        if (!m) return [];
        const levels = m[2].split(',').map((v) => v.trim()).filter(Boolean);
        return levels.map((id) => ({ id, label: id }));
      } catch {
        return [];
      }
    })()
      .then((levels) => {
        if (levels.length) this._effortCache = { at: Date.now(), levels };
        return levels;
      })
      .finally(() => { this._effortInFlight = null; });

    return this._effortInFlight;
  }

  /** `claude --help` captured as text. No API call, no session. */
  _runHelpText(binary) {
    return new Promise((resolve) => {
      const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(binary);
      const cmd = isBatch ? (process.env.COMSPEC || 'cmd.exe') : binary;
      const argv = isBatch ? ['/c', binary, '--help'] : ['--help'];
      let proc;
      try {
        proc = spawn(cmd, argv, {
          windowsHide: true,
          env: this.agentEnv || process.env,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        resolve('');
        return;
      }
      let out = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 20000);
      proc.stdout.on('data', (d) => { out += d.toString('utf-8'); });
      proc.on('error', () => { clearTimeout(timer); resolve(''); });
      proc.on('close', () => { clearTimeout(timer); resolve(out); });
    });
  }

  /** Effort in force: a workspace override first, then the CLI's own env. */
  _currentEffort(channel) {
    if (channel && this._channelEfforts[channel]) return this._channelEfforts[channel];
    if (this._channelEfforts['*']) return this._channelEfforts['*'];
    const env = this.agentEnv || process.env;
    return (env.CLAUDE_EFFORT || '').trim() || '';
  }

  async fetchAndReportUsage(force = false) {
    if (!this.workspaceId || !this.client) return null;
    if (!force && this._cachedUsage && (Date.now() - (this._cachedUsageTime || 0) < 30_000)) {
      return this._cachedUsage;
    }
    try {
      const claudeBin = this._findClaudeBinary();
      if (!claudeBin) return null;
      
      const usageData = await this._runHiddenCli(claudeBin, ['-p', '/usage', '--output-format', 'json']);
      let text = (usageData && usageData.result) || '';
      if (!text && typeof usageData === 'string') text = usageData;
      
      let sessionPercent = null;
      let sessionReset = null;
      let weekPercent = null;
      let weekReset = null;

      const sessionMatch = text.match(/Current session:\s*(\d+)%?\s*used(?:\s*·\s*resets\s*([^\n]+))?/i);
      if (sessionMatch) {
        sessionPercent = parseInt(sessionMatch[1], 10);
        sessionReset = sessionMatch[2] ? sessionMatch[2].trim() : null;
      } else {
        const fallbackSession = text.match(/session[^\d:]*:\s*(\d+)%/i) || text.match(/(\d+)%\s*used/i);
        if (fallbackSession) {
          sessionPercent = parseInt(fallbackSession[1], 10);
        }
      }

      const weekMatch = text.match(/Current week[^:]*:\s*(\d+)%?\s*used(?:\s*·\s*resets\s*([^\n]+))?/i);
      if (weekMatch) {
        weekPercent = parseInt(weekMatch[1], 10);
        weekReset = weekMatch[2] ? weekMatch[2].trim() : null;
      } else {
        const fallbackWeek = text.match(/week[^\d:]*:\s*(\d+)%/i);
        if (fallbackWeek) {
          weekPercent = parseInt(fallbackWeek[1], 10);
        }
      }

      const h24Match = text.match(/Last 24h\s*·\s*([^\n]+)/i);
      const d7Match = text.match(/Last 7d\s*·\s*([^\n]+)/i);

      let parseStatus = 'ok';
      if (sessionPercent === null && weekPercent === null && text.length > 0) {
        parseStatus = 'unparsed';
        this._log(`Warning: Claude /usage output format did not match expected regex: ${text.slice(0, 160)}`);
      }

      // Models and effort come from what Claude Code itself records, not from a
      // second `-p /model` round trip: that costs an API call per refresh and
      // returns the model's own error text when the configured model is
      // unreachable, so the regexes below it silently produced null.
      const models = await this._listModels();
      const currentModel = this._resolveModel() || this._currentModelFromConfig() || null;
      const availableModels = models.length ? JSON.stringify(models) : null;

      const efforts = await this._listEffortLevels();
      const currentEffort = this._currentEffort() || null;
      const availableEfforts = efforts.length ? JSON.stringify(efforts) : null;

      const usagePayload = {
        session_used_percent: sessionPercent !== null ? sessionPercent : 0,
        session_resets_at: sessionReset,
        week_used_percent: weekPercent !== null ? weekPercent : 0,
        week_resets_at: weekReset,
        last_24h_summary: h24Match ? h24Match[1].trim() : null,
        last_7d_summary: d7Match ? d7Match[1].trim() : null,
        current_model: currentModel,
        available_models: availableModels,
        current_effort: currentEffort,
        available_efforts: availableEfforts,
        raw_text: text,
        // Surfaces WHY the catalog is short (relay 500, no credential, offline)
        // instead of leaving a one-item picker looking like the real answer.
        models_source: this._apiModelsError ? `api:${this._apiModelsError}` : 'api',
        parse_status: parseStatus,
      };

      this._cachedUsage = usagePayload;
      this._cachedUsageTime = Date.now();

      await this.client.reportAgentUsage(this.workspaceId, this.agentName, usagePayload, this.token);
      this._log(`Reported Claude usage: session=${usagePayload.session_used_percent}%, week=${usagePayload.week_used_percent}%, parse=${parseStatus}`);
      return usagePayload;
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
      return null;
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'set_effort') {
      const requested = payload && (payload.effort || payload.model);
      const channel = payload && payload.channel;
      if (!requested) return;
      // Validated against what this build itself says it accepts, so a stale UI
      // cannot push a level that makes every subsequent run fail to launch.
      const levels = await this._listEffortLevels();
      if (levels.length && !levels.some((l) => l.id.toLowerCase() === String(requested).toLowerCase())) {
        this._log(`set_effort: '${requested}' is not one of ${levels.map((l) => l.id).join(', ')} - ignoring`);
        return;
      }
      if (channel) this._channelEfforts[channel] = requested;
      else this._channelEfforts['*'] = requested;
      this._saveChannelEfforts();
      // claude reads --effort at launch, so an in-flight persistent process
      // keeps the old level until it is replaced.
      if (channel && this._persistentProcs[channel]) {
        const pp = this._persistentProcs[channel];
        if (pp.proc) { try { pp.proc.kill(); } catch {} }
        delete this._persistentProcs[channel];
      }
      this._log(`Effort updated to '${requested}' for channel=${channel || 'all'}`);
      this.fetchAndReportUsage(true).catch(() => {});
      return;
    }
    if (action === 'set_model') {
      const model = payload && payload.model;
      const channel = payload && payload.channel;
      if (model) {
        if (channel) {
          this._channelModels[channel] = model;
          // Must survive an adapter restart (daemon bounce, `restart` control,
          // watchdog kill). Without this the choice evaporated on the agent side
          // while the UI chip — backed by localStorage — kept showing it, so the
          // next turn silently ran on the old model.
          this._saveChannelModels();
          if (this._persistentProcs[channel]) {
            const pp = this._persistentProcs[channel];
            if (pp.proc) {
              try { pp.proc.kill(); } catch {}
            }
            delete this._persistentProcs[channel];
          }
        } else {
          this.model = model;
        }
        this._log(`Model updated to '${model}' for channel=${channel || 'all'}`);
      }
      return;
    }
    if (action === 'stop') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel) {
        const pp = this._persistentProcs[channel];
        if (pp) pp.userStopped = true;
      }
      if (channel && this._channelProcesses[channel]) {
        this._log(`Stopping process for channel=${channel}`);
        this._stoppingChannels.add(channel);
        const proc = this._channelProcesses[channel];
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        delete this._channelQueues[channel];
        await this._postStopNotice(channel);
      } else {
        for (const pp of Object.values(this._persistentProcs)) pp.userStopped = true;
        await this._stopAllProcesses('Execution stopped by user.');
      }
      return;
    }
    if (action === 'restart') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel) {
        // Kill in-flight subprocess + clear the per-channel session BEFORE
        // asking the daemon to bounce us. The new adapter spawned after
        // the bounce loads sessions from disk, so the cleared state must
        // be persisted first.
        const proc = this._channelProcesses[channel];
        if (proc) {
          try { await this._stopProcess(proc); } catch {}
          delete this._channelProcesses[channel];
        }
        if (this._channelSessions[channel]) {
          delete this._channelSessions[channel];
          try { this._saveSessions(); } catch {}
          this._log(`Restart: cleared session for channel=${channel}`);
        } else {
          this._log(`Restart: no session to clear for channel=${channel}`);
        }
        // Post the status BEFORE the bounce so the message lands while
        // we're still online.
        try {
          await this.client.sendMessage(this.workspaceId, channel, this.token,
            'Session restarted — next message starts fresh.',
            {
              senderType: 'agent',
              senderName: this.agentName,
              messageType: 'status',
              metadata: { agent_mode: this._mode },
              sessionId: this._sessionId,
            });
        } catch (e) {
          this._log(`Restart: failed to post status: ${e && e.message ? e.message : e}`);
        }
      } else {
        // Defensive — no channel, clear everything before the bounce.
        this._channelSessions = {};
        try { this._saveSessions(); } catch {}
        await this._stopAllProcesses('Execution stopped by user.');
        this._log('Restart: cleared all sessions (no channel param)');
      }
      // Ask the daemon to bounce just THIS agent — true process-level
      // restart. Daemon's command-file poller picks up `restart:<name>`
      // within ~1s, calls restartAgent, our run() loop exits cleanly,
      // and a fresh adapter is spawned with a new `_startedAt`. Sibling
      // agents on the same daemon are untouched.
      try {
        const path = require('path');
        const os = require('os');
        const fs = require('fs');
        const cmdFile = path.join(os.homedir(), '.wwj', 'daemon.cmd');
        fs.writeFileSync(cmdFile, `restart:${this.agentName}\n`);
        this._log(`Restart: requested daemon bounce for agent=${this.agentName}`);
      } catch (e) {
        this._log(`Restart: failed to write daemon.cmd: ${e && e.message ? e.message : e}`);
        // Fallback: reset uptime in-place so the next /status reflects
        // SOMETHING changed even if the daemon bounce didn't happen.
        this._startedAt = Date.now();
      }
      return;
    }
    // Fall through to base for shared actions (status, etc.).
    await super._onControlAction(action, payload);
  }

  /**
   * Override BaseAdapter.stop so daemon shutdown also tears down in-flight
   * claude subprocesses cleanly. Without this, killing the daemon leaves
   * the channel's last event as a `status` (e.g. "Bash › ..." mid-tool-call)
   * forever — the workspace UI then shows the thread as "running" until a
   * new message arrives. Fire-and-forget; daemon._killAgent gives us up to
   * 5s to actually finish the cleanup before the parent exits.
   */
  stop() {
    for (const channel of Object.keys(this._persistentProcs)) {
      this._killPersistentProc(channel);
    }
    this._stopAllProcesses(
      'Task interrupted — daemon restarting. Send another message to continue.'
    ).catch(() => {});
    super.stop();
  }

  async _stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (IS_WINDOWS) {
        // Give Claude Code a Ctrl+C-like interrupt first so it can cancel
        // shell/background tasks it manages before the forceful process-tree
        // cleanup below. Going straight to /F can leave detached tool work
        // alive even though the Claude CLI process itself is gone.
        try { proc.kill('SIGINT'); } catch {}
        const exited = await new Promise((resolve) => {
          if (proc.exitCode !== null) {
            resolve(true);
            return;
          }
          const timeout = setTimeout(() => resolve(false), 1500);
          proc.once('exit', () => { clearTimeout(timeout); resolve(true); });
        });
        if (!exited) {
          try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch {}
        }
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {
          proc.kill('SIGTERM');
        }
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          const timeout = setTimeout(() => {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch {
              proc.kill('SIGKILL');
            }
            const reapTimeout = setTimeout(finish, 1000);
            proc.once('exit', () => { clearTimeout(reapTimeout); finish(); });
          }, 1500);
          proc.once('exit', () => { clearTimeout(timeout); finish(); });
        });
      }
    } catch {}
  }

  /**
   * Build the channel-context prefix for one turn.
   *
   * We are only *delivered* messages that @mention us (see BaseAdapter's
   * addressing filter), so everything else said in the channel — including
   * whole analyses posted by sibling agents — never reaches the CLI session.
   * A message like "@claude 你对以上分析怎么看" then resolves "以上" against
   * our own last turn instead of the message it actually points at. Pushing
   * the gap in is the only fix: the agent cannot know it is missing context,
   * so `workspace_get_history` (a pull) is never called.
   *
   * Two shapes, both keyed off `_recapCursor`:
   * - `full` (fresh CLI, or the cursor fell out of the fetch window): the
   *   old behaviour — a tail recap of the recent conversation, own messages
   *   included, since the new session has no history at all.
   * - incremental (a live/resumed session): only what was posted after the
   *   cursor, minus our own posts. Normally one to three lines.
   *
   * The cursor advances on every call, injected or not, so nothing replays.
   * Returns null when there is nothing worth adding.
   */
  async _buildChannelContext(channelName, opts = {}) {
    const {
      currentMessage = '',
      currentMessageId = null,
      full = false,
    } = opts;

    const messages = await this.client.getRecentMessages(
      this.workspaceId, channelName, this.token, 60
    );
    if (!messages || messages.length === 0) return null;

    const cursor = full ? null : this._recapCursor[channelName];

    let startIdx = 0;
    let incremental = false;
    if (cursor) {
      const idx = messages.findIndex((m) => m.messageId === cursor);
      if (idx === -1) {
        // Cursor aged out of the window — fall back to a tail recap rather
        // than replaying all 60 messages.
        startIdx = Math.max(0, messages.length - RECAP_TAIL_LINES);
      } else {
        startIdx = idx + 1;
        incremental = true;
      }
    } else {
      startIdx = Math.max(0, messages.length - RECAP_TAIL_LINES);
    }

    // Advance the cursor before any early return: these messages are now
    // accounted for whether or not they made it into the prefix.
    const ids = new Set();
    for (const m of messages) if (m.messageId) ids.add(m.messageId);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].messageId) { this._recapCursor[channelName] = messages[i].messageId; break; }
    }
    // The message we are handling may not have propagated to the events API
    // yet; pin the cursor to it so the next turn doesn't echo it back at us.
    if (currentMessageId && !ids.has(currentMessageId)) {
      this._recapCursor[channelName] = currentMessageId;
    }

    const lines = [];
    for (let i = startIdx; i < messages.length; i++) {
      const m = messages[i];
      const mt = m.messageType || 'chat';
      if (mt === 'status' || mt === 'thinking' || mt === 'loading') continue;
      const text = (m.content || '').trim();
      if (!text) continue;
      // Exclude the message being handled — the caller appends it below.
      if (currentMessageId ? m.messageId === currentMessageId : text === currentMessage) continue;
      // Our own posts are already in a live session's history.
      if (incremental && m.senderType !== 'human' && m.senderName === this.agentName) continue;
      const who = m.senderType === 'human'
        ? (m.senderName || 'user')
        : (m.senderName || 'agent');
      const truncated = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
      lines.push(`[${who}] ${truncated}`);
    }
    if (lines.length === 0) return null;

    const tail = lines.slice(-RECAP_TAIL_LINES).join('\n');
    if (!incremental) {
      return (
        'You previously worked in this channel but your prior session is no ' +
        'longer available, so here is the recent conversation for context:\n\n' +
        tail
      );
    }
    return (
      '## Channel context you have not seen\n' +
      'Posted in this channel after your last turn. These were not delivered ' +
      'to you (only messages that @mention you are), so they are NOT in your ' +
      'conversation history:\n\n' +
      tail + '\n\n' +
      'The message below is the one addressed to you. If it refers to "the ' +
      'above", "that analysis", "the previous message" or anything similar, ' +
      'it means the channel messages above — not your own earlier work.'
    );
  }

  /**
   * Post "Execution stopped by user." at most once per channel for a given
   * stop. The control-action handler and the in-flight message handler both
   * race to announce a stop; without this guard the user sees it twice. The
   * guard is reset when a new message starts processing in the channel.
   */
  async _postStopNotice(channel) {
    if (!channel || this._stopNoticeSent.has(channel)) return;
    this._stopNoticeSent.add(channel);
    try { await this.sendResponse(channel, 'Execution stopped by user.'); } catch {}
  }

  async _stopAllProcesses(completionMessage = 'Execution stopped.') {
    for (const channel of Object.keys(this._persistentProcs)) {
      this._killPersistentProc(channel);
    }
    const entries = Object.entries(this._channelProcesses);
    if (!entries.length) return;
    this._log(`Stopping ${entries.length} running process(es)...`);
    for (const [channel, proc] of entries) {
      this._stoppingChannels.add(channel);
      await this._stopProcess(proc);
      delete this._channelProcesses[channel];
      delete this._channelQueues[channel];
      try {
        await this.sendResponse(channel, completionMessage);
      } catch {}
    }
  }

  /**
   * Find the portable Node.js binary.
   */
  _findNodeBin() {
    const home = os.homedir();
    const candidates = IS_WINDOWS
      ? [path.join(home, '.wwj', 'nodejs', 'node.exe')]
      : [path.join(home, '.wwj', 'nodejs', 'node'),
         path.join(home, '.wwj', 'nodejs', 'bin', 'node')];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // Fall back to the node already running this daemon (absolute, always valid).
    // Bare 'node' can be off-PATH in a packaged daemon or CI runner.
    return process.execPath;
  }

  /**
   * Resolve a binary shim/symlink to [nodeBin, jsEntryPoint].
   * On Windows: parses .cmd shim to extract the JS path.
   * On macOS/Linux: follows symlink to the actual .js file.
   * Returns [nodeBin, jsPath] or null if resolution fails.
   */
  _resolveToNodeCmd(binPath) {
    const nodeBin = this._findNodeBin();
    if (IS_WINDOWS && binPath.toLowerCase().endsWith('.cmd')) {
      const cmdDir = path.dirname(path.resolve(binPath));
      const cmdContent = fs.readFileSync(binPath, 'utf-8');
      const jsMatch = cmdContent.match(/%dp0%\\([^\s"*?]+\.m?js)/i);
      if (jsMatch) {
        return [nodeBin, path.resolve(cmdDir, jsMatch[1])];
      }
      // .cmd shims that forward to a native .exe (e.g. Claude Code's
      // claude.cmd → @anthropic-ai/claude-code/bin/claude.exe). Resolve to the
      // exe and spawn it directly. Wrapping such a .cmd in `cmd.exe /c` caps the
      // command line at cmd.exe's 8191-char limit, which truncates the ~14KB
      // --append-system-prompt and makes the agent hang ("command line too long").
      const exeMatch = cmdContent.match(/%dp0%\\([^\s"*?]+\.exe)/i);
      if (exeMatch) {
        return [path.resolve(cmdDir, exeMatch[1])];
      }
    } else {
      // Unix: symlink → resolve to actual .js file
      try {
        let target = binPath;
        if (fs.lstatSync(binPath).isSymbolicLink()) {
          target = path.resolve(path.dirname(binPath), fs.readlinkSync(binPath));
        }
        if (target.endsWith('.js') || target.endsWith('.mjs')) {
          return [nodeBin, target];
        }
      } catch {}
    }
    return null;
  }

  _findClaudeBinary() {
    const home = os.homedir();

    // Tier 0: Isolated runtime prefix (~/.wwj/runtimes/claude/)
    const ext = IS_WINDOWS ? '.cmd' : '';
    const runtimeCandidate = path.join(home, '.wwj', 'runtimes', 'claude', 'node_modules', '.bin', `claude${ext}`);
    if (fs.existsSync(runtimeCandidate)) return runtimeCandidate;

    // Tier 0b: Legacy portable install at ~/.wwj/nodejs/node_modules/.bin/
    const portableBin = path.join(home, '.wwj', 'nodejs', 'node_modules', '.bin');
    const portableCandidate = path.join(portableBin, `claude${ext}`);
    if (fs.existsSync(portableCandidate)) return portableCandidate;

    // Tier 1: PATH search via a codepage-safe lookup (whereBinary forces UTF-8
    // output + verifies existence, so a non-ASCII/Chinese username isn't mangled
    // into an ENOENT). Uses the ENRICHED env so a packaged daemon's minimal PATH
    // still sees the node-version-manager / homebrew / npm-global dirs the
    // launcher adds — that's why a bare `which claude` came up empty before.
    const viaWhere = whereBinary('claude');
    if (viaWhere) return viaWhere;

    // Tier 2: Next to current Node.js interpreter (npm global)
    const nodeBinDir = path.dirname(process.execPath);
    const nearNode = path.join(nodeBinDir, `claude${ext}`);
    if (fs.existsSync(nearNode)) return nearNode;

    // Tier 3: Common install locations
    const candidates = IS_WINDOWS ? [
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    ] : [
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.claude', 'local', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // Tier 4: Deep scan of every known bin dir (nvm/fnm/volta node-global,
    // homebrew, cargo, pip, …). This is what catches a `claude` installed as a
    // global npm package under a version-managed Node — the most common setup,
    // and the one the fixed-PATH tiers above miss.
    const viaWhich = whichBinary('claude');
    if (viaWhich) return viaWhich;

    return null;
  }

  _buildClaudeCmd(prompt, channelName, { skipResume = false, browserEnabled = false, workingDir } = {}) {
    const claudeBin = this._findClaudeBinary();
    if (!claudeBin) {
      throw new Error('claude CLI not found. Install with: curl -fsSL https://claude.ai/install.sh | bash');
    }

    // The builder emits the correct tool-reference block for toolMode directly
    // (mcp → workspace_* tools, skills → wwj-workspace skill), so there
    // is no post-hoc string replacement to drift out of sync.
    const systemPrompt = '\n' + buildClaudeSystemPrompt({
      agentName: this.agentName,
      workspaceId: this.workspaceId,
      channelName,
      mode: this._mode,
      browserEnabled,
      toolMode: this.toolMode,
    });

    const cmd = [claudeBin, '-p', prompt, '--output-format', 'stream-json', '--verbose'];

    cmd.push('--append-system-prompt', systemPrompt);
    cmd.push('--disallowedTools', 'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup');

    // Resume existing conversation (skipped on retry after stale session)
    const sessionId = this._channelSessions[channelName];
    if (sessionId && !skipResume) {
      cmd.push('--resume', sessionId);
    }

    // Model selection (sonnet, haiku, opus, etc.)
    const selectedModel = this._channelModels[channelName] || this.model;
    if (selectedModel) {
      cmd.push('--model', selectedModel);
    }

    // Reasoning effort, forwarded only when the workspace actually set one -
    // otherwise the CLI keeps whatever the user configured for themselves.
    const selectedEffort = this._channelEfforts[channelName] || this._channelEfforts['*'];
    if (selectedEffort) {
      cmd.push('--effort', selectedEffort);
    }

    // ── Skills mode: write SKILL.md, no MCP server ──
    if (this.toolMode === 'skills') {
      return this._buildSkillsCmd(cmd, channelName, workingDir);
    }

    // ── MCP mode (default): spawn MCP server ──
    return this._buildMcpCmd(cmd, channelName);
  }

  /**
   * Skills mode: write a SKILL.md file and allow Bash + curl for workspace ops.
   */
  _buildSkillsCmd(cmd, channelName, workingDir) {
    if (this._mode === 'plan') {
      cmd.push('--permission-mode', 'plan');
      cmd.push('--allowedTools', 'Read', 'Glob', 'Grep', 'Bash');
    } else {
      cmd.push('--dangerously-skip-permissions');
      cmd.push('--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep');
    }

    // Write SKILL.md to .claude/skills/ in the working directory. Never use
    // process.cwd() as the fallback — on a packaged Windows daemon that is
    // C:\WINDOWS\system32 and mkdir there throws EPERM.
    const workDir = workingDir || this.workingDir || defaultAgentWorkdir(this.agentName);
    const skillDir = path.join(workDir, '.claude', 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'wwj-workspace.md');

    const skillContent = buildClaudeSkillMd({
      endpoint: this.endpoint,
      workspaceId: this.workspaceId,
      token: this.token,
      agentName: this.agentName,
      channelName,
      disabledModules: this.disabledModules,
      browserEnabled: this._browserEnabledCache === true,
    });
    fs.writeFileSync(skillFile, skillContent, 'utf-8');
    this._log(`Wrote workspace skill to ${skillFile}`);

    return { cmd, skillFile };
  }

  /**
   * MCP mode (default): spawn MCP server subprocess for workspace tools.
   */
  _buildMcpCmd(cmd, channelName) {
    // Mode-dependent permission and tool flags
    const pfx = 'mcp__wwj-workspace__';
    const mcpTools = [
      `${pfx}workspace_get_history`,
      `${pfx}workspace_get_agents`,
      `${pfx}workspace_status`,
    ];
    const mcpWriteTools = [];

    if (!this.disabledModules.has('files')) {
      mcpTools.push(`${pfx}workspace_list_files`, `${pfx}workspace_read_file`);
      mcpWriteTools.push(`${pfx}workspace_write_file`, `${pfx}workspace_delete_file`);
    }
    if (!this.disabledModules.has('browser')) {
      mcpTools.push(
        `${pfx}workspace_browser_list_tabs`,
        `${pfx}workspace_browser_snapshot`,
        `${pfx}workspace_browser_screenshot`
      );
      mcpWriteTools.push(
        `${pfx}workspace_browser_open`,
        `${pfx}workspace_browser_navigate`,
        `${pfx}workspace_browser_click`,
        `${pfx}workspace_browser_type`,
        `${pfx}workspace_browser_close`
      );
    }
    if (!this.disabledModules.has('tunnel')) {
      mcpTools.push(`${pfx}tunnel_list`);
      mcpWriteTools.push(`${pfx}tunnel_expose`, `${pfx}tunnel_close`);
    }

    // Todos, Timers & Routines (always enabled)
    mcpTools.push(`${pfx}workspace_get_todos`, `${pfx}workspace_list_timers`, `${pfx}workspace_list_routines`);
    mcpWriteTools.push(`${pfx}workspace_put_todos`, `${pfx}workspace_create_timer`, `${pfx}workspace_cancel_timer`, `${pfx}workspace_create_routine`, `${pfx}workspace_cancel_routine`);

    if (this._mode === 'plan') {
      cmd.push('--permission-mode', 'plan');
      cmd.push('--allowedTools', ...mcpTools, 'Read', 'Glob', 'Grep');
    } else {
      cmd.push('--dangerously-skip-permissions');
      cmd.push('--allowedTools', ...mcpTools, ...mcpWriteTools, 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep');
    }

    // MCP config for workspace tools
    const mcpArgs = [
      'mcp-server',
      '--workspace-id', this.workspaceId,
      '--channel-name', channelName,
      '--agent-name', this.agentName,
      '--endpoint', this.endpoint,
    ];
    if (this.disabledModules.has('files')) mcpArgs.push('--disable-files');
    if (this.disabledModules.has('browser')) mcpArgs.push('--disable-browser');

    // Resolve the MCP server entry point
    let mcpCommand = this._findNodeBin();
    let mcpFinalArgs = mcpArgs;
    const siblingBin = path.resolve(__dirname, '..', '..', 'bin', 'agent-connector.js');
    if (fs.existsSync(siblingBin)) {
      mcpFinalArgs = [siblingBin, ...mcpArgs];
    } else {
      let oaBin = null;
      const home3 = os.homedir();
      const oaExt = IS_WINDOWS ? '.cmd' : '';
      const runtimesRoot = path.join(home3, '.wwj', 'runtimes');
      try {
        for (const d of fs.readdirSync(runtimesRoot, { withFileTypes: true })) {
          if (d.isDirectory()) {
            const candidate = path.join(runtimesRoot, d.name, 'node_modules', '.bin', `wwj${oaExt}`);
            if (fs.existsSync(candidate)) { oaBin = candidate; break; }
          }
        }
      } catch {}
      if (!oaBin) {
        const oaPortable = path.join(home3, '.wwj', 'nodejs', 'node_modules', '.bin', `wwj${oaExt}`);
        if (fs.existsSync(oaPortable)) oaBin = oaPortable;
      }
      // Codepage-safe lookup so a non-ASCII/Chinese username in the path isn't
      // mangled into an ENOENT (see whereBinary).
      if (!oaBin) oaBin = whereBinary('wwj');
      if (!oaBin) {
        this._log('Could not find wwj binary — MCP tools may not be available');
        mcpCommand = 'wwj';
      } else {
        const resolved = this._resolveToNodeCmd(oaBin);
        if (resolved) {
          mcpCommand = resolved[0];
          mcpFinalArgs = [...resolved.slice(1), ...mcpArgs];
        } else {
          mcpCommand = oaBin;
        }
      }
    }

    const mcpConfig = {
      mcpServers: {
        'wwj-workspace': {
          type: 'stdio',
          command: mcpCommand,
          args: mcpFinalArgs,
          env: { WWJ_WORKSPACE_TOKEN: this.token },
        },
      },
    };

    // Write MCP config to temp file (avoids cmd.exe JSON quoting issues)
    const mcpDir = path.join(os.homedir(), '.wwj', 'mcp-configs');
    fs.mkdirSync(mcpDir, { recursive: true });
    const mcpFile = path.join(mcpDir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig));
    cmd.push('--mcp-config', mcpFile);

    return { cmd, mcpConfigFile: mcpFile };
  }

  /**
   * Kill a persistent process for a channel and clean up its idle timer.
   */
  _killPersistentProc(channel) {
    const pp = this._persistentProcs[channel];
    if (!pp) return;
    if (pp.idleTimer) clearTimeout(pp.idleTimer);
    this._stopWatchdog(pp);
    this._stopProcess(pp.proc).catch(() => {});
    delete this._persistentProcs[channel];
  }

  /**
   * Reset the idle timer for a persistent process. Kills the process
   * after _IDLE_TIMEOUT_MS of inactivity.
   */
  _resetIdleTimer(channel) {
    const pp = this._persistentProcs[channel];
    if (!pp) return;
    if (pp.idleTimer) clearTimeout(pp.idleTimer);
    pp.idleTimer = setTimeout(() => {
      this._log(`Persistent process idle for ${this._IDLE_TIMEOUT_MS / 60000}min, releasing ${channel}`);
      this._killPersistentProc(channel);
    }, this._IDLE_TIMEOUT_MS);
  }

  /**
   * Start a watchdog that kills the persistent process if stdout goes
   * silent for too long while a message is in flight.  Pauses during
   * tool execution (awaitingToolResult) since long-running commands
   * like builds or sleep produce no stdout legitimately.
   */
  _startWatchdog(pp) {
    this._stopWatchdog(pp);
    pp.lastStdoutTime = Date.now();
    let consecutiveTimeouts = 0;

    pp.watchdogTimer = setInterval(async () => {
      if (!pp.messageResolve) { consecutiveTimeouts = 0; return; }
      if (pp.awaitingToolResult) { consecutiveTimeouts = 0; return; }

      const elapsed = Date.now() - pp.lastStdoutTime;
      if (elapsed < this._WATCHDOG_INTERVAL_MS) { consecutiveTimeouts = 0; return; }

      consecutiveTimeouts++;
      pp.lastStdoutTime = Date.now();

      if (consecutiveTimeouts === 2 || consecutiveTimeouts % 4 === 0) {
        const mins = Math.round((consecutiveTimeouts * 15) / 60);
        try { await this.sendStatus(pp.msgChannel, `Still processing${mins > 0 ? ` (${mins}m)` : ''}...`); } catch {}
      }

      if (consecutiveTimeouts >= this._WATCHDOG_MAX_TIMEOUTS) {
        this._log(`Watchdog: process unresponsive for ${consecutiveTimeouts * 15}s on ${pp.msgChannel} — killing`);
        this._stopWatchdog(pp);
        try { await this.sendError(pp.msgChannel, `⚠️ Agent execution exceeded watchdog limit (${Math.round((consecutiveTimeouts * 15) / 60)}m) and was restarted.`); } catch {}
        if (pp.messageResolve) {
          const resolve = pp.messageResolve;
          pp.messageResolve = null;
          resolve({ exited: true, error: new Error('watchdog timeout') });
        }
        this._killPersistentProc(pp.msgChannel);
      }
    }, this._WATCHDOG_INTERVAL_MS);
  }

  _stopWatchdog(pp) {
    if (pp.watchdogTimer) { clearInterval(pp.watchdogTimer); pp.watchdogTimer = null; }
  }

  /**
   * Spawn a persistent Claude process for a channel that accepts messages
   * via stdin (--input-format stream-json). Returns the persistent proc entry.
   */
  _spawnPersistentProc(channel, cmd, cleanEnv, workingDir) {
    // Remove -p and its argument from cmd — prompts go via stdin
    const filteredCmd = [];
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === '-p' || cmd[i] === '--print') {
        // -p in stream-json mode is just a flag (no argument to skip)
        // but _buildClaudeCmd passes [-p, prompt] — skip both
        if (i + 1 < cmd.length && !cmd[i + 1].startsWith('-')) {
          i++; // skip the prompt argument
        }
        continue;
      }
      filteredCmd.push(cmd[i]);
    }
    // Add stdin streaming flags
    filteredCmd.push('--input-format', 'stream-json');
    // Ensure -p is present (required for stream-json)
    if (!filteredCmd.includes('-p') && !filteredCmd.includes('--print')) {
      filteredCmd.splice(1, 0, '-p');
    }

    const resolved = this._resolveToNodeCmd(filteredCmd[0]);
    let finalCmd = filteredCmd;
    if (resolved) {
      finalCmd = [...resolved, ...filteredCmd.slice(1)];
    } else if (IS_WINDOWS && filteredCmd[0].toLowerCase().endsWith('.cmd')) {
      finalCmd = ['cmd.exe', '/c', ...filteredCmd];
    }

    const proc = spawn(finalCmd[0], finalCmd.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd: workingDir || this.workingDir,
      detached: !IS_WINDOWS,
      windowsHide: true,
    });

    const pp = {
      proc,
      lineBuffer: '',
      pendingLines: Promise.resolve(),
      idleTimer: null,
      messageResolve: null,
      msgChannel: channel,
      lastResponseText: [],
      lastErrorText: '',
      hasToolUseSinceLastText: false,
      postedThinking: false,
      everPostedAnything: false,
      stderrBuf: '',
      // Absolute paths of files this turn's tools wrote, registered into the
      // workspace Files space once the turn ends (at tool_use time the tool has
      // not run yet, so the file may not exist or still be stale).
      producedFiles: new Set(),
      alive: true,
      lastStdoutTime: Date.now(),
      watchdogTimer: null,
      awaitingToolResult: false,
      userStopped: false,
      // Partial-message streaming state. `thinkingDeltas` accumulates a thinking
      // block's `thinking_delta` fragments keyed by block index; `streamedThinking`
      // records that this run delivered reasoning that way, so the complete
      // `assistant` event that follows does not post the same reasoning again.
      thinkingDeltas: new Map(),
      streamedThinking: false,
    };

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => { pp.stderrBuf += chunk.toString('utf-8'); });
    }

    const processLine = async (line) => {
      line = line.trim();
      if (!line) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const eventType = event.type;

      /*
       * Partial-message streaming.
       *
       * `claude -p --output-format stream-json` currently runs WITHOUT
       * `--include-partial-messages`, so complete `assistant` events arrive and
       * the `block.type === 'thinking'` branch below handles reasoning. Add that
       * flag, though, and Claude Code stops sending whole blocks: reasoning then
       * arrives only as Anthropic's SSE deltas, nested inside a `stream_event`
       * wrapper —
       *
       *   stream_event -> content_block_delta -> delta.thinking_delta -> .thinking
       *
       * and a handler that only knows about complete blocks silently stops
       * showing any reasoning at all. Handled here so enabling that flag for
       * smoother output cannot quietly cost the Thought disclosure.
       *
       * Only `thinking_delta` is consumed. `text_delta` is left alone because the
       * reply already reaches the workspace through the complete `assistant`
       * event, and taking it from both places would post it twice.
       *
       * `signature_delta` is deliberately ignored for display: it is an opaque
       * continuity token for later turns, not text, and concatenating it into the
       * Thought box would render base64 as reasoning.
       */
      if (eventType === 'stream_event') {
        const inner = event.event || event.data || {};
        const innerType = inner.type;
        const idx = typeof inner.index === 'number' ? inner.index : 0;

        if (innerType === 'content_block_delta' && inner.delta && inner.delta.type === 'thinking_delta') {
          const prev = pp.thinkingDeltas.get(idx) || '';
          pp.thinkingDeltas.set(idx, prev + String(inner.delta.thinking || ''));
          return;
        }

        // Flush on block close rather than per delta: one Thought per block, not
        // one per token. A token-per-message stream would also be indexed and
        // stored as hundreds of rows for a single thought.
        if (innerType === 'content_block_stop') {
          const buffered = (pp.thinkingDeltas.get(idx) || '').trim();
          pp.thinkingDeltas.delete(idx);
          if (buffered) {
            pp.streamedThinking = true;
            try { await this.sendThinking(pp.msgChannel, buffered); } catch {}
          }
          return;
        }

        // Any other partial event is a duplicate of information the complete
        // `assistant` event carries; dropped rather than double-reported.
        return;
      }

      if (eventType === 'assistant') {
        pp.awaitingToolResult = false;
        const blocks = (event.message || {}).content || [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            if (pp.hasToolUseSinceLastText) {
              pp.lastResponseText.length = 0;
              pp.hasToolUseSinceLastText = false;
            }
            pp.lastResponseText.push(block.text.trim());
            pp.postedThinking = true;
            pp.everPostedAnything = true;
            try { await this.sendThinking(pp.msgChannel, block.text.trim(), { isReplyPreview: true }); } catch {}
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            /*
             * Claude's extended thinking. THIS IS THE ONLY GENUINE
             * CHAIN-OF-THOUGHT THIS ADAPTER RECEIVES, and it used to fall
             * through this if/else chain and be discarded — so the model with
             * the strongest reasoning trace showed no reasoning at all, while
             * its reply was being displayed under a "Thought" heading instead.
             *
             * The text is on `block.thinking`, not `block.text`. Reaching for
             * `.text` here is how this silently yields nothing.
             *
             * `redacted_thinking` carries only an encrypted `data` field with
             * nothing readable, so it is matched to be skipped deliberately
             * rather than left to fall through to the generic branch.
             *
             * Deliberately does NOT touch `postedThinking`, `lastResponseText`
             * or `everPostedAnything`: those drive the reply-finalisation state
             * machine, and reasoning is not a reply. A turn that produced only
             * reasoning must still be reported as having produced no answer.
             */
            // Skipped when the same reasoning already went out as
            // `thinking_delta` fragments this run: with
            // `--include-partial-messages` on, Claude Code sends BOTH the deltas
            // and the assembled block, and posting both means every thought
            // appears twice.
            const thought = String(block.thinking || '').trim();
            if (thought && !pp.streamedThinking) {
              try { await this.sendThinking(pp.msgChannel, thought); } catch {}
            }
          } else if (block.type === 'tool_use') {
            pp.hasToolUseSinceLastText = true;
            pp.postedThinking = false;
            pp.lastResponseText.length = 0;
            pp.awaitingToolResult = true;
            const toolName = block.name || '';
            if (toolName === 'TodoWrite' && block.input && block.input.todos) {
              try {
                const wsTodos = block.input.todos.map((t) => ({
                  content: t.content, status: t.status || 'pending', assignee: t.assignee,
                }));
                await this.sendTodos(pp.msgChannel, wsTodos);
              } catch {}
            }
            if (FILE_WRITING_TOOLS.has(toolName) && block.input && typeof block.input === 'object') {
              const written = block.input.file_path || block.input.path || block.input.notebook_path;
              if (written) pp.producedFiles.add(String(written));
            }
            let inputPreview = '';
            if (block.input && typeof block.input === 'object') {
              const inp = block.input;
              if (inp.command) inputPreview = inp.command;
              else if (inp.file_path || inp.path) inputPreview = inp.file_path || inp.path;
              else if (inp.pattern) inputPreview = inp.pattern;
              else if (inp.query) inputPreview = inp.query;
              else if (inp.url) inputPreview = inp.url;
              else if (inp.content) inputPreview = inp.content.slice(0, 100);
              else inputPreview = JSON.stringify(inp).slice(0, 150);
            } else {
              inputPreview = String(block.input || '').slice(0, 150);
            }
            await this.sendStatus(pp.msgChannel, `${toolName} › ${inputPreview}`);
            pp.everPostedAnything = true;
          }
        }
      } else if (eventType === 'result') {
        pp.awaitingToolResult = false;
        const sessionId = event.session_id;
        if (sessionId) {
          this._channelSessions[pp.msgChannel] = sessionId;
          this._saveSessions();
        }
        if (event.is_error) {
          // Capture the error so _handleMessage can surface it to the user.
          // Without this, an auth/API failure (e.g. 401 invalid token) is only
          // logged and the user just sees "No response generated", hiding the
          // real cause and making it nearly impossible to diagnose.
          pp.lastErrorText = String(event.result || '').trim();
          this._log(`Claude error: ${pp.lastErrorText.slice(0, 200)}`);
        }
        // Fire-and-forget: registering produced files must never delay
        // resolving the turn or posting the reply.
        this._flushProducedFiles(pp);
        if (pp.messageResolve) {
          pp.messageResolve({ resultEvent: event });
          pp.messageResolve = null;
        } else {
          // Background-triggered turn: the CLI produced output on its own after
          // the user-initiated turn already resolved (e.g. a run_in_background
          // task finished and fed its result back to the model). That text was
          // streamed as `thinking` only — with no messageResolve waiting,
          // _handleMessage never posts it as a `chat`, so the thread visually
          // hangs on "thinking…/Working…". Finalize the accumulated text as a
          // real answer so the turn settles on an actual message bubble.
          const trailing = pp.lastResponseText.join('\n').trim();
          if (trailing && !event.is_error) {
            this._resetIdleTimer(pp.msgChannel);
            try { await this.sendResponse(pp.msgChannel, trailing); } catch {}
          }
          pp.lastResponseText.length = 0;
        }
      } else if (eventType === 'system') {
        const subtype = event.subtype || '';
        const message = event.message || '';
        if (subtype.includes('compact') || String(message).toLowerCase().includes('compact')) {
          await this.sendStatus(pp.msgChannel, String(message) || 'Compacting conversation...');
        }
      } else if (eventType === 'rate_limit_event') {
        this._log(`Rate limited event: ${JSON.stringify(event).slice(0, 200)}`);
        this.fetchAndReportUsage(true).catch(() => {});
      }
    };

    proc.stdout.on('data', (chunk) => {
      pp.lineBuffer += chunk.toString('utf-8');
      pp.lastStdoutTime = Date.now();
      const lines = pp.lineBuffer.split('\n');
      pp.lineBuffer = lines.pop();
      for (const line of lines) {
        pp.pendingLines = pp.pendingLines.then(() => processLine(line)).catch(() => {});
      }
    });

    proc.on('exit', (code) => {
      this._log(`Persistent process exited: channel=${channel} code=${code}`);
      pp.alive = false;
      if (pp.idleTimer) clearTimeout(pp.idleTimer);
      this._stopWatchdog(pp);
      if (pp.messageResolve) {
        pp.messageResolve({ exited: true, code });
        pp.messageResolve = null;
      }
      delete this._persistentProcs[channel];
      delete this._channelProcesses[channel];
    });

    proc.on('error', (err) => {
      this._log(`Persistent process error: ${err.message}`);
      pp.alive = false;
      this._stopWatchdog(pp);
      if (pp.messageResolve) {
        pp.messageResolve({ exited: true, error: err });
        pp.messageResolve = null;
      }
      delete this._persistentProcs[channel];
    });

    this._persistentProcs[channel] = pp;
    this._channelProcesses[channel] = proc;
    this._resetIdleTimer(channel);
    return pp;
  }

  /**
   * Send a user message to a persistent process via stdin and wait for
   * the result event. Returns { resultEvent } on success or { exited, code }
   * if the process dies mid-message.
   */
  _sendToPersistentProc(pp, content) {
    pp.lastResponseText = [];
    pp.lastErrorText = '';
    pp.hasToolUseSinceLastText = false;
    pp.postedThinking = false;
    pp.everPostedAnything = false;
    pp.awaitingToolResult = false;
    /*
     * Per-turn reset. `pp` is keyed by CHANNEL and outlives a single message
     * (`this._persistentProcs[channel]`), so partial-message state left set here
     * leaks into every later turn: one turn that streamed its reasoning as
     * `thinking_delta` would suppress the complete-block reasoning of every turn
     * after it, for the lifetime of the process. Anything scoped to one turn has
     * to be cleared at the point the turn starts, which is here.
     */
    pp.streamedThinking = false;
    // Replaced rather than `.clear()`ed: a process object created before this
    // field existed has no Map to clear, and assignment is correct either way.
    pp.thinkingDeltas = new Map();

    const stdinMsg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
      },
    }) + '\n';

    return new Promise((resolve) => {
      pp.messageResolve = (result) => {
        this._stopWatchdog(pp);
        resolve(result);
      };
      pp.lastStdoutTime = Date.now();
      this._startWatchdog(pp);
      try {
        pp.proc.stdin.write(stdinMsg);
      } catch (e) {
        this._log(`stdin write failed: ${e.message}`);
        this._stopWatchdog(pp);
        pp.messageResolve = null;
        resolve({ exited: true, error: e });
      }
    });
  }

  /**
   * Turn a raw Claude `result` error into a user-facing message. Auth failures
   * (401 / invalid token) are the most common real-world cause and are otherwise
   * invisible — add a concrete hint about which env vars to check.
   */
  _formatClaudeError(text) {
    const msg = String(text || '').trim() || 'Claude returned an error.';
    if (/401|403|authenticate|invalid.*(token|key|api)|无效的?\s*(令牌|密钥|key)/i.test(msg)) {
      return `Claude authentication failed: ${msg}\n\n` +
        'Check this agent\'s API key and Base URL in the launcher — the key may be invalid or expired.';
    }
    return `Claude error: ${msg}`;
  }

  /**
   * Register the files this turn's tools wrote into the workspace Files space.
   * Drains the set so a later turn in the same persistent process does not
   * re-submit them (BaseAdapter also dedupes by size+mtime, which covers a file
   * genuinely rewritten with identical content).
   *
   * Never rejects — a failed upload must not affect the conversation.
   *
   * @param {object} pp persistent-process state
   */
  async _flushProducedFiles(pp) {
    if (!pp || !pp.producedFiles || pp.producedFiles.size === 0) return;
    const paths = [...pp.producedFiles];
    pp.producedFiles.clear();
    const channel = pp.msgChannel;
    for (const filePath of paths) {
      try {
        await this.registerProducedFile(channel, filePath);
      } catch {}
    }
  }

  async _handleMessage(msg) {
    let content = (msg.content || '').trim();
    const attachments = msg.attachments || [];

    const attText = formatAttachmentsForPrompt(attachments, this.toolMode);
    if (attText) {
      content = content ? content + attText : attText.trim();
    }

    if (!content) return;

    const msgChannel = msg.sessionId || this.channelName;
    // Resolved once per message (not stashed on `this`) — multiple channels can
    // be in flight concurrently on the same adapter instance, each potentially
    // bound to a different "Open Folder" directory.
    const resolvedWorkingDir = await this._resolveWorkingDir(msgChannel);
    this._stoppingChannels.delete(msgChannel);
    this._stopNoticeSent.delete(msgChannel);
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing message from ${sender} in ${msgChannel}: ${content.slice(0, 80)}...`);

    // Auto-title + resume-from on first encounter
    if (!this._titledSessions.has(msgChannel)) {
      this._titledSessions.add(msgChannel);
      try {
        const info = await this.client.getSession(this.workspaceId, msgChannel, this.token);
        const resumeFrom = info.resumeFrom;
        if (resumeFrom && !this._channelSessions[msgChannel]) {
          const sourceSession = this._channelSessions[resumeFrom];
          if (sourceSession) {
            this._channelSessions[msgChannel] = sourceSession;
            this._saveSessions();
            this._log(`Resuming channel ${msgChannel} from ${resumeFrom}`);
          }
        }
        const title = generateSessionTitle(content);
        if (title && !info.titleManuallySet && SESSION_DEFAULT_RE.test(info.title || '')) {
          await this.client.updateSession(
            this.workspaceId, msgChannel, this.token,
            { title, autoTitle: true }
          );
        }
      } catch {}
    }

    await this.sendStatus(msgChannel, 'thinking...');

    // ── Persistent process fast-path ──
    // If we have a living persistent process for this channel, send via stdin
    // instead of spawning a new CLI (saves ~2s startup time).
    const existingPP = this._persistentProcs[msgChannel];
    if (existingPP && existingPP.alive) {
      this._log(`Reusing persistent process for ${msgChannel}`);
      this._resetIdleTimer(msgChannel);
      existingPP.msgChannel = msgChannel;
      // The live session only ever saw messages addressed to us — push in
      // whatever else the channel said since our last turn.
      let turnContent = content;
      try {
        const ctx = await this._buildChannelContext(msgChannel, {
          currentMessage: content,
          currentMessageId: msg.messageId,
        });
        if (ctx) turnContent = `${ctx}\n\n---\n\n${content}`;
      } catch {}
      const result = await this._sendToPersistentProc(existingPP, turnContent);
      if (result.resultEvent) {
        const fullResponse = existingPP.lastResponseText.join('\n').trim();
        if (existingPP.lastErrorText) {
          try { await this.sendError(msgChannel, this._formatClaudeError(existingPP.lastErrorText)); } catch {}
        } else if (fullResponse) {
          try { await this.sendResponse(msgChannel, fullResponse); } catch {}
        }
        this._resetIdleTimer(msgChannel);
        try {
          await this.client.postEvent(this.workspaceId, {
            channel: msgChannel,
            messageType: 'status',
            content: 'idle',
            senderName: this.agentName,
          });
        } catch {}
        if (!msg._todoNudge) {
          try {
            const remaining = await this.getRemainingTodos(msgChannel);
            if (remaining.length > 0) {
              const items = remaining.map((t) => `- ${t.content}`).join('\n');
              const nudge = `You have ${remaining.length} remaining task(s) from your plan:\n${items}\n\nPlease continue working on them.`;
              if (!this._channelQueues[msgChannel]) this._channelQueues[msgChannel] = [];
              this._channelQueues[msgChannel].push({
                content: nudge, senderType: 'system', senderName: 'system:todos',
                sessionId: msgChannel, messageType: 'chat', _todoNudge: true,
              });
            }
          } catch {}
        } else {
          // The nudge has already run once for this plan. Anything still open is
          // not going to be picked up by this turn, and leaving it as "pending"
          // means the next, unrelated task opens with the previous task's list
          // still on the panel. Cancel it — the cursor adapter has always done
          // this; claude had no else branch, so its todos never got closed out.
          try { await this.cleanupTodos(msgChannel); } catch {}
        }
        return;
      }
      if (existingPP.userStopped) {
        if (!existingPP.everPostedAnything) {
          await this._postStopNotice(msgChannel);
        }
        // A stopped run leaves its plan half-done. Those items are not coming
        // back, so close them out instead of parking them on the panel.
        try { await this.cleanupTodos(msgChannel); } catch {}
        return;
      }
      // Process died mid-message — fall through to spawn a fresh one
      this._log(`Persistent process died, falling back to fresh spawn for ${msgChannel}`);
    }

    let mcpConfigFile = null;
    let cmd;

    // Clean env: strip CLAUDE_* / AI_AGENT variables that make the spawned
    // `claude` think it's running under an SDK harness (org-scoped auth
    // path → 403). But preserve config vars the child needs for cloud
    // provider auth (Vertex, Bedrock) and model selection.
    const CLAUDE_ENV_KEEP = new Set([
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_MODEL',
      'CLAUDE_API_KEY',
      'CLAUDE_CODE_MAX_TURNS',
    ]);
    const cleanEnv = { ...(this.agentEnv || process.env) };
    for (const k of Object.keys(cleanEnv)) {
      if ((k.startsWith('CLAUDE_') && !CLAUDE_ENV_KEEP.has(k)) || k === 'CLAUDECODE' || k === 'AI_AGENT') {
        delete cleanEnv[k];
      }
    }

    // Third-party Anthropic-compatible relays (the common reason a custom
    // ANTHROPIC_BASE_URL is set) authenticate via `Authorization: Bearer`, which
    // the Claude CLI only sends when ANTHROPIC_AUTH_TOKEN is set. With just
    // ANTHROPIC_API_KEY the CLI sends `x-api-key`, which most relays ignore — the
    // relay then rejects every request as 401 "invalid token / 无效的令牌". When a
    // non-official base URL is configured and no auth token was provided, mirror
    // the API key into ANTHROPIC_AUTH_TOKEN (it outranks the API key in Claude
    // Code's auth precedence) so the CLI uses Bearer auth. The launcher normally
    // sets this when saving env; this is the runtime backstop for envs saved by
    // an older launcher or coming from any other source. The official
    // api.anthropic.com endpoint keeps x-api-key, so it is left untouched.
    const anthropicBase = (cleanEnv.ANTHROPIC_BASE_URL || '').trim();
    const anthropicKey = (cleanEnv.ANTHROPIC_API_KEY || '').trim();
    if (anthropicKey && anthropicBase && !(cleanEnv.ANTHROPIC_AUTH_TOKEN || '').trim()) {
      let officialAnthropic = false;
      try {
        const host = new URL(anthropicBase).hostname.toLowerCase();
        officialAnthropic = host === 'anthropic.com' || host.endsWith('.anthropic.com');
      } catch { officialAnthropic = false; }
      if (!officialAnthropic) {
        cleanEnv.ANTHROPIC_AUTH_TOKEN = anthropicKey;
      }
    }

    // Spawn a persistent process and send the first message via stdin
    let effectiveContent = content;

    // Without a session (no --resume) the fresh CLI needs the full recap;
    // with one it only needs the messages posted since our last turn.
    try {
      const ctx = await this._buildChannelContext(msgChannel, {
        currentMessage: content,
        currentMessageId: msg.messageId,
        full: !this._channelSessions[msgChannel],
      });
      if (ctx) effectiveContent = `${ctx}\n\n---\n\n${content}`;
    } catch {}

    for (let attempt = 0; attempt < 2; attempt++) {
      if (mcpConfigFile) { try { fs.unlinkSync(mcpConfigFile); } catch {} mcpConfigFile = null; }

      if (attempt > 0) {
        this._killPersistentProc(msgChannel);
        // Retry spawns a brand-new CLI (skipResume), so it needs the full
        // recap regardless of what the cursor thinks the old session saw.
        try {
          const recap = await this._buildChannelContext(msgChannel, {
            currentMessage: content,
            currentMessageId: msg.messageId,
            full: true,
          });
          if (recap) effectiveContent = `${recap}\n\n---\n\n${content}`;
        } catch {}
      }

      try {
        const browserEnabled = await this.getBrowserEnabled();
        const built = this._buildClaudeCmd(effectiveContent, msgChannel, {
          skipResume: attempt > 0,
          browserEnabled,
          workingDir: resolvedWorkingDir,
        });
        cmd = built.cmd;
        mcpConfigFile = built.mcpConfigFile;
      } catch (e) {
        await this.sendError(msgChannel, e.message);
        return;
      }

      try {
        const pp = this._spawnPersistentProc(msgChannel, cmd, cleanEnv, resolvedWorkingDir);
        this._log(`Spawned persistent process for ${msgChannel} (attempt ${attempt + 1})`);

        const result = await this._sendToPersistentProc(pp, effectiveContent);

        if (result.exited) {
          this._log(`Process exited during first message (attempt ${attempt + 1}), userStopped=${pp.userStopped}`);
          if (pp.userStopped) {
            if (!pp.everPostedAnything) {
              await this._postStopNotice(msgChannel);
            }
            break;
          }
          if (attempt === 0 && this._channelSessions[msgChannel]) {
            this._log(`Stale session detected, retrying without resume`);
            delete this._channelSessions[msgChannel];
            this._saveSessions();
            continue;
          }
          if (!pp.everPostedAnything) {
            if (pp.lastErrorText) {
              try { await this.sendError(msgChannel, this._formatClaudeError(pp.lastErrorText)); } catch {}
            } else {
              try { await this.sendError(msgChannel, 'No response generated. Please try again.'); } catch {}
            }
          }
          break;
        }

        // Success — post final response
        const fullResponse = pp.lastResponseText.join('\n').trim();

        if (this._mode === 'plan') {
          try {
            const planDir = path.join(resolvedWorkingDir || defaultAgentWorkdir(this.agentName), '.claude', 'plans');
            if (fs.existsSync(planDir)) {
              const planFiles = fs.readdirSync(planDir)
                .filter((f) => f.endsWith('.md'))
                .map((f) => ({ name: f, mtime: fs.statSync(path.join(planDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
              if (planFiles.length > 0) {
                const planContent = fs.readFileSync(path.join(planDir, planFiles[0].name), 'utf-8').trim();
                if (planContent) pp.lastResponseText.push('\n\n---\n\n**Plan:**\n\n' + planContent);
              }
            }
          } catch {}
        }

        const finalResponse = pp.lastResponseText.join('\n').trim();
        if (/prompt is too long/i.test(finalResponse) && this._channelSessions[msgChannel]) {
          this._log(`Prompt too long, clearing session and retrying`);
          delete this._channelSessions[msgChannel];
          this._saveSessions();
          this._killPersistentProc(msgChannel);
          continue;
        }

        if (pp.lastErrorText) {
          // Claude finished with an error and no assistant text (e.g. 401 invalid
          // token). Surface it instead of silently dropping the turn.
          try { await this.sendError(msgChannel, this._formatClaudeError(pp.lastErrorText)); } catch {}
        } else if (finalResponse) {
          try { await this.sendResponse(msgChannel, finalResponse); } catch {}
        }

        this._resetIdleTimer(msgChannel);
        try {
          await this.client.postEvent(this.workspaceId, {
            channel: msgChannel,
            messageType: 'status',
            content: 'idle',
            senderName: this.agentName,
          });
        } catch {}

        if (!msg._todoNudge) {
          try {
            const remaining = await this.getRemainingTodos(msgChannel);
            if (remaining.length > 0) {
              const items = remaining.map((t) => `- ${t.content}`).join('\n');
              const nudge = `You have ${remaining.length} remaining task(s) from your plan:\n${items}\n\nPlease continue working on them.`;
              if (!this._channelQueues[msgChannel]) this._channelQueues[msgChannel] = [];
              this._channelQueues[msgChannel].push({
                content: nudge, senderType: 'system', senderName: 'system:todos',
                sessionId: msgChannel, messageType: 'chat', _todoNudge: true,
              });
            }
          } catch {}
        } else {
          // The nudge has already run once for this plan. Anything still open is
          // not going to be picked up by this turn, and leaving it as "pending"
          // means the next, unrelated task opens with the previous task's list
          // still on the panel. Cancel it — the cursor adapter has always done
          // this; claude had no else branch, so its todos never got closed out.
          try { await this.cleanupTodos(msgChannel); } catch {}
        }
        break;
      } catch (e) {
        this._log(`Error handling message: ${e.message}`);
        await this.sendError(msgChannel, `Error processing message: ${e.message}`);
        break;
      }
    }

    if (mcpConfigFile) {
      try { fs.unlinkSync(mcpConfigFile); } catch {}
    }
  }

  async run() {
    setTimeout(() => {
      this.fetchAndReportUsage().catch(() => {});
    }, 2000);
    this._usageInterval = setInterval(() => {
      this.fetchAndReportUsage().catch(() => {});
    }, 180000);
    return super.run();
  }
}

module.exports = ClaudeAdapter;
