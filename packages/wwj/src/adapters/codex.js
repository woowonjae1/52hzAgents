/**
 * Codex adapter for 52hzAgents workspace.
 *
 * Bridges OpenAI Codex CLI to an 52hzAgents workspace via:
 * - Codex CLI subprocess (exec --json --full-auto) as primary mode
 * - Direct HTTP mode for OpenAI-compatible LLM APIs as fallback
 *
 * Similar to ClaudeAdapter: spawns the CLI per message, processes
 * structured JSON events, maintains session/thread IDs per channel,
 * and sends real-time status updates.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const http = require('http');
const https = require('https');

const { whereBinary } = require('../paths');
const BaseAdapter = require('./base');
const { buildOpenclawSystemPrompt } = require('./workspace-prompt');
const { logRawEvent } = require('./utils');

const IS_WINDOWS = process.platform === 'win32';
const MAX_HISTORY_ENTRIES = 50;

class CodexAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {Set} [opts.disabledModules]
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();

    const env = this.agentEnv || process.env;
    this._directApiKey = env.OPENAI_API_KEY || '';
    this._directBaseUrl = (env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
    this._channelEfforts = {};
    this._directModel = env.CODEX_MODEL || env.OPENAI_MODEL || env.OPENCLAW_MODEL || '';
    this.model = this._directModel || opts.model || '';

    // Per-channel thread tracking (like Claude's session IDs)
    this._channelThreads = {};
    this._channelProcesses = {};
    this._stoppingChannels = new Set();
    this._sessionsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}_codex.json`
    );
    this._loadSessions();

    // Determine mode:
    // - CLI mode: works with OpenAI's native Responses API (api.openai.com)
    //   OR with subscription-based auth via 'codex login'
    // - Direct API mode: works with any OpenAI-compatible chat completions endpoint
    this._codexBin = this._findCodexBinary();
    this._directMode = false;
    this._useCliMode = false;

    // Check if base URL is OpenAI's native API (CLI requires Responses API)
    const isOpenAiNative = !this._directBaseUrl ||
      this._directBaseUrl.includes('api.openai.com');

    if (this._codexBin && (isOpenAiNative || !this._directApiKey)) {
      // CLI mode: either OpenAI native API or subscription auth (no API key)
      this._useCliMode = true;
      this._log(`CLI mode: ${this._codexBin}${!this._directApiKey ? ' (subscription auth)' : ''}`);
    } else if (this._directApiKey && this._directBaseUrl) {
      this._directMode = true;
      if (this._codexBin) {
        this._log(`Direct LLM mode (non-OpenAI endpoint, CLI requires Responses API): ${this._directBaseUrl} model=${this._directModel || 'gpt-4o'}`);
      } else {
        this._log(`Direct LLM mode: ${this._directBaseUrl} model=${this._directModel || 'gpt-4o'}`);
      }
    } else if (this._codexBin) {
      // CLI binary found, no custom base URL â€?assume OpenAI or subscription auth
      this._useCliMode = true;
      this._log(`CLI mode: ${this._codexBin}`);
    } else {
      this._log('Warning: No codex CLI binary found and no direct API configured');
    }

    // Conversation history (direct API mode only)
    this._conversationHistory = [];
  }

  // ------------------------------------------------------------------
  // Session persistence (per-channel thread IDs)
  // ------------------------------------------------------------------

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelThreads, data);
          this._log(`Loaded ${Object.keys(data).length} thread(s)`);
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
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelThreads));
    } catch {}
  }

  // ------------------------------------------------------------------
  // Find codex binary (multi-tier, like Claude adapter)
  // ------------------------------------------------------------------

  /**
   * Verify a candidate binary can actually be launched.
   *
   * Existence is not enough. A Microsoft Store app execution alias (under
   * C:\Program Files\WindowsApps) passes fs.existsSync and even reports an
   * executable bit, yet spawning it fails with EACCES because of the package
   * ACLs. Detection that only stats the path logs "CLI mode: <path>" at startup
   * and then fails every single task at run time. Probing --version keeps the
   * advertised capability honest.
   *
   * Records the errno per candidate in this._probeFailures so the run-time
   * error can tell "not installed" (ENOENT) apart from "installed but not
   * launchable" (EACCES), instead of advising a reinstall that cannot help.
   */
  /**
   * Render a thrown value as something actionable. A failed spawn often carries
   * an empty .message but a meaningful code/syscall (EACCES, ENOENT), and the
   * previous `Error: ${e.message}` turned exactly those into a bare "Error:".
   */
  _describeThrown(e) {
    if (!e) return 'unknown error';
    const parts = [];
    if (e.code) parts.push(String(e.code));
    if (e.syscall) parts.push(`syscall=${e.syscall}`);
    if (e.path) parts.push(`path=${e.path}`);
    const msg = (e.message || '').trim();
    if (msg) parts.push(msg);
    return parts.length > 0 ? parts.join(' ') : String(e);
  }

  /**
   * Explain an empty turn using what the CLI actually reported. Every branch
   * here used to collapse into "No response generated. Please try again." â€?
   * advice that cannot help when the real cause is an expired login, a bad
   * model name, or a non-zero exit, and that makes a retry pointless.
   */
  _describeEmptyResult(result) {
    const bits = [];
    const turnFailure = (result.turnFailure || '').trim();
    if (turnFailure) bits.push(turnFailure);
    const stderr = (result.stderr || '').trim();
    if (stderr) bits.push(stderr.slice(-800));
    if (bits.length === 0) {
      const code = result.exitCode;
      bits.push(code === 0 || code === null || code === undefined
        ? 'the CLI exited cleanly but emitted no agent message'
        : `the CLI exited with code ${code} and wrote nothing to stderr`);
    }
    return `codex produced no response â€?${bits.join('\n\n')}`;
  }

  /**
   * Explain why no CLI is usable, based on what detection actually observed.
   * Reporting "not found" for a binary that exists but cannot be spawned sends
   * people off to reinstall it, which never fixes an ACL/alias problem.
   */
  _unavailableReason() {
    const blocked = Object.entries(this._probeFailures || {})
      .filter(([, code]) => code !== 'ENOENT');
    if (blocked.length === 0) {
      return 'codex CLI not found. Install with: npm install -g @openai/codex'
        + '\n\nOr configure OPENAI_API_KEY + OPENAI_BASE_URL for direct API mode.';
    }
    const detail = blocked.map(([p, code]) => `  â€?${p} â€?${code}`).join('\n');
    return 'codex CLI was found but could not be launched:\n' + detail
      + '\n\nEACCES usually means a Microsoft Store install (under WindowsApps),'
      + ' which cannot be spawned directly. Install a runnable copy instead:'
      + '\n  npm install -g @openai/codex'
      + '\n\nOr configure OPENAI_API_KEY + OPENAI_BASE_URL for direct API mode.';
  }

  _isLaunchable(binPath) {
    try {
      execSync(`"${binPath}" --version`, {
        encoding: 'utf-8', timeout: 15000, windowsHide: true, stdio: 'pipe',
      });
      return true;
    } catch (e) {
      this._probeFailures[binPath] = e.code || 'EPROBE';
      return false;
    }
  }

  _findCodexBinary() {
    const home = os.homedir();
    const ext = IS_WINDOWS ? '.cmd' : '';
    this._probeFailures = {};

    // Tier 1 uses a codepage-safe lookup (whereBinary forces UTF-8 output +
    // verifies existence so a non-ASCII/Chinese username isn't mangled into an
    // ENOENT; it also no longer returns an empty string on a miss, which used
    // to short-circuit the Node-derived fallback tiers below).
    const viaWhere = whereBinary('codex');

    const candidates = [
      // Tier 0: Isolated runtime prefix (~/.wwj/runtimes/codex/)
      path.join(home, '.wwj', 'runtimes', 'codex', 'node_modules', '.bin', `codex${ext}`),
      // Tier 0b: Legacy portable install
      path.join(home, '.wwj', 'nodejs', 'node_modules', '.bin', `codex${ext}`),
      // Tier 1: PATH search
      viaWhere,
      // Tier 2: Next to current Node.js interpreter (npm global)
      path.join(path.dirname(process.execPath), `codex${ext}`),
    ];

    // Tier 3: npm global prefix (handles custom npm prefix like D:\node\node_global)
    try {
      const npmPrefix = execSync('npm config get prefix', {
        encoding: 'utf-8', timeout: 5000, windowsHide: true,
      }).trim();
      if (npmPrefix) candidates.push(path.join(npmPrefix, `codex${ext}`));
    } catch {}

    // Tier 4: Common install locations
    candidates.push(...(IS_WINDOWS ? [
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
    ] : [
      path.join(home, '.local', 'bin', 'codex'),
      path.join(home, '.npm-global', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ]));

    // Existence gates the probe; launchability decides. A candidate that exists
    // but cannot spawn is skipped so the next tier still gets its chance,
    // rather than winning detection and then failing every task.
    for (const c of candidates) {
      if (!c || !fs.existsSync(c)) continue;
      if (this._isLaunchable(c)) return c;
    }

    return null;
  }

  _buildSystemContext(channelName) {
    const base = buildOpenclawSystemPrompt({
      agentName: this.agentName,
      workspaceId: this.workspaceId,
      channelName,
      endpoint: this.endpoint,
      token: this.token,
      mode: this._mode,
      disabledModules: this.disabledModules,
    });
    const skillsSection = this._buildInstalledSkillsSection();
    return skillsSection ? `${base}\n\n${skillsSection}` : base;
  }

  /**
   * Codex has no native skills-directory discovery (unlike Claude Code), so
   * we inject installed Skill Hub skills directly into its context. Each
   * skill's SKILL.md lives at <workingDir>/.codex/skills/<id>/SKILL.md and
   * Codex (running with cwd=workingDir, full file access) can read it.
   */
  _buildInstalledSkillsSection() {
    let skills = [];
    try {
      const installer = require('../skill-installer');
      skills = installer.listInstalledSkills({
        agentType: this.agentType || 'codex',
        workingDir: this.workingDir,
      });
    } catch {
      return '';
    }
    if (!skills.length) return '';
    const lines = skills.map((s) => {
      const desc = s.description ? ` â€?${s.description}` : '';
      return `- **${s.name}** (\`${s.id}\`)${desc}\n  Read its instructions: \`cat ${s.skillMd}\``;
    });
    return (
      '## Installed Skills\n' +
      'You have the following skills installed. When a task matches a skill, ' +
      'read its `SKILL.md` (via the `cat` command shown) and follow it:\n' +
      lines.join('\n')
    );
  }

  // ------------------------------------------------------------------
  // Process management
  // ------------------------------------------------------------------

  async _stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (IS_WINDOWS) {
        try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch {}
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {
          proc.kill('SIGTERM');
        }
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch {
              proc.kill('SIGKILL');
            }
            resolve();
          }, 5000);
          proc.on('exit', () => { clearTimeout(timeout); resolve(); });
        });
      }
    } catch {}
  }

  /** Codex's own config directory â€?CODEX_HOME when set, else ~/.codex. */
  _codexHome() {
    const env = this.agentEnv || process.env;
    return (env.CODEX_HOME && env.CODEX_HOME.trim()) || path.join(os.homedir(), '.codex');
  }

  /**
   * The model and provider the user selected inside Codex, from the top-level
   * keys of `~/.codex/config.toml`. Only the keys above the first `[section]`
   * are read â€?those are the document-level ones â€?so a `model = ` inside a
   * `[model_providers.x]` table can never be mistaken for the active model.
   * Strictly read-only; this adapter never writes Codex's config.
   */
  _configFromCodexToml() {
    const file = path.join(this._codexHome(), 'config.toml');
    const out = { model: '', provider: '', effort: '' };
    try {
      if (!fs.existsSync(file)) return out;
      for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[')) break; // first table header ends the document-level keys
        const m = line.match(/^(model|model_provider|model_reasoning_effort)\s*=\s*(.+)$/);
        if (!m) continue;
        const value = m[2].trim().replace(/^['"]|['"]$/g, '').trim();
        if (!value) continue;
        if (m[1] === 'model') out.model = value;
        else if (m[1] === 'model_reasoning_effort') out.effort = value;
        else out.provider = value;
      }
    } catch {
      // A malformed config is Codex's problem to report, not ours to guess around.
    }
    return out;
  }

  /**
   * Every model this install can actually reach, from Codex's own
   * `models_cache.json` â€?the catalog the CLI fetched for this account. Returns
   * [] when the cache is absent; an empty list must read as "unknown" and is
   * never substituted with a hardcoded guess.
   */
  _listModels() {
    const file = path.join(this._codexHome(), 'models_cache.json');
    const out = [];
    const seen = new Set();
    try {
      if (fs.existsSync(file)) {
        const cache = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const models = Array.isArray(cache && cache.models) ? cache.models : [];
        for (const m of models) {
          const id = typeof m === 'string' ? m : (m && (m.slug || m.id));
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push({ id, provider: 'codex', label: (m && m.display_name) || id });
        }
      }
    } catch {
      // Unparsable cache â†?report nothing rather than a half-read list.
    }
    const current = this._configFromCodexToml().model;
    if (current && !seen.has(current)) {
      seen.add(current);
      out.push({ id: current, provider: 'codex', label: current });
    }
    return out;
  }

  /**
   * Reasoning-effort levels Codex accepts for the active model, read out of its
   * own `models_cache.json`: each entry carries `supported_reasoning_levels`
   * and a `default_reasoning_level`. Scoped to the model actually in use - a
   * union across every cached model would advertise levels the selected one
   * rejects - and [] when that model is not in the cache.
   */
  _listEffortLevels() {
    const entry = this._activeModelCacheEntry();
    const levels = entry && Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
      : [];
    const out = [];
    const seen = new Set();
    for (const lv of levels) {
      const id = typeof lv === 'string' ? lv : (lv && lv.effort);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: id });
    }
    return out;
  }

  /** The models_cache.json entry for the model currently in use, or null. */
  _activeModelCacheEntry() {
    const file = path.join(this._codexHome(), 'models_cache.json');
    try {
      if (!fs.existsSync(file)) return null;
      const cache = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const models = Array.isArray(cache && cache.models) ? cache.models : [];
      const current = (this._resolveModel() || '').toLowerCase();
      if (!current) return null;
      return models.find((m) => m && String(m.slug || m.id || '').toLowerCase() === current) || null;
    } catch {
      return null;
    }
  }

  /**
   * Effort in force: a workspace override first, then what config.toml pins,
   * then the active model's own default from the cache.
   */
  _currentEffort(channel) {
    if (channel && this._channelEfforts[channel]) return this._channelEfforts[channel];
    if (this._channelEfforts['*']) return this._channelEfforts['*'];
    const fromConfig = this._configFromCodexToml().effort;
    if (fromConfig) return fromConfig;
    const entry = this._activeModelCacheEntry();
    return (entry && entry.default_reasoning_level) || '';
  }

  /**
   * Model forwarded to Codex, in priority order:
   *   1. a workspace override (per-message, per-channel, or global set_model)
   *   2. what Codex's own config.toml says the user selected
   *   3. this agent's env (legacy configuration path)
   */
  _resolveModel(channel, msg) {
    const override = super._resolveModel(channel, msg);
    if (override) return override;
    return this._configFromCodexToml().model || this._directModel || undefined;
  }

  /**
   * Read-only runtime snapshot for the workspace UI. `available_models` is
   * omitted entirely â€?not padded with the current model â€?when Codex has no
   * model cache to read, so the UI shows "not configured" instead of a guess.
   */
  async fetchAndReportUsage() {
    try {
      const fromConfig = this._configFromCodexToml();
      const current = this._resolveModel() || null;
      const source = !current ? 'unconfigured'
        : (current !== fromConfig.model && current !== this._directModel) ? 'workspace-override'
        : current === fromConfig.model ? 'codex-config'
        : 'agent-env';
      const models = this._listModels();
      const efforts = this._listEffortLevels();
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: current,
          available_models: models.length ? JSON.stringify(models) : null,
          current_effort: this._currentEffort() || null,
          available_efforts: efforts.length ? JSON.stringify(efforts) : null,
          raw_text: `codex mode=${this._useCliMode ? 'cli' : 'direct'} model_source=${source}`
            + (fromConfig.provider ? ` provider=${fromConfig.provider}` : ''),
        },
        this.token
      );
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'set_effort') {
      const requested = payload && (payload.effort || payload.model);
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (!requested) return;
      const levels = this._listEffortLevels();
      if (levels.length && !levels.some((l) => l.id.toLowerCase() === String(requested).toLowerCase())) {
        this._log(`set_effort: '${requested}' is not supported by the active model (${levels.map((l) => l.id).join(', ')}) - ignoring`);
        return;
      }
      if (channel) this._channelEfforts[channel] = requested;
      else this._channelEfforts['*'] = requested;
      this._log(`Reasoning effort for channel=${channel || 'all'} set to '${requested}'`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    if (action === 'set_model') {
      const requested = payload && payload.model;
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (!requested) return;
      if (channel) {
        this._channelModels[channel] = requested;
      } else {
        for (const c of Object.keys(this._channelModels)) this._channelModels[c] = requested;
        this._channelModels['*'] = requested;
        this.model = requested;
        this._directModel = requested;
      }
      this._log(`Model override for channel=${channel || 'all'} set to '${requested}'`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    if (action === 'stop') {
      const requestedChannel = (payload && typeof payload === 'object') ? payload.channel : null;
      const processes = requestedChannel
        ? Object.entries(this._channelProcesses).filter(([channel]) => channel === requestedChannel)
        : Object.entries(this._channelProcesses);
      for (const [channel, proc] of processes) {
        this._stoppingChannels.add(channel);
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        delete this._channelQueues[channel];
        try { await this.sendStatus(channel, 'Execution stopped by user'); } catch {}
      }
      return;
    }
    // Shared actions (status, routines, skill.install, skill.uninstall).
    await super._onControlAction(action, payload);
  }

  // ------------------------------------------------------------------
  // Message handler
  // ------------------------------------------------------------------

  async _handleMessage(msg) {
    const content = (msg.content || '').trim();
    if (!content) return;

    const msgChannel = msg.sessionId || this.channelName;
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing message from ${sender} in ${msgChannel}: ${content.slice(0, 80)}...`);

    await this._autoTitleChannel(msgChannel, content);
    await this.sendStatus(msgChannel, 'thinking...');

    if (this._useCliMode) {
      await this._handleViaSubprocess(content, msgChannel, msg);
    } else if (this._directMode) {
      await this._handleViaDirectApi(content, msgChannel, msg);
    } else {
      await this.sendError(msgChannel, this._unavailableReason());
    }
  }

  // ------------------------------------------------------------------
  // CLI subprocess mode (primary)
  // ------------------------------------------------------------------

  async _handleViaSubprocess(content, msgChannel, msg) {
    const env = { ...(this.agentEnv || process.env) };
    const activeModel = this._resolveModel(msgChannel, msg) || this._directModel;

    // Set model via env if configured
    if (activeModel) env.CODEX_MODEL = activeModel;
    if (this._directApiKey) env.OPENAI_API_KEY = this._directApiKey;
    if (this._directBaseUrl) env.OPENAI_BASE_URL = this._directBaseUrl;
    if (!this._directApiKey) delete env.OPENAI_API_KEY;
    if (!this._directBaseUrl) delete env.OPENAI_BASE_URL;

    const context = this._buildSystemContext(msgChannel);
    const fullPrompt = `${context}\n\n---\n\nUser message:\n${content}`;

    // Run up to 2 attempts: first with resume, then fresh if stale
    for (let attempt = 0; attempt < 2; attempt++) {
      const cmd = [this._codexBin, 'exec'];

      // Resume existing thread for this channel
      const threadId = this._channelThreads[msgChannel];
      if (threadId && attempt === 0) {
        cmd.push('resume', threadId);
      }

      cmd.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');

      // Model override
      if (activeModel) {
        cmd.push('-m', activeModel);
      }
      const activeEffort = this._currentEffort(msgChannel);
      if (activeEffort) {
        // Codex exposes no --effort flag; its documented route is the -c override.
        cmd.push('-c', `model_reasoning_effort="${activeEffort}"`);
      }

      this._log(`Spawning: codex exec ${threadId && attempt === 0 ? `resume ${threadId} ` : ''}--json --full-auto -m ${activeModel || 'default'}`);

      try {
        const result = await this._spawnCodex(cmd, env, msgChannel, fullPrompt);

        if (this._stoppingChannels.has(msgChannel)) {
          this._stoppingChannels.delete(msgChannel);
          return;
        }

        if (result.responseText) {
          await this.sendResponse(msgChannel, result.responseText);
          return;
        } else if (result.exitCode !== 0 && threadId && attempt === 0) {
          // Stale thread â€?clear and retry fresh
          this._log(`Stale thread detected for ${msgChannel}, clearing and retrying`);
          delete this._channelThreads[msgChannel];
          this._saveSessions();
          continue;
        } else {
          // The CLI produced no answer. It already told us why via turn.failed,
          // a non-zero exit code, or stderr â€?report that instead of a generic
          // "try again", which hides the cause and makes a retry pointless.
          await this.sendError(msgChannel, this._describeEmptyResult(result));
          return;
        }
      } catch (e) {
        const reason = this._describeThrown(e);
        this._log(`Error in subprocess: ${reason}`);
        await this.sendError(msgChannel, `codex failed to run: ${reason}`);
        return;
      }
    }
  }

  _resolveShimToJs(binPath) {
    if (IS_WINDOWS && binPath) {
      try {
        if (!binPath.toLowerCase().endsWith('.cmd')) return null;
        const cmdContent = fs.readFileSync(binPath, 'utf-8');
        const match = cmdContent.match(/%dp0%\\([^\s"*?]+\.js)/i)
          || cmdContent.match(/%dp0%\\([^\s"*?]+\.mjs)/i);
        if (match) {
          const cmdDir = path.dirname(path.resolve(binPath));
          return path.resolve(cmdDir, match[1]);
        }
      } catch {}
    }
    return null;
  }

  async _spawnCodex(cmd, env, msgChannel, prompt) {
    return new Promise((resolve, reject) => {
      let bin = cmd[0];
      let args = cmd.slice(1);
      let useShell = IS_WINDOWS;

      const scriptPath = this._resolveShimToJs(bin);
      if (scriptPath && fs.existsSync(scriptPath)) {
        bin = process.execPath;
        args = [scriptPath, ...args];
        useShell = false;
      }

      const proc = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd: this.workingDir,
        detached: !IS_WINDOWS,
        windowsHide: true,
        shell: useShell,
      });
      this._channelProcesses[msgChannel] = proc;

      const responseTexts = [];
      let hasToolUseSinceLastText = false;
      let lineBuffer = '';
      let stderrBuf = '';
      // Reason reported by the CLI itself via a turn.failed event. Kept so the
      // caller can tell the user why the turn produced no text, instead of
      // collapsing every failure into "No response generated".
      let turnFailure = '';
      let _pendingLines = Promise.resolve();

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });
      }

      if (proc.stdin) {
        proc.stdin.write(prompt || '', 'utf-8');
        proc.stdin.end();
      }

      const processLine = async (line) => {
        if (this._stoppingChannels.has(msgChannel)) return;
        line = line.trim();
        if (!line) return;

        let event;
        try { event = JSON.parse(line); } catch { return; }
        logRawEvent('codex', event);
        // Printed separately as well: `item.completed` is the envelope that
        // carries reasoning, and in a busy run it is otherwise lost among the
        // token-level events.
        if (event && event.type === 'item.completed') {
          logRawEvent('codex.item.completed', event.item || event);
        }

        const eventType = event.type;

        if (eventType === 'thread.started') {
          if (event.thread_id) {
            this._channelThreads[msgChannel] = event.thread_id;
            this._saveSessions();
            this._log(`Thread started: ${event.thread_id}`);
          }
        } else if (eventType === 'item.completed') {
          const item = event.item || {};
          if (item.type === 'agent_message' && item.text) {
            if (hasToolUseSinceLastText) {
              responseTexts.length = 0;
              hasToolUseSinceLastText = false;
            }
            responseTexts.push(item.text);
            // The reply arriving early, not reasoning â€?see the `reasoning`
            // branch below for the real thing.
            try { await this.sendThinking(msgChannel, item.text, { isReplyPreview: true }); } catch {}
          } else if (item.type === 'reasoning') {
            /*
             * o-series reasoning â€?the genuine chain-of-thought, which this
             * adapter previously ignored entirely (the word "reasoning" did not
             * appear in this file). So the reply was shown inside a "Thought"
             * disclosure while the actual thought was dropped.
             *
             * `item.text` IS THE EXPECTED FIELD HERE. Codex's exec JSONL layer
             * aggregates the model's reasoning summary into a string before
             * emitting it, so the CLI's `ReasoningItem` is `{ id, type, text }`
             * â€?there is no `summary` array at this boundary.
             *
             * The `summary` branch is a cross-interface fallback, not a guess at
             * this one: that array shape belongs to the raw Responses API
             * reasoning output item, which only carries visible text when the
             * caller explicitly requests `reasoning.summary` (the underlying
             * chain-of-thought is never exposed). Kept so a future direct-API
             * path lands here rather than silently yielding nothing.
             *
             * BOTH BEING EMPTY IS NOT EVIDENCE THE FIELDS ARE WRONG. It equally
             * means the model produced no reasoning, or none was requested.
             */
            const summaryText = Array.isArray(item.summary)
              ? item.summary
                  .filter((x) => x && x.type === 'summary_text' && typeof x.text === 'string')
                  .map((x) => x.text)
                  .join('\n\n')
              : '';
            const text = String(item.text || summaryText || '').trim();
            if (text) {
              try { await this.sendThinking(msgChannel, text); } catch {}
            }
          } else if (item.type === 'command_execution') {
            hasToolUseSinceLastText = true;
            const cmdText = (item.command || '').slice(0, 200);
            const exitCode = item.exit_code;
            const output = (item.output || '').slice(0, 500);
            let status = `**Running:** \`${cmdText}\``;
            if (exitCode !== undefined && exitCode !== null) {
              status += ` (exit ${exitCode})`;
            }
            try { await this.sendStatus(msgChannel, status); } catch {}
            this._log(`Command: ${cmdText} â†?exit ${exitCode}`);
          } else if (item.type === 'file_change') {
            hasToolUseSinceLastText = true;
            const filename = item.filename || '';
            try { await this.sendStatus(msgChannel, `**Editing:** \`${filename}\``); } catch {}
            this._log(`File change: ${filename}`);
          }
        } else if (eventType === 'turn.failed') {
          const error = event.error || {};
          const errMsg = error.message || JSON.stringify(error);
          turnFailure = errMsg;
          this._log(`Turn failed: ${errMsg}`);
        }
      };

      proc.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString('utf-8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          _pendingLines = _pendingLines.then(() => processLine(line)).catch(() => {});
        }
      });

      proc.on('exit', async (code) => {
        // Wait for all in-flight processLine calls
        try { await _pendingLines; } catch {}

        // Process remaining buffer
        for (const line of lineBuffer.split('\n')) {
          try { await processLine(line); } catch {}
        }

        delete this._channelProcesses[msgChannel];

        if (code !== 0) {
          this._log(`Codex CLI exited with code ${code}`);
          if (stderrBuf.trim()) {
            this._log(`stderr: ${stderrBuf.trim().slice(0, 500)}`);
          }
        }

        resolve({
          responseText: responseTexts.join('\n').trim(),
          exitCode: code,
          stderr: stderrBuf,
          turnFailure,
        });
      });

      proc.on('error', (err) => {
        delete this._channelProcesses[msgChannel];
        reject(err);
      });
    });
  }

  // ------------------------------------------------------------------
  // Direct HTTP mode (fallback when CLI not available)
  // ------------------------------------------------------------------

  async _handleViaDirectApi(content, msgChannel, msg) {
    try {
      const activeModel = this._resolveModel(msgChannel, msg) || this._directModel || 'gpt-4o';
      const responseText = await this._callCompletionApi(content, msgChannel, msg);
      if (responseText) {
        this._conversationHistory.push({ role: 'user', content });
        this._conversationHistory.push({ role: 'assistant', content: responseText });
        if (this._conversationHistory.length > MAX_HISTORY_ENTRIES * 2) {
          this._conversationHistory = this._conversationHistory.slice(-MAX_HISTORY_ENTRIES * 2);
        }
        await this.sendResponse(msgChannel, responseText);
      } else {
        // Name the endpoint and model that came back empty. "Please try again"
        // hid the usual causes here â€?wrong model id, or a proxy that answers
        // 200 with no choices â€?neither of which a retry fixes.
        await this.sendError(msgChannel, 'codex produced no response â€?the API returned an empty completion'
          + ` (endpoint: ${this._directBaseUrl || 'default'}, model: ${activeModel})`);
      }
    } catch (e) {
      const reason = this._describeThrown(e);
      this._log(`Error in direct API: ${reason}`);
      await this.sendError(msgChannel, `codex API call failed: ${reason}`);
    }
  }

  async _callCompletionApi(userMessage, channel, msg) {
    const systemPrompt = this._buildSystemContext(channel);
    const messages = [{ role: 'system', content: systemPrompt }];
    messages.push(...this._conversationHistory);
    messages.push({ role: 'user', content: userMessage });

    const activeModel = this._resolveModel(channel, msg) || this._directModel || 'gpt-4o';
    const url = `${this._directBaseUrl}/chat/completions`;
    const payload = JSON.stringify({
      model: activeModel,
      messages,
      stream: true,
    });

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(parsed, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._directApiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 300000,
      }, (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => reject(new Error(`LLM API returned ${res.statusCode}: ${body.slice(0, 300)}`)));
          return;
        }

        let fullText = '';
        let toolCallText = '';
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const choices = parsed.choices || [];
              if (choices.length > 0) {
                const delta = choices[0].delta || {};
                if (delta.content) fullText += delta.content;
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function && tc.function.arguments) {
                      toolCallText += tc.function.arguments;
                    }
                  }
                }
              }
            } catch {}
          }
        });
        res.on('end', () => {
          if (!fullText && toolCallText) {
            try {
              const args = JSON.parse(toolCallText);
              fullText = args.command || args.input || args.content || args.text || toolCallText;
            } catch {
              fullText = toolCallText;
            }
          }
          resolve(fullText.trim());
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = CodexAdapter;
