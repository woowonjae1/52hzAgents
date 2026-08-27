/**
 * Amp adapter for OpenAgents workspace.
 *
 * Bridges Sourcegraph's Amp CLI to an OpenAgents workspace by running the
 * agent in its official non-interactive *execute* mode with structured output:
 *
 *   amp -x --stream-json                                  // first turn (new thread)
 *   amp threads continue <threadId> -x --stream-json      // follow-up turns
 *
 * The prompt is fed on stdin (the documented `echo "..." | amp -x` path), which
 * avoids ARG_MAX / shell-quoting issues with the large workspace system context.
 * Amp's `--stream-json` output is intentionally compatible with Claude Code's
 * stream-json schema, so the event handling mirrors the Claude adapter: `system`
 * (init / session id), `assistant` (text + tool_use blocks), and `result`
 * (final text + session id).
 *
 * Reuses all shared connectivity / dispatch / state machinery in BaseAdapter;
 * only the Amp-specific subprocess invocation and parsing live here.
 *
 * Mirrors the Python adapter: sdk/src/openagents/adapters/amp.py
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { captureCli, parseHelpChoices, sliceSection, parseParenLabelledList, toOptions } = require('./model-introspection');
const { buildOpenclawSystemPrompt } = require('./workspace-prompt');
const { whichBinary, getEnhancedEnv } = require('../paths');
const { REASON, classifySpawnError, redactDiagnostic, shouldUseShellForBinary } = require('./health-status');

const IS_WINDOWS = process.platform === 'win32';

// `amp plugin show-agent-options` and `amp --help` run off the 30s heartbeat,
// so both are cached.
const INTROSPECT_CACHE_TTL_MS = 5 * 60 * 1000;
// Terminate the subprocess if it produces no output for this long (a wedged
// turn) — guards the daemon against a hung Amp process without arbitrary sleeps.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Platform-appropriate Amp CLI install command for "not found" messages. */
function ampInstallHint() {
  return IS_WINDOWS
    ? 'powershell -NoProfile -Command "irm https://ampcode.com/install.ps1 | iex"'
    : 'curl -fsSL https://ampcode.com/install.sh | bash';
}

class AmpAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();

    // channel -> Amp thread id (for `amp threads continue <id>`)
    this._channelThreads = {};
    // channel -> running child process (for stop / cleanup)
    this._channelProcesses = {};
    // channels the user explicitly stopped (suppress "no response" noise)
    this._stoppingChannels = new Set();

    this._sessionsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}_amp.json`,
    );
    this._loadSessions();

    this._channelEfforts = {};
    this._modelsCache = null;
    this._modelsInFlight = null;
    this._effortCache = null;
    this._effortInFlight = null;
    this._ampBin = this._findAmpBinary();
    if (this._ampBin) {
      this._log(`Using Amp CLI: ${this._ampBin}`);
    } else {
      this._log(`Warning: Amp CLI not found — install with: ${ampInstallHint()}`);
    }
  }

  // ------------------------------------------------------------------
  // Session (thread id) persistence
  // ------------------------------------------------------------------

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelThreads, data);
          this._log(`Loaded ${Object.keys(data).length} Amp thread(s)`);
        }
      }
    } catch {
      this._log('Could not load Amp sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this._sessionsFile), { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelThreads));
    } catch {}
  }

  _rememberThread(channel, threadId) {
    if (!threadId) return;
    if (this._channelThreads[channel] !== threadId) {
      this._channelThreads[channel] = threadId;
      this._saveSessions();
      this._log(`Amp thread for ${channel}: ${threadId}`);
    }
  }

  // ------------------------------------------------------------------
  // Binary resolution (cross-platform)
  // ------------------------------------------------------------------

  _findAmpBinary() {
    const home = os.homedir();
    const ext = IS_WINDOWS ? '.cmd' : '';

    // Tier 0: isolated runtime prefix (~/.wwj/runtimes/amp/)
    const runtimeCandidate = path.join(home, '.wwj', 'runtimes', 'amp', 'node_modules', '.bin', `amp${ext}`);
    if (fs.existsSync(runtimeCandidate)) return runtimeCandidate;

    // Tier 1: shared cross-platform resolver. It runs `which`/`where` against
    // an ENHANCED PATH that includes nvm/fnm/volta/homebrew, ~/.local/bin and
    // the Amp installer's ~/.amp/bin. This is what makes detection work inside
    // a GUI- or daemon-spawned process that did NOT inherit the user's
    // interactive shell PATH (the common "installed but not found" case).
    const resolved = whichBinary('amp');
    if (resolved) return resolved;

    // Tier 2: explicit known install dirs as a last resort. The official
    // installer (curl https://ampcode.com/install.sh | bash) writes the
    // canonical binary to ~/.amp/bin and only symlinks into ~/.local/bin
    // (or ~/bin, ~/.bin) when one of those is already on PATH.
    const candidates = IS_WINDOWS ? [
      path.join(home, '.amp', 'bin', 'amp.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'amp', 'amp.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'amp.cmd'),
    ] : [
      path.join(home, '.amp', 'bin', 'amp'),
      path.join(home, '.local', 'bin', 'amp'),
      path.join(home, 'bin', 'amp'),
      '/usr/local/bin/amp',
      '/opt/homebrew/bin/amp',
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }

    return null;
  }

  /**
   * Preflight gate (run by the daemon before join). Amp needs a resolvable CLI
   * binary to do anything useful, so when none can be found we surface a precise
   * 'runtime_missing' reason and skip the workspace join entirely — instead of
   * joining and then failing every message. This is also the one place that
   * logs the resolved Amp path for diagnostics. NOTE: 'runtime_missing' (binary
   * gone at run time), NOT 'not_installed' — install detection lives elsewhere.
   */
  preflight() {
    if (!this._ampBin) this._ampBin = this._findAmpBinary();
    if (!this._ampBin) {
      return {
        ok: false,
        reason: REASON.RUNTIME_MISSING,
        message: `Amp CLI not found — install with: ${ampInstallHint()}`,
      };
    }
    this._log(`Amp CLI resolved: ${this._ampBin}`);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Prompt / command construction
  // ------------------------------------------------------------------

  _buildSystemContext(channelName, browserEnabled = false) {
    return buildOpenclawSystemPrompt({
      agentName: this.agentName,
      workspaceId: this.workspaceId,
      channelName,
      endpoint: this.endpoint,
      token: this.token,
      mode: this._mode,
      disabledModules: this.disabledModules,
      browserEnabled,
    });
  }

  _buildAmpCmd(channelName, resume) {
    const threadId = resume ? this._channelThreads[channelName] : null;
    const args = threadId
      ? [this._ampBin, 'threads', 'continue', threadId, '-x', '--stream-json']
      : [this._ampBin, '-x', '--stream-json'];
    const activeModel = this._resolveModel(channelName) || (this.agentEnv || process.env).AMP_MODEL;
    if (activeModel) {
      // NOTE: `--model` is entitlement-gated on Amp - accounts without it get
      // "Error: The --model flag is not enabled for your account." So it is
      // passed only when a model was actually chosen, never on the default
      // path, and the run error is surfaced verbatim rather than swallowed.
      args.push('--model', activeModel);
    }
    const activeMode = this._currentEffort(channelName);
    if (activeMode) {
      args.push('--mode', activeMode);
    }
    return args;
  }

  // ------------------------------------------------------------------
  // Control actions (stop / set_model)
  // ------------------------------------------------------------------

  /**
   * Every model this account can actually reach, from
   * `amp plugin show-agent-options` - Amp's own answer, printed as
   * `  <provider/model> (<Label>)` under a "Models" heading. Scoped to that
   * section so the "Built-in tools" block below it can never be read as models.
   */
  async _listModels() {
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCache.at < INTROSPECT_CACHE_TTL_MS) {
      return this._modelsCache.models;
    }
    if (this._modelsInFlight) return this._modelsInFlight;

    const bin = this._ampBin || this._findAmpBinary();
    if (!bin) return [];

    this._modelsInFlight = captureCli(bin, ['plugin', 'show-agent-options'], { env: this.agentEnv || process.env })
      .then((out) => {
        const section = sliceSection(out, 'Models');
        const models = toOptions(parseParenLabelledList(section), 'amp');
        if (models.length) this._modelsCache = { at: Date.now(), models };
        return models;
      })
      .catch(() => [])
      .finally(() => { this._modelsInFlight = null; });
    return this._modelsInFlight;
  }

  /**
   * Amp's effort analogue is `--mode`, which its own help describes as
   * controlling "the model, system prompt, and tool selection". The accepted
   * values are read out of `amp --help` rather than listed here.
   */
  async _listEffortLevels() {
    const now = Date.now();
    if (this._effortCache && now - this._effortCache.at < INTROSPECT_CACHE_TTL_MS) {
      return this._effortCache.levels;
    }
    if (this._effortInFlight) return this._effortInFlight;

    const bin = this._ampBin || this._findAmpBinary();
    if (!bin) return [];

    this._effortInFlight = captureCli(bin, ['--help'], { env: this.agentEnv || process.env, timeoutMs: 20000, includeStderr: true })
      .then((help) => {
        const levels = parseHelpChoices(help, '--mode').map((id) => ({ id, label: id }));
        if (levels.length) this._effortCache = { at: Date.now(), levels };
        return levels;
      })
      .catch(() => [])
      .finally(() => { this._effortInFlight = null; });
    return this._effortInFlight;
  }

  _currentEffort(channel) {
    if (channel && this._channelEfforts[channel]) return this._channelEfforts[channel];
    return this._channelEfforts['*'] || '';
  }

  async fetchAndReportUsage() {
    try {
      const env = this.agentEnv || process.env;
      const current = this._resolveModel() || env.AMP_MODEL || null;
      const models = await this._listModels();
      const efforts = await this._listEffortLevels();
      const effort = this._currentEffort() || null;
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: current,
          available_models: models.length ? JSON.stringify(models) : null,
          current_effort: effort,
          available_efforts: efforts.length ? JSON.stringify(efforts) : null,
          raw_text: `amp model=${current || 'account-default'} mode=${effort || 'account-default'}`,
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
      const levels = await this._listEffortLevels();
      if (levels.length && !levels.some((l) => l.id.toLowerCase() === String(requested).toLowerCase())) {
        this._log(`set_effort: '${requested}' is not one of ${levels.map((l) => l.id).join(', ')} - ignoring`);
        return;
      }
      if (channel) this._channelEfforts[channel] = requested;
      else this._channelEfforts['*'] = requested;
      this._log(`Mode override for channel=${channel || 'all'} set to '${requested}'`);
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
      }
      this._log(`Model override for channel=${channel || 'all'} set to '${requested}'`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    if (action === 'stop') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel && this._channelProcesses[channel]) {
        this._stoppingChannels.add(channel);
        await this._stopProcess(this._channelProcesses[channel]);
        delete this._channelProcesses[channel];
        try { await this.sendResponse(channel, 'Execution stopped by user.'); } catch {}
      } else {
        await this._stopAllProcesses('Execution stopped by user.');
      }
      return;
    }
    await super._onControlAction(action, payload);
  }

  async _stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (IS_WINDOWS) {
        try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch {}
        return;
      }
      // POSIX: kill the whole process group (proc was detached) so child
      // tool processes are reaped too.
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
          resolve();
        }, 5000);
        proc.on('exit', () => { clearTimeout(timeout); resolve(); });
      });
    } catch {}
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

    if (!this._ampBin) this._ampBin = this._findAmpBinary();
    if (!this._ampBin) {
      const message = `Amp CLI not found — install with: ${ampInstallHint()}`;
      this._reportStatus(REASON.RUNTIME_MISSING, message);
      await this.sendError(msgChannel, message);
      return;
    }

    await this._autoTitleChannel(msgChannel, content);
    this._stoppingChannels.delete(msgChannel);
    await this.sendStatus(msgChannel, 'thinking...');

    let responseText = '';
    try {
      responseText = await this._runAmp(content, msgChannel);
    } catch (e) {
      // A failure to LAUNCH the amp process (ENOENT/EACCES/spawn error) is a
      // distinct, actionable failure — surface it as spawn_failed with the
      // resolved path + code, never a generic "Not installed". Other errors keep
      // a redacted generic message. Both report up so the agent row shows why.
      if (this._isSpawnError(e)) {
        const { reason, message } = classifySpawnError(e, {
          label: 'Amp',
          bin: this._ampBin,
        });
        this._log(message);
        this._reportStatus(reason, message);
        await this.sendError(msgChannel, message);
      } else {
        this._log(`Error handling message: ${redactDiagnostic(e.message)}`);
        await this.sendError(
          msgChannel,
          `Error processing message: ${redactDiagnostic(e.message)}`,
        );
      }
      return;
    }

    if (this._stoppingChannels.has(msgChannel)) {
      this._stoppingChannels.delete(msgChannel);
      return;
    }
    // A successful turn proves the runtime is healthy — clear any prior
    // spawn/runtime error the agent row may be showing.
    this._reportStatus(null);
    if (responseText) {
      await this.sendResponse(msgChannel, responseText);
    } else {
      await this.sendResponse(msgChannel, 'No response generated. Please try again.');
    }
  }

  /** True when an error is a child_process spawn failure (vs. a runtime error). */
  _isSpawnError(e) {
    if (!e) return false;
    const code = e.code || e.errno;
    return (
      e.syscall === 'spawn' ||
      e.syscall === 'spawn amp' ||
      code === 'ENOENT' ||
      code === 'EACCES' ||
      code === 'EPERM'
    );
  }

  // ------------------------------------------------------------------
  // Subprocess execution + stream-json parsing
  // ------------------------------------------------------------------

  async _runAmp(content, msgChannel) {
    const browserEnabled = await this.getBrowserEnabled();

    for (let attempt = 0; attempt < 2; attempt++) {
      const resume = attempt === 0 && !!this._channelThreads[msgChannel];
      const cmd = this._buildAmpCmd(msgChannel, resume);

      let prompt;
      if (resume) {
        // Resumed Amp thread already carries the workspace context.
        prompt = content;
      } else {
        const context = this._buildSystemContext(msgChannel, browserEnabled);
        prompt = `${context}\n\n---\n\n${content}`;
      }

      const { text, stale } = await this._spawnAmp(cmd, prompt, msgChannel);

      if (this._stoppingChannels.has(msgChannel)) return '';
      if (text) return text;
      if (stale && resume) {
        this._log(`Amp thread for ${msgChannel} appears stale — retrying fresh`);
        delete this._channelThreads[msgChannel];
        this._saveSessions();
        continue;
      }
      return '';
    }
    return '';
  }

  async _spawnAmp(cmd, prompt, msgChannel) {
    return new Promise((resolve, reject) => {
      // Pass the agent env with an enhanced PATH (nvm/fnm/volta/homebrew,
      // ~/.local/bin, ~/.amp/bin) so the amp subprocess and any tools it shells
      // out to resolve, even in a GUI/daemon process. AMP_API_KEY / AMP_URL
      // flow through unchanged and are never logged.
      const env = getEnhancedEnv(this.agentEnv);

      const proc = spawn(cmd[0], cmd.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd: this.workingDir,
        detached: !IS_WINDOWS,
        windowsHide: true,
        // Windows .cmd/.bat shims (npm/pnpm/yarn global bins) are not directly
        // executable — must go through a shell. Shared helper so the daemon,
        // adapter and launcher probe all agree on the rule.
        shell: shouldUseShellForBinary(cmd[0]),
      });
      this._channelProcesses[msgChannel] = proc;
      // Diagnostic: the exact argv we launched (no secrets — flags only). The
      // resolved binary path was logged at preflight/init.
      this._log(`Running Amp: ${cmd.map((c) => String(c)).join(' ')}`);

      // Guard the child's stdio streams against 'error'. When the process is
      // SIGKILL'd on stop, macOS Node can emit a benign EPIPE/ECONNRESET 'error'
      // on stdout/stderr a tick later; with a 'data' listener but no 'error'
      // listener that becomes an uncaughtException which crashes the
      // (single-process, e.g. Node 18) test run with exit 1 and no `not ok`.
      // No-op — data handling below is unchanged.
      if (proc.stdout) proc.stdout.on('error', () => {});
      if (proc.stderr) proc.stderr.on('error', () => {});

      let lastTurnText = [];
      let resultText = '';
      let hasToolUseSinceText = false;
      let lineBuffer = '';
      let stderrBuf = '';
      let pending = Promise.resolve();

      // Idle watchdog — reset on any stdout activity.
      let idleTimer = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          this._log(`Amp produced no output for ${IDLE_TIMEOUT_MS / 1000}s — terminating`);
          this._stopProcess(proc);
        }, IDLE_TIMEOUT_MS);
      };
      armIdle();

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });
      }

      if (proc.stdin) {
        proc.stdin.write(prompt || '', 'utf-8');
        proc.stdin.end();
      }

      const processLine = async (line) => {
        line = line.trim();
        if (!line) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }

        const eventType = event.type;
        if (eventType === 'system') {
          if (event.session_id) this._rememberThread(msgChannel, event.session_id);
        } else if (eventType === 'assistant') {
          const blocks = (event.message && event.message.content) || [];
          for (const block of blocks) {
            if (block.type === 'text') {
              const text = (block.text || '').trim();
              if (!text) continue;
              if (hasToolUseSinceText) {
                lastTurnText = [];
                hasToolUseSinceText = false;
              }
              lastTurnText.push(text);
              try { await this.sendThinking(msgChannel, text, { isReplyPreview: true }); } catch {}
            } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
              // Extended thinking, on `block.thinking` rather than `block.text`.
              // Unflagged: this is the real chain-of-thought, so it belongs in
              // the Thought disclosure. Kept out of `lastTurnText` — reasoning is
              // not part of the reply. `redacted_thinking` is matched only to be
              // skipped; its payload is encrypted with nothing readable in it.
              const thought = String(block.thinking || '').trim();
              if (thought) {
                try { await this.sendThinking(msgChannel, thought); } catch {}
              }
            } else if (block.type === 'tool_use') {
              hasToolUseSinceText = true;
              lastTurnText = [];
              const toolName = block.name || '';
              const toolInput = String(JSON.stringify(block.input || {})).slice(0, 200);
              try { await this.sendStatus(msgChannel, `**Using tool:** \`${toolName}\`\n\`\`\`\n${toolInput}\n\`\`\``); } catch {}
            }
          }
        } else if (eventType === 'result') {
          if (event.session_id) this._rememberThread(msgChannel, event.session_id);
          if (event.is_error) this._log(`Amp result error: ${String(event.result || '').slice(0, 200)}`);
          if (event.result) resultText = event.result;
        }
      };

      proc.stdout.on('data', (chunk) => {
        armIdle();
        lineBuffer += chunk.toString('utf-8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          pending = pending.then(() => processLine(line)).catch(() => {});
        }
      });

      proc.on('exit', async (code) => {
        if (idleTimer) clearTimeout(idleTimer);
        try { await pending; } catch {}
        for (const line of lineBuffer.split('\n')) {
          try { await processLine(line); } catch {}
        }
        delete this._channelProcesses[msgChannel];

        if (code !== 0 && stderrBuf.trim()) {
          this._log(`Amp exited ${code}; stderr: ${stderrBuf.trim().slice(0, 300)}`);
        }

        const text = lastTurnText.filter(Boolean).join('\n').trim() || resultText.trim();
        const stale = code !== 0 && !text;
        resolve({ text, exitCode: code, stale });
      });

      proc.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer);
        delete this._channelProcesses[msgChannel];
        reject(err);
      });
    });
  }
}

module.exports = AmpAdapter;
