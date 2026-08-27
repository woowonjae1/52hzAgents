/**
 * Hermes adapter for OpenAgents workspace.
 *
 * Bridges Nous Research's Hermes Agent CLI (https://github.com/NousResearch/hermes-agent)
 * to an OpenAgents workspace using `hermes chat -Q --query-file --source wwj`.
 *
 * Key design decisions per official Hermes documentation:
 * - Uses --query-file instead of -q to avoid shell interpretation of user input
 * - Uses --in <workspace> to fix working directory per invocation
 * - Uses --source wwj for business-specific session tagging
 * - Session IDs managed via adapter persistence (not stdout regex extraction)
 * - No --yolo by default (dangerous command approval must be explicit)
 * - v2 path: migrate to `hermes acp` ACP JSON-RPC for real-time events
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { buildOpenclawSystemPrompt } = require('./workspace-prompt');
const { whichBinary, whereBinary } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';
const HERMES_INSTALL_HINT = IS_WINDOWS
  ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex"'
  : 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';
const MAX_HISTORY_ENTRIES = 12;

class HermesAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {string} [opts.hermesProfile] - explicit Hermes profile, or 'auto'
   * @param {string} [opts.hermesSource]  - `--source` label (default: 'wwj')
   * @param {number} [opts.maxTurns]      - `--max-turns` value
   * @param {Set} [opts.disabledModules]
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();
    this.hermesProfile = this._resolveProfile(opts.hermesProfile, this.agentName);
    this.hermesSource = opts.hermesSource || 'wwj';
    this.maxTurns = Number.isInteger(opts.maxTurns) ? opts.maxTurns : 60;

    this._channelSessions = {};
    this._channelProcesses = {};
    this._sessionsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}_hermes.json`,
    );
    this._loadSessions();

    // Temp directory for --query-file prompts
    this._queryDir = path.join(os.homedir(), '.wwj', 'hermes-queries');
    try { fs.mkdirSync(this._queryDir, { recursive: true }); } catch {}

    this._hermesBin = this._findHermesBinary();
    if (this._hermesBin) {
      this._log(`Using Hermes binary: ${this._hermesBin} (profile=${this.hermesProfile})`);
    } else {
      this._log(`Warning: hermes CLI not found. Install: ${HERMES_INSTALL_HINT}`);
    }
  }

  // ------------------------------------------------------------------
  // Binary discovery (multi-tier, matching codex/claude pattern)
  // ------------------------------------------------------------------

  _findHermesBinary() {
    const home = os.homedir();
    this._hermesViaWsl = false;

    // Tier 1: PATH (enriched env)
    const viaWhere = whereBinary('hermes');
    if (viaWhere) return viaWhere;

    // Tier 2: Common install locations
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const candidates = IS_WINDOWS ? [
      path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.cmd'),
      path.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
      path.join(localAppData, 'hermes', 'bin', 'hermes.cmd'),
      path.join(home, '.hermes', 'bin', 'hermes.exe'),
      path.join(home, '.hermes', 'bin', 'hermes.cmd'),
      path.join(home, '.hermes', 'bin', 'hermes'),
      path.join(home, '.local', 'bin', 'hermes.exe'),
      path.join(home, '.local', 'bin', 'hermes.cmd'),
      path.join(home, '.local', 'bin', 'hermes'),
    ] : [
      path.join(home, '.hermes', 'bin', 'hermes'),
      path.join(home, '.local', 'bin', 'hermes'),
      '/opt/homebrew/bin/hermes',
      '/usr/local/bin/hermes',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // Tier 3: Deep scan
    const viaWhich = whichBinary('hermes');
    if (viaWhich) return viaWhich;

    // Tier 4 (Windows only): WSL fallback
    if (IS_WINDOWS) {
      const wslPath = this._resolveWslHermes();
      if (wslPath) {
        this._hermesViaWsl = true;
        return wslPath;
      }
    }

    return null;
  }

  _resolveWslHermes() {
    if (!IS_WINDOWS) return null;
    try {
      const out = execSync('wsl.exe -e bash -lc "command -v hermes"', {
        encoding: 'utf-8', timeout: 8000, windowsHide: true,
      }).trim();
      const p = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (p && p.startsWith('/')) return p;
    } catch {}
    return null;
  }

  _resolveProfile(explicit, agentName) {
    if (explicit && explicit !== '' && explicit !== 'auto') return explicit;
    try {
      const profileDir = path.join(os.homedir(), '.hermes', 'profiles', agentName);
      if (fs.existsSync(profileDir)) return agentName;
    } catch {}
    return 'default';
  }

  // ------------------------------------------------------------------
  // Session persistence (per-channel Hermes session IDs)
  // ------------------------------------------------------------------

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelSessions, data);
          this._log(`Loaded ${Object.keys(data).length} Hermes session(s)`);
        }
      }
    } catch {
      this._log('Could not load Hermes sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this._sessionsFile), { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelSessions));
    } catch {}
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
  // Query file management (--query-file for safe prompt passing)
  // ------------------------------------------------------------------

  _writeQueryFile(channelName, prompt) {
    const safeName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const queryFile = path.join(this._queryDir, `${safeName}_${Date.now()}.txt`);
    fs.writeFileSync(queryFile, prompt, 'utf-8');
    return queryFile;
  }

  _cleanupQueryFile(filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  // ------------------------------------------------------------------
  // Subprocess lifecycle
  // ------------------------------------------------------------------

  _buildHermesCmd(queryFilePath, resumeSessionId, workingDir) {
    if (!this._hermesBin) {
      throw new Error(`hermes CLI not found. Install with: ${HERMES_INSTALL_HINT}`);
    }
    const args = [];
    if (this.hermesProfile && this.hermesProfile !== 'default') {
      args.push('-p', this.hermesProfile);
    }
    args.push(
      'chat',
      '-Q',
      '--source', this.hermesSource,
      '--max-turns', String(this.maxTurns),
      '--query-file', queryFilePath,
    );
    // --in fixes the working directory for this invocation
    if (workingDir) {
      args.push('--in', workingDir);
    }
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    // No --yolo: dangerous command approval must be explicit
    return args;
  }

  async _runHermes(prompt, channelName) {
    const resumeId = this._channelSessions[channelName];
    const cwd = await this._resolveWorkingDir(channelName);

    // Write prompt to a temp file (--query-file avoids shell interpretation)
    const queryFile = this._writeQueryFile(channelName, prompt);

    const args = this._buildHermesCmd(queryFile, resumeId, cwd);
    this._log(`Running hermes (profile=${this.hermesProfile}, channel=${channelName}, resume=${!!resumeId})`);

    const env = { ...(this.agentEnv || process.env) };

    let spawnBin = this._hermesBin;
    let spawnArgs = args;
    if (this._hermesViaWsl) {
      spawnBin = 'wsl.exe';
      spawnArgs = ['-e', this._hermesBin, ...args];
    }

    const proc = spawn(spawnBin, spawnArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WINDOWS && !this._hermesViaWsl,
      windowsHide: true,
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
    this._cleanupQueryFile(queryFile);

    if (exitCode !== 0) {
      if (resumeId) {
        // Resume may have failed because the session was deleted
        this._log(`Hermes resume failed (code=${exitCode}), retrying without resume`);
        delete this._channelSessions[channelName];
        this._saveSessions();
        return this._runHermes(prompt, channelName);
      }
      const detail = (stderr || stdout).trim().slice(0, 600);
      throw new Error(`hermes exited with code ${exitCode}: ${detail}`);
    }

    // Parse stdout: clean up resume banners and extract text
    const text = this._parseHermesOutput(stdout);

    // Try to discover the session ID from hermes sessions list
    this._discoverSessionId(channelName);

    return text;
  }

  /**
   * Parse Hermes stdout output, removing noise lines.
   * Session ID is NOT extracted from stdout (use _discoverSessionId instead).
   */
  _parseHermesOutput(raw) {
    const lines = [];
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped) continue;
      // Skip resume banners and session ID lines
      if (stripped.startsWith('\u21bb Resumed session ')) continue;
      if (/^session_id:\s/i.test(stripped)) continue;
      lines.push(line);
    }
    return lines.join('\n').trim();
  }

  /**
   * Discover the Hermes session ID via `hermes sessions list --source wwj`.
   * Falls back to parsing stdout session_id if CLI query fails.
   * Runs asynchronously and saves the result for future --resume.
   */
  _discoverSessionId(channelName) {
    // Best-effort async discovery; don't block on it
    try {
      const result = execSync(
        `"${this._hermesBin}" sessions list --source ${this.hermesSource} --limit 1`,
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      ).trim();
      // Parse the most recent session ID from output
      // Hermes typically outputs session IDs in a list format
      const idMatch = result.match(/([0-9]{8}_[0-9]{6}_[a-f0-9]+|[a-f0-9-]{36})/);
      if (idMatch) {
        this._channelSessions[channelName] = idMatch[1];
        this._saveSessions();
        this._log(`Discovered Hermes session: ${idMatch[1]}`);
      }
    } catch {
      // Fall back: if hermes printed a session_id line in stdout, we already
      // stripped it in _parseHermesOutput. For now, just log.
      this._log('Could not discover Hermes session ID via CLI');
    }
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

  _listProfiles() {
    try {
      const profilesDir = path.join(os.homedir(), '.hermes', 'profiles');
      if (fs.existsSync(profilesDir)) {
        const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
        const profiles = entries
          .filter((d) => d.isDirectory())
          .map((d) => ({ id: d.name, provider: 'Hermes Profile', label: d.name }));
        if (profiles.length) return profiles;
      }
    } catch {}
    return [];
  }

  async fetchAndReportUsage() {
    try {
      const profiles = this._listProfiles();
      // `hermesProfile` is 'default' when nothing was configured - that is this
      // adapter's sentinel for "no -p flag", not a profile that exists on disk.
      // Reporting it as the current selection dressed a missing configuration up
      // as a real one, so it is surfaced only when ~/.hermes/profiles actually
      // has something in it (or the user named a profile explicitly).
      const isRealProfile = !!this.hermesProfile
        && (this.hermesProfile !== 'default' || profiles.some((p) => p.id === 'default'));
      const current = isRealProfile ? this.hermesProfile : null;
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: current,
          available_models: profiles.length > 0 ? JSON.stringify(profiles) : null,
          raw_text: `hermes profile=${current || 'unconfigured'} profiles_dir=${path.join(os.homedir(), '.hermes', 'profiles')}`,
        },
        this.token
      );
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'set_model' || action === 'set_profile') {
      const requested = payload && (payload.model || payload.profile);
      if (requested) {
        this.hermesProfile = requested;
        this._log(`Hermes profile set to: ${requested}`);
        this.fetchAndReportUsage().catch(() => {});
        return;
      }
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
      const responseText = await this._runHermes(prompt, msgChannel);

      if (responseText) {
        await this.sendResponse(msgChannel, responseText);
      } else {
        await this.sendResponse(msgChannel, 'No response generated. Please try again.');
      }
    } catch (e) {
      this._log(`Hermes adapter error: ${e.message}`);
      await this.sendError(msgChannel, `Error processing message: ${e.message}`);
    }
  }
}

module.exports = HermesAdapter;
