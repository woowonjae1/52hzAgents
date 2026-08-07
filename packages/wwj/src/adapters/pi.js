/**
 * Pi adapter for OpenAgents workspace.
 *
 * Bridges the Pi coding agent CLI (D:\code\pi\pi_woowonjae, package
 * @earendil-works/pi-coding-agent, binary `pi`) to an OpenAgents workspace by
 * spawning `pi --session-id <key> -p <prompt>` per incoming message and
 * posting the response back to the workspace channel.
 *
 * Pi's own `--session-id <id>` flag creates-the-session-if-missing and
 * resumes it otherwise, so — unlike Hermes/Codex — this adapter does not
 * need to persist a separate session-id file: the id is derived
 * deterministically from workspaceId+channel and handed to Pi every call.
 *
 * Mirrors the Python adapter at sdk/src/openagents/adapters/pi.py.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { buildOpenclawSystemPrompt } = require('./workspace-prompt');
const { whereBinary, getRuntimePrefix, defaultAgentWorkdir } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';
const MAX_HISTORY_ENTRIES = 12;

class PiAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {string} [opts.piModel]    - `--model` value (provider/id pattern)
   * @param {string} [opts.piProvider] - `--provider` value
   * @param {Set} [opts.disabledModules]
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();

    const env = this.agentEnv || process.env;
    this.piModel = opts.piModel || env.PI_MODEL || '';
    this.piProvider = opts.piProvider || env.PI_PROVIDER || '';

    this._channelProcesses = {};

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
  // Session key (deterministic — Pi creates/resumes by --session-id itself)
  // ------------------------------------------------------------------

  _sessionKeyFor(channelName) {
    return `openagents-${this.workspaceId.slice(0, 8)}-${channelName.slice(-8)}`;
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
      '\n## OpenAgents-specific Rules',
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

  _buildPiCmd(prompt, sessionKey) {
    if (!this._piBin) {
      throw new Error('pi CLI not found. Install with: npm install -g @earendil-works/pi-coding-agent');
    }
    const args = [];
    if (this._piJsPath) {
      args.push(this._piJsPath);
    }
    args.push('--session-id', sessionKey, '--no-context-files');
    if (this.piProvider) args.push('--provider', this.piProvider);
    if (this.piModel) args.push('--model', this.piModel);
    // -p consumes the very next token as the message, so it must come last.
    args.push('-p', prompt);
    return args;
  }

  async _runPi(prompt, channelName) {
    const sessionKey = this._sessionKeyFor(channelName);
    const args = this._buildPiCmd(prompt, sessionKey);
    this._log(`Running pi (channel=${channelName}, session=${sessionKey})`);

    const env = { ...(this.agentEnv || process.env) };
    const cwd = this.workingDir || defaultAgentWorkdir(this.agentName);

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

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });

    const exitCode = await new Promise((resolve) => {
      proc.on('exit', resolve);
      proc.on('error', () => resolve(-1));
    });
    delete this._channelProcesses[channelName];

    if (exitCode !== 0) {
      const detail = (stderr || stdout).trim().slice(0, 600);
      throw new Error(`pi exited with code ${exitCode}: ${detail}`);
    }

    return stdout.trim();
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
