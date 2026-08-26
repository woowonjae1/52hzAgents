/**
 * Google Antigravity (AGY) Adapter for OpenAgents workspace.
 *
 * Bridges the local Antigravity CLI (agy) / Google Antigravity Agent to 52hzAgents:
 * - Reads and syncs model configurations with ~/.gemini/antigravity-cli/settings.json
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

// Standard Antigravity Model Catalog (Exact matching from Antigravity CLI)
const ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', shortName: 'Gemini 3.7 Flash', agyName: 'Gemini 3.7 Flash (Medium)' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', shortName: 'Gemini 3.6 Flash', agyName: 'Gemini 3.6 Flash (Medium)' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', shortName: 'Gemini 3.5 Flash', agyName: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', shortName: 'Gemini 3.1 Pro', agyName: 'Gemini 3.1 Pro (High)' },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (Thinking)', shortName: 'Sonnet 4.6', agyName: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6 (Thinking)', shortName: 'Opus 4.6', agyName: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Medium)', shortName: 'GPT-OSS 120B', agyName: 'GPT-OSS 120B (Medium)' },
];

function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

const FILE_WRITING_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'write_to_file', 'replace_file_content',
  'multi_replace_file_content', 'sed_file', 'notebook_edit'
]);

function formatToolPreview(toolName, params) {
  if (!params || typeof params !== 'object') return '';
  if (toolName === 'invoke_subagent' || toolName === 'subagent') {
    const subagents = params.Subagents || params.subagents || [];
    if (Array.isArray(subagents) && subagents.length > 0) {
      const first = subagents[0];
      const role = first.Role || first.role || first.TypeName || 'Researcher';
      const prompt = first.Prompt || first.prompt || '';
      return `${role}: ${prompt.slice(0, 120)}`;
    }
    if (params.Role || params.role || params.TypeName) {
      const role = params.Role || params.role || params.TypeName;
      const prompt = params.Prompt || params.prompt || '';
      return `${role}: ${prompt.slice(0, 120)}`;
    }
  }
  if (params.CommandLine) return params.CommandLine;
  if (params.TargetFile) return params.TargetFile;
  if (params.AbsolutePath) return params.AbsolutePath;
  if (params.file_path) return params.file_path;
  if (params.DirectoryPath) return params.DirectoryPath;
  if (params.Query) return params.Query;
  if (params.Pattern) return params.Pattern;
  if (params.Url) return params.Url;
  if (params.prompt) return params.prompt;
  const str = JSON.stringify(params);
  return str.length > 150 ? str.slice(0, 150) + '…' : str;
}

class AntigravityAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();
    this._channelSessions = {};
    this._channelProcesses = {};
    this._stoppingChannels = new Set();

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

  _getModel() {
    const settings = this._getSettings();
    return settings.model || 'Gemini 3.7 Flash (High)';
  }

  getCurrentModel() {
    return this._getModel();
  }

  async _onControlAction(action, payload) {
    if (action === 'set_model') {
      const modelIdOrName = payload && payload.model;
      if (modelIdOrName) {
        const found = ANTIGRAVITY_MODELS.find(
          (m) =>
            m.id === modelIdOrName ||
            m.name.toLowerCase() === modelIdOrName.toLowerCase() ||
            m.shortName.toLowerCase() === modelIdOrName.toLowerCase() ||
            (m.agyName && m.agyName.toLowerCase() === modelIdOrName.toLowerCase())
        );
        const targetModelName = found ? (found.agyName || found.name) : modelIdOrName;

        const settings = this._getSettings();
        settings.model = targetModelName;
        this._saveSettings(settings);
        this.model = targetModelName;
        this._log(`Switched Antigravity model to: ${targetModelName}`);
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
    let channel = this.channelName || 'general';
    if (msg.sessionId && !msg.sessionId.startsWith('openagents:') && !msg.sessionId.startsWith('agent:')) {
      channel = msg.sessionId;
    }
    const content = stripSelfMention(msg.content || '', this.agentName);

    this._log(`Received message in channel ${channel}: ${content.slice(0, 80)}...`);

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
    await this.sendStatus(channel, 'Reasoning');

    return new Promise((resolve) => {
      // Check if message metadata carries explicit model selection from UI
      const explicitModel =
        msg.metadata?.agent_models?.antigravity ||
        msg.metadata?.selected_model ||
        msg.metadata?.model ||
        msg.model;
      if (explicitModel) {
        const found = ANTIGRAVITY_MODELS.find(
          (m) =>
            m.id === explicitModel ||
            m.name.toLowerCase() === explicitModel.toLowerCase() ||
            m.shortName.toLowerCase() === explicitModel.toLowerCase() ||
            (m.agyName && m.agyName.toLowerCase() === explicitModel.toLowerCase())
        );
        const targetModelName = found ? (found.agyName || found.name) : explicitModel;
        const settings = this._getSettings();
        settings.model = targetModelName;
        this._saveSettings(settings);
        this.model = targetModelName;
        this._log(`Applied explicit model from message metadata: ${targetModelName}`);
      }

      const currentModelName = this._getModel();
      const matched = ANTIGRAVITY_MODELS.find(
        (m) =>
          m.id === currentModelName ||
          m.name.toLowerCase() === currentModelName.toLowerCase() ||
          m.shortName.toLowerCase() === currentModelName.toLowerCase() ||
          (m.agyName && m.agyName.toLowerCase() === currentModelName.toLowerCase())
      );
      const agyModelFlag = matched ? (matched.agyName || matched.name) : currentModelName;

      const args = ['-p', content, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
      if (agyModelFlag) {
        args.push('--model', agyModelFlag);
      }
      if (conversationId) {
        args.push('--conversation', conversationId);
      }
      if (workingDir) {
        args.push('--add-dir', workingDir);
      }

      const spawnEnv = { ...(this.agentEnv || process.env) };
      this._log(`Spawning ${agyBin} ${args.join(' ')} (cwd: ${workingDir || process.cwd()})`);

      const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(agyBin);
      const spawnCmd = isBatch ? 'cmd.exe' : agyBin;
      const spawnArgs = isBatch ? ['/c', agyBin, ...args] : args;

      const proc = spawn(spawnCmd, spawnArgs, {
        cwd: workingDir || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnEnv,
      });

      this._channelProcesses[channel] = proc;

      let lineBuffer = '';
      let pendingLines = Promise.resolve();
      let finalResponse = '';
      let lastErrorText = '';
      const textDeltas = [];
      const reportedSteps = new Set();
      let rawStdout = '';
      let rawStderr = '';

      const processLine = async (line) => {
        line = line.trim();
        if (!line) return;
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }

        if (data.event === 'init') {
          const convId = data.conversation_id || (data.init && data.init.conversation_id);
          if (convId) {
            this._channelSessions[channel] = convId;
            this._saveSessions();
          }
        } else if (data.event === 'step_update') {
          const su = data.step_update || {};
          if (su.conversation_id) {
            this._channelSessions[channel] = su.conversation_id;
            this._saveSessions();
          }

          if (su.step_type === 'tool') {
            const toolName = su.tool_name || (su.tool_info && su.tool_info.name) || 'tool';
            const params = (su.tool_info && su.tool_info.parameters) || {};
            const preview = formatToolPreview(toolName, params);
            const stepKey = `${su.step_index}:${toolName}:${su.state}`;

            if (!reportedSteps.has(stepKey)) {
              reportedSteps.add(stepKey);
              if (preview) {
                try { await this.sendStatus(channel, `${toolName} › ${preview}`); } catch {}
              } else {
                try { await this.sendStatus(channel, `${toolName}`); } catch {}
              }
            }

            if (su.state === 'DONE' && FILE_WRITING_TOOLS.has(toolName)) {
              const written = params.TargetFile || params.AbsolutePath || params.file_path;
              if (written) {
                this.registerProducedFile(channel, written).catch(() => {});
              }
            }
          } else if (su.step_type === 'thought' || su.step_type === 'reasoning') {
            if (su.text_delta || su.content) {
              try { await this.sendThinking(channel, su.text_delta || su.content); } catch {}
            }
          } else if (su.step_type === 'agent_response') {
            const delta = su.text_delta || '';
            if (delta) {
              textDeltas.push(delta);

              // Detect if agent text announces launching subagents in real-time
              const fullTextSoFar = textDeltas.join('');
              if (!reportedSteps.has('text_subagent_detected') && (fullTextSoFar.includes('子代理') || fullTextSoFar.includes('子智能体') || fullTextSoFar.includes('subagent') || fullTextSoFar.includes('Subagent'))) {
                const listMatches = fullTextSoFar.match(/(?:^|\n)\s*(?:\d+\.|\*|-)\s*([^—\n:：]+)[—\-:：]\s*([^\n]+)/g);
                if (listMatches && listMatches.length > 0) {
                  const detectedAgents = [];
                  for (const line of listMatches) {
                    const m = line.match(/(?:\d+\.|\*|-)\s*([^—\n:：]+)[—\-:：]\s*([^\n]+)/);
                    if (m) {
                      const role = m[1].replace(/^[·•\s]+|[·•\s]+$/g, '').trim();
                      const prompt = m[2].trim();
                      if (role && prompt && role.length < 40) {
                        detectedAgents.push({
                          role,
                          prompt,
                          typeName: 'research',
                          workspace: 'inherit',
                          status: fullTextSoFar.includes('已完成') || fullTextSoFar.includes('报告已完成') ? 'completed' : 'running',
                        });
                      }
                    }
                  }
                  if (detectedAgents.length > 0) {
                    reportedSteps.add('text_subagent_detected');
                    try {
                      await this.sendStatus(channel, `invoke_subagent › ${JSON.stringify(detectedAgents)}`);
                    } catch {}
                  }
                }
              }
            }
          } else if (su.step_type === 'checkpoint') {
            try { await this.sendStatus(channel, 'Checkpoint reached'); } catch {}
          }
        } else if (data.event === 'result') {
          const res = data.result || {};
          if (res.conversation_id) {
            this._channelSessions[channel] = res.conversation_id;
            this._saveSessions();
          }
          if (res.response) {
            finalResponse = res.response;
          }
          if (res.error || res.status === 'ERROR') {
            lastErrorText = res.error || 'Execution encountered an error';
          }
        }
      };

      // `agy` gets no timeout of its own, and a single-agent turn has no
      // pipeline sweeper behind it either, so a hung child left the channel
      // sitting on "正在推理中..." forever with nothing to report and no way
      // out. Reap on *silence* rather than total duration: a long task keeps
      // emitting stream-json, so any real work resets this.
      const IDLE_KILL_MS = Number(process.env.ANTIGRAVITY_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
      let idleTimer = null;
      let idleKilled = false;
      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const armIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => {
          idleKilled = true;
          this._log(`[spawn] idle timeout after ${IDLE_KILL_MS}ms, killing pid=${proc.pid}`);
          // _stopProcess, not proc.kill(): on Windows the child is often
          // cmd.exe wrapping agy, and killing the wrapper leaves the real
          // process running. taskkill /F /T takes the whole tree.
          this._stopProcess(proc).catch(() => {});
        }, IDLE_KILL_MS);
      };
      armIdle();

      if (proc.stdout) {
        proc.stdout.on('data', (data) => {
          armIdle();
          const str = data.toString('utf-8');
          rawStdout += str;
          lineBuffer += str;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop();
          for (const line of lines) {
            pendingLines = pendingLines.then(() => processLine(line)).catch(() => {});
          }
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data) => {
          armIdle();
          rawStderr += data.toString('utf-8');
        });
      }

      proc.on('close', async (code) => {
        clearIdle();
        if (lineBuffer.trim()) {
          pendingLines = pendingLines.then(() => processLine(lineBuffer)).catch(() => {});
        }
        await pendingLines;

        this._log(`[spawn] event=close channel=${channel} pid=${proc.pid} code=${code} stdout=${rawStdout.length}B stderr=${rawStderr.length}B`);
        delete this._channelProcesses[channel];

        if (this._stoppingChannels.has(channel)) {
          this._stoppingChannels.delete(channel);
          resolve();
          return;
        }

        let outputText = finalResponse || (textDeltas.length ? textDeltas.join('') : '');

        // Never dump raw NDJSON stream lines to chat
        if (!outputText && rawStdout && !rawStdout.trim().startsWith('{"event":')) {
          outputText = rawStdout;
        }

        const cleanOutput = stripAnsi(outputText).trim();

        if (lastErrorText) {
          await this.sendError(channel, `⚠️ Antigravity 调用异常提示:\n${lastErrorText}`);
        } else if (cleanOutput) {
          await this.sendResponse(channel, cleanOutput);
        } else if (idleKilled) {
          const tail = stripAnsi(rawStderr).trim().split('\n').slice(-4).join('\n');
          const mins = Math.round(IDLE_KILL_MS / 60000);
          const detail = tail
            ? `\n最后的 stderr:\n${tail}`
            : '\n没有 stderr 输出 — agy 可能在等待登录或交互确认。';
          await this.sendError(
            channel,
            `⏱️ Antigravity ${mins} 分钟内没有任何输出，已终止。`
            + `\nstdout ${rawStdout.length}B / stderr ${rawStderr.length}B`
            + detail
          );
        } else if (code !== 0) {
          await this.sendResponse(channel, `Antigravity exited with code ${code} and produced no output.`);
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

        resolve();
      });

      proc.on('error', async (err) => {
        clearIdle();
        delete this._channelProcesses[channel];
        this._log(`[spawn] event=error channel=${channel} msg=${err.message}`);
        await this.sendError(channel, `❌ 启动 Antigravity 失败: ${err.message}`);
        resolve();
      });
    });
  }
}

module.exports = AntigravityAdapter;
module.exports.ANTIGRAVITY_MODELS = ANTIGRAVITY_MODELS;
