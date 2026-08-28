/**
 * Base adapter for 52hzAgents workspace.
 *
 * Extracts the common connectivity logic shared by all adapters:
 * - Event cursor management and skip-existing-events on startup
 * - Heartbeat loop (30s)
 * - Adaptive poll loop with deduplication
 * - Control event polling (mode changes, stop)
 * - Per-channel task dispatch with queuing
 * - Auto-titling of new channels
 * - Graceful shutdown with disconnect
 *
 * Subclasses must implement _handleMessage(msg).
 *
 * Direct port of Python: sdk/src/52hzAgents/adapters/base.py
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceClient, SessionRevokedError } = require('../workspace-client');
const { generateSessionTitle, SESSION_DEFAULT_RE, leadingMentions } = require('./utils');
const { extractDecisionQuestions } = require('./decision-parser');
const { extractPreview } = require('./preview-parser');
const { defaultAgentWorkdir } = require('../paths');
const {
  REASON,
  classifyJoinError,
  classifyHeartbeatError,
} = require('./health-status');

const DEFAULT_ENDPOINT = process.env.WWJ_WORKSPACE_ENDPOINT || process.env.WWJ_ENDPOINT || 'http://localhost:8000';

// Heartbeat runs every 30s. A SINGLE failure is usually a transient blip (brief
// network hiccup, server redeploy) that the next tick recovers from �?surfacing
// it as a hard 'error' would make the agent flap red for no real reason. Only
// after this many CONSECUTIVE failures (~60s+ of real downtime) do we report
// heartbeat_failed up to the daemon. A success resets the streak immediately.
const HEARTBEAT_ERROR_THRESHOLD = 2;

// Hard cutoff for agent-to-agent ping-pong: the completion-phrase and
// direct-action regexes below are wording-dependent and can be bypassed by
// two agents that keep issuing directives at each other without ever using a
// phrase either regex recognizes. This counter is the backstop �?it counts
// consecutive agent-to-agent turns processed per channel and refuses once the
// limit is hit, regardless of message wording. Any human message resets it.
const MAX_AGENT_HOPS_WITHOUT_HUMAN = 20;

// Extension -> MIME for files agents produce. The workspace stores whatever it
// is given, but the Files panel previews by content type, so plain-text
// artifacts (the common case: a .md report) must not be sent as a binary blob.
const CONTENT_TYPES = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
  json: 'application/json', csv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain',
  py: 'text/x-python', go: 'text/x-go', sh: 'text/x-shellscript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  zip: 'application/zip', log: 'text/plain',
};

function guessContentType(filename) {
  const dot = String(filename || '').lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// How long _resolveWorkingDir() trusts its per-channel cache before re-checking
// the channel's bound directory. Short enough that toggling/re-pointing Open
// Folder on a thread takes effect quickly; long enough to avoid a network
// round trip on every single message.
const WORKING_DIR_CACHE_TTL_MS = 15000;

class BaseAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.workspaceId
   * @param {string} opts.channelName - default/initial channel
   * @param {string} opts.token
   * @param {string} opts.agentName
   * @param {string} [opts.endpoint]
   */
  constructor({ workspaceId, channelName, token, agentName, endpoint, agentEnv, agentType, workingDir, onStatus, logFile, client }) {
    this.workspaceId = workspaceId;
    this.channelName = channelName;
    this.token = token;
    this.agentName = agentName;
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.agentEnv = agentEnv || process.env;
    this.agentType = agentType;
    this.workingDir = workingDir || undefined;
    // Optional callback the daemon supplies to surface live runtime/connectivity
    // status (reason + redacted message) into daemon.status.json so the Agents
    // list / TUI can show the REAL failure instead of a swallowed log line. A
    // null reason means "healthy again" (clears any prior error).
    this._onStatus = typeof onStatus === 'function' ? onStatus : null;
    this._lastReportedStatusKey = null;
    // Consecutive heartbeat failures �?a transient single blip must not flip the
    // agent to a hard error (see HEARTBEAT_ERROR_THRESHOLD).
    this._heartbeatFailStreak = 0;
    // Structured terminal exit reason ({ reason, message }) read by the daemon
    // after run() returns, to distinguish a clean stop from a real failure.
    this._exitInfo = null;
    // Set when the user explicitly stops this adapter (vs an error/revoke), so a
    // clean stop is never mislabeled as an error.
    this._stopRequested = false;
    this.client = client || new WorkspaceClient(this.endpoint);
    this._lastEventId = null;
    this._running = false;
    this._sessionId = null;  // issued by server on /v1/join; used to prove liveness
    this._processedIds = new Set();
    this._titledSessions = new Set();
    this._mode = 'execute';
    this._lastControlId = null;
    this._controlWake = null;
    // Per-channel task tracking for parallel execution
    this._channelBusy = new Set();
    this._channelQueues = {};
    // Cached workspace.browser_enabled. Populated lazily on first read so we
    // don't pay an HTTP roundtrip per message �?adapters that toggle the
    // workspace flag must reconnect/restart to pick up the change (matches
    // the Python adapter behavior in workspace_prompt.py).
    this._browserEnabledCache = null;
    // Wall-clock timestamp of adapter init, used by the `status` control
    // action to report uptime back to the channel. Reset on reinstantiation
    // (e.g. after a `restart` IPC bounce) so uptime tracks "time since last
    // restart" rather than the long-running daemon's process uptime.
    this._startedAt = Date.now();
    // path|size|mtime of files already registered into the workspace Files space,
    // so an unchanged file is not re-uploaded on every turn that touches it.
    this._registeredFiles = new Set();
    this.model = undefined;
    this._channelModels = {};
    // Adapter logs must reach ~/.wwj/daemon.log the same way Daemon._log does:
    // by appending to the file directly. Relying on console.log only works when
    // the daemon's stdout is redirected into the log file (the `wwj up` path,
    // daemon.js `stdio: ['ignore', logFd, logFd]`). When the desktop app spawns
    // the daemon itself there is no such redirection, so every adapter line was
    // silently lost �?which makes any spawn/error diagnostics invisible.
    this._logFile = logFile || path.join(os.homedir(), '.wwj', 'daemon.log');
    this._log = (msg) => {
      const ts = new Date().toISOString();
      const line = `${ts} INFO adapter [${this.agentName}]: ${msg}`;
      try {
        fs.appendFileSync(this._logFile, line + '\n', 'utf-8');
      } catch {}
      if (process.stdout.isTTY) {
        console.log(line);
      }
    };
  }

  // ------------------------------------------------------------------
  // Produced-file registration
  // ------------------------------------------------------------------

  /**
   * Register a file the agent just produced into the workspace's shared Files
   * space, so it shows up in the Files panel alongside human uploads.
   *
   * The panel lists the workspace's own storage directory only; an agent writes
   * into its working directory, which is not part of it. Rather than widening
   * the backend scan (which previously pulled in unrelated files and produced a
   * junk file list), the agent that made the file registers it explicitly.
   *
   * Best-effort by design: never throws, and skips anything that is not a real
   * user-facing artifact (internal agent config, oversized files, unchanged
   * re-writes).
   *
   * @param {string} channel
   * @param {string} absPath
   * @returns {Promise<boolean>} whether the file was uploaded
   */
  async registerProducedFile(channel, absPath) {
    try {
      if (!absPath || !this.workspaceId || !this.client) return false;
      const filePath = path.resolve(String(absPath));

      // Internal scaffolding the agent writes for itself is not an artifact, and
      // a dotfile (.env above all) must never be published into a shared space.
      // Split on path.sep rather than a character-class regex: path.resolve has
      // already normalised separators, and this cannot be broken by escaping.
      const base = path.basename(filePath);
      if (!base || base.startsWith('.')) return false;
      const internal = ['.claude', '.git', '.gemini', 'node_modules', '__pycache__', '.venv'];
      const segments = filePath.split(path.sep).map((seg) => seg.toLowerCase());
      if (segments.some((seg) => internal.includes(seg))) return false;

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return false; // the tool call may have failed, or the path is a scratch target
      }
      if (!stat.isFile() || stat.size === 0) return false;
      // Server rejects >50MB; skip rather than fail the upload.
      if (stat.size > 50 * 1024 * 1024) {
        this._log(`Files: skipping ${base} �?${Math.round(stat.size / 1048576)}MB exceeds the 50MB limit`);
        return false;
      }

      const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
      if (this._registeredFiles.has(key)) return false;

      const data = fs.readFileSync(filePath);
      await this.client.uploadFile(
        this.workspaceId,
        this.token,
        base,
        data.toString('base64'),
        {
          contentType: guessContentType(base),
          source: `52hz:${this.agentName}`,
          channelName: channel || undefined,
        }
      );
      this._registeredFiles.add(key);
      this._log(`Files: registered ${base} (${stat.size}B) from ${filePath}`);
      return true;
    } catch (e) {
      this._log(`Files: failed to register ${absPath}: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Runtime status reporting (daemon surfaces this in daemon.status.json)
  // ------------------------------------------------------------------

  /**
   * Surface a live status transition to the daemon. `reason` null/'' means the
   * agent is healthy again (clears any prior error). Deduped so a repeated
   * failure (e.g. heartbeat every 30s on a down workspace) writes the status
   * file once, not on every tick. Never throws �?status is best-effort.
   */
  _reportStatus(reason, message) {
    const key = `${reason || ''}|${message || ''}`;
    if (key === this._lastReportedStatusKey) return;
    this._lastReportedStatusKey = key;
    if (!this._onStatus) return;
    try {
      this._onStatus({ reason: reason || null, message: message || null });
    } catch { /* status is best-effort */ }
  }

  /** Record the FIRST terminal failure reason; later teardown noise can't mask it. */
  _setExitInfo(reason, message) {
    if (!this._exitInfo) this._exitInfo = { reason, message };
  }

  /** Read by the daemon after run() returns. null = clean exit. */
  getExitInfo() {
    return this._exitInfo;
  }

  /** True when stop() was called explicitly (a clean user stop, not a failure). */
  wasStopRequested() {
    return this._stopRequested === true;
  }

  /**
   * Preflight gate, run by the daemon BEFORE join. Default: always runnable.
   * Subclasses whose agent needs a resolvable CLI binary override this to return
   * { ok:false, reason:'runtime_missing', message } so the daemon surfaces a
   * precise reason and skips the workspace join (no pointless join loop).
   */
  preflight() {
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Announce this agent to the workspace (/v1/join). Returns true on success.
   * On failure surfaces the REAL reason (e.g. "Workspace join failed: HTTP 401")
   * to the daemon status instead of only logging it �?non-fatal, the poll/
   * heartbeat loops keep retrying and a later success clears it. Extracted from
   * run() so the failure-reporting can be unit-tested without the poll loop.
   */
  async _joinWorkspace() {
    try {
      const joinResult = await this.client.joinNetwork(this.agentName, this.token, {
        network: this.workspaceId,
        agentType: this.agentType || 'agent',
        serverHost: require('os').hostname(),
        workingDir: this.workingDir || defaultAgentWorkdir(this.agentName),
      });
      this._sessionId = (joinResult && joinResult.session_id) || null;
      this._log(`Joined workspace ${this.workspaceId}${this._sessionId ? ` (session ${this._sessionId.slice(0, 8)})` : ''}`);
      this._reportStatus(null); // joined OK �?clear any prior error
      return true;
    } catch (e) {
      const { reason, message } = classifyJoinError(e);
      this._log(`${message} (status: ${e && e.statusCode != null ? e.statusCode : 'n/a'})`);
      this._reportStatus(reason, message);
      return false;
    }
  }

  async run() {
    this._running = true;

    // Announce agent to workspace
    await this._joinWorkspace();

    // Sync workspace-managed skills into disabledModules
    try {
      const agents = await Promise.race([
        this.client.getAgents(this.workspaceId, this.token),
        new Promise((_, reject) => setTimeout(() => reject(new Error('skill sync timed out (10s)')), 10000)),
      ]);
      const self = agents.find((a) => a.agentName === this.agentName);
      if (self && self.enabledSkills) {
        const { skillsToDisabledModules } = require('../skill-catalog');
        this.disabledModules = skillsToDisabledModules(self.enabledSkills);
        this._log(`Synced skills from workspace: disabled=[${[...this.disabledModules].join(',')}]`);
      }
    } catch (e) {
      this._log(`Warning: skill sync failed (non-fatal): ${e.message}`);
    }

    // Fast-path operations (control-event cursor + heartbeat + control poll)
    // run BEFORE the message-cursor advance. Even though _skipExistingEvents
    // is fast on a healthy backend, we don't want slash commands gated on
    // its success �?keeping these paths independent makes /restart and
    // /status responsive immediately after join.
    await this._skipExistingControlEvents();
    const heartbeatInterval = setInterval(() => this._heartbeat(), 30000);
    const controlPoller = this._controlPollerLoop();

    try {
      // Send initial heartbeat
      try { await this._heartbeat(); } catch (e) {
        this._log(`Heartbeat failed (non-fatal): ${e.message}`);
      }
      // Slow path: only the message-poll loop waits for this.
      await this._skipExistingEvents();
      this._log('Starting poll loop...');
      await this._pollLoop();

      if (this._running && !this._stopRequested) {
        const msg = 'Message polling loop exited unexpectedly';
        this._log(`CRITICAL: ${msg}`);
        this._setExitInfo(REASON.ADAPTER_CRASHED, msg);
        this._reportStatus(REASON.ADAPTER_CRASHED, msg);
      }
    } catch (e) {
      if (!this._stopRequested) {
        const msg = `Message polling loop crashed: ${e && e.message ? e.message : String(e)}`;
        this._log(`CRITICAL: ${msg}`);
        this._setExitInfo(REASON.ADAPTER_CRASHED, msg);
        this._reportStatus(REASON.ADAPTER_CRASHED, msg);
      }
      throw e;
    } finally {
      this._running = false;
      this._wakeControlPoller();
      clearInterval(heartbeatInterval);
      try { await controlPoller; } catch {}
      try {
        await this.client.disconnect(this.workspaceId, this.agentName, this.token);
      } catch {}
    }
  }

  stop() {
    this._stopRequested = true;
    this._running = false;
  }

  // ------------------------------------------------------------------
  // Event cursor / skip existing
  // ------------------------------------------------------------------

  async _skipExistingEvents() {
    // Jump straight to the head with one server call. Pagination from the
    // start was slow and brittle: on a busy workspace it could take many
    // minutes to chew through historical events 200 at a time, leaving the
    // agent silently behind, and a transient mid-paginate empty response
    // (e.g. shared-cache race) would strand the cursor at a non-head id.
    const head = await this.client.getHeadEventId(this.workspaceId, this.token);
    if (head) {
      this._lastEventId = head;
      this._log(`Skipped existing events, cursor at ${head}`);
    }
  }

  // ------------------------------------------------------------------
  // Heartbeat
  // ------------------------------------------------------------------

  async _heartbeat() {
    try {
      await this.client.heartbeat(this.workspaceId, this.agentName, this.token, this._sessionId);
      this._heartbeatFailStreak = 0;
      this._reportStatus(null); // alive �?clear any prior connectivity error

      // Periodic quota & usage background refresh
      if (typeof this.fetchAndReportUsage === 'function') {
        this.fetchAndReportUsage().catch(() => {});
      }
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._log(`SESSION REVOKED: another client joined as '${this.agentName}'. Stopping adapter.`);
        // Terminal (not a user stop): record so the daemon can show why it ended.
        this._setExitInfo(REASON.SESSION_REVOKED, 'Workspace session revoked �?another client joined with the same agent name');
        this._reportStatus(REASON.SESSION_REVOKED, 'Workspace session revoked');
        this._running = false;
        return;
      }
      // Only surface a hard error after repeated consecutive failures, so a
      // single transient blip (or an expected brief reconnect) isn't mislabeled.
      this._heartbeatFailStreak++;
      const { reason, message } = classifyHeartbeatError(e);
      this._log(`${message} (consecutive failures: ${this._heartbeatFailStreak})`);
      if (this._heartbeatFailStreak >= HEARTBEAT_ERROR_THRESHOLD) {
        this._reportStatus(reason, message);
      }
    }
  }

  // ------------------------------------------------------------------
  // Control polling
  // ------------------------------------------------------------------

  /**
   * Advance `_lastControlId` past any pending control events for this agent
   * so we don't re-process them after a respawn. Without this, /restart
   * triggers a daemon bounce, the new adapter starts with _lastControlId=null,
   * polls and re-finds the same /restart event, bounces again �?restart loop.
   */
  async _skipExistingControlEvents() {
    try {
      const events = await this.client.pollControl(
        this.workspaceId, this.agentName, this.token,
        { after: null }
      );
      if (events.length > 0) {
        // pollControl returns ascending-by-timestamp; take the latest.
        this._lastControlId = events[events.length - 1].id;
        this._log(`Skipped ${events.length} existing control event(s), cursor at ${this._lastControlId}`);
      }
    } catch {}
  }

  async _pollControl() {
    try {
      const events = await this.client.pollControl(
        this.workspaceId, this.agentName, this.token,
        { after: this._lastControlId }
      );
      for (const ev of events) {
        if (ev.id) this._lastControlId = ev.id;
        const payload = ev.payload || {};
        const action = payload.action;
        if (action === 'set_mode') {
          const newMode = payload.mode || 'execute';
          if ((newMode === 'execute' || newMode === 'plan') && newMode !== this._mode) {
            const oldMode = this._mode;
            this._mode = newMode;
            this._log(`Mode changed: ${oldMode} -> ${newMode}`);
          }
        } else {
          await this._onControlAction(action, payload);
        }
      }
    } catch {}
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
          (typeLower && models[typeLower]);
        if (!explicit) {
          for (const k of Object.keys(models)) {
            const kLower = k.toLowerCase();
            if (kLower === nameLower || (typeLower && kLower === typeLower)) {
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
    return this.model || undefined;
  }

  /**
   * Handle adapter-specific control actions. Override in subclasses to add
   * per-adapter actions (`stop`, `restart`, �?; always call
   * `await super._onControlAction(action, payload)` from the override for
   * actions you don't recognize, so shared actions like `status` keep
   * working uniformly across adapter types.
   */
  async _onControlAction(action, payload) {
    if (action === 'set_model') {
      const requested = payload && payload.model;
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (!requested) return;
      if (channel) {
        this._channelModels[channel] = requested;
      } else {
        for (const c of Object.keys(this._channelModels)) this._channelModels[c] = requested;
        this._channelModels['*'] = requested;
        this.model = requested;
      }
      this._log(`Model override for channel=${channel || 'all'} set to '${requested}'`);
      if (typeof this.fetchAndReportUsage === 'function') {
        this.fetchAndReportUsage().catch(() => {});
      }
      return;
    } else if (action === 'status') {
      await this._postStatusReport(payload);
    } else if (action === 'routines') {
      await this._postRoutinesReport(payload);
    } else if (action === 'skill.install') {
      await this._handleSkillInstall(payload);
    } else if (action === 'skill.uninstall') {
      await this._handleSkillUninstall(payload);
    }
  }

  /**
   * Install a Skill Hub catalog skill into this agent's local skills
   * directory, then report the result back to the workspace so the UI can
   * show installing �?installed / failed. Errors are logged loudly and
   * surfaced as a `failed` status �?never swallowed.
   *
   * payload: { action: "skill.install", skill: { id, name, source_repo, source_path } }
   */
  async _handleSkillInstall(payload) {
    const installer = require('../skill-installer');
    const skill = (payload && payload.skill) || null;
    const skillId = skill && (skill.id || skill.skill_id);
    if (!skillId) {
      this._log('skill.install: missing skill metadata in payload �?ignoring');
      return;
    }
    this._log(`skill.install: starting install of "${skillId}" (type=${this.agentType}, dir=${this.workingDir || defaultAgentWorkdir(this.agentName)})`);

    // Best-effort "installing" ping so the UI flips immediately even if the
    // initial DB write from the request hasn't propagated to this client.
    try {
      await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
        skillId, state: 'installing',
      });
    } catch (e) {
      this._log(`skill.install: could not report 'installing' (non-fatal): ${e && e.message ? e.message : e}`);
    }

    try {
      const result = installer.installSkill({
        skill,
        agentType: this.agentType,
        workingDir: this.workingDir,
        log: (m) => this._log(`skill.install: ${m}`),
      });
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId, state: 'installed', path: result.path, partial: result.partial === true,
        });
      } catch (e) {
        this._log(`skill.install: installed on disk but failed to report 'installed': ${e && e.message ? e.message : e}`);
      }
      this._log(`skill.install: SUCCESS "${skillId}" �?${result.path}${result.partial ? ' (partial)' : ''}`);
      await this._onSkillsChanged();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this._log(`skill.install: FAILED "${skillId}": ${msg}`);
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId, state: 'failed', error: msg,
        });
      } catch (e2) {
        this._log(`skill.install: also failed to report 'failed': ${e2 && e2.message ? e2.message : e2}`);
      }
    }
  }

  /**
   * Remove a previously-installed skill from disk and report `uninstalled`.
   */
  async _handleSkillUninstall(payload) {
    const installer = require('../skill-installer');
    const skill = (payload && payload.skill) || null;
    const skillId = skill && (skill.id || skill.skill_id);
    if (!skillId) {
      this._log('skill.uninstall: missing skill metadata in payload �?ignoring');
      return;
    }
    try {
      const result = installer.uninstallSkill({
        skill,
        agentType: this.agentType,
        workingDir: this.workingDir,
        log: (m) => this._log(`skill.uninstall: ${m}`),
      });
      this._log(`skill.uninstall: "${skillId}" removed=${result.removed}`);
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId, state: 'uninstalled',
        });
      } catch (e) {
        this._log(`skill.uninstall: failed to report status: ${e && e.message ? e.message : e}`);
      }
      await this._onSkillsChanged();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this._log(`skill.uninstall: FAILED "${skillId}": ${msg}`);
    }
  }

  /**
   * Hook for subclasses to react to a change in the installed-skills set
   * (e.g. rebuild prompt context). Default: no-op.
   */
  async _onSkillsChanged() {}

  /**
   * Post a chat message back to the requesting channel summarizing agent
   * name, type, agent-launcher version, uptime, and network. Used by the
   * `/status` slash command.
   */
  async _postStatusReport(payload) {
    const channel = (payload && typeof payload === 'object') ? payload.channel : null;
    if (!channel) return;

    let pkgVersion = 'unknown';
    try {
      const path = require('path');
      const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
      pkgVersion = pkg.version || 'unknown';
    } catch {}

    const uptimeMs = Math.max(0, Date.now() - this._startedAt);
    const totalSec = Math.floor(uptimeMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    let uptime;
    if (days > 0) uptime = `${days}d ${hours}h ${minutes}m`;
    else if (hours > 0) uptime = `${hours}h ${minutes}m`;
    else if (minutes > 0) uptime = `${minutes}m ${seconds}s`;
    else uptime = `${seconds}s`;

    const adapterType = this.agentType || 'unknown';
    const content =
      `**Agent status**\n` +
      `- Name: \`${this.agentName}\` (${adapterType})\n` +
      `- Version: agent-launcher \`${pkgVersion}\`\n` +
      `- Uptime: ${uptime}\n` +
      `- Network: \`${this.workspaceId}\``;

    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'chat',
        metadata: { agent_mode: this._mode },
        sessionId: this._sessionId,
      });
    } catch (e) {
      this._log(`Status: failed to post: ${e && e.message ? e.message : e}`);
    }
  }

  /**
   * Post a markdown table of the agent's active routines back to the
   * requesting channel. Used by the `/routines` slash command. Each agent
   * reports only routines it owns (created_by === 52hz:<agentName>)
   * so the user sees a clear "my routines" view per agent, mirroring how
   * /status reports per-agent uptime.
   */
  async _postRoutinesReport(payload) {
    const channel = (payload && typeof payload === 'object') ? payload.channel : null;
    if (!channel) return;

    let routines = [];
    try {
      const data = await this.client.listRoutines(this.workspaceId, channel, this.token);
      // Accept both the canonical `52hz:<name>` source and the bare
      // `<name>` form. Agents that follow the workspace prompt verbatim
      // produce the prefixed form, but some agents send the bare name when
      // they construct the POST body themselves.
      const prefixed = `52hz:${this.agentName}`;
      routines = ((data && data.routines) || []).filter(
        (r) => r.created_by === prefixed || r.created_by === this.agentName,
      );
    } catch (e) {
      this._log(`Routines: failed to list: ${e && e.message ? e.message : e}`);
      try {
        await this.client.sendMessage(
          this.workspaceId, channel, this.token,
          `**Routines for \`${this.agentName}\`**\n\n_Failed to fetch routines._`,
          { senderType: 'agent', senderName: this.agentName, messageType: 'chat', sessionId: this._sessionId },
        );
      } catch {}
      return;
    }

    let content;
    if (!routines.length) {
      content = `**Routines for \`${this.agentName}\`**\n\n_No active routines._`;
    } else {
      const rows = routines.map((r) => {
        const schedule = (r.schedule_interval_minutes != null)
          ? `every ${r.schedule_interval_minutes} min`
          : `${String(r.schedule_hour ?? 0).padStart(2, '0')}:${String(r.schedule_minute ?? 0).padStart(2, '0')} UTC` +
            (r.schedule_days ? ` (days [${r.schedule_days.join(',')}])` : ' daily');
        const next = r.next_fires_at || '...';
        const name = String(r.name || '').replace(/\|/g, '\\|');
        const id = String(r.id || '').slice(0, 8);
        return `| \`${id}\` | ${name} | ${schedule} | ${next} |`;
      });
      content =
        `**Routines for \`${this.agentName}\`** (${routines.length})\n\n` +
        '| ID | Name | Schedule | Next fires |\n' +
        '|---|---|---|---|\n' +
        rows.join('\n');
    }

    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'chat',
        metadata: { agent_mode: this._mode },
        sessionId: this._sessionId,
      });
    } catch (e) {
      this._log(`Routines: failed to post: ${e && e.message ? e.message : e}`);
    }
  }

  _hasActiveWork() {
    return this._channelBusy.size > 0;
  }

  _controlPollDelayMs() {
    return this._hasActiveWork() ? 500 : 2000;
  }

  _wakeControlPoller() {
    if (this._controlWake) {
      this._controlWake();
      this._controlWake = null;
    }
  }

  async _sleepUntilControlPollDue(delayMs) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, delayMs);
      this._controlWake = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    this._controlWake = null;
  }

  async _controlPollerLoop() {
    while (this._running) {
      await this._pollControl();
      if (!this._running) break;
      await this._sleepUntilControlPollDue(this._controlPollDelayMs());
    }
  }

  // ------------------------------------------------------------------
  // Poll loop
  // ------------------------------------------------------------------

  async _pollLoop() {
    let idleCount = 0;
    let pollCount = 0;

    while (this._running) {
      pollCount++;
      let messages, rawCursor, composingActive = false;
      try {
        const result = await this.client.pollPending(
          this.workspaceId, this.agentName, this.token,
          { after: this._lastEventId }
        );
        messages = result.messages;
        rawCursor = result.cursor;
        composingActive = !!result.composing;
        if (pollCount <= 3 || pollCount % 200 === 0) {
          this._log(`Poll #${pollCount}: ${messages.length} messages, cursor=${rawCursor || 'none'}${composingActive ? ' composing' : ''}`);
        }
      } catch (e) {
        // Back off on sustained failure. A deleted or mistyped workspace now
        // correctly 404s (the server used to silently fall back to another
        // workspace and answer 200), so a dead adapter would otherwise hammer
        // this endpoint at 2 req/s forever without ever giving up or saying so.
        this._pollFailures = (this._pollFailures || 0) + 1;
        const backoff = Math.min(500 * 2 ** Math.min(this._pollFailures - 1, 6), 30_000);
        if (this._pollFailures === 1 || this._pollFailures % 20 === 0) {
          this._log(`Poll #${pollCount} failed (${this._pollFailures}x consecutively): ${e.message} �?backing off ${backoff}ms`);
        }
        await this._sleep(backoff);
        continue;
      }
      this._pollFailures = 0;

      if (rawCursor) this._lastEventId = rawCursor;

      // Deduplicate
      const incoming = [];
      for (const msg of messages) {
        const msgId = msg.id || msg.messageId;
        if (msgId && this._processedIds.has(msgId)) continue;
        if (msg.metadata?.tool_approval_response) {
          let handled = false;
          try { handled = await this._handleApprovalResponse(msg); } catch (e) {
            this._log(`Approval response handler failed: ${e.message}`);
          }
          if (handled) {
            if (msgId) this._processedIds.add(msgId);
            continue;
          }
        }
        if (['status', 'thinking', 'loading', 'error'].includes(msg.messageType)) continue;
        if (msg.messageType === 'queue_cancel') {
          if (msgId) this._processedIds.add(msgId);
          const channel = msg.sessionId || this.channelName || 'general';
          const queueId = msg.metadata?.queue_id || (msg.content || '').replace('__queue_cancel:', '');
          if (queueId) this._cancelQueuedMessage(channel, queueId);
          continue;
        }

        // 方案 2 落地：禁�?Agent 自动对系统连线或非目标消息打招呼�?
        // 只有当消息来自用�?(human)，或者显�?@ 当前 Agent / 指定 targetAgents 时才激活回应�?
        const isHuman = msg.senderType === 'human' || msg.senderType === 'user' || msg.senderType === 'pipeline' || (msg.senderId || '').startsWith('human:') || (msg.senderId || '').startsWith('user:');
        const addressedAgents = leadingMentions(msg.content);
        const selfLower = this.agentName.toLowerCase();
        const rawTargetAgents = msg.targetAgents || msg.target_agents || msg.metadata?.target_agents || [];
        const targetedMe = Array.isArray(rawTargetAgents) && rawTargetAgents.some((t) => String(t).toLowerCase() === selfLower);
        const mentionsMe = addressedAgents.length > 0
          ? addressedAgents.includes(selfLower)
          : (targetedMe || (Array.isArray(msg.mentions) && msg.mentions.map((m) => String(m).toLowerCase()).includes(selfLower)) ||
            (typeof msg.content === 'string' && (
              msg.content.toLowerCase().includes(`@${selfLower}`) ||
              msg.content.toLowerCase().includes(`/${selfLower}`)
            )));
        const isSelf = msg.senderName === this.agentName || msg.senderId === `52hz:${this.agentName}` || msg.senderId === `agent:${this.agentName}`;

        if (isSelf) continue;

        const hopChannel = msg.sessionId || this.channelName || 'general';
        this._agentHopCounts = this._agentHopCounts || {};

        if (isHuman) {
          this._agentHopCounts[hopChannel] = 0;

          // If the human message explicitly targets specific agent(s) via @mention, /agent or targetAgents,
          // other agents who were NOT mentioned/targeted MUST NOT process or interrupt this message.
          const explicitTargeted = Array.isArray(msg.targetAgents) && msg.targetAgents.length > 0;
          const explicitMentions = Array.isArray(msg.mentions) && msg.mentions.length > 0;
          const contentWithoutKnowledge = typeof msg.content === 'string'
            ? msg.content.replace(/@knowledge:[a-zA-Z0-9_-]+/gi, ' ')
            : '';
          const textMentionMatches = contentWithoutKnowledge.match(/(?:^|\s)[@/]([a-zA-Z0-9_-]+)/g) || [];
          const agentMentions = textMentionMatches
            .map(m => m.trim().replace(/^[@/]/, ''))
            .filter(name => name.toLowerCase() !== 'knowledge' && !name.includes('.'));

          const hasSpecificTarget = explicitTargeted || explicitMentions || agentMentions.length > 0;

          if (hasSpecificTarget && !mentionsMe && !targetedMe) {
            this._log(`Ignoring human message targeted at other agent(s): mentionsMe=${mentionsMe}, targetedMe=${targetedMe}`);
            continue;
          }
        }

        if (!isHuman) {
          if (!mentionsMe && !targetedMe) {
            this._log(`Ignoring non-targeted message from ${msg.senderName || msg.senderId}`);
            continue;
          }

          const contentStr = typeof msg.content === 'string' ? msg.content : '';

          // 1. Action directive guard: check if message explicitly requests action
          //    from this.agentName.
          //
          //    `targetedMe` is the authoritative signal here �?the server already
          //    decided this message is for us and put us in metadata.target_agents.
          //    This used to read `msg.targetAgents`, a field _eventToMessage never
          //    builds (it exposes the raw `metadata`), so that half of the check was
          //    dead and a relayed hand-off survived only if its prose happened to
          //    match the regex below. An agent handing over with "here are the
          //    results" never did, so the relay reached the adapter and was dropped
          //    one line later.
          const actionRegex = new RegExp(`(?:请|步骤|step|让|由|交给|分派)\s*@?${this.agentName}|@?${this.agentName}\s*(?:请|处理|负责|编写|实现)`, 'i');
          const hasDirectAction = targetedMe || actionRegex.test(contentStr);

          // 2. Completion / wrap-up guard: if no direct action requested or if general wrap-up without explicit delegation, ignore
          const isFinished = /(任务|流程|工作|审查)(已|全|全部)?(完成|结束|完毕)|确认——报告已完成|所有三步协作|任务已全部完成|还有什么要做的吗|不需要再次|不存在/i.test(contentStr);
          //    The wrap-up test is a heuristic over prose, so it must not overrule
          //    an explicit server routing decision: a hand-off legitimately reads
          //    like a summary ("here are the results, @next take it from here").
          //    Loop protection is the hop limit below, which does not depend on
          //    wording.
          if (!hasDirectAction || (isFinished && !targetedMe && !actionRegex.test(contentStr))) {
            this._log(`Ignoring agent message from ${msg.senderName}: no direct action for ${this.agentName} or completion wrap-up message`);
            continue;
          }

          // 3. Hop-limit guard: hard backstop independent of wording (see
          // MAX_AGENT_HOPS_WITHOUT_HUMAN comment above).
          const hopCount = (this._agentHopCounts[hopChannel] || 0) + 1;
          if (hopCount > MAX_AGENT_HOPS_WITHOUT_HUMAN) {
            this._log(`Ignoring agent message from ${msg.senderName}: hop limit (${MAX_AGENT_HOPS_WITHOUT_HUMAN}) reached in channel ${hopChannel} without a human message �?likely ping-pong loop`);
            continue;
          }
          this._agentHopCounts[hopChannel] = hopCount;
        }

        incoming.push(msg);
      }

      if (incoming.length > 0) {
        idleCount = 0;
        for (const msg of incoming) {
          const msgId = msg.id || msg.messageId;
          if (msgId) this._processedIds.add(msgId);
          await this._dispatchMessage(msg);
        }
        if (this._processedIds.size > 2000) {
          const arr = [...this._processedIds];
          this._processedIds.clear();
          for (const id of arr.slice(-1000)) this._processedIds.add(id);
        }
      } else {
        idleCount++;
      }

      // Reasonable production polling with adaptive backoff:
      //   Active (incoming msgs processing): 200ms
      //   Warm (conversation active within last 15s): 1000ms (1s)
      //   Idle (long silence): 5000ms (5s)
      let delay;
      if (incoming.length > 0) {
        delay = 200;
      } else if (idleCount <= 15) { // First 15s of idle
        delay = 1000;
      } else {
        delay = 5000;
      }

      await this._sleep(delay);
    }
  }

  // Adapter-specific approval bridges override this. Returning true consumes
  // the response so it cannot start an ordinary agent turn.
  async _handleApprovalResponse(_msg) {
    return false;
  }

  // ------------------------------------------------------------------
  // Channel dispatch
  // ------------------------------------------------------------------

  async _dispatchMessage(msg) {
    // Use sessionId only if it looks like a channel, not an agent target
    let channel = this.channelName || 'general';
    if (msg.sessionId && !msg.sessionId.startsWith('52hz:') && !msg.sessionId.startsWith('agent:')) {
      channel = msg.sessionId;
    }

    if (this._channelBusy.has(channel)) {
      if (!this._channelQueues[channel]) this._channelQueues[channel] = [];
      const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      msg._queueId = queueId;
      this._channelQueues[channel].push(msg);
      try {
        await this.sendStatus(channel, 'message queued �?will process after current task', {
          queued_message: (msg.content || '').slice(0, 200),
          queue_id: queueId,
        });
      } catch {}
      return;
    }

    // Run channel worker (don't await �?parallel execution)
    this._channelWorker(channel, msg);
    this._wakeControlPoller();
  }

  async cancelQueuedMessage(channel, queueId) {
    const queue = this._channelQueues[channel];
    if (!queue) return false;
    const idx = queue.findIndex((m) => m._queueId === queueId);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    this._log(`Cancelled queued message ${queueId} in ${channel}`);
    return true;
  }

  /**
   * Auto-resolves knowledge references in message content:
   * 1. Explicit `@knowledge:slug` mentions: inlines full markdown document.
   * 2. Implicit / Auto RAG: if no explicit @knowledge mention exists and message has substantive
   *    inquiry content, queries the workspace semantic search API and injects top matching snippets.
   */
  async _resolveKnowledgeMentions(content) {
    if (!content || typeof content !== 'string') return content;
    const matches = content.match(/@knowledge:([a-zA-Z0-9_-]+)/g);

    // 1. Explicit @knowledge:slug mentions
    if (matches && matches.length > 0) {
      const slugs = Array.from(new Set(matches.map((m) => m.replace(/^@knowledge:/, ''))));
      const attachedKnowledge = [];

      for (const slug of slugs) {
        try {
          let entry = null;
          if (this.client && this.workspaceId && this.token) {
            try {
              entry = await this.client.getKnowledgeBySlug(this.workspaceId, this.token, slug);
            } catch (e) {}
            if (!entry || !entry.content) {
              try {
                entry = await this.client.getKnowledge(this.workspaceId, this.token, slug);
              } catch (e) {}
            }
          }
          if (entry && (entry.content || entry.title)) {
            this._log(`Auto-injected knowledge base entry: ${entry.title || slug} (@knowledge:${slug})`);
            attachedKnowledge.push(
              `\n---\n📁 [系统附带知识库文�? ${entry.title || slug} (@knowledge:${slug})]\n${entry.content || ''}\n---`
            );
          }
        } catch (err) {
          this._log(`Failed to resolve knowledge mention @knowledge:${slug}: ${err.message}`);
        }
      }

      if (attachedKnowledge.length > 0) {
        return `${attachedKnowledge.join('\n\n')}\n\n${content}`;
      }
      return content;
    }

    // 2. Implicit Auto-RAG for substantive questions (length >= 6 and not pure command/code)
    if (this.client && this.workspaceId && this.token && typeof this.client.searchKnowledge === 'function') {
      const cleanText = content.replace(/@[a-zA-Z0-9_-]+/g, '').trim();
      // Only search if user prompt is between 6 and 300 chars, not starting with markdown code fences or commands
      if (cleanText.length >= 6 && cleanText.length <= 300 && !cleanText.startsWith('```') && !cleanText.startsWith('/')) {
        try {
          const searchRes = await this.client.searchKnowledge(this.workspaceId, this.token, {
            query: cleanText,
            limit: 2,
            threshold: 0.35,
          });
          const results = (searchRes && searchRes.results) || [];
          if (results.length > 0) {
            const snippets = results.map((r) =>
              `\n---\n📁 [相关知识库参�? ${r.title} > ${r.section} (@knowledge:${r.slug})]\n${r.snippet}\n---`
            );
            this._log(`Auto-RAG retrieved ${results.length} knowledge chunk(s) for prompt: "${cleanText.slice(0, 40)}"`);
            return `${snippets.join('\n\n')}\n\n${content}`;
          }
        } catch (e) {
          // Non-fatal, continue with original content
        }
      }
    }

    return content;
  }

  async _channelWorker(channel, msg) {
    this._channelBusy.add(channel);
    try {
      if (msg && typeof msg.content === 'string') {
        msg.content = await this._resolveKnowledgeMentions(msg.content);
      }
      await this._handleMessage(msg);
    } catch (e) {
      this._log(`Error in channel worker for ${channel}: ${e.message}`);
      try { await this.sendError(channel, `Agent error: ${e.message}`); } catch {}
    }

    // Drain queue
    while (true) {
      const queue = this._channelQueues[channel];
      if (!queue || queue.length === 0) break;
      const nextMsg = queue.shift();
      if (nextMsg._queueId) {
        try { await this.sendStatus(channel, 'processing queued message', { queue_id: nextMsg._queueId, queue_status: 'processed' }); } catch {}
      }
      try {
        if (nextMsg && typeof nextMsg.content === 'string') {
          nextMsg.content = await this._resolveKnowledgeMentions(nextMsg.content);
        }
        await this._handleMessage(nextMsg);
      } catch (e) {
        this._log(`Error processing queued message in ${channel}: ${e.message}`);
        try { await this.sendError(channel, `Agent error: ${e.message}`); } catch {}
      }
    }
    this._channelBusy.delete(channel);
  }

  // ------------------------------------------------------------------
  // Auto-title helper
  // ------------------------------------------------------------------

  async _autoTitleChannel(channel, content) {
    if (this._titledSessions.has(channel)) return;
    this._titledSessions.add(channel);
    const title = generateSessionTitle(content);
    if (!title) return;
    try {
      const info = await this.client.getSession(this.workspaceId, channel, this.token);
      if (!info.titleManuallySet && SESSION_DEFAULT_RE.test(info.title || '')) {
        await this.client.updateSession(
          this.workspaceId, channel, this.token,
          { title, autoTitle: true }
        );
        this._log(`Auto-titled channel: ${title}`);
      }
    } catch (e) {
      this._log(`Failed to auto-title channel: ${e.message}`);
    }
  }

  /**
   * Resolve the working directory a CLI-driving adapter should spawn into for
   * this channel/thread ("Open Folder" mode). Falls back to the agent-level
   * default (this.workingDir, or the per-agent sandbox) when the channel has
   * no bound directory, or when the bound directory doesn't exist on this
   * machine (e.g. typo, or the agent runs on a different host than the one
   * that set it).
   *
   * Cached per channel for WORKING_DIR_CACHE_TTL_MS so every message doesn't
   * pay a network round trip �?call after computing `channel` for a message,
   * not once at adapter startup, since the binding is per-thread not per-agent.
   */
  async _resolveWorkingDir(channel, messageText = '') {
    this._workingDirCache = this._workingDirCache || new Map();
    const cached = this._workingDirCache.get(channel);
    const now = Date.now();
    if (cached && now - cached.at < WORKING_DIR_CACHE_TTL_MS) {
      return cached.value;
    }

    const fallback = this.workingDir || defaultAgentWorkdir(this.agentName);
    let resolved = fallback;
    try {
      const info = await this.client.getSession(this.workspaceId, channel, this.token);
      if (info.workingDir && fs.existsSync(info.workingDir)) {
        resolved = info.workingDir;
      } else if (messageText && typeof messageText === 'string') {
        // Try parsing explicit working dir pattern from message text (e.g. "工作目录 D:\code\X I LIKE" or "D:\code\...")
        const match = messageText.match(/(?:工作目录|working\s*dir|directory|folder)[:�?\s]*([a-zA-Z]:\\[^\s"',;\n\r]+|\/[^\s"',;\n\r]+)/i)
          || messageText.match(/([a-zA-Z]:\\(?:[^\s"',;\n\r\\]+\\)*[^\s"',;\n\r\\]+)/);
        if (match && match[1] && fs.existsSync(match[1])) {
          resolved = match[1];
          this._log(`Auto-resolved working dir '${resolved}' from message text for channel ${channel}`);
        }
      }
    } catch (e) {
      this._log(`Failed to resolve channel working dir for ${channel}: ${e.message}`);
    }

    this._workingDirCache.set(channel, { value: resolved, at: now });
    return resolved;
  }

  // ------------------------------------------------------------------
  // Message helpers
  // ------------------------------------------------------------------

  async sendStatus(channel, content, extraMeta) {
    // Spreading a non-object here silently explodes it into char-indexed keys
    // ({0:'A',1:'n',...}), which is how a mis-passed status label ended up
    // corrupting the event metadata instead of failing loudly.
    const meta = (extraMeta && typeof extraMeta === 'object' && !Array.isArray(extraMeta))
      ? extraMeta
      : undefined;
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'status',
        metadata: { agent_mode: this._mode, ...meta },
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.isReplyPreview]
   *   This chunk is part of the model's REPLY, streamed early so the user sees
   *   progress �?not chain-of-thought.
   *
   *   Most adapters here stream the reply through this method and then post the
   *   assembled text again through `sendResponse`, so the same answer reaches
   *   the workspace twice. The receiving end used to have to guess which of the
   *   two it was looking at, by normalising both texts and testing for overlap;
   *   that guess silently failed whenever `sendResponse` rewrote the text on its
   *   way out (it strips ```decision and ```preview blocks), and the reader got
   *   the answer twice inside a "Thought" disclosure.
   *
   *   Pass `true` and the guess is not needed: the workspace can drop the
   *   preview the moment the real reply lands, and can render what is left as
   *   prose rather than as reasoning. Genuine `reasoning`/`thought` events must
   *   NOT pass it �?that is the whole distinction.
   */
  async sendThinking(channel, content, opts) {
    // Skip empty thinking traces entirely.
    if (!content || !content.trim()) return;
    const isReplyPreview = Boolean(opts && opts.isReplyPreview);
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'thinking',
        metadata: {
          agent_mode: this._mode,
          // Omitted rather than set false when absent, so an adapter that has
          // not been updated is distinguishable from one asserting "this really
          // is reasoning".
          ...(isReplyPreview ? { reply_preview: true } : {}),
        },
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  async sendResponse(channel, content) {
    // Promote an explicit ```decision block into metadata the workspace renders
    // as an interactive card. Sits here rather than in each adapter because
    // every adapter funnels its final reply through this one method �?the
    // per-adapter streaming paths (sendThinking/sendStatus) deliberately do NOT
    // parse, since a card that appears mid-stream and then moves is worse than
    // one that appears once at the end.
    const decision = extractDecisionQuestions(content);
    const questions = decision.questions;
    if (decision.invalid > 0) {
      this._log(
        `Decision block ignored (${decision.invalid} malformed) �?left as text ` +
        `so the question still reaches the user`
      );
    }

    // Preview runs on the decision pass's OUTPUT, so a reply carrying both
    // blocks has each stripped exactly once.
    const previewResult = extractPreview(decision.text);
    const preview = previewResult.preview;
    if (previewResult.invalid > 0) {
      this._log(
        `Preview block ignored (${previewResult.invalid} malformed or ` +
        `non-loopback) �?left as text`
      );
    }
    if (preview) this._log(`Preview target reported: ${preview.url}`);

    // If the reply was nothing but blocks, an empty body renders as a blank
    // bubble above the card. Fall back to something that says what happened.
    let body = previewResult.text;
    if (!body) {
      if (questions) body = questions[0].title;
      else if (preview) body = `Dev server running at ${preview.url}`;
    }

    const metadata = {};
    if (questions) metadata.questions = questions;
    if (preview) metadata.preview = preview;

    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, body, {
        senderType: 'agent',
        senderName: this.agentName,
        sessionId: this._sessionId,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._onSessionRevoked();
        return;
      }
      throw e;
    }
  }

  async cleanupTodos(channel) {
    try {
      const result = await this.client.getTodos(this.workspaceId, channel, this.token, {
        all: false,
      });
      const todos = (result && result.todos) || [];
      const hasActive = todos.some((t) => t.status === 'pending' || t.status === 'in_progress');
      if (!hasActive) return;
      const updated = todos.map((t) => ({
        content: t.content,
        status: (t.status === 'pending' || t.status === 'in_progress') ? 'cancelled' : t.status,
        assignee: t.assignee,
      }));
      await this.client.putTodos(this.workspaceId, channel, this.token, updated, {
        source: `52hz:${this.agentName}`,
      });
    } catch {
      // Best-effort cleanup
    }
  }

  async getRemainingTodos(channel) {
    try {
      const result = await this.client.getTodos(this.workspaceId, channel, this.token, {
        all: false,
      });
      const todos = (result && result.todos) || [];
      return todos.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    } catch {
      return [];
    }
  }

  async sendTodos(channel, todos) {
    try {
      await this.client.putTodos(this.workspaceId, channel, this.token, todos, {
        source: `52hz:${this.agentName}`,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) { this._onSessionRevoked(); return; }
      // Fallback to event-based approach for older backends
      const lines = todos.map((t) => {
                const icon = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
        return `${icon} ${t.content}`;
      });
      try {
        await this.client.sendMessage(this.workspaceId, channel, this.token, lines.join('\n'), {
          senderType: 'agent',
          senderName: this.agentName,
          messageType: 'todos',
          metadata: { agent_mode: this._mode, todos },
          sessionId: this._sessionId,
        });
      } catch (e2) {
        if (e2 instanceof SessionRevokedError) this._onSessionRevoked();
      }
    }
  }

  async sendError(channel, error) {
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, error, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'error',
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  _onSessionRevoked() {
    this._log(`SESSION REVOKED: another client joined as '${this.agentName}'. Stopping adapter.`);
    this._running = false;
  }

  // ------------------------------------------------------------------
  // Abstract
  // ------------------------------------------------------------------

  /**
   * Process a single incoming message. Must be implemented by subclasses.
   * @param {object} msg
   */
  async _handleMessage(_msg) {
    throw new Error('_handleMessage must be implemented by subclass');
  }

  // ------------------------------------------------------------------
  // Utility
  // ------------------------------------------------------------------

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Return whether the workspace has the Browser Fabric viewer toggle on.
   * Cached for the lifetime of the adapter �?restart to pick up a flip.
   * Falls back to false on error so the prompt builders don't accidentally
   * inject the strong directive against an older backend that can't route
   * to Browser Fabric.
   */
  async getBrowserEnabled() {
    if (this._browserEnabledCache === null) {
      try {
        const meta = await this.client.getWorkspaceMetadata(this.workspaceId, this.token);
        this._browserEnabledCache = !!(meta && meta.browserEnabled);
      } catch (e) {
        this._browserEnabledCache = false;
      }
    }
    return this._browserEnabledCache;
  }
}

module.exports = BaseAdapter;
