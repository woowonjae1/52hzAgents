/**
 * Pi adapter for OpenAgents workspace.
 *
 * Bridges the Pi coding agent CLI (@earendil-works/pi-coding-agent) to an
 * OpenAgents workspace using `pi --mode json --session <path>` for real-time
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
const { whereBinary, getRuntimePrefix } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';
const MAX_HISTORY_ENTRIES = 12;

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

  _findPiBinary() {
    // Tier 0: Check if workingDir points to pi source repository
    if (this.workingDir) {
      const sourceCli = path.join(this.workingDir, 'packages', 'coding-agent', 'dist', 'cli.js');
      if (fs.existsSync(sourceCli)) {
        this._piJsPath = sourceCli;
        return process.execPath;
      }
    }

    // Tier 1: isolated per-agent runtime prefix (~/.wwj/runtimes/pi/)
    const runtimeJs = path.join(getRuntimePrefix('pi'), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (fs.existsSync(runtimeJs)) {
      this._piJsPath = runtimeJs;
      return process.execPath;
    }

    // Tier 2: npm-global node_modules entrypoint
    const globalAppdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    if (globalAppdata) {
      const globalJs = path.join(globalAppdata, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
      if (fs.existsSync(globalJs)) {
        this._piJsPath = globalJs;
        return process.execPath;
      }
    }

    // Tier 3: PATH + npm-global lookup
    const viaWhere = whereBinary('pi');
    if (viaWhere) {
      if (viaWhere.endsWith('.cmd')) {
        const cmdJs = path.join(path.dirname(viaWhere), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
        if (fs.existsSync(cmdJs)) {
          this._piJsPath = cmdJs;
          return process.execPath;
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
    if (this.piProvider) args.push('--provider', this.piProvider);
    if (this.piModel) args.push('--model', this.piModel);
    // -p consumes the very next token as the message, so it must come last.
    args.push('-p', prompt);
    return args;
  }

  async _runPi(prompt, channelName) {
    const sessionPath = this._sessionPathFor(channelName);
    const args = this._buildPiCmd(prompt, channelName);
    this._log(`Running pi (channel=${channelName}, session=${sessionPath})`);

    const env = { ...(this.agentEnv || process.env) };
    const cwd = await this._resolveWorkingDir(channelName);

    let spawnBin = this._piBin;
    let spawnArgs = args;
    if (this._piViaWsl) {
      spawnBin = 'wsl.exe';
      spawnArgs = ['-e', this._piBin, ...args];
    }

    const isDirectJs = Boolean(this._piJsPath);
    const proc = spawn(spawnBin, spawnArgs, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WINDOWS && !this._piViaWsl,
      windowsHide: true,
      shell: !isDirectJs && IS_WINDOWS && Boolean(spawnBin && (spawnBin.endsWith('.cmd') || spawnBin.endsWith('.bat'))),
    });
    this._channelProcesses[channelName] = proc;

    // Real-time JSON Lines event streaming (not buffered stdout)
    const responseChunks = [];
    let stderrBuf = '';
    let lineBuffer = '';
    let everPostedAnything = false;
    let _pendingLines = Promise.resolve();

    proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf-8'); });

    // Process JSON Lines events in real-time
    const processLine = async (line) => {
      line = line.trim();
      if (!line) return;

      let event;
      try { event = JSON.parse(line); } catch {
        // Not JSON — treat as plain text output (fallback)
        if (line.trim()) responseChunks.push(line.trim());
        return;
      }

      const eventType = event.type || '';

      /*
       * `thinking` and `assistant`/`text_delta` used to share one branch, so
       * they were indistinguishable downstream. They are not the same thing:
       * `thinking` is the model reasoning, the other two are its reply arriving
       * a piece at a time. Only the latter is flagged as a reply preview — with
       * them merged, tagging the branch would have mislabelled real reasoning as
       * the answer, and not tagging it would have left the answer duplicated.
       */
      if (eventType === 'thinking') {
        const text = event.text || event.content || event.delta || '';
        if (text.trim()) {
          everPostedAnything = true;
          try { await this.sendThinking(channelName, text.trim()); } catch {}
        }
      } else if (eventType === 'assistant' || eventType === 'text_delta') {
        const text = event.text || event.content || event.delta || '';
        if (text.trim()) {
          everPostedAnything = true;
          try { await this.sendThinking(channelName, text.trim(), { isReplyPreview: true }); } catch {}
        }
      }

      // Tool use / tool call activity
      if (eventType === 'tool_use' || eventType === 'tool_call' || eventType === 'tool') {
        const toolName = event.name || event.tool || event.tool_name || 'tool';
        const detail = event.input?.command || event.input?.path || event.input?.query || '';
        const label = detail ? `${toolName} > ${detail}` : toolName;
        everPostedAnything = true;
        try { await this.sendStatus(channelName, label); } catch {}
      }

      // Result / completion
      if (eventType === 'result' || eventType === 'response' || eventType === 'message') {
        const text = event.text || event.content || event.result || '';
        if (text.trim()) {
          responseChunks.push(text.trim());
        }
      }

      // Error events
      if (eventType === 'error') {
        const errMsg = event.message || event.error || event.text || 'Unknown error';
        this._log(`Pi error event: ${errMsg}`);
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

    delete this._channelProcesses[channelName];

    if (exitCode !== 0) {
      const detail = (stderrBuf || responseChunks.join('\n')).trim().slice(0, 600);
      throw new Error(`pi exited with code ${exitCode}: ${detail}`);
    }

    return responseChunks.join('\n').trim();
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

  async _onControlAction(action, _payload) {
    if (action === 'stop') {
      for (const [channel, proc] of Object.entries(this._channelProcesses)) {
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        try { await this.sendStatus(channel, 'Execution stopped by user'); } catch {}
      }
    }
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
      const responseText = await this._runPi(prompt, msgChannel);

      if (responseText) {
        await this.sendResponse(msgChannel, responseText);
      } else {
        await this.sendResponse(msgChannel, 'No response generated. Please try again.');
      }
    } catch (e) {
      this._log(`Pi adapter error: ${e.message}`);
      await this.sendError(msgChannel, `Error processing message: ${e.message}`);
    }
  }
}

module.exports = PiAdapter;
