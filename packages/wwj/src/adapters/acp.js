/**
 * Generic ACP (Agent Client Protocol) adapter.
 *
 * Every other adapter in this directory spawns a vendor CLI and hand-parses
 * that vendor's private stdout format, and that parsing layer is where most of
 * their bugs have come from. ACP (https://agentclientprotocol.com) is an open
 * JSON-RPC 2.0 protocol over stdio that a growing set of CLIs speak natively:
 *
 *   gemini --experimental-acp      opencode acp
 *   claude-code-acp                codex-acp        (Zed's adapters)
 *   copilot --acp                  ...
 *
 * so ONE class serves all of them. The command is configuration, read from
 * (first wins): opts.acpCommand/acpArgs, the agent's configured command/args
 * (opts.customCommand/customArgs, which the daemon fills from agentCfg), or the
 * agent env ACP_COMMAND / ACP_ARGS. ACP_COMMAND may be a whole command line
 * ("gemini --experimental-acp") when ACP_ARGS is unset.
 *
 * Lifecycle, per channel:
 *   spawn -> initialize -> session/new {cwd, mcpServers}   (or session/load
 *   when a session id was persisted for this channel+cwd and the agent
 *   advertises agentCapabilities.loadSession) -> session/prompt per message.
 * The process is kept alive between turns and reused; if it dies, the next
 * turn respawns it and tries session/load.
 *
 * Method and field names follow the ACP spec pages
 *   /protocol/initialization, /protocol/session-setup, /protocol/prompt-turn,
 *   /protocol/tool-calls, /protocol/file-system
 * and the typescript-sdk example client (nested permission outcome).
 *
 * Env knobs (all optional):
 *   ACP_PERMISSION_MODE     ask (default) | auto | deny      -- see below
 *   ACP_PERMISSION_TIMEOUT_MS   how long an approval card waits (10 min)
 *   ACP_IDLE_TIMEOUT_MS     no session/update for this long -> cancel (10 min)
 *   ACP_WORKSPACE_MCP=0     do not hand the wwj workspace MCP server to the agent
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const BaseAdapter = require('./base');
const { whereBinary, whichBinary } = require('../paths');
const { formatAttachmentsForPrompt } = require('./utils');
const { buildClaudeSystemPrompt } = require('./workspace-prompt');

const IS_WINDOWS = process.platform === 'win32';
const PROTOCOL_VERSION = 1;

const DEFAULTS = {
  initTimeoutMs: 30000,
  sessionTimeoutMs: 60000,
  loadTimeoutMs: 120000,
  idleTimeoutMs: 10 * 60 * 1000,
  permissionTimeoutMs: 10 * 60 * 1000,
  cancelGraceMs: 10000,
  // Reply chunks from ACP agents are often a few tokens each. Posting every one
  // as its own workspace message would be one HTTP request per token, so chunks
  // are coalesced and flushed at most this often.
  previewIntervalMs: 300,
};

// Tool kinds that change something. In plan mode these are refused without
// asking anyone -- plan mode means "analyse, do not act".
const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

let CLIENT_VERSION = '0.0.0';
try { CLIENT_VERSION = require('../../package.json').version || CLIENT_VERSION; } catch {}

/**
 * Split a command line into argv, honouring single and double quotes.
 * Backslashes are NOT escapes: they are Windows path separators here.
 */
function splitCommandLine(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** ACP_ARGS may be a JSON array or a plain command-line string. */
function parseArgsValue(value) {
  if (Array.isArray(value)) return value.map(String);
  const s = String(value || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {}
  }
  return splitCommandLine(s);
}

function resolveCommandConfig(opts, env) {
  if (opts.acpCommand) {
    return { command: String(opts.acpCommand).trim(), args: parseArgsValue(opts.acpArgs) };
  }
  if (opts.customCommand && String(opts.customCommand).trim()) {
    return { command: String(opts.customCommand).trim(), args: parseArgsValue(opts.customArgs) };
  }
  const raw = String((env && env.ACP_COMMAND) || '').trim();
  if (!raw) return { command: '', args: [] };
  if (env.ACP_ARGS !== undefined && String(env.ACP_ARGS).trim()) {
    return { command: raw, args: parseArgsValue(env.ACP_ARGS) };
  }
  // A path that exists is taken whole even if it contains spaces.
  if (fs.existsSync(raw)) return { command: raw, args: [] };
  const parts = splitCommandLine(raw);
  return { command: parts[0] || '', args: parts.slice(1) };
}

function rpcError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

/**
 * One agent process and the JSON-RPC conversation with it.
 *
 * Framing is newline-delimited JSON. Lines that are not JSON (banners, stray
 * logging on stdout) are logged and skipped rather than breaking the stream;
 * a multibyte UTF-8 character split across two reads is reassembled by the
 * StringDecoder. Every outgoing request is correlated by id; when the process
 * goes away every pending request is rejected with `processExited`, so nothing
 * that awaits this connection can hang on a dead process.
 */
class AcpConnection {
  constructor({ command, args, cwd, env, log, onNotification, onRequest, onClose }) {
    this.command = command;
    this.args = args || [];
    this.cwd = cwd;
    this.env = env;
    this._log = log || (() => {});
    this._onNotification = onNotification || (() => {});
    this._onRequest = onRequest || (async () => { throw rpcError(-32601, 'Method not found'); });
    this._onClose = onClose || (() => {});
    this._nextId = 0;
    this._pending = new Map();
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._stderrTail = '';
    this.closed = false;
    this.proc = null;
    this.exitCode = null;
  }

  start() {
    const [cmd, args, extra] = this._spawnSpec();
    const proc = spawn(cmd, args, {
      cwd: this.cwd && fs.existsSync(this.cwd) ? this.cwd : undefined,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !IS_WINDOWS,
      ...extra,
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this._onData(this._decoder.write(chunk)));
    proc.stderr.on('data', (chunk) => {
      this._stderrTail = (this._stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    // EPIPE when the agent dies with a write in flight: the close handler
    // reports the real cause, this must just not crash the daemon.
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this._close({ error: err }));
    proc.on('close', (code, signal) => {
      const rest = this._decoder.end();
      if (rest) this._onData(rest);
      if (this._buffer.trim()) { const last = this._buffer; this._buffer = ''; this._onLine(last); }
      this._close({ code, signal });
    });
  }

  /** Resolve how to actually launch the command on this platform. */
  _spawnSpec() {
    let command = this.command;
    if (!/[\\/]/.test(command)) {
      try { command = whereBinary(command) || whichBinary(command) || command; } catch {}
    }
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(command)) {
      // An npm .cmd shim cannot be spawned without a shell. Prefer running the
      // script it wraps with node directly; fall back to cmd.exe.
      try {
        const text = fs.readFileSync(command, 'utf-8');
        const js = text.match(/%dp0%\\([^\s"*?]+\.m?js)/i);
        if (js) return [process.execPath, [path.resolve(path.dirname(command), js[1]), ...this.args], {}];
        const exe = text.match(/%dp0%\\([^\s"*?]+\.exe)/i);
        if (exe) return [path.resolve(path.dirname(command), exe[1]), this.args, {}];
      } catch {}
      const quote = (a) => (/[\s&()<>^|"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
      const line = [command, ...this.args].map(quote).join(' ');
      return ['cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
    }
    return [command, this.args, {}];
  }

  get stderrTail() {
    return this._stderrTail.trim();
  }

  _onData(text) {
    if (!text) return;
    this._buffer += text;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      this._onLine(line);
    }
  }

  _onLine(raw) {
    const line = raw.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      this._log(`ACP: ignoring non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && !msg.method && ('result' in msg || 'error' in msg)) {
      const pending = this._pending.get(String(msg.id));
      if (!pending) return;
      this._pending.delete(String(msg.id));
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        const e = msg.error || {};
        pending.reject(rpcError(e.code, e.message || `ACP ${pending.method} failed`, e.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (hasId && typeof msg.method === 'string') {
      Promise.resolve()
        .then(() => this._onRequest(msg.method, msg.params || {}))
        .then(
          (result) => this._write({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result }),
          (err) => this._write({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: Number.isInteger(err && err.code) ? err.code : -32603,
              message: (err && err.message) || 'Internal error',
            },
          }),
        );
      return;
    }
    if (typeof msg.method === 'string') {
      try { this._onNotification(msg.method, msg.params || {}); } catch (e) {
        this._log(`ACP: notification handler failed: ${e.message}`);
      }
    }
  }

  _write(obj) {
    if (this.closed || !this.proc || !this.proc.stdin || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {number} timeoutMs  0 = no fixed timeout (session/prompt, whose
   *   liveness is policed by the adapter's idle watchdog instead).
   */
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(this._exitError());
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._pending.delete(String(id));
          reject(new Error(`ACP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }
      this._pending.set(String(id), entry);
      if (!this._write({ jsonrpc: '2.0', id, method, params })) {
        this._pending.delete(String(id));
        if (entry.timer) clearTimeout(entry.timer);
        reject(this._exitError());
      }
    });
  }

  notify(method, params) {
    return this._write({ jsonrpc: '2.0', method, params });
  }

  _exitError(info) {
    const i = info || this._closeInfo || {};
    let what;
    if (i.error) what = `could not be started: ${i.error.message}`;
    else if (i.signal) what = `was terminated (${i.signal})`;
    else if (i.code !== undefined && i.code !== null) what = `exited with code ${i.code}`;
    else what = 'is not running';
    const tail = this.stderrTail;
    const err = new Error(`ACP agent process ${what}${tail ? `: ${tail.slice(-600)}` : ''}`);
    err.processExited = true;
    return err;
  }

  _close(info) {
    if (this.closed) return;
    this.closed = true;
    this._closeInfo = info;
    this.exitCode = info.code === undefined ? null : info.code;
    const err = this._exitError(info);
    for (const pending of this._pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
    try { this._onClose(info, err); } catch {}
  }

  kill() {
    const proc = this.proc;
    if (!proc || this.closed || proc.exitCode !== null) return;
    try { proc.stdin.end(); } catch {}
    try {
      if (IS_WINDOWS) {
        try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
        const t = setTimeout(() => {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
        }, 3000);
        if (t.unref) t.unref();
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class AcpAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {string}   [opts.acpCommand]
   * @param {string[]|string} [opts.acpArgs]
   * @param {string}   [opts.customCommand]  - daemon passes agentCfg.command here
   * @param {string[]} [opts.customArgs]
   * @param {string}   [opts.sessionsFile]   - where channel -> session ids persist
   * @param {object}   [opts.acpOptions]     - overrides for DEFAULTS, plus
   *                                           permissionMode / workspaceMcp
   */
  constructor(opts) {
    super(opts);
    const env = this.agentEnv || process.env;
    const { command, args } = resolveCommandConfig(opts, env);
    this.acpCommand = command;
    this.acpArgs = args;
    this.disabledModules = opts.disabledModules || new Set();

    const o = opts.acpOptions || {};
    this._cfg = {
      initTimeoutMs: numberOr(o.initTimeoutMs, DEFAULTS.initTimeoutMs),
      sessionTimeoutMs: numberOr(o.sessionTimeoutMs, DEFAULTS.sessionTimeoutMs),
      loadTimeoutMs: numberOr(o.loadTimeoutMs, DEFAULTS.loadTimeoutMs),
      idleTimeoutMs: numberOr(o.idleTimeoutMs, numberOr(env.ACP_IDLE_TIMEOUT_MS, DEFAULTS.idleTimeoutMs)),
      permissionTimeoutMs: numberOr(o.permissionTimeoutMs, numberOr(env.ACP_PERMISSION_TIMEOUT_MS, DEFAULTS.permissionTimeoutMs)),
      cancelGraceMs: numberOr(o.cancelGraceMs, DEFAULTS.cancelGraceMs),
      previewIntervalMs: numberOr(o.previewIntervalMs, DEFAULTS.previewIntervalMs),
    };
    const mode = String(o.permissionMode || env.ACP_PERMISSION_MODE || 'ask').toLowerCase();
    this._permissionMode = ['ask', 'auto', 'deny'].includes(mode) ? mode : 'ask';
    this._workspaceMcp = o.workspaceMcp !== undefined ? o.workspaceMcp !== false : String(env.ACP_WORKSPACE_MCP || '') !== '0';

    this._conns = {};          // channel -> { conn, sessionId, cwd, loadSession, authMethods, turn }
    this._activeTurns = {};    // channel -> turn
    this._pendingApprovals = new Map(); // approval_id -> { turn, resolve }

    this._sessionsFile = opts.sessionsFile || path.join(
      os.homedir(), '.wwj', 'sessions', `${this.workspaceId}_${this.agentName}_acp.json`,
    );
    this._savedSessions = {};  // channel -> { sessionId, cwd }
    this._loadSessions();

    if (this.acpCommand) {
      this._log(`ACP runtime: ${[this.acpCommand, ...this.acpArgs].join(' ')} (permissions: ${this._permissionMode})`);
    } else {
      this._log('Warning: no ACP command configured (ACP_COMMAND) — this agent cannot run.');
    }
  }

  // ---------------- persistence ----------------

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') Object.assign(this._savedSessions, data);
      }
    } catch {
      this._log('ACP: could not read sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this._sessionsFile), { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._savedSessions));
    } catch {}
  }

  // ---------------- preflight / lifecycle ----------------

  preflight() {
    if (!this.acpCommand) {
      return {
        ok: false,
        reason: 'runtime_missing',
        message:
          'No ACP command configured. Set ACP_COMMAND (e.g. "gemini --experimental-acp", ' +
          '"opencode acp", "claude-code-acp"), or `wwj create <name> --type acp --command <executable>`.',
      };
    }
    const cmd = this.acpCommand;
    const found = /[\\/]/.test(cmd)
      ? fs.existsSync(cmd)
      : (() => { try { return Boolean(whereBinary(cmd) || whichBinary(cmd)); } catch { return true; } })();
    if (!found) {
      return { ok: false, reason: 'runtime_missing', message: `ACP command '${cmd}' was not found on PATH.` };
    }
    return { ok: true };
  }

  stop() {
    super.stop();
    for (const entry of Object.values(this._conns)) {
      try { entry.conn.kill(); } catch {}
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'stop') {
      const only = payload && typeof payload === 'object' ? payload.channel : null;
      const channels = only ? [only] : Object.keys(this._activeTurns);
      for (const channel of channels) {
        delete this._channelQueues[channel];
        const turn = this._activeTurns[channel];
        if (!turn) continue;
        this._cancelTurn(turn, 'user');
        try { await this.sendStatus(channel, 'Execution stopped by user'); } catch {}
      }
      return;
    }
    await super._onControlAction(action, payload);
  }

  /**
   * ACP cancellation: send session/cancel and let the agent wind down, which it
   * signals by resolving session/prompt with stopReason "cancelled". If it has
   * not done so within cancelGraceMs the process is killed, which rejects the
   * prompt request -- so the channel worker is released either way.
   */
  _cancelTurn(turn, why) {
    if (why === 'user') turn.userStopped = true;
    else turn.idleStopped = true;
    this._settleApprovals(turn, 'cancelled');
    turn.conn.notify('session/cancel', { sessionId: turn.sessionId });
    if (!turn.killTimer) {
      turn.killTimer = setTimeout(() => {
        this._log(`ACP: agent did not honour session/cancel within ${this._cfg.cancelGraceMs}ms; killing it`);
        turn.conn.kill();
      }, this._cfg.cancelGraceMs);
    }
  }

  // ---------------- connection & session ----------------

  _workspaceMcpServers(channel) {
    if (!this._workspaceMcp) return [];
    const bin = path.resolve(__dirname, '..', '..', 'bin', 'agent-connector.js');
    if (!fs.existsSync(bin)) return [];
    const args = [
      bin, 'mcp-server',
      '--workspace-id', String(this.workspaceId),
      '--channel-name', String(channel),
      '--agent-name', String(this.agentName),
      '--endpoint', String(this.endpoint),
    ];
    if (this._sessionId) args.push('--session-id', this._sessionId);
    if (this.disabledModules.has('files')) args.push('--disable-files');
    if (this.disabledModules.has('browser')) args.push('--disable-browser');
    // ACP stdio server shape: env is an array of {name, value}.
    return [{
      name: 'wwj-workspace',
      command: process.execPath,
      args,
      env: [{ name: 'WWJ_WORKSPACE_TOKEN', value: String(this.token || '') }],
    }];
  }

  async _startConnection(channel, cwd) {
    const entry = { channel, conn: null, sessionId: null, cwd: null, loadSession: false, authMethods: [], turn: null };
    const conn = new AcpConnection({
      command: this.acpCommand,
      args: this.acpArgs,
      cwd,
      env: { ...(this.agentEnv || process.env) },
      log: (m) => this._log(m),
      onNotification: (method, params) => this._onNotification(entry, method, params),
      onRequest: (method, params) => this._onAgentRequest(entry, method, params),
      onClose: (info, err) => {
        if (this._conns[channel] === entry) delete this._conns[channel];
        this._log(`ACP: agent process for ${channel} closed — ${err.message}`);
      },
    });
    entry.conn = conn;
    conn.start();
    this._conns[channel] = entry;

    let init;
    try {
      init = await conn.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // Honest capabilities: fs text read/write are implemented below;
        // terminal/* is not, so it is declared false.
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: 'wwj', title: '52hzAgents', version: CLIENT_VERSION },
      }, this._cfg.initTimeoutMs);
    } catch (e) {
      conn.kill();
      if (this._conns[channel] === entry) delete this._conns[channel];
      throw new Error(`initialize failed: ${e.message}`);
    }
    init = init || {};
    if (init.protocolVersion !== undefined && init.protocolVersion !== PROTOCOL_VERSION) {
      this._log(`ACP: agent negotiated protocol version ${init.protocolVersion} (client speaks ${PROTOCOL_VERSION})`);
    }
    entry.loadSession = Boolean(init.agentCapabilities && init.agentCapabilities.loadSession);
    entry.authMethods = Array.isArray(init.authMethods) ? init.authMethods : [];
    const info = init.agentInfo || {};
    this._log(`ACP: initialized ${info.name || this.acpCommand}${info.version ? ` ${info.version}` : ''} for ${channel} (loadSession=${entry.loadSession})`);
    return entry;
  }

  _authError(entry, e) {
    const methods = entry.authMethods.map((m) => m && (m.name || m.id)).filter(Boolean);
    return new Error(
      `the agent requires authentication${methods.length ? ` (${methods.join(', ')})` : ''}. ` +
      `Sign in with the agent's own CLI first, then retry. (${e.message})`,
    );
  }

  /**
   * Make sure `channel` has a live process with a session rooted at `cwd`.
   * Returns { entry, isNew } -- isNew is true when the agent has no memory of
   * this conversation (a fresh session/new), false after a successful load or
   * when the live session is reused.
   */
  async _ensureSession(channel, cwd) {
    let entry = this._conns[channel];
    if (entry && entry.conn.closed) {
      delete this._conns[channel];
      entry = null;
    }
    if (!entry) entry = await this._startConnection(channel, cwd);
    if (entry.sessionId && entry.cwd === cwd) return { entry, isNew: false };

    const mcpServers = this._workspaceMcpServers(channel);
    const saved = this._savedSessions[channel];
    if (!entry.sessionId && saved && saved.sessionId && saved.cwd === cwd && entry.loadSession) {
      try {
        // The agent replays the whole conversation as session/update
        // notifications before answering. No turn is attached to the entry
        // yet, so _onNotification drops every one of them.
        await entry.conn.request('session/load', { sessionId: saved.sessionId, cwd, mcpServers }, this._cfg.loadTimeoutMs);
        entry.sessionId = saved.sessionId;
        entry.cwd = cwd;
        this._log(`ACP: loaded session ${saved.sessionId} for ${channel}`);
        return { entry, isNew: false };
      } catch (e) {
        if (entry.conn.closed) throw e;
        this._log(`ACP: session/load failed (${e.message}); starting a new session`);
      }
    }

    let result;
    try {
      result = await entry.conn.request('session/new', { cwd, mcpServers }, this._cfg.sessionTimeoutMs);
    } catch (e) {
      if (!e.processExited && (e.code === -32000 || /auth/i.test(e.message || ''))) throw this._authError(entry, e);
      throw new Error(`session/new failed: ${e.message}`);
    }
    if (!result || !result.sessionId) throw new Error('session/new returned no sessionId');
    entry.sessionId = String(result.sessionId);
    entry.cwd = cwd;
    this._savedSessions[channel] = { sessionId: entry.sessionId, cwd };
    this._saveSessions();
    this._log(`ACP: new session ${entry.sessionId} for ${channel} in ${cwd}`);
    return { entry, isNew: true };
  }

  // ---------------- turn ----------------

  async _handleMessage(msg) {
    let content = (msg.content || '').trim();
    const attText = formatAttachmentsForPrompt(msg.attachments || []);
    if (attText) content = content ? content + attText : attText.trim();
    if (!content) return;

    const channel = msg.sessionId || this.channelName || 'general';
    this._log(`Processing message from ${msg.senderName || msg.senderType || 'user'} in ${channel}`);

    if (!this.acpCommand) {
      await this.sendError(channel, this.preflight().message);
      return;
    }

    try { await this._autoTitleChannel(channel, content); } catch {}
    await this.sendStatus(channel, 'thinking...');

    let cwd = this.workingDir;
    try { cwd = (await this._resolveWorkingDir(channel, content)) || cwd; } catch {}

    let ensured;
    try {
      ensured = await this._ensureSession(channel, cwd);
    } catch (e) {
      this._log(`ACP: could not start agent: ${e.message}`);
      await this.sendError(channel, `ACP agent could not start: ${e.message}`);
      return;
    }

    const text = await this._buildPromptText(channel, msg, content, ensured.isNew);
    await this._runTurn(channel, ensured.entry, text);
  }

  async _buildPromptText(channel, msg, content, isNew) {
    const parts = [];
    if (isNew) {
      // ACP has no system-prompt field, so a fresh session gets the workspace
      // instructions in its first user message (as gemini.js does).
      try {
        parts.push(buildClaudeSystemPrompt({
          agentName: this.agentName,
          workspaceId: this.workspaceId,
          channelName: channel,
          mode: this._mode,
          browserEnabled: this._browserEnabledCache === true,
        }));
      } catch {}
    }
    try {
      const ctx = await this._buildChannelContext(channel, {
        currentMessage: content,
        currentMessageId: msg.id || msg.messageId || null,
        full: isNew,
      });
      if (ctx) parts.push(ctx);
    } catch {}
    if (parts.length === 0) return content;
    return `${parts.join('\n\n---\n\n')}\n\n---\n\nUser message:\n${content}`;
  }

  async _runTurn(channel, entry, text) {
    const conn = entry.conn;
    const turn = {
      channel,
      conn,
      sessionId: entry.sessionId,
      segments: [''],
      pendingPreview: '',
      pendingThought: '',
      flushTimer: null,
      queue: Promise.resolve(),
      tools: new Map(),
      lastActivity: Date.now(),
      awaitingApproval: 0,
      approvals: new Set(),
      userStopped: false,
      idleStopped: false,
      killTimer: null,
    };
    this._activeTurns[channel] = turn;
    entry.turn = turn;

    const idleMs = this._cfg.idleTimeoutMs;
    const watchdog = idleMs > 0 ? setInterval(() => {
      // Waiting on a human is not the agent being stuck.
      if (turn.awaitingApproval > 0) { turn.lastActivity = Date.now(); return; }
      if (!turn.idleStopped && !turn.userStopped && Date.now() - turn.lastActivity > idleMs) {
        this._log(`ACP: no activity for ${Math.round(idleMs / 1000)}s in ${channel}; cancelling`);
        this._cancelTurn(turn, 'idle');
      }
    }, Math.max(50, Math.min(15000, Math.floor(idleMs / 4)))) : null;

    let result;
    let error;
    try {
      result = await conn.request('session/prompt', {
        sessionId: entry.sessionId,
        prompt: [{ type: 'text', text }],
      }, 0);
    } catch (e) {
      error = e;
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (turn.killTimer) clearTimeout(turn.killTimer);
      this._flush(turn);
      try { await turn.queue; } catch {}
      this._settleApprovals(turn, 'cancelled');
      if (this._activeTurns[channel] === turn) delete this._activeTurns[channel];
      if (entry.turn === turn) entry.turn = null;
    }

    const reply = turn.segments.map((s) => s.trim()).filter(Boolean).join('\n\n');
    const idleNote = `ACP agent produced no output for ${Math.round(idleMs / 1000)}s and was stopped`;

    if (error) {
      if (turn.userStopped) return; // the stop handler already said so
      if (!error.processExited && error.code === -32602 && /session/i.test(error.message || '')) {
        // The agent no longer knows this session: start fresh next turn.
        entry.sessionId = null;
        delete this._savedSessions[channel];
        this._saveSessions();
      }
      const message = turn.idleStopped
        ? idleNote
        : error.processExited
          ? `ACP agent exited during the turn. ${error.message}`
          : `ACP agent error: ${error.message}`;
      this._log(message);
      this._markTurnFailed(channel);
      await this.sendError(channel, message);
      return;
    }

    const stopReason = (result && result.stopReason) || 'end_turn';
    let body;
    if (stopReason === 'cancelled') {
      if (turn.userStopped) return;
      if (turn.idleStopped) {
        this._markTurnFailed(channel);
        await this.sendError(channel, idleNote);
        return;
      }
      if (!reply) {
        try { await this.sendStatus(channel, 'The agent cancelled the turn'); } catch {}
        return;
      }
      body = reply;
    } else if (stopReason === 'refusal') {
      body = reply || 'The agent declined this request.';
    } else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      body = reply
        ? `${reply}\n\n_(The agent stopped early: ${stopReason}.)_`
        : `The agent stopped before finishing (${stopReason}).`;
    } else {
      body = reply || 'No response generated. Please try again.';
    }
    try {
      await this.sendResponse(channel, body);
    } catch (e) {
      this._log(`ACP: reply could not be posted: ${e.message}`);
    }
  }

  // ---------------- streaming ----------------

  _enqueue(turn, fn) {
    turn.queue = turn.queue.then(fn).catch((e) => this._log(`ACP: post failed: ${e && e.message}`));
  }

  /** Post whatever preview/thought text is buffered, preserving order. */
  _flush(turn) {
    if (turn.flushTimer) { clearTimeout(turn.flushTimer); turn.flushTimer = null; }
    const thought = turn.pendingThought;
    const preview = turn.pendingPreview;
    turn.pendingThought = '';
    turn.pendingPreview = '';
    // Only one of the two is ever non-empty: switching kind flushes first.
    if (thought.trim()) this._enqueue(turn, () => this.sendThinking(turn.channel, thought));
    if (preview.trim()) this._enqueue(turn, () => this.sendThinking(turn.channel, preview, { isReplyPreview: true }));
  }

  _scheduleFlush(turn) {
    if (this._cfg.previewIntervalMs <= 0) { this._flush(turn); return; }
    if (!turn.flushTimer) turn.flushTimer = setTimeout(() => { turn.flushTimer = null; this._flush(turn); }, this._cfg.previewIntervalMs);
  }

  _onNotification(entry, method, params) {
    if (method !== 'session/update') return;
    const turn = entry.turn;
    // No turn attached means history replay during session/load (or a stray
    // late update after the turn ended): nothing to show.
    if (!turn || !params || params.sessionId !== turn.sessionId) return;
    const u = params.update || {};
    turn.lastActivity = Date.now();

    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(u.content);
        if (!text) return;
        if (turn.pendingThought) this._flush(turn);
        turn.segments[turn.segments.length - 1] += text;
        turn.pendingPreview += text;
        this._scheduleFlush(turn);
        return;
      }
      case 'agent_thought_chunk': {
        const text = textOf(u.content);
        if (!text) return;
        if (turn.pendingPreview) this._flush(turn);
        turn.pendingThought += text;
        this._scheduleFlush(turn);
        return;
      }
      case 'tool_call':
        this._onToolCall(turn, u, true);
        return;
      case 'tool_call_update':
        this._onToolCall(turn, u, false);
        return;
      case 'plan': {
        if (!Array.isArray(u.entries)) return;
        const todos = u.entries
          .filter((e) => e && typeof e.content === 'string' && e.content.trim())
          .map((e) => ({ content: e.content, status: TODO_STATUSES.has(e.status) ? e.status : 'pending' }));
        this._enqueue(turn, () => this.sendTodos(turn.channel, todos));
        return;
      }
      case 'usage_update':
        // `used` = tokens currently in context, `size` = the context window.
        this.reportContext(turn.channel, { promptTokens: u.used, contextWindow: u.size });
        return;
      default:
        // user_message_chunk, available_commands_update, current_mode_update,
        // session_info_update, config_option_update: nothing to show.
        return;
    }
  }

  /**
   * One workspace line per tool call (see BaseAdapter.sendToolCall: the
   * frontend draws every message as its own line and does not pair them).
   * So: the call is posted once when it first appears, as 'running' unless it
   * already carries a terminal status; a later update posts again only when
   * the call FAILED, because that is the one outcome worth a second line.
   */
  _onToolCall(turn, u, isNew) {
    const id = u.toolCallId ? String(u.toolCallId) : '';
    const known = id ? turn.tools.get(id) : null;
    const merged = {
      title: u.title || (known && known.title) || '',
      kind: u.kind || (known && known.kind) || '',
      args: u.rawInput !== undefined ? u.rawInput : (known && known.args),
      posted: Boolean(known && known.posted),
      failedPosted: Boolean(known && known.failedPosted),
    };
    if (id) turn.tools.set(id, merged);

    const status = u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'failed' : 'running';
    const name = merged.kind && merged.kind !== 'other' ? merged.kind : (merged.title || 'tool');
    const post = (st) => {
      this._flush(turn);
      this._enqueue(turn, () => this.sendToolCall(turn.channel, {
        name,
        args: merged.args,
        status: st,
        id: id || undefined,
        summary: merged.title || undefined,
      }));
    };

    if (isNew || !merged.posted) {
      if (!isNew && !merged.title && !merged.kind) return;
      // Text after a tool call is a new paragraph of the reply.
      if (turn.segments[turn.segments.length - 1].trim()) turn.segments.push('');
      merged.posted = true;
      if (status === 'failed') merged.failedPosted = true;
      post(status);
      return;
    }
    if (status === 'failed' && !merged.failedPosted) {
      merged.failedPosted = true;
      post('failed');
    }
  }

  // ---------------- requests from the agent ----------------

  async _onAgentRequest(entry, method, params) {
    switch (method) {
      case 'session/request_permission':
        return this._onPermissionRequest(entry, params);
      case 'fs/read_text_file':
        return this._fsRead(params);
      case 'fs/write_text_file':
        return this._fsWrite(entry, params);
      default:
        // terminal/* is not advertised, so an agent should never ask.
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  /*
    PERMISSION POLICY.

    Most adapters here run their CLI fully unattended (claude with
    --dangerously-skip-permissions, codex with --dangerously-bypass-approvals-
    and-sandbox), but the workspace DOES have a real approval flow -- the
    tool_approval_request card that openclaw.js publishes, answered by a human
    with a tool_approval_response that BaseAdapter routes to
    _handleApprovalResponse. ACP hands us each permission decision explicitly,
    so the least-privilege choice is to use that flow:

      ask  (default) -- post an approval card; grant -> allow_once, decline or
                        no answer within ACP_PERMISSION_TIMEOUT_MS -> reject_once.
      auto           -- select allow_once without asking (the unattended
                        behaviour of the other adapters), logged per call.
      deny           -- select reject_once for everything.

    allow_always / reject_always are never chosen on anyone's behalf; they are
    only used when the agent offers no *_once option at all. In plan mode,
    edit/delete/move/execute calls are refused without asking.
  */
  async _onPermissionRequest(entry, params) {
    const turn = entry.turn;
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (!turn || turn.userStopped || turn.idleStopped) return cancelled;
    turn.lastActivity = Date.now();

    const options = Array.isArray(params.options) ? params.options : [];
    const tc = params.toolCall || {};
    const known = tc.toolCallId ? turn.tools.get(String(tc.toolCallId)) : null;
    const title = tc.title || (known && known.title) || tc.kind || 'a tool call';
    const kind = tc.kind || (known && known.kind) || '';
    const args = tc.rawInput !== undefined ? tc.rawInput : (known && known.args);

    let decision;
    let why;
    if (this._mode === 'plan' && WRITE_KINDS.has(kind)) {
      decision = 'denied';
      why = 'plan mode';
    } else if (this._permissionMode === 'auto') {
      decision = 'granted';
      why = 'ACP_PERMISSION_MODE=auto';
    } else if (this._permissionMode === 'deny') {
      decision = 'denied';
      why = 'ACP_PERMISSION_MODE=deny';
    } else {
      this._flush(turn);
      try { await turn.queue; } catch {}
      decision = await this._askWorkspaceApproval(turn, { title, kind, args });
      why = `workspace approval: ${decision}`;
    }

    let outcome = cancelled;
    if (decision === 'granted' || decision === 'denied') {
      const prefs = decision === 'granted' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
      for (const k of prefs) {
        const opt = options.find((o) => o && o.kind === k);
        if (opt) { outcome = { outcome: { outcome: 'selected', optionId: opt.optionId } }; break; }
      }
    }
    this._log(`ACP permission "${title}" -> ${outcome.outcome.optionId || 'cancelled'} (${why})`);
    return outcome;
  }

  async _askWorkspaceApproval(turn, { title, kind, args }) {
    const approvalId = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    turn.awaitingApproval++;
    let settle;
    const decided = new Promise((resolve) => {
      const timer = this._cfg.permissionTimeoutMs > 0
        ? setTimeout(() => settle('timeout'), this._cfg.permissionTimeoutMs)
        : null;
      settle = (value) => {
        if (!this._pendingApprovals.has(approvalId)) return;
        if (timer) clearTimeout(timer);
        this._pendingApprovals.delete(approvalId);
        turn.approvals.delete(approvalId);
        resolve(value);
      };
      this._pendingApprovals.set(approvalId, { turn, resolve: settle });
      turn.approvals.add(approvalId);
    });

    try {
      await this.client.sendMessage(this.workspaceId, turn.channel, this.token,
        `${this.agentName} needs your approval: ${title}`, {
          senderType: 'agent',
          senderName: this.agentName,
          messageType: 'chat',
          sessionId: this._sessionId,
          metadata: {
            tool_approval_request: {
              approval_id: approvalId,
              tool: title,
              kind: kind || undefined,
              args: args && typeof args === 'object' ? args : (args !== undefined ? { input: args } : {}),
            },
          },
        });
    } catch (e) {
      // Nobody can see the card, so nobody can approve: decline.
      this._log(`ACP: could not post approval request (${e.message}); declining`);
      settle('unavailable');
    }

    const decision = await decided;
    turn.awaitingApproval = Math.max(0, turn.awaitingApproval - 1);
    turn.lastActivity = Date.now();
    if (decision === 'timeout') {
      try {
        await this.sendStatus(turn.channel,
          `No answer to the approval request within ${Math.round(this._cfg.permissionTimeoutMs / 1000)}s — declined: ${title}`);
      } catch {}
      return 'denied';
    }
    if (decision === 'unavailable') return 'denied';
    return decision;
  }

  _settleApprovals(turn, value) {
    for (const id of [...turn.approvals]) {
      const pending = this._pendingApprovals.get(id);
      if (pending) pending.resolve(value);
    }
  }

  async _handleApprovalResponse(msg) {
    const response = msg && msg.metadata && msg.metadata.tool_approval_response;
    const id = response && response.approval_id;
    const pending = id ? this._pendingApprovals.get(id) : null;
    if (!pending) return false;
    pending.resolve(response.granted ? 'granted' : 'denied');
    this._log(`ACP approval ${String(id).slice(0, 16)} ${response.granted ? 'granted' : 'declined'}`);
    return true;
  }

  // ---------------- client fs ----------------

  _fsRead(params) {
    const p = params && params.path;
    if (!p || !path.isAbsolute(p)) throw rpcError(-32602, 'path must be absolute');
    let content;
    try {
      content = fs.readFileSync(p, 'utf-8');
    } catch (e) {
      throw rpcError(e.code === 'ENOENT' ? -32002 : -32603, `Cannot read ${p}: ${e.message}`);
    }
    const line = Number(params.line) > 0 ? Math.floor(Number(params.line)) : null;
    const limit = Number(params.limit) > 0 ? Math.floor(Number(params.limit)) : null;
    if (line || limit) {
      const lines = content.split('\n');
      const start = (line || 1) - 1;
      content = lines.slice(start, limit ? start + limit : undefined).join('\n');
    }
    return { content };
  }

  _fsWrite(entry, params) {
    if (this._mode === 'plan') throw rpcError(-32000, 'Writing files is disabled in plan mode');
    const p = params && params.path;
    if (!p || !path.isAbsolute(p)) throw rpcError(-32602, 'path must be absolute');
    if (typeof params.content !== 'string') throw rpcError(-32602, 'content must be a string');
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, params.content, 'utf-8');
    } catch (e) {
      throw rpcError(-32603, `Cannot write ${p}: ${e.message}`);
    }
    this.registerProducedFile(entry.channel, p).catch(() => {});
    return {};
  }
}

module.exports = AcpAdapter;
module.exports.AcpConnection = AcpConnection;
module.exports.splitCommandLine = splitCommandLine;
module.exports.resolveCommandConfig = resolveCommandConfig;
