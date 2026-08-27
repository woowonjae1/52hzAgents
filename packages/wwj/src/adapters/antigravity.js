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
const { captureCli, parseHelpChoices, parseTabbedList, toOptions } = require('./model-introspection');
const { whereBinary } = require('../paths');
const { formatAttachmentsForPrompt, SESSION_DEFAULT_RE, generateSessionTitle, stripSelfMention } = require('./utils');
const { buildClaudeSystemPrompt } = require('./workspace-prompt');

const IS_WINDOWS = process.platform === 'win32';

// Standard Antigravity Model Catalog (Exact matching from Antigravity CLI)
// Antigravity's own settings file. `model` holds the exact name the user
// selected in the CLI (e.g. "Gemini 3.5 Flash (Medium)"). There is no local
// catalog file listing the selectable models, so this adapter reports the one
// model it can actually read and nothing else - the UI offers free-text entry
// for anything the CLI accepts. Read-only; never written here.
// `agy models` and `agy --help` run off the 30s heartbeat, so both are cached:
// long enough that a tick costs nothing, short enough that a newly granted
// model shows up without a restart.
const INTROSPECT_CACHE_TTL_MS = 5 * 60 * 1000;

const ANTIGRAVITY_SETTINGS_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');

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
    this._channelModels = {};
    this._channelEfforts = {};
    this._modelsCache = null;
    this._modelsInFlight = null;
    this._effortCache = null;
    this._effortInFlight = null;
    this._stoppingChannels = new Set();

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
      this._log('Could not load Antigravity sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this._sessionsFile), { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelSessions));
    } catch {}
  }

  _findAntigravityBinary() {
    const viaWhich = whereBinary('agy') || whereBinary('antigravity');
    if (viaWhich) return viaWhich;

    const candidates = IS_WINDOWS ? [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'bin', 'agy.exe'),
      path.join(process.env.ProgramFiles || '', 'Antigravity', 'bin', 'agy.cmd'),
      path.join(process.env.ProgramFiles || '', 'Antigravity', 'bin', 'agy.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'agy.cmd'),
      path.join(process.env.USERPROFILE || '', '.local', 'bin', 'agy.cmd'),
      path.join(process.env.USERPROFILE || '', '.local', 'bin', 'agy.exe'),
    ] : [
      '/usr/local/bin/agy',
      '/opt/homebrew/bin/agy',
      path.join(os.homedir(), '.local', 'bin', 'agy'),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  _resolveModel(channel, msg) {
    if (msg) {
      let explicit = null;
      if (msg.metadata?.agent_models && typeof msg.metadata.agent_models === 'object') {
        const models = msg.metadata.agent_models;
        const nameLower = (this.agentName || '').toLowerCase();
        const typeLower = (this.agentType || '').toLowerCase();
        explicit =
          models[this.agentName] ||
          models[nameLower] ||
          (this.agentType && models[this.agentType]) ||
          (typeLower && models[typeLower]) ||
          models.antigravity ||
          models.agy;
        if (!explicit) {
          for (const k of Object.keys(models)) {
            const kLower = k.toLowerCase();
            if (kLower === nameLower || (typeLower && kLower === typeLower) || kLower === 'antigravity' || kLower === 'agy') {
              explicit = models[k];
              break;
            }
          }
        }
      }
      explicit =
        explicit ||
        msg.metadata?.selected_model ||
        msg.metadata?.model ||
        msg.model;
      if (explicit) return explicit;
    }
    if (channel && this._channelModels && this._channelModels[channel]) {
      return this._channelModels[channel];
    }
    if (this._channelModels && this._channelModels['*']) {
      return this._channelModels['*'];
    }
    // No fallback model: what the CLI is set to is what settings.json says, and
    // if that is empty the run uses Antigravity's own default rather than a
    // name this adapter made up.
    return this.model
      || this._modelFromAntigravitySettings()
      || (this.agentEnv.ANTIGRAVITY_MODEL || '').trim()
      || undefined;
  }

  /**
   * The model the user selected inside Antigravity, read out of the CLI's own
   * settings.json. Strictly read-only.
   */
  _modelFromAntigravitySettings() {
    try {
      if (!fs.existsSync(ANTIGRAVITY_SETTINGS_FILE)) return '';
      const cfg = JSON.parse(fs.readFileSync(ANTIGRAVITY_SETTINGS_FILE, 'utf-8'));
      return cfg && typeof cfg.model === 'string' ? cfg.model.trim() : '';
    } catch {
      return '';
    }
  }

  _getModel(channel) {
    return this._resolveModel(channel);
  }

  getCurrentModel(channel) {
    return this._resolveModel(channel);
  }

  /**
   * Every model this install can actually reach, from `agy models` - the CLI's
   * own answer. There is deliberately no catalog in this repo: the ids
   * Antigravity accepts (`gemini-3.7-flash-medium`) are not the display names
   * it shows (`Gemini 3.7 Flash (Medium)`), and the table that used to live
   * here shipped the display names as ids.
   */
  async _listModels() {
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCache.at < INTROSPECT_CACHE_TTL_MS) {
      return this._modelsCache.models;
    }
    if (this._modelsInFlight) return this._modelsInFlight;

    const bin = this._agyBin || this._findAntigravityBinary();
    if (!bin) return [];

    this._modelsInFlight = captureCli(bin, ['models'], { env: this.agentEnv || process.env })
      .then((out) => {
        const models = toOptions(parseTabbedList(out), 'antigravity');
        // Only cache a non-empty answer: a failed probe must stay retryable and
        // must never harden into "this account has no models".
        if (models.length) this._modelsCache = { at: Date.now(), models };
        return models;
      })
      .catch(() => [])
      .finally(() => { this._modelsInFlight = null; });
    return this._modelsInFlight;
  }

  /** Effort levels this build accepts, from `agy --help`. Costs no API call. */
  async _listEffortLevels() {
    const now = Date.now();
    if (this._effortCache && now - this._effortCache.at < INTROSPECT_CACHE_TTL_MS) {
      return this._effortCache.levels;
    }
    if (this._effortInFlight) return this._effortInFlight;

    const bin = this._agyBin || this._findAntigravityBinary();
    if (!bin) return [];

    this._effortInFlight = captureCli(bin, ['--help'], { env: this.agentEnv || process.env, timeoutMs: 20000, includeStderr: true })
      .then((help) => {
        const levels = parseHelpChoices(help, '--effort').map((id) => ({ id, label: id }));
        if (levels.length) this._effortCache = { at: Date.now(), levels };
        return levels;
      })
      .catch(() => [])
      .finally(() => { this._effortInFlight = null; });
    return this._effortInFlight;
  }

  /** Effort in force for a channel: a workspace override, else unset. */
  _currentEffort(channel) {
    if (channel && this._channelEfforts[channel]) return this._channelEfforts[channel];
    return this._channelEfforts['*'] || '';
  }

  async fetchAndReportUsage() {
    try {
      const fromSettings = this._modelFromAntigravitySettings();
      const current = this.getCurrentModel() || null;
      const source = !current ? 'unconfigured'
        : current === fromSettings ? 'antigravity-settings'
        : 'workspace-override';
      // Only the model Antigravity itself reports. No catalog is shipped here:
      // an empty list must read as "not configured", never as a guess.
      const models = await this._listModels();
      const efforts = await this._listEffortLevels();
      const effort = this._currentEffort() || null;
      // settings.json stores the display name ("Gemini 3.5 Flash (Medium)")
      // while `agy models` keys on the id ("gemini-3.5-flash-medium"). Report
      // the id so the UI can match the running model against the list instead
      // of showing a selection that appears to be in neither.
      const canonical = current
        ? (models.find((m) => m.id.toLowerCase() === current.toLowerCase())
          || models.find((m) => m.label.toLowerCase() === current.toLowerCase()))
        : null;
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: canonical ? canonical.id : current,
          available_models: models.length ? JSON.stringify(models) : null,
          current_effort: effort,
          available_efforts: efforts.length ? JSON.stringify(efforts) : null,
          raw_text: `antigravity model_source=${source}`,
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
      // Validated against what this build says it accepts, so a stale UI cannot
      // push a level that makes every subsequent run fail to launch.
      const levels = await this._listEffortLevels();
      if (levels.length && !levels.some((l) => l.id.toLowerCase() === String(requested).toLowerCase())) {
        this._log(`set_effort: '${requested}' is not one of ${levels.map((l) => l.id).join(', ')} - ignoring`);
        return;
      }
      if (channel) this._channelEfforts[channel] = requested;
      else this._channelEfforts['*'] = requested;
      this._log(`Effort override for channel=${channel || 'all'} set to '${requested}'`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    if (action === 'set_model') {
      const requested = payload && payload.model;
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (!requested) return;

      // Matched against what `agy models` itself reports, so a display name
      // ("Gemini 3.5 Flash (Medium)") resolves to the id the CLI accepts
      // ("gemini-3.5-flash-medium"). An unknown value passes through untouched
      // rather than being rewritten against a table in this repo.
      const known = await this._listModels();
      const lower = String(requested).toLowerCase();
      const match = known.find((m) => m.id.toLowerCase() === lower)
        || known.find((m) => m.label.toLowerCase() === lower);
      const targetModelName = match ? match.id : requested;

      if (channel) {
        this._channelModels[channel] = targetModelName;
      } else {
        for (const c of Object.keys(this._channelModels)) this._channelModels[c] = targetModelName;
        this._channelModels['*'] = targetModelName;
        this.model = targetModelName;
      }
      this._log(`Model override for channel=${channel || 'all'} set to '${targetModelName}' (this session only)`);
      this.fetchAndReportUsage().catch(() => {});
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
      const agyModelFlag = this._resolveModel(channel, msg);

      const args = ['-p', content, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
      const agyEffort = this._currentEffort(channel);
      if (agyEffort) {
        args.push('--effort', agyEffort);
      }
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
