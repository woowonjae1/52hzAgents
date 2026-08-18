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
const { formatAttachmentsForPrompt, SESSION_DEFAULT_RE, generateSessionTitle } = require('./utils');
const { buildClaudeSystemPrompt } = require('./workspace-prompt');

const IS_WINDOWS = process.platform === 'win32';

// Standard Antigravity Gemini Model Catalog
const ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash (Medium)', shortName: 'Flash 3.5' },
  { id: 'gemini-3.5-pro', name: 'Gemini 3.5 Pro (Large)', shortName: 'Pro 3.5' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (Fast)', shortName: 'Flash-Lite 3.5' },
  { id: 'gemini-3.0-pro', name: 'Gemini 3.0 Pro', shortName: 'Pro 3.0' },
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
      let sessionCount = 0;
      let dayCount = 0;

      // Estimate usage from history.jsonl if available
      try {
        if (fs.existsSync(this._historyPath)) {
          const content = fs.readFileSync(this._historyPath, 'utf-8');
          const lines = content.trim().split('\n');
          const now = Date.now();
          const fiveHoursAgo = now - 5 * 3600 * 1000;
          const oneDayAgo = now - 24 * 3600 * 1000;

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const item = JSON.parse(line);
              const t = item.timestamp ? new Date(item.timestamp).getTime() : 0;
              if (t >= fiveHoursAgo) sessionCount++;
              if (t >= oneDayAgo) dayCount++;
            } catch {}
          }
        }
      } catch {}

      // Calculate approximate percentages (e.g. 5-hour rolling pool vs daily pool)
      const sessionPercent = Math.min(100, Math.round((sessionCount / 50) * 100));
      const weekPercent = Math.min(100, Math.round((dayCount / 200) * 100));

      const now = new Date();
      const nextResetHour = new Date(now);
      nextResetHour.setHours(now.getHours() + 1, 0, 0, 0);
      const resetTimeStr = `${String(nextResetHour.getHours()).padStart(2, '0')}:00`;

      const usagePayload = {
        session_used_percent: sessionPercent,
        session_resets_at: `${resetTimeStr} (5小时窗口)`,
        week_used_percent: weekPercent,
        week_resets_at: '每日 00:00',
        last_24h_summary: `${dayCount} 次请求已完成`,
        last_7d_summary: 'Gemini 3.5 标准速率配额',
        current_model: currentModel,
        available_models: ANTIGRAVITY_MODELS.map((m) => m.name).join(', '),
        raw_text: `Antigravity Engine (${currentModel}) · 状态正常`,
      };

      this._cachedUsage = usagePayload;
      this._cachedUsageTime = Date.now();

      await this.client.reportAgentUsage(this.workspaceId, this.agentName, usagePayload, this.token);
      this._log(`Reported Antigravity usage: model=${currentModel}, session=${sessionPercent}%`);
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
    const channel = msg.channel;
    const content = msg.content || '';
    const sender = msg.sender || 'user';

    this._log(`Received message in channel ${channel}: ${content.slice(0, 80)}...`);

    const agyBin = this._findAntigravityBinary();
    if (!agyBin) {
      await this.postMessage(
        channel,
        '⚠️ 未在当前系统中找到 Antigravity (`agy`) 可执行程序。请确认已正确安装 Google Antigravity 或配置 PATH 环境变量。'
      );
      return;
    }

    const workingDir = await this._resolveWorkingDir(channel);
    const conversationId = this._channelSessions[channel] || null;

    await this.sendStatus(channel, 'thinking', 'Antigravity 正在推理中...');
    await this.fetchAndReportUsage();

    return new Promise((resolve) => {
      const args = ['-p', content, '--dangerously-skip-permissions'];
      if (conversationId) {
        args.push('--conversation', conversationId);
      }
      if (workingDir) {
        args.push('--add-dir', workingDir);
      }

      this._log(`Spawning ${agyBin} ${args.join(' ')} (cwd: ${workingDir || process.cwd()})`);

      const proc = spawn(agyBin, args, {
        cwd: workingDir || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
        env: {
          ...(this.agentEnv || process.env),
        },
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
          await this.postMessage(channel, cleanOutput);
        } else if (code !== 0) {
          await this.postMessage(channel, `⚠️ Antigravity 执行结束（退出码: ${code}），未产生输出。`);
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
        this._log(`Antigravity spawn error: ${err.message}`);
        await this.postMessage(channel, `❌ 启动 Antigravity 失败: ${err.message}`);
        resolve();
      });
    });
  }
}

module.exports = AntigravityAdapter;
module.exports.ANTIGRAVITY_MODELS = ANTIGRAVITY_MODELS;
