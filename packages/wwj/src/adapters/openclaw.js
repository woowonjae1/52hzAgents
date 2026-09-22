/**
 * OpenClaw adapter for 52hzAgents workspace.
 *
 * Bridges OpenClaw to an 52hzAgents workspace via:
 * - CLI mode: `openclaw agent --local --json` (preferred)
 * - Workspace context injected via SKILL.md auto-discovery
 *
 * Direct port of Python: sdk/src/52hzAgents/adapters/openclaw.py
 * (CLI mode only —gateway WS and direct HTTP modes are not yet ported)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const BaseAdapter = require('./base');
const { formatAttachmentsForPrompt } = require('./utils');
const { buildOpenclawSkillMd, buildOpenclawSystemPrompt } = require('./workspace-prompt');
const { getRuntimePrefix } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';
const OPENCLAW_STATE_DIR = path.join(
  IS_WINDOWS ? (process.env.USERPROFILE || '') : (process.env.HOME || ''),
  '.openclaw'
);

class OpenClawAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {string} [opts.openclawAgentId='main']
   * @param {Set} [opts.disabledModules]
   */
  constructor(opts) {
    super(opts);
    this.openclawAgentId = opts.openclawAgentId || 'main';
    this.disabledModules = opts.disabledModules || new Set();
    this._channelProcesses = {};
    this._stoppingChannels = new Set();
    this._gatewayWs = null;
    this._gatewayRequests = new Map();
    this._gatewayConnected = false;
    this._gatewaySessionChannels = new Map();
    this._pendingApprovals = new Map();

    // Find the openclaw binary —always use CLI/gateway mode for full tool support
    this._openclawBinary = this._findOpenclawBinary();

    if (this._openclawBinary) {
      this._log(`Using OpenClaw CLI mode (${this._openclawBinary})`);
    } else {
      this._log('OpenClaw binary not found —agent will not be able to process messages');
    }

    // Install workspace skill
    this._installWorkspaceSkill();
    this._ensureExecApprovalsConfigured();
  }

  // ------------------------------------------------------------------
  // Binary resolution
  // ------------------------------------------------------------------

  _findOpenclawBinary() {
    const home = process.env.USERPROFILE || process.env.HOME || '';

    // Tier 0: Isolated runtime prefix (~/.wwj/runtimes/openclaw/)
    const runtimeMjs = path.join(getRuntimePrefix('openclaw'), 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(runtimeMjs)) return runtimeMjs;

    // Tier 0b: Legacy shared prefix
    const portableDir = path.join(home, '.wwj', 'nodejs');
    const mjs = path.join(portableDir, 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(mjs)) return mjs;

    // Tier 0c: Windows global npm path (~/AppData/Roaming/npm/node_modules/openclaw/)
    if (IS_WINDOWS) {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      for (const entryFile of ['openclaw.mjs', 'openclaw.js', 'index.js', 'bin/openclaw.js', 'dist/index.js']) {
        const candidate = path.join(appData, 'npm', 'node_modules', 'openclaw', entryFile);
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    // Fallback: check if openclaw is on PATH (system install)
    // On Windows, resolve .cmd shim to actual .mjs path to avoid spawn issues
    try {
      const cmd = IS_WINDOWS ? 'where openclaw.cmd' : 'which openclaw';
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
        .split(/\r?\n/)[0].trim();
      if (result) {
        const resolved = this._resolveShimToMjs(result);
        if (resolved) return resolved;
        // On Unix, which returns the actual binary/symlink
        if (!IS_WINDOWS) return result;
      }
    } catch {}
    // Windows: also try without .cmd extension (for system installs on PATH)
    if (IS_WINDOWS) {
      try {
        const result = execSync('where openclaw', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
          .split(/\r?\n/)[0].trim();
        if (result) {
          // Try the .cmd variant of this path
          const cmdPath = result.replace(/(?:\.cmd)?$/i, '.cmd');
          const resolved = this._resolveShimToMjs(cmdPath);
          if (resolved) return resolved;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Resolve a .cmd shim or Unix symlink to the actual openclaw.mjs path.
   * On Windows: parses the .cmd shim to extract %dp0%\..\openclaw\openclaw.mjs
   * On Unix: follows symlink to the .mjs file
   */
  _resolveShimToMjs(binPath) {
    if (IS_WINDOWS) {
      try {
        if (!binPath.toLowerCase().endsWith('.cmd')) return null;
        const cmdContent = fs.readFileSync(binPath, 'utf-8');
        const match = cmdContent.match(/%dp0%\\([^\s"*?]+\.mjs)/i)
          || cmdContent.match(/%dp0%\\([^\s"*?]+\.js)/i);
        if (match) {
          const cmdDir = path.dirname(path.resolve(binPath));
          return path.resolve(cmdDir, match[1]);
        }
      } catch {}
    } else {
      try {
        let target = binPath;
        if (fs.lstatSync(binPath).isSymbolicLink()) {
          target = path.resolve(path.dirname(binPath), fs.readlinkSync(binPath));
        }
        if (target.endsWith('.mjs') || target.endsWith('.js')) return target;
      } catch {}
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Workspace skill installation
  // ------------------------------------------------------------------

  _resolveOpenclawWorkspace() {
    const agentId = this.openclawAgentId;
    const wsDir = agentId && agentId !== 'main'
      ? path.join(OPENCLAW_STATE_DIR, `workspace-${agentId}`)
      : path.join(OPENCLAW_STATE_DIR, 'workspace');

    if (fs.existsSync(wsDir)) return wsDir;

    // Fall back to default workspace
    const fallback = path.join(OPENCLAW_STATE_DIR, 'workspace');
    if (fs.existsSync(fallback)) return fallback;

    return null;
  }

  _installWorkspaceSkill() {
    const wsDir = this._resolveOpenclawWorkspace();
    if (!wsDir) {
      this._log('OpenClaw workspace not found, skipping skill install');
      return;
    }

    const skillName = `wwj-workspace-${this.agentName}`;
    const skillDir = path.join(wsDir, 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });

    const content = buildOpenclawSkillMd({
      endpoint: this.endpoint,
      workspaceId: this.workspaceId,
      token: this.token,
      agentName: this.agentName,
      channelName: this.channelName,
      disabledModules: this.disabledModules,
    });

    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, content, 'utf-8');
    this._log(`Installed workspace skill at ${skillPath}`);
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  async run() {
    // Native exec approvals are broadcast by the OpenClaw Gateway. Keep this
    // operator connection alive alongside the workspace bridge so requests can
    // be displayed and resolved by the 52hzAgents chat UI.
    this._connectGatewayApprovalRelay();
    return super.run();
  }

  stop() {
    this._closeGatewayApprovalRelay();

    // A workspace reconnect replaces this adapter, but an in-flight
    // `openclaw agent` process is independent of the poll loop. Leave it
    // alive and it keeps writing the old workspace's session after the new
    // adapter has started, causing session-takeover errors and duplicate work.
    for (const [channel, proc] of Object.entries(this._channelProcesses)) {
      this._stoppingChannels.add(channel);
      void this._stopProcess(proc);
    }
    this._channelProcesses = {};
    super.stop();
  }

  _gatewaySettings() {
    const configPath = path.join(OPENCLAW_STATE_DIR, 'openclaw.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    const port = process.env.OPENCLAW_GATEWAY_PORT || config.gateway?.port || 18789;
    const url = process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${port}`;
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token || '';
    return { url, token };
  }

  _connectGatewayApprovalRelay() {
    if (this._gatewayWs || this._stopRequested) return;
    const { url, token } = this._gatewaySettings();
    try {
      const ws = new WebSocket(url);
      this._gatewayWs = ws;
      ws.on('message', (raw) => {
        try {
          this._onGatewayFrame(raw, token);
        } catch (e) {
          this._log(`Error in OpenClaw gateway frame handler: ${e && e.message ? e.message : String(e)}`);
        }
      });
      ws.on('error', (e) => {
        this._log(`OpenClaw approval relay unavailable (${url}): ${e && e.message ? e.message : String(e)}`);
      });
      ws.on('close', () => {
        if (this._gatewayWs === ws) {
          this._gatewayWs = null;
          this._gatewayConnected = false;
          if (this._running && !this._stopRequested) {
            setTimeout(() => {
              try {
                this._connectGatewayApprovalRelay();
              } catch (e) {
                this._log(`Approval relay reconnect error: ${e && e.message ? e.message : String(e)}`);
              }
            }, 3000).unref?.();
          }
        }
      });
    } catch (e) {
      this._log(`OpenClaw approval relay setup failed: ${e && e.message ? e.message : String(e)}`);
    }
  }

  _onGatewayFrame(raw, token) {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      this._gatewaySend({
        type: 'req', id: 'wwj-connect', method: 'connect',
        params: {
          minProtocol: 4, maxProtocol: 4,
          client: { id: 'gateway-client', version: '0.1.0', platform: process.platform, mode: 'backend' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.approvals'],
          caps: [], commands: [], permissions: {}, auth: token ? { token } : {},
        },
      });
      return;
    }
    if (frame.type === 'res') {
      if (frame.id === 'wwj-connect') {
        this._gatewayConnected = !!frame.ok;
        this._log(frame.ok ? 'Connected to OpenClaw approval relay' : `OpenClaw approval relay rejected: ${frame.error?.message || 'unknown error'}`);
      }
      const pending = this._gatewayRequests.get(frame.id);
      if (pending) {
        this._gatewayRequests.delete(frame.id);
        frame.ok ? pending.resolve(frame.payload) : pending.reject(new Error(frame.error?.message || 'Gateway request failed'));
      }
      return;
    }
    if (frame.type === 'event' && frame.event === 'exec.approval.requested') {
      this._publishGatewayApproval(frame.payload).catch((e) => this._log(`Failed to publish OpenClaw approval: ${e.message}`));
    }
  }

  _gatewaySend(frame) {
    if (this._gatewayWs && this._gatewayWs.readyState === WebSocket.OPEN) this._gatewayWs.send(JSON.stringify(frame));
  }

  _gatewayRequest(method, params) {
    if (!this._gatewayConnected) return Promise.reject(new Error('OpenClaw Gateway approval relay is not connected'));
    const id = `wwj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._gatewayRequests.delete(id);
        reject(new Error(`OpenClaw Gateway ${method} timed out`));
      }, 15000);
      this._gatewayRequests.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this._gatewaySend({ type: 'req', id, method, params });
    });
  }

  async _publishGatewayApproval(payload) {
    const approvalId = payload?.id;
    if (!approvalId || this._pendingApprovals.has(approvalId)) return;
    let details = payload;
    try { details = await this._gatewayRequest('exec.approval.get', { id: approvalId }); } catch {}
    const request = details?.request || payload?.request || {};
    const sessionKey = request.sessionKey || payload?.sessionKey || '';
    const channel = this._gatewaySessionChannels.get(sessionKey) || this.channelName || 'general';
    const command = request.command || request.rawCommand || 'OpenClaw requested a command execution';
    this._pendingApprovals.set(approvalId, { channel, sessionKey });
    await this.client.sendMessage(this.workspaceId, channel, this.token,
      'OpenClaw needs your approval before it can execute this command.', {
        senderType: 'agent', senderName: this.agentName, messageType: 'chat', sessionId: this._sessionId,
        metadata: { tool_approval_request: { approval_id: approvalId, tool: 'exec', args: { command } } },
      });
  }

  async _handleApprovalResponse(msg) {
    const response = msg.metadata?.tool_approval_response;
    const approvalId = response?.approval_id;
    if (!approvalId || !this._pendingApprovals.has(approvalId)) return false;
    await this._gatewayRequest('exec.approval.resolve', {
      id: approvalId,
      decision: response.granted ? 'allow-once' : 'deny',
    });
    this._pendingApprovals.delete(approvalId);
    this._log(`OpenClaw approval ${approvalId.slice(0, 8)} resolved: ${response.granted ? 'approved' : 'denied'}`);
    return true;
  }

  _closeGatewayApprovalRelay() {
    for (const { reject } of this._gatewayRequests.values()) reject(new Error('OpenClaw approval relay closed'));
    this._gatewayRequests.clear();
    if (this._gatewayWs) { try { this._gatewayWs.close(); } catch {} }
    this._gatewayWs = null;
    this._gatewayConnected = false;
  }

  // ------------------------------------------------------------------
  // Model selection —openclaw.json is the single source of truth
  // ------------------------------------------------------------------

  get _configPath() {
    return path.join(OPENCLAW_STATE_DIR, 'openclaw.json');
  }

  _readConfig() {
    try {
      return JSON.parse(fs.readFileSync(this._configPath, 'utf-8')) || {};
    } catch {
      return {};
    }
  }

  _writeConfig(config) {
    try {
      fs.mkdirSync(OPENCLAW_STATE_DIR, { recursive: true });
      fs.writeFileSync(this._configPath, JSON.stringify(config, null, 2), 'utf-8');
      return true;
    } catch (e) {
      this._log(`Failed to write ${this._configPath}: ${e.message}`);
      return false;
    }
  }

  /**
   * The model OpenClaw will actually use, as `<provider>/<modelId>`.
   * Mirrors what configureNativeAuth writes.
   */
  _getCurrentModel() {
    const config = this._readConfig();
    const primary = config?.agents?.defaults?.model?.primary;
    return typeof primary === 'string' && primary ? primary : null;
  }

  /**
   * Every model openclaw.json actually declares, as `{ id, name }` where the
   * id is the `<provider>/<modelId>` string OpenClaw expects. Two sources:
   * `models.providers.*.models` (custom endpoints —the list the user
   * configured) and the current `agents.defaults.model.primary` (standard
   * providers write only this, with no provider block to enumerate).
   *
   * The UI renders exactly this, so an unconfigured provider shows nothing
   * rather than a menu of models the account cannot reach.
   */
  _listModels() {
    const config = this._readConfig();
    const out = [];
    const seen = new Set();

    const push = (id, name) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name: name || id });
    };

    const providers = config?.models?.providers;
    if (providers && typeof providers === 'object') {
      for (const [providerName, provider] of Object.entries(providers)) {
        const models = Array.isArray(provider?.models) ? provider.models : [];
        for (const m of models) {
          const modelId = typeof m === 'string' ? m : m?.id;
          if (!modelId) continue;
          const label = (typeof m === 'object' && m?.name) || modelId;
          push(`${providerName}/${modelId}`, label);
        }
      }
    }

    // A standard provider (openai/anthropic) has no provider block —the only
    // evidence it exists is the primary itself.
    const primary = this._getCurrentModel();
    if (primary) push(primary, primary.split('/').slice(1).join('/') || primary);

    return out;
  }

  /**
   * Publish the openclaw.json model state so the UI's model switcher can offer
   * the models this install actually has, instead of a hardcoded guess. Called
   * off BaseAdapter's heartbeat. Percentages stay 0 —OpenClaw exposes no quota
   * figures, and the quota capsule excludes this agent kind for that reason.
   */
  async fetchAndReportUsage() {
    try {
      const models = this._listModels();
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: this._getCurrentModel(),
          available_models: JSON.stringify(models),
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
      if (!requested) return;

      // Accept the full `<provider>/<modelId>` id (what the UI sends), or a
      // bare model id when exactly one provider declares it —the same bare id
      // can legitimately exist under two providers, and guessing which one
      // would silently route to the wrong endpoint.
      const known = this._listModels();
      const bare = known.filter((m) => m.id.split('/').slice(1).join('/') === requested);
      const match = known.find((m) => m.id === requested) || (bare.length === 1 ? bare[0] : null);
      if (!match) {
        const why = bare.length > 1
          ? `is ambiguous (declared by ${bare.length} providers —send the full <provider>/<model> id)`
          : `is not declared in ${this._configPath}`;
        this._log(`set_model: '${requested}' ${why} —ignoring`);
        return;
      }

      const config = this._readConfig();
      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      config.agents.defaults.model = { ...(config.agents.defaults.model || {}), primary: match.id };
      if (!this._writeConfig(config)) return;
      this.model = match.id;
      this._log(`Switched OpenClaw model to: ${match.id}`);

      // openclaw reads its config at process start, so an in-flight process
      // keeps the old model. Kill the channel's process (or all of them) so the
      // next turn spawns against the new config.
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      const targets = channel
        ? Object.entries(this._channelProcesses).filter(([c]) => c === channel)
        : Object.entries(this._channelProcesses);
      for (const [c, proc] of targets) {
        this._stoppingChannels.add(c);
        await this._stopProcess(proc);
        delete this._channelProcesses[c];
      }

      this.fetchAndReportUsage().catch(() => {});
      return;
    }

    if (action === 'stop') {
      const requestedChannel = (payload && typeof payload === 'object') ? payload.channel : null;
      const processes = requestedChannel
        ? Object.entries(this._channelProcesses).filter(([channel]) => channel === requestedChannel)
        : Object.entries(this._channelProcesses);
      for (const [channel, proc] of processes) {
        this._log(`Stopping process for channel=${channel}`);
        this._stoppingChannels.add(channel);
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        // No _channelQueues here —this adapter never had one, and the delete
        // that used to sit on this line threw on `undefined[channel]`, aborting
        // the loop before the status below (and before any later channel).
        try { await this.sendStatus(channel, 'Execution stopped by user'); } catch {}
      }
      return;
    }
    await super._onControlAction(action, payload);
  }

  async _stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (IS_WINDOWS) {
        try { proc.kill('SIGINT'); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (proc.exitCode === null) {
          try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch {}
        }
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      }
    } catch {}
  }

  async _handleMessage(msg) {
    let content = (msg.content || '').trim();
    const attachments = msg.attachments || [];

    // Append attachment info
    const attText = formatAttachmentsForPrompt(attachments);
    if (attText) {
      content = content ? content + attText : attText.trim();
    }

    if (!content) return;

    // msg.sessionId may be a channel name (from workspace UI) or an agent target
    // (from API). Only use it if it looks like a channel, otherwise use channelName.
    let msgChannel = this.channelName || 'general';
    if (msg.sessionId && !msg.sessionId.startsWith('52hz:') && !msg.sessionId.startsWith('agent:')) {
      msgChannel = msg.sessionId;
    }
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing message from ${sender} in ${msgChannel}: ${content.slice(0, 80)}...`);

    await this._autoTitleChannel(msgChannel, content);
    await this.sendStatus(msgChannel, 'thinking...');

    // Snapshot the OpenClaw workspace so we can publish any files this run creates.
    const openclawWs = this._resolveOpenclawWorkspace();
    const filesBefore = openclawWs ? this._collectWorkspaceFiles(openclawWs) : null;

    try {
      const responseText = await this._runCliAgent(content, msgChannel);

      if (this._stoppingChannels.has(msgChannel)) {
        this._stoppingChannels.delete(msgChannel);
        return;
      }

      if (responseText) {
        await this.sendResponse(msgChannel, responseText);
      } else {
        await this.sendResponse(msgChannel, 'No response generated. Please try again.');
      }

      // Publish files the agent created/modified during this run to the workspace.
      if (openclawWs && filesBefore) {
        await this._syncNewFilesToWorkspace(openclawWs, filesBefore, msgChannel);
      }
    } catch (e) {
      this._log(`Error handling message: ${e.message}`);
      await this.sendError(msgChannel, `Error processing message: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Workspace file sync —publish files the agent produced
  // ------------------------------------------------------------------

  /**
   * Recursively map relative-path →mtimeMs for files under `root`, skipping
   * internal/noise directories. Used to diff the workspace before/after a run.
   */
  _collectWorkspaceFiles(root) {
    const out = new Map();
    const SKIP_DIRS = new Set([
      'skills', 'node_modules', '.git', '.openclaw', 'sessions',
      'history', 'memory', 'logs', 'cache', 'tmp', '.cache', '.tmp',
    ]);
    const walk = (dir, rel) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const abs = path.join(dir, ent.name);
        const relPath = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          walk(abs, relPath);
        } else if (ent.isFile()) {
          try { out.set(relPath, fs.statSync(abs).mtimeMs); } catch {}
        }
      }
    };
    walk(root, '');
    return out;
  }

  /**
   * Upload files created or modified since the `before` snapshot to the
   * workspace so they show up in the Files panel. Best-effort: per-file
   * failures are logged and do not interrupt the run.
   */
  async _syncNewFilesToWorkspace(root, before, channel) {
    const MAX_BYTES = 10 * 1024 * 1024;
    const after = this._collectWorkspaceFiles(root);
    const changed = [];
    for (const [rel, mtime] of after) {
      if (!before.has(rel) || before.get(rel) !== mtime) changed.push(rel);
    }
    if (changed.length === 0) return;
    this._log(`Publishing ${changed.length} file(s) to workspace…`);
    for (const rel of changed) {
      const abs = path.join(root, ...rel.split('/'));
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_BYTES) { this._log(`Skipping ${rel} (> ${MAX_BYTES} bytes)`); continue; }
        const ext = rel.toLowerCase().split('.').pop();
        const contentType =
          ext === 'md' || ext === 'txt' ? 'text/markdown; charset=utf-8'
          : ext === 'json' ? 'application/json'
          : ext === 'csv' ? 'text/csv'
          : ext === 'html' ? 'text/html; charset=utf-8'
          : ext === 'png' ? 'image/png'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'pdf' ? 'application/pdf'
          : 'application/octet-stream';
        const buf = fs.readFileSync(abs);
        await this.client.uploadFile(
          this.workspaceId, this.token, rel, buf.toString('base64'),
          { contentType, source: `52hz:${this.agentName}`, channelName: channel },
        );
        this._log(`Uploaded ${rel}`);
      } catch (e) {
        this._log(`Failed to upload ${rel}: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // CLI mode (openclaw agent --local)
  // ------------------------------------------------------------------

  async _runCliAgent(userMessage, channel) {
    const spawnCwd = await this._resolveWorkingDir(channel, userMessage);
    return new Promise((resolve, reject) => {
      // Re-check binary if not found at construction time (installed after daemon started)
      if (!this._openclawBinary) {
        this._openclawBinary = this._findOpenclawBinary();
        if (this._openclawBinary) {
          this._log(`OpenClaw binary found (late): ${this._openclawBinary}`);
        }
      }
      const binary = this._openclawBinary;
      if (!binary) {
        reject(new Error('OpenClaw binary not found'));
        return;
      }

      const channelSuffix = (channel || 'general').replace(/[^a-zA-Z0-9-]/g, '').slice(-8) || 'general';
      const sessionKey = `52hzAgents-${this.workspaceId.slice(0, 8)}-${channelSuffix}`;
      this._gatewaySessionChannels.set(`agent:${this.openclawAgentId}:explicit:${sessionKey}`, channel);
      this._gatewaySessionChannels.set(sessionKey, channel);

      this._ensureExecApprovalsConfigured();

      const args = [
        '--log-level', 'trace',
        'agent',
        '--agent', this.openclawAgentId,
        '--local',
        '--session-id', sessionKey,
        '--message', userMessage,
        '--json',
      ];

      this._log(`CLI: ${binary} ${args.slice(0, 5).join(' ')} ...`);

      const spawnEnv = {
        ...(this.agentEnv || process.env),
        OPENCLAW_SKIP_VERSION_CHECK: '1',
        OPENCLAW_SKIP_SQLITE_CHECK: '1',
        OPENCLAW_ALLOW_UNSAFE_SQLITE: '1',
      };
      if (IS_WINDOWS) {
        const nodeBinDir = path.dirname(process.execPath);
        const npmBin = path.join(process.env.APPDATA || '', 'npm');
        const portableDir2 = path.join(os.homedir(), '.wwj', 'nodejs');
        const runtimeBin = path.join(getRuntimePrefix('openclaw'), 'node_modules', '.bin');
        for (const p of [runtimeBin, nodeBinDir, npmBin, portableDir2]) {
          if (p && !(spawnEnv.PATH || '').includes(p)) {
            spawnEnv.PATH = p + path.delimiter + (spawnEnv.PATH || '');
          }
        }
      }

      // Tool name →human-readable status
      const toolLabels = {
        exec: 'Running command...',
        read: 'Reading file...',
        write: 'Writing file...',
        edit: 'Editing file...',
        browser: 'Using browser...',
        web_search: 'Searching the web...',
        web_fetch: 'Fetching webpage...',
        process: 'Running process...',
        image_generate: 'Generating image...',
        memory_search: 'Searching memory...',
      };

      let output = '';
      let lineBuffer = '';

      const processLine = (line) => {
        const toolStart = line.match(/embedded run tool start:.*tool=(\w+)/);
        if (toolStart) {
          const label = toolLabels[toolStart[1]] || `Using ${toolStart[1]}...`;
          this._log(`Tool: ${label}`);
          // No args: unlike every other adapter, this one recovers its tool
          // calls by regex over a log line, and the line carries the name and
          // nothing else. The name is still structure worth sending — it is
          // what names the card — and the label stays as the readable line.
          this.sendToolCall(channel, {
            name: toolStart[1],
            status: 'running',
            summary: label,
          }).catch(() => {});
        }
        if (line.match(/embedded run agent start/)) {
          this.sendStatus(channel, 'thinking...').catch(() => {});
        }
      };

      // Redirect stderr to temp file for real-time tool status polling.
      // --log-level trace makes OpenClaw write diagnostic events to stderr
      // even in non-TTY mode. We poll the temp file for new lines every 500ms.
      const stderrFile = path.join(os.tmpdir(), `openclaw-stderr-${Date.now()}.log`);
      const stderrFd = fs.openSync(stderrFile, 'w');
      this._log('Spawn: stderr →' + stderrFile);

      // Always spawn node + openclaw.mjs directly (no shims, no cmd.exe, cross-platform)
      // This avoids Windows .cmd shim issues and Unicode path encoding problems.
      const portableDir = path.join(os.homedir(), '.wwj', 'nodejs');
      // Unified path first (symlink on Unix), then legacy bin/ fallback, then system node
      const nodeUnified = path.join(portableDir, IS_WINDOWS ? 'node.exe' : 'node');
      let nodeBin = fs.existsSync(nodeUnified) ? nodeUnified : path.join(portableDir, 'bin', 'node');
      if (!fs.existsSync(nodeBin)) {
        try {
          const cmd = IS_WINDOWS ? 'where node.exe' : 'which node';
          nodeBin = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
            .split(/\r?\n/)[0].trim();
        } catch { nodeBin = 'node'; }
      }

      // binary from _findOpenclawBinary() is already resolved to .mjs when possible
      let spawnBin, spawnArgs;
      if (binary && binary.endsWith('.mjs')) {
        // Direct node + .mjs invocation (works for managed, legacy, AND global installs)
        spawnBin = nodeBin;
        spawnArgs = [binary, ...args];
      } else {
        // Check managed locations explicitly
        const runtimeMjs = path.join(getRuntimePrefix('openclaw'), 'node_modules', 'openclaw', 'openclaw.mjs');
        const legacyMjs = path.join(portableDir, 'node_modules', 'openclaw', 'openclaw.mjs');
        const openclawMjs = fs.existsSync(runtimeMjs) ? runtimeMjs : (fs.existsSync(legacyMjs) ? legacyMjs : null);
        if (openclawMjs) {
          spawnBin = nodeBin;
          spawnArgs = [openclawMjs, ...args];
        } else {
          // Last resort: spawn binary directly with shell (handles .cmd on Windows)
          spawnBin = binary;
          spawnArgs = args;
        }
      }
      const proc = spawn(spawnBin, spawnArgs, {
        stdio: ['ignore', 'pipe', stderrFd],
        env: spawnEnv,
        cwd: spawnCwd,
        timeout: 600000,
        windowsHide: true,
      });
      this._channelProcesses[channel] = proc;
      if (proc.stdout) proc.stdout.on('data', (d) => { output += d; });

      // Poll stderr file every 500ms for tool events
      let stderrOffset = 0;
      const pollInterval = setInterval(() => {
        try {
          const stat = fs.statSync(stderrFile);
          if (stat.size > stderrOffset) {
            const fd = fs.openSync(stderrFile, 'r');
            const buf = Buffer.alloc(stat.size - stderrOffset);
            fs.readSync(fd, buf, 0, buf.length, stderrOffset);
            fs.closeSync(fd);
            stderrOffset = stat.size;
            const chunk = buf.toString('utf-8');
            const lines = chunk.split('\n');
            for (const line of lines) processLine(line);
          }
        } catch {}
      }, 500);

      // 'error' and 'exit' can BOTH fire for a single failed spawn. Closing
      // stderrFd twice throws EBADF from inside the event callback, which —      // with no daemon-level handler —used to crash the entire daemon. Guard
      // so the fd is closed once and the promise settles once.
      let settled = false;
      const closeFd = () => { try { fs.closeSync(stderrFd); } catch {} };

      const killTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(pollInterval);
        closeFd();
        try { fs.unlinkSync(stderrFile); } catch {}
        try { proc.kill(); } catch {}
        reject(new Error('CLI timed out after 600 seconds'));
      }, 600000);

      proc.on('error', (err) => {
        if (this._channelProcesses[channel] === proc) delete this._channelProcesses[channel];
        if (this._stoppingChannels.has(channel)) {
          resolve('');
          return;
        }
        if (settled) return;
        settled = true;
        clearInterval(pollInterval);
        clearTimeout(killTimeout);
        closeFd();
        try { fs.unlinkSync(stderrFile); } catch {}
        reject(err);
      });
      proc.on('exit', (code) => {
        if (this._channelProcesses[channel] === proc) delete this._channelProcesses[channel];
        if (settled) return;
        settled = true;
        clearInterval(pollInterval);
        clearTimeout(killTimeout);
        closeFd();
        // Read full stderr content (contains JSON output + trace lines)
        let stderrContent = '';
        try {
          stderrContent = fs.readFileSync(stderrFile, 'utf-8');
          this._log(`CLI exit code=${code}, stdout=${output.length}b, stderr=${stderrContent.length}b`);
          // Process any remaining lines for tool events
          const remaining = stderrContent.slice(stderrOffset);
          if (remaining) {
            for (const line of remaining.split('\n')) processLine(line);
          }
        } catch (e) {
          this._log(`CLI stderr read error: ${e.message}`);
        }
        try { fs.unlinkSync(stderrFile); } catch {}

        // OpenClaw --json writes JSON to stderr, so combine stdout + stderr
        const allOutput = output + '\n' + stderrContent;
        const hasPayloads = allOutput.includes('"payloads"');
        this._log(`CLI parse: hasPayloads=${hasPayloads}, total=${allOutput.length}b`);

        if (this._stoppingChannels.has(channel)) {
          resolve('');
          return;
        }

        if (code !== 0) {
          reject(new Error(`CLI exited ${code}: ${allOutput.slice(-300)}`));
          return;
        }
        this._parseCliOutput(output, allOutput, resolve);
      });
    });
  }

  _parseCliOutput(stdoutText, combinedText, resolve) {
    const text = (stdoutText || '').trim() || (combinedText || '').trim();
    if (!text) { resolve(''); return; }

    const tryParseJson = (str) => {
      try {
        const obj = JSON.parse(str);
        if (obj && typeof obj === 'object') {
          if (obj.payloads || obj.meta || obj.finalAssistantVisibleText || obj.finalAssistantRawText) {
            return obj;
          }
        }
      } catch {}
      return null;
    };

    let data = null;

    // Search for JSON in stdout first, then combined stdout+stderr
    for (const source of [stdoutText, combinedText]) {
      if (!source || data) break;
      const src = source.trim();

      // Strategy 1: find {"payloads" or { "payloads"
      let payloadsIdx = src.indexOf('{"payloads"');
      if (payloadsIdx < 0) {
        const match = src.match(/\{\s*"payloads"/);
        if (match) payloadsIdx = match.index;
      }
      if (payloadsIdx >= 0) {
        let depth = 0;
        for (let i = payloadsIdx; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
              data = tryParseJson(src.slice(payloadsIdx, i + 1));
              break;
            }
          }
        }
      }

      // Strategy 2: scan backwards for valid JSON with payloads or meta
      if (!data) {
        for (let i = src.length - 1; i >= 0; i--) {
          if (src[i] === '{') {
            const candidate = src.slice(i);
            const parsed = tryParseJson(candidate);
            if (parsed) { data = parsed; break; }
          }
        }
      }

      // Strategy 3: try each line that starts with '{'
      if (!data) {
        for (const line of src.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{')) {
            const parsed = tryParseJson(trimmed);
            if (parsed) { data = parsed; break; }
          }
        }
      }
    }

    if (data) {
      try {
        let assistantText = '';

        // Priority 1: payloads with non-empty text
        const payloads = Array.isArray(data.payloads) ? data.payloads : [];
        const payloadTexts = payloads.filter(p => p && typeof p.text === 'string' && p.text.trim()).map(p => p.text.trim());
        if (payloadTexts.length > 0) {
          assistantText = payloadTexts.join('\n\n');
        }

        // Priority 2: meta.finalAssistantVisibleText or top-level finalAssistantVisibleText
        if (!assistantText) {
          const visibleText = (data.meta && data.meta.finalAssistantVisibleText) || data.finalAssistantVisibleText;
          if (typeof visibleText === 'string' && visibleText.trim()) {
            assistantText = visibleText.trim();
          }
        }

        // Priority 3: meta.finalAssistantRawText or top-level finalAssistantRawText
        if (!assistantText) {
          const rawText = (data.meta && data.meta.finalAssistantRawText) || data.finalAssistantRawText;
          if (typeof rawText === 'string' && rawText.trim()) {
            assistantText = rawText.trim();
          }
        }

        // Priority 4: reply, message, response, or text fields
        if (!assistantText) {
          const directText = data.reply || data.response || data.message || data.text;
          if (typeof directText === 'string' && directText.trim()) {
            assistantText = directText.trim();
          }
        }

        // Priority 5: Read last assistant message directly from OpenClaw session JSONL file if available
        if (!assistantText) {
          const sessionFile = data.meta && data.meta.agentMeta && data.meta.agentMeta.sessionFile;
          if (sessionFile && fs.existsSync(sessionFile)) {
            try {
              const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
              for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                const msgObj = JSON.parse(line);
                if (msgObj.type === 'message' && msgObj.message && msgObj.message.role === 'assistant') {
                  const contents = msgObj.message.content || [];
                  const texts = contents.filter(c => c.type === 'text' && c.text).map(c => c.text.trim());
                  if (texts.length > 0) {
                    assistantText = texts.join('\n\n');
                    break;
                  }
                }
              }
            } catch (err) {
              this._log(`Session file inspect fallback error: ${err.message}`);
            }
          }
        }

        if (assistantText) {
          this._log(`CLI successfully parsed assistant text (${assistantText.length} chars)`);
          resolve(assistantText);
          return;
        }

        // If JSON was parsed successfully but no assistant text was generated:
        // NEVER dump raw JSON telemetry into user chat!
        this._log(`CLI returned JSON without assistant text: keys=${Object.keys(data).join(',')}`);
        resolve('');
        return;
      } catch (e) {
        this._log(`CLI JSON parse error: ${e.message}`);
      }
    }

    // Fallback: return filtered non-diagnostic text only if no JSON structure was recognized
    const noisePatterns = [
      /^\s*\[(plugins|paths|agents|diagnostic|provider-transport|mem9|openclaw|model-fetch)/i,
      /^\s*\{.*\}\s*$/,
      /^\s*["']?payloads["']?\s*:/,
      /^\s*["']?meta["']?\s*:/,
      /^\s*Registered plugin/i,
      /^\s*__dirname:/i,
      /^\s*getProjectRoot:/i,
    ];
    const cleanLines = (combinedText || '').split('\n').filter(l => {
      const tr = l.trim();
      if (!tr) return false;
      return !noisePatterns.some(pat => pat.test(tr));
    }).map(l => l.trim()).filter(Boolean);

    resolve(cleanLines.join('\n') || '');
  }

  /**
   * Configure OpenClaw's exec approvals to bypass interactive approval timeouts in background agent mode.
   */
  _ensureExecApprovalsConfigured() {
    try {
      fs.mkdirSync(OPENCLAW_STATE_DIR, { recursive: true });
      const approvalsFile = path.join(OPENCLAW_STATE_DIR, 'exec-approvals.json');
      let approvalsData = {
        version: 1,
        defaults: { security: 'full', ask: 'off', askFallback: 'allow' },
        agents: { main: { security: 'full', ask: 'off' } },
      };
      if (fs.existsSync(approvalsFile)) {
        try {
          approvalsData = JSON.parse(fs.readFileSync(approvalsFile, 'utf-8'));
        } catch {}
      }
      approvalsData.defaults = approvalsData.defaults || {};
      approvalsData.defaults.security = 'full';
      approvalsData.defaults.ask = 'off';
      approvalsData.defaults.askFallback = 'allow';

      approvalsData.agents = approvalsData.agents || {};
      const agentKey = this.openclawAgentId || 'main';
      approvalsData.agents[agentKey] = approvalsData.agents[agentKey] || {};
      approvalsData.agents[agentKey].security = 'full';
      approvalsData.agents[agentKey].ask = 'off';

      fs.writeFileSync(approvalsFile, JSON.stringify(approvalsData, null, 2), 'utf-8');
      this._log(`Configured exec approvals (security=full, ask=off) in ${approvalsFile}`);
    } catch (e) {
      this._log(`Failed to configure exec approvals: ${e.message}`);
    }

    try {
      const configFile = path.join(OPENCLAW_STATE_DIR, 'openclaw.json');
      if (fs.existsSync(configFile)) {
        let config = {};
        try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}
        config.tools = config.tools || {};
        config.tools.exec = { security: 'full', ask: 'off' };
        if (config.plugins && config.plugins.entries && config.plugins.entries['openclaw-eigenflux']) {
          config.plugins.entries['openclaw-eigenflux'].enabled = false;
        }
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
      }
    } catch (e) {
      this._log(`Failed to update openclaw.json tools config: ${e.message}`);
    }
  }
  // ------------------------------------------------------------------
  // Static: configure OpenClaw's native auth from LLM env vars
  // ------------------------------------------------------------------

  /**
   * Configure OpenClaw's native auth and model from user-provided
   * LLM_API_KEY / LLM_BASE_URL / LLM_MODEL values.
   * Called by the Launcher's saveAgentEnv when type === 'openclaw'.
   *
   * For standard providers (OpenAI, Anthropic), uses auth-profiles.json.
   * For custom endpoints, uses models.providers in openclaw.json which
   * gives full tool support via the CLI gateway mode.
   */
  static configureNativeAuth(env) {
    const apiKey = env.LLM_API_KEY;
    // Strip /chat/completions suffix —OpenClaw appends it internally
    const rawUrl = env.LLM_BASE_URL || 'https://api.openai.com/v1';
    const baseUrl = rawUrl.replace(/\/chat\/completions\/?$/, '');
    const model = env.LLM_MODEL || 'gpt-4o';
    if (!apiKey) return;

    const isOpenAI = baseUrl.includes('api.openai.com');
    const isAnthropic = baseUrl.includes('api.anthropic.com');
    const configFile = path.join(OPENCLAW_STATE_DIR, 'openclaw.json');

    if (isOpenAI || isAnthropic) {
      // Standard provider —use auth-profiles.json
      const provider = isAnthropic ? 'anthropic' : 'openai';
      const profileId = `${provider}:manual`;
      const agentDir = path.join(OPENCLAW_STATE_DIR, 'agents', 'main', 'agent');

      try {
        fs.mkdirSync(agentDir, { recursive: true });
        const authFile = path.join(agentDir, 'auth-profiles.json');
        let authData = { version: 1, profiles: {} };
        try { authData = JSON.parse(fs.readFileSync(authFile, 'utf-8')); } catch {}
        authData.profiles = authData.profiles || {};
        authData.profiles[profileId] = { type: 'token', provider, token: apiKey };
        authData.lastGood = authData.lastGood || {};
        authData.lastGood[provider] = profileId;
        fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf-8');
      } catch {}

      // Set model
      try {
        let config = {};
        try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: `${provider}/${model}` };
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
      } catch {}
    } else {
      // Custom endpoint —use models.providers for full gateway/tool support
      // This is the proper way to add custom LLM endpoints to OpenClaw.
      // See: https://docs.openclaw.ai/concepts/model-providers
      try {
        fs.mkdirSync(OPENCLAW_STATE_DIR, { recursive: true });
        let config = {};
        try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers.custom = {
          baseUrl: baseUrl.replace(/\/+$/, ''),
          apiKey,
          api: 'openai-completions',
          models: [{ id: model, name: model }],
        };

        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: `custom/${model}` };

        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
      } catch {}

      // Also write auth-profiles.json for the custom provider
      try {
        const agentDir = path.join(OPENCLAW_STATE_DIR, 'agents', 'main', 'agent');
        fs.mkdirSync(agentDir, { recursive: true });
        const authFile = path.join(agentDir, 'auth-profiles.json');
        let authData = { version: 1, profiles: {} };
        try { authData = JSON.parse(fs.readFileSync(authFile, 'utf-8')); } catch {}
        authData.profiles = authData.profiles || {};
        authData.profiles['custom:manual'] = { type: 'token', provider: 'custom', token: apiKey };
        authData.lastGood = authData.lastGood || {};
        authData.lastGood.custom = 'custom:manual';
        fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf-8');
      } catch {}
    }
  }
}

module.exports = OpenClawAdapter;
