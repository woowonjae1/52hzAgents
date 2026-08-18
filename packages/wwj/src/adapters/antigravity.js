/**
 * Google Antigravity (AGY) Adapter for OpenAgents workspace.
 *
 * Bridges the local Antigravity CLI (agy) / Google Antigravity Agent to 52hzAgents:
 * - Reads and syncs model configurations with ~/.gemini/antigravity-cli/settings.json
 * - Provides live quota, usage tracking, and 5-hour/daily reset status
 * - Supports dynamic model switching across Gemini 3.5 Pro / Flash / Lite
 * - Runs commands non-interactively in the background with windowsHide
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { whereBinary } = require('../paths');
const { formatAttachmentsForPrompt, SESSION_DEFAULT_RE, generateSessionTitle, stripSelfMention } = require('./utils');
const { buildClaudeSystemPrompt } = require('./workspace-prompt');

const IS_WINDOWS = process.platform === 'win32';

// Standard Antigravity Model Catalog (Exact matching from Antigravity client)
const ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', shortName: 'Gemini 3.7 Flash' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', shortName: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', shortName: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', shortName: 'Gemini 3.1 Pro' },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (Thinking)', shortName: 'Sonnet 4.6' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6 (Thinking)', shortName: 'Opus 4.6' },
  { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Medium)', shortName: 'GPT-OSS 120B' },
];

function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

class AntigravityAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();
    this._channelSessions = {};
    this._channelProcesses = {};
    this._stoppingChannels = new Set();
    this._cachedUsage = null;
    this._cachedUsageTime = 0;

    this._settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    this._historyPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');
    this._sessionsFile = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}_antigravity.json`
    );

    this._loadSessions();
    this._agyBin = this._findAntigravityBinary();
    if (this._agyBin) {
      this._log(`Antigravity binary found: ${this._agyBin}`);
    } else {
      this._log('Warning: No agy / antigravity CLI binary detected in standard paths.');
    }
  }

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelSessions, data);
          this._log(`Loaded ${Object.keys(data).length} Antigravity session(s)`);
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

  _findAntigravityBinary() {
    const home = os.homedir();
    const candidates = IS_WINDOWS ? [
      path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
      path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'antigravity', 'antigravity.exe'),
      path.join(home, 'AppData', 'Local', 'antigravity', 'antigravity.exe'),
    ] : [
      path.join(home, '.local', 'bin', 'agy'),
      '/usr/local/bin/agy',
      '/opt/homebrew/bin/agy',
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    const viaWhere = whereBinary('agy') || whereBinary('antigravity');
    if (viaWhere) return viaWhere;

    return null;
  }

  _getSettings() {
    try {
      if (fs.existsSync(this._settingsPath)) {
        return JSON.parse(fs.readFileSync(this._settingsPath, 'utf-8'));
      }
    } catch {}
    return {};
  }

  _saveSettings(newSettings) {
    try {
      const dir = path.dirname(this._settingsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._settingsPath, JSON.stringify(newSettings, null, 2), 'utf-8');
      return true;
    } catch (e) {
      this._log(`Failed to save settings to ${this._settingsPath}: ${e.message}`);
      return false;
    }
  }

  getCurrentModel() {
    const settings = this._getSettings();
    return settings.model || 'Gemini 3.5 Flash (Medium)';
  }

  async fetchAndReportUsage(force = false) {
    if (!this.workspaceId || !this.client) return null;
    if (!force && this._cachedUsage && (Date.now() - (this._cachedUsageTime || 0) < 30_000)) {
      return this._cachedUsage;
    }

    try {
      const currentModel = this.getCurrentModel();
      const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
      let activeSessions5h = 0;
      let activeSessions24h = 0;
      let activeSessions7d = 0;
      let totalConversations = 0;

      try {
        if (fs.existsSync(conversationsDir)) {
          const files = fs.readdirSync(conversationsDir);
          const now = Date.now();
          const fiveHoursAgo = now - 5 * 3600 * 1000;
          const oneDayAgo = now - 24 * 3600 * 1000;
          const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

          for (const file of files) {
            if (file.endsWith('.pb') || file.endsWith('.db')) {
              totalConversations++;
              try {
                const stat = fs.statSync(path.join(conversationsDir, file));
                const mtime = stat.mtimeMs;
                if (mtime >= fiveHoursAgo) activeSessions5h++;
                if (mtime >= oneDayAgo) activeSessions24h++;
                if (mtime >= sevenDaysAgo) activeSessions7d++;
              } catch {}
            }
          }
        }
      } catch {}

      // Calculate activity levels for visual monitoring
      const sessionPercent = Math.min(100, activeSessions5h * 20);
      const weekPercent = Math.min(100, activeSessions7d * 10);

      const usagePayload = {
        is_estimated: true,
        session_used_percent: sessionPercent,
        session_resets_at: '滚动刷新 (本地会话活跃度)',
        week_used_percent: weekPercent,
        week_resets_at: '7天窗口',
        last_24h_summary: `近 24h 活跃 ${activeSessions24h} 个会话 (累计 ${totalConversations} 个项目会话)`,
        last_7d_summary: `近 7 天活跃 ${activeSessions7d} 个会话`,
        current_model: currentModel,
        available_models: ANTIGRAVITY_MODELS.map((m) => m.name).join(', '),
        raw_text: `Antigravity Engine (${currentModel}) · 状态正常 · 本地活跃会话: 24h内${activeSessions24h}个`,
        parse_status: 'ok',
      };

      this._cachedUsage = usagePayload;
      this._cachedUsageTime = Date.now();

      await this.client.reportAgentUsage(this.workspaceId, this.agentName, usagePayload, this.token);
      this._log(`Reported Antigravity usage: model=${currentModel}, 24h_active=${activeSessions24h}, total=${totalConversations}`);
      return usagePayload;
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
      return null;
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'set_model') {
      const modelIdOrName = payload && payload.model;
      if (modelIdOrName) {
        const found = ANTIGRAVITY_MODELS.find(
          (m) => m.id === modelIdOrName || m.name.toLowerCase() === modelIdOrName.toLowerCase() || m.shortName.toLowerCase() === modelIdOrName.toLowerCase()
        );
        const targetModelName = found ? found.name : modelIdOrName;

        const settings = this._getSettings();
        settings.model = targetModelName;
        this._saveSettings(settings);
        this.model = targetModelName;
        this._log(`Switched Antigravity model to: ${targetModelName}`);
        await this.fetchAndReportUsage(true);
      }
      return;
    }

    if (action === 'stop') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel && this._channelProcesses[channel]) {
        this._log(`Stopping Antigravity process for channel=${channel}`);
        this._stoppingChannels.add(channel);
        const proc = this._channelProcesses[channel];
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        delete this._channelQueues[channel];
      } else {
        await this._stopAllProcesses();
      }
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
      }
    } catch {}
  }

  async _stopAllProcesses() {
    const entries = Object.entries(this._channelProcesses);
    if (!entries.length) return;
    this._log(`Stopping ${entries.length} running process(es)...`);
    for (const [channel, proc] of entries) {
      await this._stopProcess(proc);
      delete this._channelProcesses[channel];
      delete this._channelQueues[channel];
      try {
        await this.sendStatus(channel, 'Execution stopped by user');
      } catch {}
    }
  }

  async _handleMessage(msg) {
    // Messages carry the channel in `sessionId`, not `channel` — reading
    // msg.channel yielded undefined, so every status/response was posted to a
    // non-existent channel and the UI spun forever. Mirror _dispatchMessage()
    // exactly so this key matches the one used for queueing and the `stop`
    // control action (_channelProcesses / _channelQueues are keyed by it).
    let channel = this.channelName || 'general';
    if (msg.sessionId && !msg.sessionId.startsWith('openagents:') && !msg.sessionId.startsWith('agent:')) {
      channel = msg.sessionId;
    }
    // The "@antigravity" a user types to address this agent in a shared channel
    // is addressing, not part of the question — keep it out of the prompt.
    const content = stripSelfMention(msg.content || '', this.agentName);
    const sender = msg.sender || 'user';

    this._log(`Received message in channel ${channel}: ${content.slice(0, 80)}...`);

    // A bare "@antigravity" with no question left after stripping is an
    // address with no request — don't spawn agy with an empty -p.
    if (!content) {
      this._log(`Ignoring empty message in channel ${channel} (mention only)`);
      return;
    }

    const agyBin = this._findAntigravityBinary();
    if (!agyBin) {
      await this.sendError(
        channel,
        '⚠️ 未在当前系统中找到 Antigravity (`agy`) 可执行程序。请确认已正确安装 Google Antigravity 或配置 PATH 环境变量。'
      );
      return;
    }

    const workingDir = await this._resolveWorkingDir(channel);
    const conversationId = this._channelSessions[channel] || null;
    this.fetchAndReportUsage().catch(() => {}); // 不阻塞消息处理：用量上报失败或超时都不应挡住 agy 启动
    await this.sendStatus(channel, 'thinking', 'Antigravity 正在推理中...');

    return new Promise((resolve) => {
      const args = ['-p', content, '--dangerously-skip-permissions'];
      if (conversationId) {
        args.push('--conversation', conversationId);
      }
      if (workingDir) {
        args.push('--add-dir', workingDir);
      }

      const spawnEnv = { ...(this.agentEnv || process.env) };
      this._log(`Spawning ${agyBin} ${args.join(' ')} (cwd: ${workingDir || process.cwd()})`);
      this._log(`[spawn] pre: bin_exists=${fs.existsSync(agyBin)} isBatch=${IS_WINDOWS && /\.(cmd|bat)$/i.test(agyBin)} hasPATH=${!!(spawnEnv.PATH || spawnEnv.Path)} hasCOMSPEC=${!!spawnEnv.ComSpec} envKeys=${Object.keys(spawnEnv).length} argv=${JSON.stringify(args)}`);

      // No `shell: true`: on Windows it hands the joined command line to
      // cmd.exe WITHOUT quoting, so any argument containing a space is split
      // into separate argv entries — `-p` then received only the first word of
      // the user's message and the rest became stray positional args. A binary
      // path containing spaces breaks outright the same way. Batch wrappers
      // still need a shell, so route only those through `cmd.exe /c`
      // (same approach as the claude adapter).
      const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(agyBin);
      const spawnCmd = isBatch ? 'cmd.exe' : agyBin;
      const spawnArgs = isBatch ? ['/c', agyBin, ...args] : args;

      const proc = spawn(spawnCmd, spawnArgs, {
        cwd: workingDir || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnEnv,
      });

      this._log(`[spawn] post: pid=${proc.pid == null ? 'NULL(spawn failed synchronously)' : proc.pid} killed=${proc.killed} channel=${channel}`);

      proc.on('spawn', () => {
        this._log(`[spawn] event=spawn channel=${channel} pid=${proc.pid} — child process actually started`);
      });

      proc.on('exit', (code, signal) => {
        this._log(`[spawn] event=exit channel=${channel} pid=${proc.pid} code=${code} signal=${signal}`);
      });

      this._channelProcesses[channel] = proc;

      let stdout = '';
      let stderr = '';

      if (proc.stdout) {
        proc.stdout.on('data', (data) => {
          stdout += data.toString('utf-8');
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data) => {
          stderr += data.toString('utf-8');
        });
      }

      proc.on('close', async (code) => {
        this._log(`[spawn] event=close channel=${channel} pid=${proc.pid} code=${code} stdout=${stdout.length}B stderr=${stderr.length}B stopping=${this._stoppingChannels.has(channel)}`);
        if (stderr.trim()) this._log(`[spawn] stderr head: ${stripAnsi(stderr).trim().slice(0, 500)}`);
        delete this._channelProcesses[channel];
        await this.sendStatus(channel, 'idle');

        if (this._stoppingChannels.has(channel)) {
          this._stoppingChannels.delete(channel);
          resolve();
          return;
        }

        const rawOutput = (stdout || stderr || '').trim();
        const cleanOutput = stripAnsi(rawOutput);

        if (cleanOutput) {
          await this.sendResponse(channel, cleanOutput);
        } else if (code !== 0) {
          await this.sendResponse(channel, `⚠️ Antigravity 执行结束（退出码: ${code}），未产生输出。`);
        }

        // Auto-title session if needed
        if (channel && SESSION_DEFAULT_RE.test(channel) && !this._titledSessions.has(channel)) {
          this._titledSessions.add(channel);
          const title = generateSessionTitle(content);
          if (title) {
            try {
              await this.client.updateSession(this.workspaceId, channel, { title }, this.token);
            } catch {}
          }
        }

        await this.fetchAndReportUsage(true);
        resolve();
      });

      proc.on('error', async (err) => {
        delete this._channelProcesses[channel];
        await this.sendStatus(channel, 'idle');
        this._log(`[spawn] event=error channel=${channel} code=${err.code || 'n/a'} errno=${err.errno != null ? err.errno : 'n/a'} syscall=${err.syscall || 'n/a'} path=${err.path || 'n/a'} msg=${err.message}`);
        await this.sendError(channel, `❌ 启动 Antigravity 失败: ${err.message}`);
        resolve();
      });
    });
  }
}

module.exports = AntigravityAdapter;
module.exports.ANTIGRAVITY_MODELS = ANTIGRAVITY_MODELS;
