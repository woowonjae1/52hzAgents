/**
 * OpenCode adapter for OpenAgents workspace.
 *
 * Bridges OpenCode (opencode-ai) to an OpenAgents workspace by running
 * `opencode run --format json` as a subprocess. OpenCode handles its own
 * model configuration, provider selection, and tool chain.
 *
 * Port of Python PR #316: sdk/src/openagents/adapters/opencode.py
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { formatAttachmentsForPrompt, logRawEvent } = require('./utils');
const { buildOpenCodeSkillMd, buildOpenCodeSystemPrompt } = require('./workspace-prompt');
const { whichBinary, whereBinary, getEnhancedEnv } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';

// Max wall-clock for a single `opencode run`. When it fires, Node kills the
// child with SIGTERM, the 'close' handler sees signal='SIGTERM' / code=null.
const TIMEOUT_MS = 300000; // 5 minutes

/**
 * Kilo Code's CLI is a fork of opencode — same `run` subcommand, same
 * `--format json` stream, same `-m/--model provider/model`, same `models`
 * subcommand (its own logs even identify the service as "opencode"). One
 * adapter therefore serves both, but they are NOT one agent type: the version
 * lines (1.18.x vs 7.4.x) are not on the same scale, and the binaries, install
 * commands, config directories and credentials are all separate.
 *
 * Everything that differs between them lives here and nowhere else. Do NOT use
 * @latest in any install command — this adapter parses the CLI's stream-json,
 * so an unbounded version floats the event schema out from under us.
 */
const FLAVORS = {
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    // Ordered: the first name that resolves wins.
    binaryCandidates: ['opencode'],
    packageName: 'opencode-ai',
    // `run` is verified against 1.18.23 on 2026-08-26: the emitted stream
    // (`step_start` / `text` / `step_finish`, part carried at the TOP level
    // rather than under `properties`) was captured and replayed through
    // _extractTextFromEvent, which assembled the reply correctly.
    pinnedVersion: '1.18.23',
    minVersion: '1.17.0',
    testedMaxVersion: '1.18.23',
    configDir: path.join(os.homedir(), '.config', 'opencode'),
    // Where the CLI keeps the model the *user* chose. Read-only to us.
    configFiles: ['opencode.jsonc', 'opencode.json', 'config.json'],
    modelEnvVars: ['OPENCODE_MODEL', 'LLM_MODEL'],
  },
  kilocode: {
    id: 'kilocode',
    displayName: 'Kilo Code',
    binaryCandidates: ['kilocode', 'kilo'],
    packageName: '@kilocode/cli',
    // 7.4.23 verified 2026-08-26 only as far as CLI behaviour: it accepted the
    // headless run and returned a well-formed `{"type":"error"}` event (the
    // stored provider key was 401). A successful assistant turn has NOT yet
    // been captured on this line — see scripts/diagnose-opencode.js.
    pinnedVersion: '7.4.23',
    minVersion: '7.0.0',
    testedMaxVersion: '7.4.23',
    configDir: path.join(os.homedir(), '.config', 'kilo'),
    configFiles: ['kilo.jsonc', 'kilo.json', 'config.json'],
    modelEnvVars: ['KILO_MODEL', 'KILOCODE_MODEL', 'LLM_MODEL'],
  },
};

/** Resolve an agent type / name to a flavor, defaulting to opencode. */
function resolveFlavor(agentType, agentName) {
  const t = String(agentType || '').toLowerCase();
  if (FLAVORS[t]) return FLAVORS[t];
  if (t === 'kilo') return FLAVORS.kilocode;
  // Legacy fallback: before kilocode was its own agent type the only surviving
  // signal was the agent's name. Kept so existing installs keep working.
  const n = String(agentName || '').toLowerCase();
  if (n.includes('kilo')) return FLAVORS.kilocode;
  return FLAVORS.opencode;
}

// How long a detected CLI version / executability probe is cached on the
// adapter instance, so preflight never spawns `--version` more than once per
// window across channels.
const VERSION_PROBE_TTL_MS = 60000;

// Short, de-identified, actionable user messages per failure category. These
// must NEVER default to "run auth login": only credential_missing / auth_failed
// mention authentication. Diagnostics (exit code, signal, redacted stdout/
// stderr) go to the daemon log, not to these.
/**
 * Per-flavor user-facing messages. Built from the flavor so a Kilo user is
 * never told to `npm install -g opencode-ai` — the old hardcoded hint sent them
 * to the wrong package entirely.
 */
function failureMessages(flavor) {
  const f = flavor || FLAVORS.opencode;
  const name = f.displayName;
  const install = `npm install -g ${f.packageName}@${f.pinnedVersion}`;
  const cli = f.binaryCandidates[0];
  return {
  cli_not_found: `${name} CLI not found. Install it (\`${install}\`) and try again.`,
  cli_not_executable: `${name} CLI was found but could not be started. Reinstall it, then retry.`,
  unsupported_version: `This ${name} CLI version is not supported (requires >= ${f.minVersion}). Reinstall \`${install}\` and retry.`,
  unverified_version: `This ${name} CLI version is newer than the highest version this adapter has been verified against (${f.testedMaxVersion}). Execution was blocked rather than risk a run that produces no output. Install \`${install}\`, or set WWJ_ALLOW_UNVERIFIED_CLI_VERSION=1 to run anyway.`,
  model_missing: `No model is configured for ${name}. Choose one in the ${name} TUI (or its config at ${f.configDir}), then retry — this workspace forwards the model you picked and never selects one for you.`,
  credential_missing: `${name} has no API key or sign-in configured. Add an API key (LLM_API_KEY) or run \`${cli} auth login\`, then retry.`,
  auth_failed: `${name}'s provider rejected the credentials (authentication failed). Check the API key or sign-in and retry.`,
  provider_not_configured: `${name} has no usable provider configured. Configure a provider and model, then retry.`,
  model_not_found: 'The configured model was not found or is not accessible. Check the model name and your access, then retry.',
  rate_limited: 'The provider is rate-limiting requests. Wait a moment and retry.',
  network_error: `${name} could not reach the provider (network or service error). Retry shortly.`,
  provider_server_error: 'The provider returned a server error. Retry shortly.',
  timeout: `${name} timed out before producing a reply. Retry; if it persists, check the model and provider configuration.`,
  stream_parse_error: `${name} produced output this version could not parse. Update to a supported ${name} version, or open diagnostics.`,
  empty_response: `${name} finished without producing a final reply. Retry; if it persists, open diagnostics.`,
  process_crashed: `${name} exited unexpectedly. Open diagnostics or retry.`,
  cwd_unavailable: `${name}'s working directory is not accessible. Check the agent home directory's permissions.`,
  unknown_error: `${name} failed for an undetermined reason. Open diagnostics or retry.`,
  };
}

class OpenCodeAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {Set} [opts.disabledModules]
   * @param {string} [opts.workingDir]
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();

    // Which CLI this instance drives. Everything version-, binary-, config- and
    // message-related reads off this, so opencode and kilo never share a
    // version scale or an install hint again.
    this.flavor = resolveFlavor(opts.agentType, this.agentName);
    this._messages = failureMessages(this.flavor);
    // Per-run model overrides from the UI: channel → model id. Deliberately
    // NOT persisted and never written into the CLI's own config — the CLI
    // remains the owner of the default, this only applies to the next turn.
    this._channelModels = {};

    // Agent home directory: ~/.wwj/agents/{agentName}/
    this.agentHome = path.join(os.homedir(), '.wwj', 'agents', this.agentName);
    fs.mkdirSync(this.agentHome, { recursive: true });

    this._channelSessions = {};
    this._sessionsFile = path.join(this.agentHome, 'sessions.json');
    this._migrateSessionsFile();
    this._loadSessions();

    // Process tracking for stop control
    this._channelProcesses = {}; // channel → child process
    this._stoppingChannels = new Set();

    this._opencodeBinary = this._findOpencodeBinary();
    if (this._opencodeBinary) {
      this._log(`Using ${this.flavor.displayName} subprocess mode: ${this._opencodeBinary}`);
    } else {
      this._log(
        `${this.flavor.displayName} binary not found. Install with: ` +
        `npm install -g ${this.flavor.packageName}@${this.flavor.pinnedVersion}`
      );
    }
  }

  /**
   * Migrate sessions file from old location to agent home.
   */
  _migrateSessionsFile() {
    const oldPath = path.join(
      os.homedir(), '.wwj', 'sessions',
      `${this.workspaceId}_${this.agentName}_opencode.json`
    );
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(this._sessionsFile)) {
        fs.copyFileSync(oldPath, this._sessionsFile);
        fs.unlinkSync(oldPath);
        this._log(`Migrated sessions file from ${oldPath}`);
      }
    } catch {}
  }

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelSessions, data);
          this._log(`Loaded ${Object.keys(data).length} session(s)`);
        }
      }
    } catch {
      this._log('Could not load sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this._sessionsFile), { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelSessions));
    } catch {}
  }

  async _onControlAction(action, payload) {
    if (action === 'stop') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel) {
        const proc = this._channelProcesses[channel];
        const hadQueuedWork = !!this._channelQueues[channel]?.length;
        if (proc) {
          this._log(`Stopping process for channel=${channel}`);
          this._stoppingChannels.add(channel);
          await this._stopProcess(proc);
          delete this._channelProcesses[channel];
        }
        delete this._channelQueues[channel];
        if (proc || hadQueuedWork) {
          try {
            await this.sendResponse(channel, 'Execution stopped by user.');
          } catch {}
        }
      } else {
        await this._stopAllProcesses('Execution stopped by user.');
      }
      return;
    }
    await super._onControlAction(action, payload);
  }

  /**
   * Write workspace skill to OpenCode's skill directory for auto-discovery.
   */
  _ensureWorkspaceSkill(channelName) {
    const skillDir = path.join(this.agentHome, '.opencode', 'skills');
    const skillFile = path.join(skillDir, 'wwj-workspace.md');
    try {
      const content = buildOpenCodeSkillMd({
        endpoint: this.endpoint,
        workspaceId: this.workspaceId,
        token: this.token,
        agentName: this.agentName,
        channelName,
        disabledModules: this.disabledModules,
      });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillFile, content, 'utf-8');
    } catch {}
  }

  _buildSystemContext(channelName) {
    return buildOpenCodeSystemPrompt({
      agentName: this.agentName,
      workspaceId: this.workspaceId,
      channelName,
      endpoint: this.endpoint,
      token: this.token,
      mode: this._mode,
      disabledModules: this.disabledModules,
    });
  }

  // ------------------------------------------------------------------
  // Binary discovery
  // ------------------------------------------------------------------

  _findOpencodeBinary() {
    const home = os.homedir();
    const ext = IS_WINDOWS ? '.cmd' : '';

    // Only this flavor's binaries. The old code sniffed the agent *name* for
    // "kilo" and fell back across flavors, so a kilocode agent named anything
    // else silently ran the opencode binary against kilo's config.
    const binNames = this.flavor.binaryCandidates;

    for (const name of binNames) {
      const nativeExe = path.join(home, '.wwj', 'runtimes', name, 'node_modules', `${name}-ai`, 'bin', `${name}.exe`);
      if (fs.existsSync(nativeExe)) return nativeExe;

      const runtimeBin = path.join(home, '.wwj', 'runtimes', name, 'node_modules', '.bin', `${name}${ext}`);
      if (fs.existsSync(runtimeBin)) return runtimeBin;

      const legacyBin = path.join(home, '.wwj', 'nodejs', 'node_modules', '.bin', `${name}${ext}`);
      if (fs.existsSync(legacyBin)) return legacyBin;

      const viaWhere = whereBinary(name);
      if (viaWhere) return viaWhere;

      const nearNode = path.join(path.dirname(process.execPath), `${name}${ext}`);
      if (fs.existsSync(nearNode)) return nearNode;

      const candidates = IS_WINDOWS ? [
        path.join(process.env.APPDATA || '', 'npm', `${name}.cmd`),
      ] : [
        path.join(home, '.wwj', 'npm-global', 'bin', name),
        path.join(home, '.npm-global', 'bin', name),
        path.join(home, '.local', 'bin', name),
        `/usr/local/bin/${name}`,
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }

      const viaWhich = whichBinary(name);
      if (viaWhich) return viaWhich;
    }

    return null;
  }

  // ------------------------------------------------------------------
  // Message handler
  // ------------------------------------------------------------------

  async _handleMessage(msg) {
    let content = (msg.content || '').trim();
    const attachments = msg.attachments || [];

    const attText = formatAttachmentsForPrompt(attachments);
    if (attText) {
      content = content ? content + attText : attText.trim();
    }

    if (!content) return;

    const msgChannel = msg.sessionId || this.channelName;
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing message from ${sender} in ${msgChannel}: ${content.slice(0, 80)}...`);

    await this._autoTitleChannel(msgChannel, content);
    await this.sendStatus(msgChannel, 'thinking...');

    try {
      const responseText = await this._runOpencode(content, msgChannel);

      if (this._stoppingChannels.has(msgChannel)) {
        this._stoppingChannels.delete(msgChannel);
        return;
      }

      // The only way _runOpencode resolves empty now is the stop path (handled
      // above). Every real failure — including exit 0 with no assistant text —
      // is thrown with a category and handled in catch, so we no longer post a
      // generic "produced no response" that misattributes everything to auth.
      if (responseText) {
        await this.sendResponse(msgChannel, responseText);
      }
    } catch (e) {
      if (this._stoppingChannels.has(msgChannel)) {
        this._stoppingChannels.delete(msgChannel);
        return;
      }
      const category = (e && e.category) ? e.category : this._classifyErrno(e);
      const diagnostic = OpenCodeAdapter._redact((e && (e.diagnostic || e.message)) || '');
      this._log(`OpenCode failure [${category}] in ${msgChannel}: ${diagnostic.slice(0, 300)}`);
      await this._sendClassifiedError(msgChannel, category, e && e.detail);
    }
  }

  // ------------------------------------------------------------------
  // JSON output parsing
  // ------------------------------------------------------------------

  /**
   * Split a string containing concatenated JSON objects.
   */
  static _splitJsonObjects(raw) {
    return OpenCodeAdapter._drainJsonObjects(raw).objects;
  }

  /**
   * Extract complete JSON objects from a possibly partial stream buffer.
   * Returns unparsed trailing text as `rest` so callers can prepend it to the
   * next stdout chunk. OpenCode may concatenate JSON objects without newlines.
   */
  static _drainJsonObjects(raw) {
    const objects = [];
    raw = String(raw || '');
    let pos = 0;
    while (pos < raw.length) {
      if (' \t\r\n'.includes(raw[pos])) { pos++; continue; }
      if (raw[pos] !== '{') { pos++; continue; }
      // Find matching brace
      let depth = 0;
      let inStr = false;
      let escaped = false;
      const start = pos;
      for (let i = pos; i < raw.length; i++) {
        const ch = raw[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inStr) { escaped = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              const obj = JSON.parse(raw.slice(start, i + 1));
              logRawEvent('opencode', obj);
              if (typeof obj === 'object' && obj !== null) objects.push(obj);
            } catch {}
            pos = i + 1;
            break;
          }
        }
        if (i === raw.length - 1) pos = raw.length; // no match, skip
      }
      if (depth !== 0) return { objects, rest: raw.slice(start) };
    }
    return { objects, rest: '' };
  }

  /**
   * Extract user-visible text from a single opencode JSON event.
   */
  /**
   * The part carried by an event, and its incremental text, across both event
   * shapes this CLI has shipped.
   *
   * Current opencode nests it as `event.properties.part` under
   * `type: 'message.part.updated'`, with the increment in
   * `event.properties.delta`. Older output put the part flat on `event.part`.
   * Reading only one of the two is how a whole event class goes missing after a
   * CLI upgrade with nothing in the logs to say so.
   */
  static _partOf(event) {
    const props = (event && event.properties) || {};
    const part = props.part || event.part || null;
    if (!part || typeof part !== 'object') return null;
    const delta = typeof props.delta === 'string' ? props.delta : (typeof event.delta === 'string' ? event.delta : '');
    return { part, type: String(part.type || ''), text: delta || part.text || part.content || '' };
  }

  /**
   * The model's reasoning, if this event carries any.
   *
   * opencode's part union includes a `reasoning` type alongside `text`, and
   * nothing here used to look at `part.type` at all — `_extractTextFromEvent`
   * pulled `part.text` out of BOTH and the caller sent the result on as a reply
   * preview. So reasoning was not merely dropped, it was labelled as the answer:
   * once the real answer arrived, the workspace's de-duplication removed it as a
   * duplicate. Reasoning has to be identified here or it is actively destroyed
   * further down.
   */
  static _extractReasoningFromEvent(event) {
    const info = OpenCodeAdapter._partOf(event);
    if (!info || info.type !== 'reasoning') return null;
    return info.text || null;
  }

  static _extractTextFromEvent(event) {
    if (!event || typeof event !== 'object') return null;
    // Reasoning is not answer text. Claimed here first so it cannot fall through
    // to the generic `part.text` read below and be mistaken for the reply.
    const info = OpenCodeAdapter._partOf(event);
    if (info && info.type && info.type !== 'text') return null;
    // A nested `message.part.updated` keeps its increment in
    // `properties.delta`, which the flat `event.part` read below cannot see —
    // so a text part in the current event shape would come back empty.
    if (info && info.text) return info.text;
    // Control / tool / error events carry no user-visible assistant text. Match
    // both underscore and hyphen spellings (`step_finish` vs `step-finish`) and
    // detect tool events by shape, since opencode's exact top-level `type`
    // string varies across versions.
    const eventType = String(event.type || '').toLowerCase();
    if (['step_start', 'step-start', 'step_finish', 'step-finish', 'tool_use', 'tool'].includes(eventType)) return null;
    if (OpenCodeAdapter._isToolEvent(event)) return null;
    if (eventType.includes('error')) return null;

    const part = event.part;
    if (part && typeof part === 'object') {
      const text = part.text || part.content || '';
      if (text) return text;
    }

    const item = event.item || event;
    const text = item.text || item.content || '';
    return text || null;
  }

  static _toolStatusFromEvent(event) {
    if (!OpenCodeAdapter._isToolEvent(event)) return null;

    const item = event.item || event.part || event.tool || event;
    const toolName = OpenCodeAdapter._safeToolName(
      item.name || item.tool || item.toolName || item.id || 'tool'
    );
    const input = OpenCodeAdapter._toolInputFromItem(item);
    const preview = OpenCodeAdapter._toolInputPreview(input);

    return OpenCodeAdapter._formatToolStatus(toolName, preview);
  }

  static _safeToolName(name) {
    return String(name || 'tool').replace(/[`\\]/g, '').slice(0, 80) || 'tool';
  }

  static _toolInputFromItem(item) {
    if (!item || typeof item !== 'object') return {};
    if (item.state && typeof item.state === 'object' && item.state.input) {
      return item.state.input;
    }
    return item.input || item.args || item.arguments || item.parameters || item.params || {};
  }

  static _toolInputPreview(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input.slice(0, 1000);
    try {
      return JSON.stringify(input, null, 2).slice(0, 1000);
    } catch {
      return String(input).slice(0, 1000);
    }
  }

  static _markdownFence(body) {
    const runs = String(body || '').match(/`+/g) || [];
    const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 2);
    return '`'.repeat(Math.max(3, maxRun + 1));
  }

  static _formatToolStatus(toolName, preview) {
    const header = `**Using tool:** \`${toolName}\``;
    const body = String(preview || '').trim();
    if (!body) return header;
    const fence = OpenCodeAdapter._markdownFence(body);
    return `${header}\n${fence}\n${body}\n${fence}`;
  }

  async _handleStreamEvent(event, msgChannel, responseState = null) {
    const status = OpenCodeAdapter._toolStatusFromEvent(event);
    if (status) {
      // A tool call resets `finalText` (the "text since the last tool"), so the
      // final answer is the text emitted AFTER the last tool. But we keep
      // `allText` intact: if the run ends on a tool with no closing text, the
      // earlier assistant text is still recoverable instead of being reported
      // as an empty response (see _finalTextFromStdout).
      if (responseState) responseState.finalText = '';
      await this.sendStatus(msgChannel, status);
      return;
    }

    // Reasoning first, and unflagged: it belongs in the Thought disclosure, and
    // it must NOT be added to `finalText` — it is not part of the answer.
    const reasoning = OpenCodeAdapter._extractReasoningFromEvent(event);
    if (reasoning && reasoning.trim()) {
      try { await this.sendThinking(msgChannel, reasoning.trim()); } catch {}
      return;
    }

    const text = OpenCodeAdapter._extractTextFromEvent(event);
    if (text) {
      if (responseState) {
        responseState.seenText = true;
        responseState.finalText += text;
        responseState.allText = (responseState.allText || '') + text;
      }
      if (text.trim()) await this.sendThinking(msgChannel, text.trim(), { isReplyPreview: true });
    }
  }

  /**
   * Extract human-readable text from opencode --format json output.
   */
  static _extractTextFromJson(raw) {
    const events = OpenCodeAdapter._splitJsonObjects(raw);
    if (!events.length) return raw.trim();

    const texts = [];
    for (const event of events) {
      const text = OpenCodeAdapter._extractTextFromEvent(event);
      if (text) texts.push(text);
    }
    return texts.length ? texts.join('\n').trim() : raw.trim();
  }

  static _finalTextFromStdout(raw, responseState = null) {
    raw = String(raw || '').trim();
    if (!raw) return '';
    if (OpenCodeAdapter._isOnlyControlJson(raw)) return '';
    if (responseState && responseState.seenText) {
      // Prefer text after the last tool call (the natural final answer); fall
      // back to everything streamed so a `text -> tool -> exit` sequence is not
      // misreported as empty.
      return (responseState.finalText || '').trim() || (responseState.allText || '').trim();
    }
    return OpenCodeAdapter._extractTextFromJson(raw);
  }

  /**
   * True when `raw` is opencode JSON that carries ONLY control events
   * (step_start / step_finish / tool_use) and no assistant text — which is what
   * opencode emits when no model/provider is configured. In that case
   * _extractTextFromJson falls back to returning the raw event JSON, which we
   * must NOT post to the channel as if it were a reply. Non-JSON output (real
   * plain text) returns false so it is kept.
   */
  static _isOnlyControlJson(raw) {
    const events = OpenCodeAdapter._splitJsonObjects(raw);
    if (!events.length) return false;
    for (const ev of events) {
      if (OpenCodeAdapter._extractTextFromEvent(ev)) return false;
    }
    return true;
  }

  /**
   * Extract and persist session_id from OpenCode JSON events.
   */
  _persistSessionId(channel, rawOutput) {
    const events = OpenCodeAdapter._splitJsonObjects(rawOutput);
    let sessionId = null;
    for (const event of events) {
      let sid = event.sessionID;
      if (!sid && event.session && typeof event.session === 'object') {
        sid = event.session.id;
      }
      if (!sid && event.part && typeof event.part === 'object') {
        sid = event.part.sessionID;
      }
      if (sid && typeof sid === 'string') sessionId = sid;
    }

    if (sessionId) {
      const prev = this._channelSessions[channel];
      this._channelSessions[channel] = sessionId;
      this._saveSessions();
      if (prev !== sessionId) {
        this._log(`OpenCode session for channel ${channel}: ${sessionId}`);
      }
    }
  }

  /**
   * Override BaseAdapter.stop so daemon shutdown also tears down in-flight
   * opencode subprocesses cleanly.
   */
  stop() {
    this._stopAllProcesses(
      'Task interrupted — daemon restarting. Send another message to continue.'
    ).catch(() => {});
    super.stop();
  }

  async _stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (IS_WINDOWS) {
        try { proc.kill('SIGINT'); } catch {}
        const exited = await new Promise((resolve) => {
          if (proc.exitCode !== null) {
            resolve(true);
            return;
          }
          const timeout = setTimeout(() => resolve(false), 1500);
          proc.once('exit', () => { clearTimeout(timeout); resolve(true); });
        });
        if (!exited) {
          try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch {}
        }
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {
          proc.kill('SIGTERM');
        }
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          const timeout = setTimeout(() => {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch {
              proc.kill('SIGKILL');
            }
            const reapTimeout = setTimeout(finish, 1000);
            proc.once('exit', () => { clearTimeout(reapTimeout); finish(); });
          }, 1500);
          proc.once('exit', () => { clearTimeout(timeout); finish(); });
        });
      }
    } catch {}
  }

  async _stopAllProcesses(completionMessage = 'Execution stopped.') {
    const entries = Object.entries(this._channelProcesses);
    if (!entries.length) return;
    this._log(`Stopping ${entries.length} running process(es)...`);
    for (const [channel, proc] of entries) {
      this._stoppingChannels.add(channel);
      await this._stopProcess(proc);
      delete this._channelProcesses[channel];
      delete this._channelQueues[channel];
      try {
        await this.sendResponse(channel, completionMessage);
      } catch {}
    }
  }

  // ------------------------------------------------------------------
  // Subprocess execution
  // ------------------------------------------------------------------

  /**
   * Build the `--model` value (provider/model) for `opencode run`.
   *
   * CRITICAL: opencode-ai does NOT read the OPENCODE_MODEL env var. When no
   * model is given on the command line AND none is set in opencode.json, the
   * non-interactive `run` command hangs forever waiting for interactive
   * provider/model selection — it emits zero output until the spawn timeout
   * kills it with SIGTERM (surfaced as the misleading "exited with code null").
   * Passing `--model` explicitly is what makes headless runs actually work.
   */
  /**
   * The model to forward on `--model`, in priority order:
   *   1. a per-run override the user picked in the workspace for this channel
   *   2. what the *CLI's own config* says the user selected
   *   3. this agent's env (legacy configuration path)
   *
   * This is forwarding, not selection: there is no fallback model and no
   * "pick something that looks usable". If all three are empty, preflight
   * blocks the run and tells the user to choose a model in the CLI. `--model`
   * is passed only because a headless run cannot complete the CLI's own
   * interactive picker.
   */
  _resolveModel(channel) {
    const override = channel && this._channelModels[channel];
    if (override) return override;

    const fromConfig = this._modelFromCliConfig();
    if (fromConfig) return fromConfig;

    const env = this.agentEnv || process.env;
    let model = '';
    for (const key of this.flavor.modelEnvVars) {
      const v = (env[key] || '').trim();
      if (v) { model = v; break; }
    }
    if (!model) return '';
    // Already provider-qualified (e.g. "openai/gpt-4o", "anthropic/claude-…").
    if (model.includes('/')) return model;
    // Infer the provider from which key/base URL the env resolved to. The
    // registry maps LLM_* → OPENAI_* for OpenAI-compatible endpoints, so
    // "openai" is the right default; only switch for an Anthropic endpoint.
    const baseUrl = (env.OPENAI_BASE_URL || env.LLM_BASE_URL || '').toLowerCase();
    const provider = (env.ANTHROPIC_API_KEY || baseUrl.includes('anthropic'))
      ? 'anthropic'
      : 'openai';
    return `${provider}/${model}`;
  }

  /**
   * The model the user selected inside the CLI, read out of the CLI's own
   * config. Strictly read-only — this adapter never writes these files.
   *
   * opencode/kilo store it as a bare `"model": "provider/id"` at the config
   * root; a `provider` block may also declare models but does not say which one
   * is active, so it is not consulted here.
   */
  _modelFromCliConfig() {
    for (const name of this.flavor.configFiles) {
      const file = path.join(this.flavor.configDir, name);
      try {
        if (!fs.existsSync(file)) continue;
        // .jsonc — strip line comments and trailing commas before parsing.
        const raw = fs.readFileSync(file, 'utf-8')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1');
        const cfg = JSON.parse(raw);
        const m = cfg && typeof cfg.model === 'string' ? cfg.model.trim() : '';
        if (m) return m;
      } catch {
        // A malformed config is the CLI's problem to report, not ours to guess
        // around. Fall through to the next candidate.
      }
    }
    return '';
  }

  /**
   * Every model this install can actually reach, from `<cli> models` — the
   * CLI's own answer, so there is no hardcoded list to drift. Returns [] when
   * the probe fails; an empty list must be reported as "unknown", never
   * substituted with a guess.
   */
  _listModels() {
    const binary = this._opencodeBinary || this._findOpencodeBinary();
    if (!binary) return [];
    const out = this._runHiddenCliSync(binary, ['models']);
    if (!out) return [];
    const seen = new Set();
    const models = [];
    for (const line of out.split(/\r?\n/)) {
      const id = line.trim();
      // One `provider/model` per line. Skip banner art and stray log lines.
      if (!/^[\w.@-]+\/[\w.:@-]+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const slash = id.indexOf('/');
      models.push({ id, provider: id.slice(0, slash), label: id.slice(slash + 1) });
    }
    return models;
  }

  /**
   * Read-only runtime snapshot for the workspace UI: what the CLI is set to and
   * what it can reach. Carries `source` so the UI can never present an inferred
   * value as configuration truth, and omits the model list entirely rather than
   * inventing one when the probe came back empty.
   */
  async fetchAndReportUsage() {
    try {
      const override = Object.values(this._channelModels)[0] || '';
      const fromConfig = this._modelFromCliConfig();
      const currentId = override || fromConfig || this._resolveModel();
      const source = override ? 'workspace-override'
        : fromConfig ? 'cli-config'
        : currentId ? 'agent-env'
        : 'unknown';
      const models = this._listModels();
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: currentId || null,
          available_models: models.length ? JSON.stringify(models) : null,
          raw_text: `flavor=${this.flavor.id} model_source=${source}`,
        },
        this.token
      );
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
    }
  }

  /** Blocking `<cli> <args>` capture for short metadata probes. */
  _runHiddenCliSync(binary, args, timeoutMs = 25000) {
    try {
      const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(binary);
      const cmd = isBatch ? (process.env.COMSPEC || 'cmd.exe') : binary;
      const argv = isBatch ? ['/c', binary, ...args] : args;
      return execFileSync(cmd, argv, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: this.agentEnv || process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      // Non-zero exit still carries usable stdout for `models`.
      return (e && e.stdout) ? String(e.stdout) : '';
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'set_model') {
      const requested = payload && payload.model;
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (!requested) return;

      // Only accept something the CLI itself declared. An id we cannot see in
      // `<cli> models` would be forwarded to `--model` and fail per-run with an
      // opaque provider error, so reject it here where we can say why.
      const known = this._listModels();
      if (known.length && !known.some((m) => m.id === requested)) {
        this._log(`set_model: '${requested}' is not in \`${this.flavor.binaryCandidates[0]} models\` — ignoring`);
        return;
      }

      if (channel) {
        this._channelModels[channel] = requested;
      } else {
        for (const c of Object.keys(this._channelModels)) this._channelModels[c] = requested;
        this._channelModels['*'] = requested;
      }
      // Deliberately no disk write and no edit to the CLI's config: this is a
      // per-run forward, and the CLI stays the owner of the default.
      this._log(`Model override for channel=${channel || 'all'} set to '${requested}' (this session only)`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    await super._onControlAction(action, payload);
  }

  _runOpencode(content, msgChannel) {
    // Preflight BEFORE spawning: bail out with a structured, actionable error
    // instead of launching a child that will hang for 5 minutes or exit 1 with
    // an opaque message. Stubbing _runOpencode in tests bypasses this, exactly
    // like the real send path bypasses spawn when preflight fails.
    const pf = this._preflight(msgChannel);
    if (!pf.ok) {
      return Promise.reject(this._failure(pf.category, pf.diagnostic, pf.detail));
    }

    const binary = this._opencodeBinary;
    const cmd = [binary, 'run', '--format', 'json', '--dir', this.agentHome];

    // Preflight guarantees a resolvable model; pin it explicitly — without it
    // opencode hangs waiting for interactive provider/model selection.
    const model = this._resolveModel(msgChannel);
    cmd.push('--model', model);

    const sessionId = this._channelSessions[msgChannel];
    let fullPrompt;
    if (sessionId) {
      fullPrompt = content;
      cmd.push('--session', sessionId);
    } else {
      this._ensureWorkspaceSkill(msgChannel);
      const context = this._buildSystemContext(msgChannel);
      fullPrompt = `${context}\n\n---\n\n${content}`;
    }

    this._log(`CLI: ${binary} run --format json --dir … --model ${model || '(none)'}`);

    const spawnEnv = { ...(this.agentEnv || process.env) };

    let spawnBinary = cmd[0];
    let spawnArgs = cmd.slice(1);
    // Only the npm `.cmd` shim needs a cmd.exe host. The native opencode.exe
    // (preferred by _findOpencodeBinary) is spawned directly — no console host.
    if (IS_WINDOWS && spawnBinary.toLowerCase().endsWith('.cmd')) {
      spawnArgs = ['/C', spawnBinary, ...spawnArgs];
      spawnBinary = process.env.COMSPEC || 'cmd.exe';
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(spawnBinary, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: this.agentHome,
        timeout: TIMEOUT_MS,
        detached: !IS_WINDOWS,
        // Never let a console window appear. Besides being ugly, an attached
        // console makes opencode start its interactive TUI and hang instead of
        // running headless — the root cause of "stuck on thinking…" on Windows.
        windowsHide: true,
      });

      this._channelProcesses[msgChannel] = proc;

      let stdout = '';
      let stderr = '';
      let streamBuffer = '';
      let pendingEvents = Promise.resolve();
      const responseState = { finalText: '', allText: '', seenText: false };
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (this._channelProcesses[msgChannel] === proc) {
          delete this._channelProcesses[msgChannel];
        }
        fn(arg);
      };

      if (proc.stdout) {
        proc.stdout.on('data', (d) => {
          const chunk = d.toString('utf-8');
          stdout += chunk;
          streamBuffer += chunk;
          const drained = OpenCodeAdapter._drainJsonObjects(streamBuffer);
          streamBuffer = drained.rest;
          for (const event of drained.objects) {
            pendingEvents = pendingEvents
              .then(() => this._handleStreamEvent(event, msgChannel, responseState))
              .catch((e) => this._log(`opencode stream event handling failed: ${e.message}`));
          }
        });
      }
      if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d; });

      // Send the prompt via stdin, then close it so opencode knows the message
      // is complete and never blocks waiting for more input. Guard the write:
      // if the child already died, writing to its stdin throws EPIPE.
      if (proc.stdin) {
        proc.stdin.on('error', () => {});
        try {
          proc.stdin.write(fullPrompt, 'utf-8');
          proc.stdin.end();
        } catch { /* child gone — the exit/error handler reports it */ }
      }

      proc.on('error', (err) => finish(reject, err));
      // 'close' (not 'exit') fires after stdout/stderr have fully drained, so we
      // never parse a truncated response. The handler receives (code, signal):
      // when the spawn timeout kills the child, code is null and signal is the
      // signal name — report that as a timeout rather than "exited with code null".
      proc.on('close', async (code, signal) => {
        try { await pendingEvents; } catch {}

        if (this._stoppingChannels.has(msgChannel)) {
          this._stoppingChannels.delete(msgChannel);
          return finish(resolve, '');
        }

        stdout = stdout.trim();
        stderr = stderr.trim();

        // A structured error event may ride on stdout regardless of exit code
        // (opencode emits {"type":"error", ...} as a JSONL event). Look there
        // first so the real auth/provider/model failure is never discarded just
        // because stderr happened to be empty.
        const stdoutErr = OpenCodeAdapter._extractErrorFromStdout(stdout);

        if (signal) {
          this._log(`opencode killed by signal ${signal} after ${TIMEOUT_MS / 1000}s (output: ${!!stdout})`);
          const cls = OpenCodeAdapter._classifyFailure({ code, signal, stdout, stderr, stdoutErr });
          // A signal almost always means our own timeout fired; only override to
          // a more specific provider error if stdout/stderr clearly show one.
          const category = (cls.category === 'unknown_error' || cls.category === 'process_crashed')
            ? 'timeout' : cls.category;
          return finish(reject, this._failure(category, cls.diagnostic || `signal=${signal}`, cls.detail));
        }

        if (code !== 0) {
          const cls = OpenCodeAdapter._classifyFailure({ code, signal, stdout, stderr, stdoutErr });
          this._log(`opencode exited code ${code} → [${cls.category}]: ${OpenCodeAdapter._redact(cls.diagnostic).slice(0, 300)}`);
          return finish(reject, this._failure(cls.category, cls.diagnostic, cls.detail));
        }

        // Exit 0.
        if (stdout) this._persistSessionId(msgChannel, stdout);
        const text = stdout ? OpenCodeAdapter._finalTextFromStdout(stdout, responseState) : '';
        if (text) return finish(resolve, text);

        // Exit 0 with no final assistant text. This is NOT proof of a missing
        // provider — it can be a structured error on stdout, an incomplete
        // stream, or a genuinely empty completion. Classify rather than guess.
        if (stdoutErr) {
          const cls = OpenCodeAdapter._classifyFailure({ code, signal, stdout, stderr, stdoutErr });
          this._log(`opencode exit 0 with error event → [${cls.category}]: ${OpenCodeAdapter._redact(cls.diagnostic).slice(0, 300)}`);
          return finish(reject, this._failure(cls.category, cls.diagnostic, cls.detail));
        }
        const emptyCat = OpenCodeAdapter._emptyExitCategory(stdout);
        this._log(`opencode exit 0, no final text → [${emptyCat}]. stdout head: ${OpenCodeAdapter._redact(stdout).slice(0, 200)}`);
        return finish(reject, this._failure(emptyCat, `exit 0, no final assistant text; stdout head: ${stdout.slice(0, 200)}`));
      });
    });
  }

  // ------------------------------------------------------------------
  // Preflight (deterministic, no model call) + failure classification
  // ------------------------------------------------------------------

  /**
   * Cheap, side-effect-free readiness check run immediately before spawning.
   * Returns { ok: true, ... } or { ok: false, category, detail?, diagnostic? }.
   * Conservative by design: it blocks only on deterministic, locally-knowable
   * problems (no binary, unsupported version, no model, no credential at all,
   * unusable cwd) and lets anything ambiguous through to a real run.
   */
  _preflight(channel) {
    const binary = this._opencodeBinary || this._findOpencodeBinary();
    if (binary) this._opencodeBinary = binary;
    if (!binary) return { ok: false, category: 'cli_not_found' };

    const probe = this._detectCliVersion(binary);
    if (!probe.executable) {
      return { ok: false, category: 'cli_not_executable', diagnostic: 'opencode --version did not run' };
    }
    const vclass = OpenCodeAdapter._classifyVersion(probe.version, this.flavor);
    if (vclass === 'unsupported') {
      return {
        ok: false,
        category: 'unsupported_version',
        detail: `detected ${probe.version || 'unknown'}`,
        diagnostic: `detected ${probe.version}, requires >= ${this.flavor.minVersion}`,
      };
    }
    if (vclass === 'unverified' && !OpenCodeAdapter._allowUnverifiedVersion(this.agentEnv)) {
      return {
        ok: false,
        category: 'unverified_version',
        detail: `detected ${probe.version}, verified up to ${this.flavor.testedMaxVersion}`,
        diagnostic:
          `detected ${probe.version} > testedMax ${this.flavor.testedMaxVersion} for flavor ` +
          `${this.flavor.id}; blocked (set WWJ_ALLOW_UNVERIFIED_CLI_VERSION=1 to override)`,
      };
    }
    // 'unknown' (unparseable version string) still runs — never block on a
    // failure to read a version number.

    const model = this._resolveModel(channel);
    if (!model) return { ok: false, category: 'model_missing' };

    const cred = this._credentialState();
    if (cred === 'missing') return { ok: false, category: 'credential_missing' };

    try {
      fs.accessSync(this.agentHome, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return { ok: false, category: 'cwd_unavailable', diagnostic: `cannot access ${this.agentHome}` };
    }

    return { ok: true, version: probe.version, versionClass: vclass, model, credential: cred };
  }

  /**
   * Probe the CLI's version and executability, cached briefly so preflight never
   * spawns `--version` more than once per VERSION_PROBE_TTL_MS across channels.
   * Returns { version: string|null, executable: boolean }.
   */
  _detectCliVersion(binary) {
    const now = Date.now();
    if (this._versionProbe && (now - this._versionProbe.ts) < VERSION_PROBE_TTL_MS) {
      return this._versionProbe;
    }
    let version = null;
    let executable = false;
    try {
      const raw = execSync(`"${binary}" --version`, {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
        env: getEnhancedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      executable = true;
      const m = raw.match(/(\d+\.\d+\.\d+)/);
      version = m ? m[1] : (raw.split('\n')[0] || null);
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
        executable = false; // never spawned
      } else {
        executable = true; // spawned but --version misbehaved
        const out = String((e && (e.stdout || e.stderr)) || '');
        const m = out.match(/(\d+\.\d+\.\d+)/);
        version = m ? m[1] : null;
      }
    }
    this._versionProbe = { version, executable, ts: now };
    return this._versionProbe;
  }

  /**
   * Best-effort credential/provider presence. 'present' | 'unknown' | 'missing'.
   * 'unknown' (custom provider key, custom endpoint, or a config file we can't
   * fully validate) is deliberately NOT blocked — only a total absence of any
   * recognizable signal is 'missing'.
   */
  _credentialState() {
    const env = this.agentEnv || process.env;
    const val = (k) => (env[k] == null ? '' : String(env[k])).trim();
    const KNOWN = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
      'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY',
      'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY',
      'AZURE_API_KEY', 'AZURE_OPENAI_API_KEY',
    ];
    if (KNOWN.some((k) => val(k))) return 'present';

    const home = os.homedir();
    const fileNonEmpty = (p) => {
      try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; }
    };
    const stores = [
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      path.join(home, '.config', 'opencode', 'opencode.json'),
      path.join(home, '.config', 'opencode', 'config.json'),
      path.join(this.agentHome, 'opencode.json'),
      path.join(this.agentHome, '.opencode', 'opencode.json'),
    ];
    if (stores.some(fileNonEmpty)) return 'present';

    if (val('OPENAI_BASE_URL') || val('LLM_BASE_URL')) return 'unknown';
    if (Object.keys(env).some((k) => /(_API_KEY|_API_TOKEN|_TOKEN)$/.test(k) && val(k))) return 'unknown';
    return 'missing';
  }

  /** Build a categorized Error carrying diagnostic (for logs) + detail (for the user). */
  _failure(category, diagnostic, detail) {
    const err = new Error(`opencode ${category}${detail ? `: ${detail}` : ''}`);
    err.category = category;
    err.diagnostic = diagnostic || '';
    err.detail = detail || '';
    return err;
  }

  /** Map a raw spawn errno (ENOENT/EACCES) to a category; default unknown_error. */
  _classifyErrno(e) {
    const code = e && e.code;
    if (code === 'ENOENT') return 'cli_not_found';
    if (code === 'EACCES' || code === 'EPERM') return 'cli_not_executable';
    return 'unknown_error';
  }

  /**
   * Post a user-visible, de-identified, actionable error that is clearly NOT a
   * normal reply. Carries `error_category` in metadata so the UI can route it.
   */
  async _sendClassifiedError(channel, category, detail) {
    const base = this._messages[category] || this._messages.unknown_error;
    const safe = detail ? OpenCodeAdapter._redact(detail).trim() : '';
    const body = safe ? `${base}\n\n> ${safe}` : base;
    const content = `⚠️ **OpenCode couldn't run** — ${body}`;
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'error',
        metadata: { agent_mode: this._mode, error: true, error_category: category },
        sessionId: this._sessionId,
      });
    } catch {
      // Older backends may reject an unknown messageType/metadata — fall back to
      // the plain error path so the user still gets an actionable message.
      try { await this.sendError(channel, content); } catch {}
    }
  }

  // ------------------------------------------------------------------
  // Static classifiers (pure — unit tested)
  // ------------------------------------------------------------------

  /** True when an event is a tool call, across opencode's version-varying shapes. */
  static _isToolEvent(event) {
    if (!event || typeof event !== 'object') return false;
    const t = String(event.type || '').toLowerCase();
    if (t === 'tool_use' || t === 'tool') return true;
    const part = event.part;
    if (part && typeof part === 'object' && String(part.type || '').toLowerCase() === 'tool') return true;
    return false;
  }

  /** Scan stdout JSONL for a structured error event; last one wins. */
  static _extractErrorFromStdout(raw) {
    const events = OpenCodeAdapter._splitJsonObjects(raw);
    for (let i = events.length - 1; i >= 0; i--) {
      const err = OpenCodeAdapter._errorFromEvent(events[i]);
      if (err) return err;
    }
    return null;
  }

  /** Pull { message, name, status } from one event, tolerant of nesting. */
  static _errorFromEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const type = String(ev.type || '').toLowerCase();
    const part = (ev.part && typeof ev.part === 'object') ? ev.part : null;
    // Nested error objects carry the richest detail — try them before the
    // wrapping event, whose only signal may be type === 'error'.
    const candidates = [];
    if (ev.error && typeof ev.error === 'object') candidates.push(ev.error);
    if (part && part.error && typeof part.error === 'object') candidates.push(part.error);
    if (part && String(part.type || '').toLowerCase().includes('error')) candidates.push(part);
    if (type.includes('error')) candidates.push(ev);
    if (typeof ev.error === 'string') candidates.push({ message: ev.error });
    if (part && typeof part.error === 'string') candidates.push({ message: part.error });

    const pick = (...vals) => {
      for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
      return '';
    };
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const data = (c.data && typeof c.data === 'object') ? c.data : {};
      const message = pick(c.message, c.error, c.detail, c.reason, data.message);
      const name = pick(c.name, c.type);
      const statusRaw = c.status != null ? c.status
        : (c.statusCode != null ? c.statusCode
          : (data.status != null ? data.status
            : (typeof c.code === 'number' ? c.code : null)));
      if (message || name || statusRaw != null) {
        return {
          message: String(message || ''),
          name: String(name || ''),
          status: statusRaw != null ? String(statusRaw) : '',
        };
      }
    }
    return null;
  }

  /**
   * Classify a failed run into one taxonomy category. Conservative: an exit
   * code alone is never "auth"; only explicit 401/403/auth wording is. Returns
   * { category, diagnostic, detail }.
   */
  static _classifyFailure({ code, signal, stdout, stderr, stdoutErr } = {}) {
    const err = stdoutErr || OpenCodeAdapter._extractErrorFromStdout(stdout || '');
    const status = err && err.status ? String(err.status) : '';
    const msg = (err && err.message) || '';
    const name = (err && err.name) || '';
    const diagnostic = [name, status, msg].filter(Boolean).join(' ')
      || (stderr || '')
      || `exit code ${code}${signal ? `, signal ${signal}` : ''}`;
    const hay = `${name} ${status} ${msg} ${stderr || ''}`.toLowerCase();
    const has = (re) => re.test(hay);

    let category;
    if (has(/\b(401|403)\b/) || has(/unauthor|invalid api key|invalid_api_key|authentication|auth(entication)? failed|forbidden|invalid token|no api key|missing api key|permission denied/)) {
      category = 'auth_failed';
    } else if (has(/\b429\b/) || has(/rate.?limit|too many requests|quota|overloaded/)) {
      category = 'rate_limited';
    } else if (has(/model.*(not found|does not exist|unknown|invalid|unsupported)|no such model|unknown model|invalid model|model_not_found|\b404\b/)) {
      category = 'model_not_found';
    } else if (has(/no provider|provider not configured|not configured|no model configured|no providers|missing provider/)) {
      category = 'provider_not_configured';
    } else if (has(/econnrefused|enotfound|etimedout|eai_again|network|fetch failed|socket hang|connection (refused|reset|error)|getaddrinfo|\bdns\b/)) {
      category = 'network_error';
    } else if (has(/\b5\d\d\b|server error|internal server|bad gateway|service unavailable|gateway timeout/)) {
      category = 'provider_server_error';
    } else if (has(/timeout|timed out/)) {
      category = 'timeout';
    } else if (err) {
      category = 'unknown_error'; // recognized an error but not its kind
    } else if (signal) {
      category = 'timeout';
    } else if (!stdout && !stderr) {
      category = 'process_crashed';
    } else if (stdout) {
      category = 'stream_parse_error';
    } else {
      category = 'unknown_error';
    }

    const detail = OpenCodeAdapter._redact(msg || stderr || '').slice(0, 200);
    return { category, diagnostic, detail };
  }

  /** Category for an exit-0 run that produced no final assistant text. */
  static _emptyExitCategory(stdout) {
    const raw = String(stdout || '').trim();
    if (!raw) return 'empty_response';
    return 'empty_response';
  }

  /** 'ok' | 'unverified' (newer than tested) | 'unsupported' (too old) | 'unknown'. */
  static _classifyVersion(version, flavor) {
    const f = flavor || FLAVORS.opencode;
    // Non-semver (or unreadable) → 'unknown': allow the run, never block on it.
    if (!version || !/^\d+\.\d+/.test(String(version))) return 'unknown';
    if (OpenCodeAdapter._cmpVer(version, f.minVersion) < 0) return 'unsupported';
    if (f.testedMaxVersion && OpenCodeAdapter._cmpVer(version, f.testedMaxVersion) > 0) return 'unverified';
    return 'ok';
  }

  /**
   * Newer-than-verified used to be 'degraded': logged, then run anyway. The
   * observed failure mode of an unparseable stream is not a loud error but five
   * minutes of zero output followed by `empty_response`, which tells the user
   * nothing. Fail closed instead, with an explicit escape hatch.
   */
  static _allowUnverifiedVersion(env) {
    const v = String((env || process.env).WWJ_ALLOW_UNVERIFIED_CLI_VERSION || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  /** Numeric-segment semver compare. Returns -1 / 0 / 1. */
  static _cmpVer(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /** Redact secrets (keys, tokens, bearer/authorization, query secrets) from diagnostics. */
  static _redact(s) {
    let out = String(s == null ? '' : s);
    out = out
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]')
      .replace(/\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{10,}/g, '[REDACTED_TOKEN]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED_TOKEN]')
      .replace(/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED_KEY]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED_JWT]')
      .replace(/(authorization|api[_-]?key|x-api-key|token|bearer|secret|password|passwd)(["'\s:=]+)([^\s"',}]+)/gi,
        (m, k, sep) => `${k}${sep}[REDACTED]`)
      .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]')
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
    return out;
  }
}

module.exports = OpenCodeAdapter;
