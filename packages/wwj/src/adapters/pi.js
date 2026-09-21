/**
 * Pi adapter for 52hzAgents workspace.
 *
 * Bridges the Pi coding agent CLI (@earendil-works/pi-coding-agent) to an
 * 52hzAgents workspace using `pi --mode json --session <path>` for real-time
 * JSON Lines event streaming.
 *
 * Follows official Pi CLI documentation:
 * https://pi.dev/docs/latest/usage
 *
 * Key design decisions:
 * - Uses --mode json for real-time JSON Lines event streaming (not buffered stdout)
 * - Uses --session <path> with real session file paths (not --session-id)
 * - Session files isolated per workspace under ~/.wwj/pi-sessions/<workspaceId>/
 * - Same session file must never be written concurrently by two Pi processes
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { buildOpenclawSystemPrompt } = require('./workspace-prompt');
const { whereBinary, whichBinary, getRuntimePrefix, getEnhancedEnv } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';
const MAX_HISTORY_ENTRIES = 12;

// Retry policy. See `_classifyFailure` / `_retryDelayFor` for why each exists.
const PI_MIN_RETRY_DELAY_MS = 1000;   // floor, so a configured 0 cannot mean "no wait"
const PI_MAX_RETRY_DELAY_MS = 30000;  // ceiling on the exponential
const PI_RESUME_MIN_CHARS = 400;      // work worth resuming rather than replaying

// Pi's own configuration directory. `models.json` declares the providers and
// models this install can reach; `settings.json` names the active one. Both are
// read-only here - the workspace never writes Pi's config.
const DEFAULT_PI_CONFIG_DIR = path.join(os.homedir(), '.pi', 'agent');

class PiAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {string} [opts.piModel]    - `--model` value (provider/id pattern)
   * @param {string} [opts.piProvider] - `--provider` value
   * @param {boolean} [opts.piApprove] - pass `--approve` to trust local resources (default: true)
   * @param {Set} [opts.disabledModules]
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();

    const env = this.agentEnv || process.env;
    this.piModel = opts.piModel || env.PI_MODEL || '';
    this.piProvider = opts.piProvider || env.PI_PROVIDER || '';
    this.piApprove = opts.piApprove !== false; // default true
    this.maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 3;
    this.retryDelayMs = opts.retryDelayMs !== undefined ? opts.retryDelayMs : 2000;

    this._channelProcesses = {};

    // Session directory: isolated per workspace under ~/.wwj/pi-sessions/<workspaceId>/
    this._sessionDir = path.join(
      os.homedir(), '.wwj', 'pi-sessions', this.workspaceId
    );
    try { fs.mkdirSync(this._sessionDir, { recursive: true }); } catch {}

    this._piBin = this._findPiBinary();
    if (this._piBin) {
      this._log(`Using Pi binary: ${this._piBin}`);
    } else {
      this._log('Warning: pi CLI not found. Install with: npm install -g @earendil-works/pi-coding-agent');
    }
  }

  // ------------------------------------------------------------------
  // Binary discovery (multi-tier, matching claude/codex/hermes pattern)
  // ------------------------------------------------------------------

  /**
   * Resolve a Node.js executable to run JS-entry CLIs with.
   * Prefers the portable Node in ~/.wwj/nodejs/, then system PATH node.
   * Deliberately avoids returning Electron's process.execPath because Electron's
   * bundled Node runtime lacks modern APIs (e.g. markAsUncloneable) and causes
   * undici/fetch crashes in child processes.
   */
  _resolveNodeBinary() {
    const nodeName = IS_WINDOWS ? 'node.exe' : 'node';
    const portableDir = path.join(os.homedir(), '.wwj', 'nodejs');
    for (const candidate of [
      path.join(portableDir, nodeName),
      path.join(portableDir, 'bin', nodeName),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }

    const found = whichBinary('node') || whereBinary('node');
    if (found && !found.toLowerCase().includes('electron') && !found.toLowerCase().includes('52hzagents')) {
      return found;
    }

    const isElectron = Boolean(process.versions.electron || (process.execPath && process.execPath.toLowerCase().includes('52hzagents')));
    if (!isElectron && process.execPath) {
      return process.execPath;
    }

    try {
      const systemFound = execSync(IS_WINDOWS ? 'where node.exe' : 'which node', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: getEnhancedEnv(),
      }).split(/\r?\n/)[0].trim();
      if (systemFound && fs.existsSync(systemFound)) return systemFound;
    } catch {}

    return 'node';
  }

  _findPiBinary() {
    const nodeBin = this._resolveNodeBinary();

    // Tier 0: Check if workingDir points to pi source repository
    if (this.workingDir) {
      const sourceCli = path.join(this.workingDir, 'packages', 'coding-agent', 'dist', 'cli.js');
      if (fs.existsSync(sourceCli)) {
        this._piJsPath = sourceCli;
        return nodeBin;
      }
    }

    // Tier 1: isolated per-agent runtime prefix (~/.wwj/runtimes/pi/)
    const runtimeJs = path.join(getRuntimePrefix('pi'), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (fs.existsSync(runtimeJs)) {
      this._piJsPath = runtimeJs;
      return nodeBin;
    }

    // Tier 2: npm-global node_modules entrypoint
    const globalAppdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    if (globalAppdata) {
      const globalJs = path.join(globalAppdata, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
      if (fs.existsSync(globalJs)) {
        this._piJsPath = globalJs;
        return nodeBin;
      }
    }

    // Tier 3: PATH + npm-global lookup
    const viaWhere = whereBinary('pi');
    if (viaWhere) {
      if (viaWhere.endsWith('.cmd')) {
        const cmdJs = path.join(path.dirname(viaWhere), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
        if (fs.existsSync(cmdJs)) {
          this._piJsPath = cmdJs;
          return nodeBin;
        }
      }
      return viaWhere;
    }

    // Tier 4 (Windows only): fall back to WSL
    if (IS_WINDOWS) {
      const wslPath = this._resolveWslPi();
      if (wslPath) {
        this._piViaWsl = true;
        return wslPath;
      }
    }

    return null;
  }

  _resolveWslPi() {
    if (!IS_WINDOWS) return null;
    try {
      const out = execSync('wsl.exe -e bash -lc "command -v pi"', {
        encoding: 'utf-8', timeout: 8000, windowsHide: true,
      }).trim();
      const p = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (p && p.startsWith('/')) return p;
    } catch {}
    return null;
  }

  // ------------------------------------------------------------------
  // Session path mapping
  // ------------------------------------------------------------------

  /**
   * Map workspace + channel to a real Pi session file path.
   * Pi's --session accepts a file path or session ID.
   */
  _sessionPathFor(channelName) {
    // Sanitize channel name for filesystem use
    const safeName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this._sessionDir, `${safeName}.jsonl`);
  }

  // ------------------------------------------------------------------
  // Prompt assembly
  // ------------------------------------------------------------------

  async _getAgentsText() {
    try {
      const agents = await this.client.getAgents(this.workspaceId, this.token);
      if (!Array.isArray(agents) || agents.length === 0) return '';
      const lines = agents
        .map((a) => {
          const name = a.agentName || a.agent_name || a.name;
          if (!name) return null;
          const role = a.role || 'member';
          const status = a.status || 'unknown';
          return `- ${name} (${role}, ${status})`;
        })
        .filter(Boolean);
      return lines.length ? `## Available Workspace Agents\n${lines.join('\n')}` : '';
    } catch {
      return '';
    }
  }

  async _getRecentHistoryText(channelName) {
    try {
      const messages = await this.client.pollMessages({
        workspaceId: this.workspaceId,
        channelName,
        token: this.token,
        limit: MAX_HISTORY_ENTRIES,
      });
      if (!Array.isArray(messages) || messages.length === 0) return '';
      const lines = messages
        .filter((m) => m.messageType !== 'status')
        .map((m) => {
          const sender = m.senderName || m.senderType || 'unknown';
          const content = (m.content || '').trim();
          if (!content) return null;
          return `- ${sender}: ${content.slice(0, 400)}`;
        })
        .filter(Boolean);
      return lines.length ? `## Recent Workspace Messages\n${lines.join('\n')}` : '';
    } catch {
      return '';
    }
  }

  async _buildContextPrefix(channelName) {
    const parts = [
      buildOpenclawSystemPrompt({
        agentName: this.agentName,
        workspaceId: this.workspaceId,
        channelName,
        endpoint: this.endpoint,
        token: this.token,
        mode: this._mode,
        disabledModules: this.disabledModules,
      }),
      '\n## 52hzAgents-specific Rules',
      '- Your final text response is posted back to the workspace automatically.',
      '- If you need to ask the user something, ask in normal text. Do not try to open an interactive prompt.',
      '- Do not reveal secrets, tokens, raw auth headers, or internal command lines.',
      '- Keep status concise. Focus on useful output over theatre.',
    ];

    const [agentsText, historyText] = await Promise.all([
      this._getAgentsText(),
      this._getRecentHistoryText(channelName),
    ]);
    if (agentsText) parts.push('\n' + agentsText);
    if (historyText) parts.push('\n' + historyText);
    return parts.join('\n').trim();
  }

  // ------------------------------------------------------------------
  // Subprocess lifecycle
  // ------------------------------------------------------------------

  _buildPiCmd(prompt, channelName) {
    if (!this._piBin) {
      throw new Error('pi CLI not found. Install with: npm install -g @earendil-works/pi-coding-agent');
    }
    const sessionPath = this._sessionPathFor(channelName);
    const args = [];
    if (this._piJsPath) {
      args.push(this._piJsPath);
    }
    // Official CLI: --mode json for JSON Lines event streaming,
    // --session <path> for session file, --session-dir for isolation
    args.push(
      '--mode', 'json',
      '--session', sessionPath,
      '--session-dir', this._sessionDir,
    );
    if (this.piApprove) args.push('--approve');
    const activeModel = this._resolveModel(channelName) || this.piModel;
    if (activeModel) args.push('--model', activeModel);
    // -p consumes the very next token as the message, so it must come last.
    args.push('-p', prompt);
    return args;
  }

  _spawnProc(spawnBin, spawnArgs, opts) {
    return spawn(spawnBin, spawnArgs, opts);
  }

  async _runPi(prompt, channelName, userMessage = '') {
    const sessionPath = this._sessionPathFor(channelName);
    const args = this._buildPiCmd(prompt, channelName);
    this._log(`Running pi (channel=${channelName}, session=${sessionPath})`);

    const env = { ...getEnhancedEnv(), ...(this.agentEnv || process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
    const cwd = await this._resolveWorkingDir(channelName, userMessage);

    let spawnBin = this._piBin;
    let spawnArgs = args;
    if (this._piViaWsl) {
      spawnBin = 'wsl.exe';
      spawnArgs = ['-e', this._piBin, ...args];
    }

    const isDirectJs = Boolean(this._piJsPath);
    const proc = this._spawnProc(spawnBin, spawnArgs, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WINDOWS && !this._piViaWsl,
      windowsHide: true,
      shell: !isDirectJs && IS_WINDOWS && Boolean(spawnBin && (spawnBin.endsWith('.cmd') || spawnBin.endsWith('.bat'))),
    });
    this._channelProcesses[channelName] = proc;
    try { await this.sendStatus(channelName, 'Thinking…'); } catch {}

    // Real-time JSON Lines event streaming (not buffered stdout)
    const responseChunks = [];
    let finalAnswer = '';
    let streamedText = '';
    let currentThinking = '';
    let hasFlushedThinkingInCurrentTurn = false;
    let stderrBuf = '';
    let lineBuffer = '';
    let lastErrorMessage = '';
    let _pendingLines = Promise.resolve();
    /*
      How much real work this attempt got through before it died. The retry
      policy in `_handleMessage` needs it: an attempt that streamed six
      minutes of reasoning must not be thrown away and restarted, while one
      that died instantly with nothing to show can safely be re-run whole.
      Counted in characters of reasoning + reply actually emitted.
    */
    let producedChars = 0;
    const startedAt = Date.now();

    const flushThinking = async () => {
      const text = currentThinking.trim();
      currentThinking = '';
      // Skip empty or lone punctuation fragments (e.g. '.', '。', ',') which are not genuine reasoning
      if (text && !/^[.\s,，。！？!?\-_/\\:：;；]+$/.test(text)) {
        hasFlushedThinkingInCurrentTurn = true;
        producedChars += text.length;
        try { await this.sendThinking(channelName, text); } catch {}
      }
    };

    proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf-8'); });

    // Process JSON Lines events in real-time
    const processLine = async (line) => {
      line = line.trim();
      if (!line) return;

      let event;
      try { event = JSON.parse(line); } catch {
        // Not JSON -- treat as plain text output (fallback)
        if (line.trim()) responseChunks.push(line.trim());
        return;
      }

      const eventType = event.type || '';

      if (eventType === 'turn_start') {
        hasFlushedThinkingInCurrentTurn = false;
        currentThinking = '';
      }

      // 1. Thinking / Reasoning
      // Official Pi CLI emits message_update with assistantMessageEvent.type = 'thinking_delta' | 'thinking_end'
      if (eventType === 'thinking') {
        const text = event.text || event.content || event.delta || '';
        if (text) {
          currentThinking += text;
        }
      } else if (eventType === 'message_update' && event.assistantMessageEvent) {
        const ame = event.assistantMessageEvent;
        if (ame.type === 'thinking_delta' && ame.delta) {
          currentThinking += ame.delta;
        } else if (ame.type === 'thinking_end') {
          // Complete thought content arrives on thinking_end. Flush once here.
          currentThinking = (ame.content && ame.content.trim()) || currentThinking;
          await flushThinking();
        }
      }

      // 2. Assistant reply accumulation & real-time preview streaming
      // Official Pi CLI emits message_update with assistantMessageEvent.type = 'text_delta' | 'text_end'
      if (eventType === 'assistant' || eventType === 'text_delta') {
        const text = event.text || event.content || event.delta || '';
        if (text) {
          if (!hasFlushedThinkingInCurrentTurn && currentThinking.trim()) {
            await flushThinking();
          }
          streamedText += text;
          try { await this.sendThinking(channelName, text, { isReplyPreview: true }); } catch {}
        }
      } else if (eventType === 'message_update' && event.assistantMessageEvent) {
        const ame = event.assistantMessageEvent;
        if (ame.type === 'text_delta' && ame.delta) {
          if (!hasFlushedThinkingInCurrentTurn && currentThinking.trim()) {
            await flushThinking();
          }
          streamedText += ame.delta;
          try { await this.sendThinking(channelName, ame.delta, { isReplyPreview: true }); } catch {}
        } else if (ame.type === 'text_end') {
          if (ame.content) streamedText = ame.content;
        }
      }

      // 3. Tool use / tool execution activity
      // Only notify on start/use, not on streaming output updates (tool_execution_update)
      if (
        eventType === 'tool_use' ||
        eventType === 'tool_call' ||
        eventType === 'tool' ||
        eventType === 'tool_execution_start'
      ) {
        await flushThinking();
        hasFlushedThinkingInCurrentTurn = false;
        // Since a tool is executing, text streamed prior to this tool was
        // intermediate commentary, NOT the final answer. Clear streamedText
        // so it cannot masquerade as the resolved answer if an error follows.
        streamedText = '';
        const toolName = event.toolName || event.name || event.tool || event.tool_name || 'tool';
        const input = event.args || event.input || {};
        const detail = input.command || input.path || input.query || (typeof input === 'string' ? input : '');
        const label = detail ? `${toolName} > ${detail}` : toolName;
        try { await this.sendStatus(channelName, label); } catch {}
      }

      // 4. Final response extraction & error detection from message_end / turn_end
      if (eventType === 'message_end' || eventType === 'turn_end') {
        await flushThinking();
        hasFlushedThinkingInCurrentTurn = false;
        const msg = event.message;
        if (msg) {
          if (msg.stopReason === 'error' || msg.errorMessage) {
            lastErrorMessage = msg.errorMessage || `Model request stopped with reason: ${msg.stopReason}`;
            this._log(`Pi model error: ${lastErrorMessage}`);
          } else {
            // A successful message turn clears any stale transient error
            lastErrorMessage = '';
          }
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const textParts = msg.content
              .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim())
              .map((p) => p.text.trim());
            if (textParts.length > 0) {
              finalAnswer = textParts.join('\n\n');
            }
          }
        }
      }

      // 5. Result / completion / legacy message
      if (eventType === 'result' || eventType === 'response' || (eventType === 'message' && typeof event.text === 'string')) {
        const text = event.text || event.content || event.result || '';
        if (typeof text === 'string' && text.trim()) {
          responseChunks.push(text.trim());
        }
      }

      // 6. Error events & retry failures
      if (eventType === 'error') {
        const errMsg = event.message || event.error || event.text || '';
        if (errMsg) lastErrorMessage = typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg);
        this._log(`Pi error event: ${lastErrorMessage || 'Unknown error'}`);
      } else if (eventType === 'auto_retry_end' && event.success === false) {
        const errMsg = event.finalError || event.errorMessage || '';
        if (errMsg) lastErrorMessage = typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg);
        this._log(`Pi retry failed: ${lastErrorMessage}`);
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

    const exitCode = await new Promise((resolve) => {
      proc.on('exit', resolve);
      proc.on('error', () => resolve(-1));
    });

    // Process remaining buffer
    try { await _pendingLines; } catch {}
    if (lineBuffer.trim()) {
      try { await processLine(lineBuffer); } catch {}
    }
    await flushThinking();

    delete this._channelProcesses[channelName];

    const resolvedAnswer = (finalAnswer || streamedText || responseChunks.join('\n')).trim();
    producedChars += streamedText.length + resolvedAnswer.length;

    // Carry the attempt's shape on the error itself. `_handleMessage` decides
    // restart-vs-resume-vs-give-up from these two numbers, and it cannot
    // recover them once the subprocess is gone.
    const fail = (message) => {
      const err = new Error(message);
      err.piProducedChars = producedChars;
      err.piElapsedMs = Date.now() - startedAt;
      return err;
    };

    if (exitCode !== 0) {
      const detail = (stderrBuf || lastErrorMessage || resolvedAnswer).trim().slice(0, 600);
      throw fail(`pi exited with code ${exitCode}: ${detail}`);
    }

    if (lastErrorMessage) {
      throw fail(lastErrorMessage);
    }

    return resolvedAnswer;
  }

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

  /**
   * Read one of Pi's own config files. Strictly read-only --?this adapter never
   * writes them. Returns null when the file is absent or unparsable, which must
   * read as "unknown", never as an empty configuration.
   */
  /** Pi's config dir - PI_AGENT_DIR when set, else ~/.pi/agent. */
  _piConfigDir() {
    const env = this.agentEnv || process.env;
    return (env.PI_AGENT_DIR && env.PI_AGENT_DIR.trim()) || DEFAULT_PI_CONFIG_DIR;
  }

  _readPiConfig(name) {
    try {
      const file = path.join(this._piConfigDir(), name);
      if (!fs.existsSync(file)) return null;
      let raw = fs.readFileSync(file, 'utf-8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      return JSON.parse(raw);
    } catch {
      // A malformed config is Pi's problem to report, not ours to guess around.
      return null;
    }
  }

  /**
   * The model the user selected inside Pi, from `~/.pi/agent/settings.json`.
   * Returned as the canonical `<provider>/<modelId>` reference Pi's own
   * `findExactModelReferenceMatch` accepts (it takes either that or a bare id).
   */
  _modelFromPiSettings() {
    const settings = this._readPiConfig('settings.json');
    const model = settings && typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : '';
    if (!model) return '';
    if (model.includes('/')) return model;
    const provider = settings && typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : '';
    return provider ? `${provider}/${model}` : model;
  }

  /**
   * Every model this install can actually reach, from `~/.pi/agent/models.json`
   * --?the providers the user configured in Pi itself. There is no hardcoded
   * catalog: an install with no configured provider reports nothing, and the UI
   * must show that as "not configured" rather than offering a guess.
   */
  _listModels() {
    const config = this._readPiConfig('models.json');
    const out = [];
    const seen = new Set();

    const push = (id, provider, label) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, provider, label: label || id });
    };

    const providers = config && config.providers;
    if (providers && typeof providers === 'object') {
      for (const [providerName, provider] of Object.entries(providers)) {
        const models = Array.isArray(provider && provider.models) ? provider.models : [];
        for (const m of models) {
          const modelId = typeof m === 'string' ? m : (m && m.id);
          if (!modelId) continue;
          const label = (typeof m === 'object' && m && m.name) || modelId;
          push(`${providerName}/${modelId}`, providerName, label);
        }
      }
    }

    // A provider block only lists models it declares; the active default is the
    // one piece of evidence that a model exists even when no block declares it.
    const current = this._modelFromPiSettings();
    if (current) {
      const slash = current.indexOf('/');
      push(current, slash > 0 ? current.slice(0, slash) : 'pi', slash > 0 ? current.slice(slash + 1) : current);
    }

    return out;
  }

  /**
   * Model forwarded on `--model`, in priority order:
   *   1. a workspace override (per-message, per-channel, or global set_model)
   *   2. what Pi's own settings.json says the user selected
   *   3. this agent's env (legacy configuration path)
   * No fallback model: if all three are empty, `--model` is simply not passed
   * and Pi uses whatever it resolves itself.
   */
  _resolveModel(channel, msg) {
    const override = super._resolveModel(channel, msg);
    if (override) return override;
    return this._modelFromPiSettings() || this.piModel || undefined;
  }

  /**
   * Read-only runtime snapshot for the workspace UI. `source` says where the
   * current model came from so the UI can never present an inferred value as
   * configuration truth, and `available_models` is omitted entirely --?not
   * padded with the current model --?when Pi has no configured providers.
   */
  async fetchAndReportUsage() {
    try {
      const fromSettings = this._modelFromPiSettings();
      const current = this._resolveModel() || null;
      const source = !current ? 'unconfigured'
        : (current !== fromSettings && current !== this.piModel) ? 'workspace-override'
        : current === fromSettings ? 'pi-settings'
        : 'agent-env';
      const models = this._listModels();
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: current,
          available_models: models.length ? JSON.stringify(models) : null,
          raw_text: `pi model_source=${source} config=${this._piConfigDir()}`,
        },
        this.token
      );
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
    }
  }

  async _onControlAction(action, payload) {
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
        this.piModel = requested;
      }
      this._log(`Model override for channel=${channel || 'all'} set to '${requested}'`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    if (action === 'stop') {
      for (const [channel, proc] of Object.entries(this._channelProcesses)) {
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        try { await this.sendStatus(channel, 'Execution stopped by user'); } catch {}
      }
      return;
    }
    await super._onControlAction(action, payload);
  }

  _isTransientError(err) {
    if (!err || !err.message) return false;
    const msg = String(err.message).toLowerCase();
    return (
      msg.includes('upstream_error') ||
      msg.includes('atria_api_error') ||
      msg.includes('inference request failed') ||
      /\b(422|429|500|502|503|504)\b/.test(msg) ||
      msg.includes('rate limit') ||
      msg.includes('overloaded') ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('etimedout') ||
      msg.includes('econnreset')
    );
  }

  /*
    A 422 `upstream_error` / `atria_api_error` is transient in shape but, on a
    turn that has already been running for minutes, is almost always about the
    size of the request rather than a blip upstream. Re-sending the identical
    prompt then fails identically: the observed case burned all four attempts
    over four minutes and surfaced only the last error. Treated as fatal once
    the attempt has run long enough to rule out a blip — UNLESS there is
    partial work to resume from, in which case the continuation prompt is
    smaller than the original and stands a real chance.
  */
  _isDeterministicOverload(err) {
    if (!err || !err.message) return false;
    const msg = String(err.message).toLowerCase();
    return (
      msg.includes('upstream_error') ||
      msg.includes('atria_api_error') ||
      msg.includes('inference request failed') ||
      msg.includes('upstream_request_rejected') ||
      msg.includes('invalid_request_error') ||
      msg.includes('unprocessable entity') ||
      /\b(400|422)\b/.test(msg)
    );
  }

  /*
    Exponential backoff with jitter, and a floor.

    The old delay was `(attempt + 1) * retryDelayMs`, which with a configured
    `retryDelayMs: 0` is zero for every attempt — the whole retry budget then
    burns in about two milliseconds against an upstream that is plainly not
    ready yet (seen in daemon.log: three attempts inside 2ms). A retry with no
    wait is not a retry.
  */
  _retryDelayFor(attempt) {
    const base = Math.max(this.retryDelayMs || 0, PI_MIN_RETRY_DELAY_MS);
    const backoff = Math.min(base * Math.pow(2, attempt), PI_MAX_RETRY_DELAY_MS);
    return Math.round(backoff * (0.75 + Math.random() * 0.5));
  }

  /*
    restart | resume | fatal.

    `resume` is the case this whole policy exists for: the attempt streamed
    real reasoning before dying, so the session file holds genuine progress.
    Rolling that back and re-sending the original prompt is a restart, not a
    retry — it discards the work AND re-incurs the full request size that
    likely caused the failure. Keeping the session and sending a short
    continuation does neither.
  */
  _classifyFailure(err) {
    if (!this._isTransientError(err)) return 'fatal';

    /*
      THE 4xx FAMILY IS NEVER RETRYABLE HERE, AND RESUME MAKES IT WORSE.

      The first version of this got both halves wrong, and a real turn paid
      for it: four attempts over 268s against
      `{"code":"upstream_request_rejected","type":"invalid_request_error"}`.

      Wrong half one: the resume branch was tested BEFORE the fatal branch, so
      any 422 that had produced work resumed regardless of what the error
      said. `invalid_request_error` is the API stating the request is not
      acceptable — retrying an invalid request cannot succeed by construction,
      and elapsed time is irrelevant to that.

      Wrong half two, and the real mistake: resume was justified by "the
      continuation prompt is smaller than the original, which is what a
      size-driven 422 needs". That is false for a `--session` CLI. The session
      file holds the whole conversation and is re-sent every turn, so NOT
      rolling it back leaves the failed partial turn in there and then appends
      a continuation on top. Each resumed attempt sends a LARGER request than
      the one that just failed. If the request was already unacceptable, every
      resume is further over the line — which is why that turn's reasoning
      came back visibly duplicated and still died.

      So resume is now reserved for failures where the request was fine and
      the far end was not: 5xx, rate limits, dropped sockets.
    */
    if (this._isDeterministicOverload(err)) return 'fatal';

    const produced = err && err.piProducedChars ? err.piProducedChars : 0;
    if (produced >= PI_RESUME_MIN_CHARS) return 'resume';
    return 'restart';
  }

  /*
    One error line that accounts for the whole turn. A four-minute,
    four-attempt failure used to surface as `Pi error: 422: {...}` — true of
    the last attempt and silent about the other three, which is why it read
    as "it just hangs then dies".
  */
  _formatTurnFailure(err) {
    const parts = [`Pi error: ${err.message}`];
    const log = err.piAttemptLog || [];
    if (log.length > 1) {
      const secs = Math.round((err.piTurnMs || 0) / 1000);
      parts.push(`\n\nFailed after ${log.length} attempts over ${secs}s:`);
      for (const line of log) parts.push(`\n  ${line}`);
    }
    return parts.join('');
  }


  // ------------------------------------------------------------------
  // Message handler
  // ------------------------------------------------------------------

  async _handleMessage(msg) {
    const content = (msg.content || '').trim();
    if (!content) return;

    const msgChannel = msg.sessionId || this.channelName;
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing workspace message from ${sender} in ${msgChannel}`);

    await this._autoTitleChannel(msgChannel, content);
    await this.sendStatus(msgChannel, 'thinking...');

    try {
      const context = await this._buildContextPrefix(msgChannel);
      const prompt = context ? `${context}\n\n---\n\nUser message:\n${content}` : content;

      const sessionPath = this._sessionPathFor(msgChannel);
      const preExists = fs.existsSync(sessionPath);
      const preSize = preExists ? fs.statSync(sessionPath).size : 0;
      const rollbackSession = () => {
        try {
          if (!preExists) {
            if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
          } else if (fs.existsSync(sessionPath)) {
            fs.truncateSync(sessionPath, preSize);
          }
        } catch (rbErr) {
          this._log(`Session rollback error: ${rbErr.message}`);
        }
      };

      const maxRetries = this.maxRetries;
      const turnStartedAt = Date.now();
      /*
        Every attempt's outcome, so the final error can say what actually
        happened. Previously the three intermediate failures went only to
        daemon.log and `sendStatus` — and each status overwrites the last —
        so a four-attempt, four-minute failure reached the user as one red
        line with no hint that it had been retried at all.
      */
      const attemptLog = [];
      let responseText = '';
      // Set once an attempt dies with work worth keeping: the next attempt
      // then resumes pi's own session instead of replaying the prompt.
      let resumeFrom = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const attemptPrompt = resumeFrom
          ? `Your previous turn was cut off by an upstream model error after producing roughly ${resumeFrom.producedChars} characters of work. Your session still holds that work. Continue from where you stopped and deliver the final answer. Do not start over and do not repeat what you already worked through.`
          : prompt;
        try {
          responseText = await this._runPi(attemptPrompt, msgChannel, content);
          if (responseText) break;
          attemptLog.push(`#${attempt + 1} empty completion`);
        } catch (err) {
          const mode = attempt < maxRetries ? this._classifyFailure(err, attempt) : 'fatal';
          const secs = Math.round((err.piElapsedMs || 0) / 1000);
          attemptLog.push(`#${attempt + 1} after ${secs}s: ${err.message}`.slice(0, 300));

          if (mode === 'fatal') {
            err.piAttemptLog = attemptLog;
            err.piTurnMs = Date.now() - turnStartedAt;
            throw err;
          }

          if (mode === 'resume') {
            // Deliberately NOT rolling the session back — the partial turn in
            // it is the thing being resumed.
            resumeFrom = { producedChars: err.piProducedChars || 0 };
            this._log(`Attempt ${attempt + 1} died after ${secs}s with ${resumeFrom.producedChars} chars of work; resuming session rather than restarting.`);
          } else {
            resumeFrom = null;
            rollbackSession();
            this._log(`Attempt ${attempt + 1} failed fast (${secs}s, no output); restarting from a clean session.`);
          }

          const delayMs = this._retryDelayFor(attempt);
          this._log(`Transient model error on attempt ${attempt + 1}: ${err.message}. ${mode} in ${delayMs}ms...`);
          try {
            await this.sendStatus(
              msgChannel,
              `${mode === 'resume' ? 'Resuming' : 'Retrying'} after model error (${attempt + 1}/${maxRetries})…`,
            );
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      if (responseText) {
        await this.sendResponse(msgChannel, responseText);
      } else {
        await this.sendError(msgChannel, 'Pi produced no response — the model returned an empty completion. Please check model settings.');
      }
    } catch (e) {
      this._log(`Pi adapter error: ${e.message}`);
      await this.sendError(msgChannel, this._formatTurnFailure(e));
    }
  }
}

module.exports = PiAdapter;
