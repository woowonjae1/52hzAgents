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
const { AsyncLocalStorage } = require('async_hooks');
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

// Which adapter+channel the running code belongs to, so a bare `this._mode`
// read inside a turn resolves to THAT turn's mode (see the `_mode` getter).
// Turns of different channels run concurrently, so an instance field alone
// cannot say which one is asking.
const turnScope = new AsyncLocalStorage();

const TURN_MODES = new Set(['execute', 'plan']);

const DEFAULT_ENDPOINT = process.env.WWJ_WORKSPACE_ENDPOINT || process.env.WWJ_ENDPOINT || 'http://localhost:8000';

// Heartbeat runs every 30s. A SINGLE failure is usually a transient blip (brief
// network hiccup, server redeploy) that the next tick recovers from — surfacing
// it as a hard 'error' would make the agent flap red for no real reason. Only
// after this many CONSECUTIVE failures (~60s+ of real downtime) do we report
// heartbeat_failed up to the daemon. A success resets the streak immediately.
const HEARTBEAT_ERROR_THRESHOLD = 2;

// Hard cutoff for agent-to-agent ping-pong: the completion-phrase and
// direct-action regexes below are wording-dependent and can be bypassed by
// two agents that keep issuing directives at each other without ever using a
// phrase either regex recognizes. This counter is the backstop — it counts
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

/*
  The human-readable half of a tool call: the one field worth putting in the
  sentence. Which field that is depends on the tool, and every adapter had
  already grown the same little ladder inline before sending its status string.
*/
function toolCallDetail(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args.length > 120 ? args.slice(0, 117) + '...' : args;
  if (typeof args !== 'object') return String(args);
  // Lower-case keys are the common CLI shape; the PascalCase ones are
  // Antigravity's (`run_command` → CommandLine, `view_file` → AbsolutePath, ...).
  // Without them every agy call reached the transcript as a bare tool name.
  for (const key of [
    'command', 'cmd', 'path', 'file_path', 'filePath', 'file', 'url', 'query', 'pattern',
    'CommandLine', 'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'Query', 'Pattern', 'Url',
  ]) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.length > 120 ? value.slice(0, 117) + '...' : value;
    }
  }
  return '';
}

/**
 * A message the workspace itself posted (a timer firing, a parallel-batch
 * summary or retry) rather than a person or another agent. Implicit
 * knowledge-base retrieval is skipped for these: their text is machine-written,
 * and matching it against the knowledge base only drags in whatever shares a
 * word with it -- "Check the tsc task status and view the log output" pulled
 * in two unrelated MQTT API sections about `status` and `systemLogs`.
 */
function isSystemMessage(msg) {
  return String((msg && msg.senderName) || '').startsWith('system:');
}

/** Lines kept in a channel recap (see _buildChannelContext). */
const RECAP_TAIL_LINES = 20;

/*
  Persisted message cursor (see _initEventCursor). A stored cursor older than
  CURSOR_MAX_AGE_MS is ignored; resuming replays at most CURSOR_REPLAY_CAP
  messages. The file is rewritten when the cursor moves (at most every
  CURSOR_SAVE_INTERVAL_MS unless a message was just dispatched) and touched
  every CURSOR_TOUCH_INTERVAL_MS while idle, so a long-idle adapter that
  restarts still counts as recent. CURSOR_REPLAY_MARGIN_MS absorbs the throttle
  and clock skew when discarding events that predate the saved cursor.
*/
const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CURSOR_REPLAY_CAP = 50;
const CURSOR_SAVE_INTERVAL_MS = 5000;
const CURSOR_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const CURSOR_REPLAY_MARGIN_MS = 2 * 60 * 1000;

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
    // Consecutive heartbeat failures — a transient single blip must not flip the
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
    // Where the message cursor survives a restart (see _initEventCursor). Off
    // under `node --test` unless a test points it at a temp dir, for the same
    // reason _logFile is.
    this._cursorDir = process.env.NODE_TEST_CONTEXT ? null : path.join(os.homedir(), '.wwj', 'cursors');
    this._cursorSavedId = null;
    this._cursorSavedAt = 0;
    this._replayFloorMs = null;
    // Channels with a turn in flight, and the failure text of the current one,
    // for turn-state reporting (see _turnStarted / _turnEnded).
    this._runningTurns = new Set();
    this._turnErrors = {};
    this._turnReportChain = {};
    this._titledSessions = new Set();
    // The fallback mode, set by the `set_mode` control. A message that carries
    // `metadata.agent_mode` overrides it for that one turn (_turnModeOverride);
    // read the effective value through `_modeFor(channel)` / `this._mode`.
    this._defaultMode = 'execute';
    this._turnModeOverride = {};
    // Extra env for one turn's spawned CLI (a parallel lane's PORT). See _turnEnv.
    this._turnEnvOverride = {};
    this._lastControlId = null;
    this._controlWake = null;
    // Per-channel task tracking for parallel execution
    this._channelBusy = new Set();
    this._channelQueues = {};
    // Cached workspace.browser_enabled. Populated lazily on first read so we
    // don't pay an HTTP roundtrip per message — adapters that toggle the
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
    // silently lost — which makes any spawn/error diagnostics invisible.
    //
    // Not under `node --test` (it sets NODE_TEST_CONTEXT): the suite's fake
    // agents ("pi-test", "test-agent", errors like "boom") were being appended
    // to the user's real daemon.log, several hundred lines per run, mixed in
    // with the genuine failures that log exists to diagnose.
    this._logFile = logFile || (process.env.NODE_TEST_CONTEXT ? null : path.join(os.homedir(), '.wwj', 'daemon.log'));
    this._log = (msg) => {
      const ts = new Date().toISOString();
      const line = `${ts} INFO adapter [${this.agentName}]: ${msg}`;
      if (this._logFile) {
        try {
          fs.appendFileSync(this._logFile, line + '\n', 'utf-8');
        } catch {}
      }
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
        this._log(`Files: skipping ${base} — ${Math.round(stat.size / 1048576)}MB exceeds the 50MB limit`);
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

  /*
    FILES AN AGENT WROTE THIS TURN GO TO THE WORKSPACE'S FILES PANEL.

    Only claude ever did this -- it watches its own Write/Edit tool calls and
    calls registerProducedFile. Every other adapter (pi, codex, gemini, ...)
    registered nothing, so their output never appeared in Files. After each
    turn, the channel's working directory is scanned for files modified since
    the turn began and each is registered; registerProducedFile already skips
    dotfiles, internal dirs, empty and >50MB files, and dedupes by
    path|size|mtime. Bounded (entries visited, files registered) so a huge repo
    cannot stall the channel. Adapters that track writes precisely set
    `_tracksProducedFiles` and skip this.
  */
  async _registerFilesTouchedSince(channel, sinceMs) {
    if (this._tracksProducedFiles) return;
    let dir;
    try { dir = await this._resolveWorkingDir(channel); } catch { return; }
    if (!dir) return;
    const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage', 'venv', '.venv']);
    const SKIP_FILES = /(^package-lock\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|\.log$|\.lock$|\.tmp$)/i;
    const MAX_VISITED = 8000;
    const MAX_FILES = 20;
    const found = [];
    const stack = [dir];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_VISITED && found.length < MAX_FILES) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++visited >= MAX_VISITED || found.length >= MAX_FILES) break;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(full);
        } else if (entry.isFile() && !SKIP_FILES.test(entry.name)) {
          try {
            if (fs.statSync(full).mtimeMs >= sinceMs) found.push(full);
          } catch {}
        }
      }
    }
    for (const file of found) {
      await this.registerProducedFile(channel, file);
    }
  }

  // ------------------------------------------------------------------
  // Runtime status reporting (daemon surfaces this in daemon.status.json)
  // ------------------------------------------------------------------

  /**
   * Surface a live status transition to the daemon. `reason` null/'' means the
   * agent is healthy again (clears any prior error). Deduped so a repeated
   * failure (e.g. heartbeat every 30s on a down workspace) writes the status
   * file once, not on every tick. Never throws — status is best-effort.
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
   * to the daemon status instead of only logging it — non-fatal, the poll/
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
      this._reportStatus(null); // joined OK → clear any prior error
      // A rejoin mid-turn: say the turns are still ours, or the backend reads
      // the new session as a restart and marks them failed.
      for (const channel of this._runningTurns || []) this._reportTurnState(channel, 'running');
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
    // its success — keeping these paths independent makes /restart and
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
      await this._initEventCursor();
      this._log('Starting poll loop...');
      await this._pollLoop();

      if (this._running && !this._stopRequested) {
        const msg = 'Message polling loop exited unexpectedly';
        this._log(`CRITICAL: ${msg}`);
        this._setExitInfo(REASON.ADAPTER_CRASHED, msg);
        this._reportStatus(REASON.ADAPTER_CRASHED, msg);
        if (this._sessionId) {
          try {
            await this.client.heartbeat(this.workspaceId, this.agentName, this.token, this._sessionId, 'crashed', msg);
          } catch {}
        }
      }
    } catch (e) {
      if (!this._stopRequested) {
        const msg = `Message polling loop crashed: ${e && e.message ? e.message : String(e)}`;
        this._log(`CRITICAL: ${msg}`);
        this._setExitInfo(REASON.ADAPTER_CRASHED, msg);
        this._reportStatus(REASON.ADAPTER_CRASHED, msg);
        if (this._sessionId) {
          try {
            await this.client.heartbeat(this.workspaceId, this.agentName, this.token, this._sessionId, 'crashed', msg);
          } catch {}
        }
      }
      throw e;
    } finally {
      this._running = false;
      this._wakeControlPoller();
      clearInterval(heartbeatInterval);
      try { await controlPoller; } catch {}
      // Not before the first successful poll: rewriting a resumed cursor then
      // would move its savedAt past a replay that never ran.
      if (this._cursorPolled) this._persistCursor(true);
      // Before disconnect: a clean stop ends its turns idle; anything else
      // ends them in error rather than leaving them looking busy.
      try {
        await this._endRunningTurns(
          this._stopRequested ? null : ((this._exitInfo && this._exitInfo.message) || 'adapter stopped mid-turn')
        );
      } catch {}
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

  /*
    WHERE THE POLL LOOP STARTS.

    Skipping to the head on every start meant anything posted while the adapter
    was down or restarting was never seen -- and the daemon now restarts
    adapters on its own, so that window opens on every crash. The cursor is
    persisted as the loop advances; a recent one is resumed from, with the
    replay capped so a stale cursor cannot flood the agent with old work.
  */
  async _initEventCursor() {
    let resumed = false;
    try {
      resumed = await this._resumeFromStoredCursor();
    } catch (e) {
      this._log(`Could not resume from the stored cursor (${e && e.message ? e.message : e}); skipping to head`);
      this._replayFloorMs = null;
    }
    // A resumed cursor is not rewritten until the replay has been polled: a
    // crash in between must find the original savedAt, not a fresh one.
    if (!resumed) {
      await this._skipExistingEvents();
      this._persistCursor(true);
    }
  }

  async _resumeFromStoredCursor() {
    const stored = this._readStoredCursor();
    if (!stored) return false;
    const age = Date.now() - stored.savedAt;
    if (age > CURSOR_MAX_AGE_MS) {
      this._log(`Stored cursor is ${Math.round(age / 3600000)}h old; skipping to head`);
      return false;
    }
    if (!this.client || typeof this.client.listAgentEvents !== 'function') return false;

    const probe = await this.client.listAgentEvents(this.workspaceId, this.agentName, this.token, {
      after: stored.eventId, limit: CURSOR_REPLAY_CAP,
    });
    if (!probe.hasMore) {
      this._lastEventId = stored.eventId;
      this._replayFloorMs = stored.savedAt - CURSOR_REPLAY_MARGIN_MS;
      this._log(`Resuming from stored cursor ${stored.eventId} (${probe.events.length} event(s) since, saved ${Math.round(age / 1000)}s ago)`);
      return true;
    }

    // Over the cap: start just before the newest CURSOR_REPLAY_CAP instead.
    const tail = await this.client.listAgentEvents(this.workspaceId, this.agentName, this.token, {
      sort: 'desc', limit: CURSOR_REPLAY_CAP + 1,
    });
    const boundary = tail.events.length > CURSOR_REPLAY_CAP ? tail.events[CURSOR_REPLAY_CAP] : null;
    if (!boundary || !boundary.id) return false;
    this._lastEventId = boundary.id;
    this._replayFloorMs = stored.savedAt - CURSOR_REPLAY_MARGIN_MS;
    this._log(`Stored cursor ${stored.eventId} is more than ${CURSOR_REPLAY_CAP} events behind; replaying only the newest ${CURSOR_REPLAY_CAP}, older ones skipped`);
    return true;
  }

  _cursorFile() {
    if (!this._cursorDir || !this.workspaceId || !this.agentName) return null;
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this._cursorDir, `${safe(this.workspaceId)}_${safe(this.agentName)}.json`);
  }

  _readStoredCursor() {
    const file = this._cursorFile();
    if (!file) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (data && typeof data.eventId === 'string' && data.eventId && Number.isFinite(data.savedAt)) return data;
    } catch {}
    return null;
  }

  /**
   * Write the cursor to disk. Throttled: a moved cursor at most every
   * CURSOR_SAVE_INTERVAL_MS, an unmoved one touched every
   * CURSOR_TOUCH_INTERVAL_MS; `force` writes now (after a dispatch, on start
   * and on stop). Never throws.
   */
  _persistCursor(force = false) {
    const file = this._cursorFile();
    const id = this._lastEventId;
    if (!file || !id) return;
    const now = Date.now();
    const elapsed = now - this._cursorSavedAt;
    if (!force) {
      const moved = id !== this._cursorSavedId;
      if (moved ? elapsed < CURSOR_SAVE_INTERVAL_MS : elapsed < CURSOR_TOUCH_INTERVAL_MS) return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ eventId: id, savedAt: now }));
      fs.renameSync(tmp, file);
      this._cursorSavedId = id;
      this._cursorSavedAt = now;
    } catch (e) {
      if (!this._cursorWriteWarned) {
        this._cursorWriteWarned = true;
        this._log(`Could not persist the message cursor (${e && e.message ? e.message : e}); a restart will skip to head`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Heartbeat
  // ------------------------------------------------------------------

  async _heartbeat() {
    /*
      NO SESSION MEANS JOIN AGAIN, NOT FAIL FOREVER.

      `_sessionId` comes only from /v1/join, and run() joined exactly once. A
      single failed join -- the backend still starting, one HTTP 500 -- left it
      null for the life of the process, and client.heartbeat() throws locally on
      a null session without sending anything. daemon.log 2026-09-22: one join
      500 at 08:51:45, then 168 heartbeat failures over 84 minutes while the
      backend was healthy, with the agent shown offline the whole time.
    */
    if (!this._sessionId) {
      const joined = await this._joinWorkspace();
      if (!joined || !this._sessionId) {
        this._heartbeatFailStreak++;
        this._log(`Rejoin failed; will retry on the next heartbeat (consecutive failures: ${this._heartbeatFailStreak})`);
        return;
      }
      this._log('Rejoined workspace after an earlier join failure');
    }
    try {
      await this.client.heartbeat(this.workspaceId, this.agentName, this.token, this._sessionId);
      this._heartbeatFailStreak = 0;
      this._reportStatus(null); // alive → clear any prior connectivity error

      // Periodic quota & usage background refresh
      if (typeof this.fetchAndReportUsage === 'function') {
        this.fetchAndReportUsage().catch(() => {});
      }
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._log(`SESSION REVOKED: another client joined as '${this.agentName}'. Stopping adapter.`);
        // Terminal (not a user stop): record so the daemon can show why it ended.
        this._setExitInfo(REASON.SESSION_REVOKED, 'Workspace session revoked — another client joined with the same agent name');
        this._reportStatus(REASON.SESSION_REVOKED, 'Workspace session revoked');
        this._running = false;
        return;
      }
      // 404 "Agent member not registered": the backend no longer knows this
      // member (database reset, member removed). Drop the session so the next
      // heartbeat joins again. 409 is a different client holding the name and
      // is handled above as revoked -- never fought over.
      // 409 session_expired: the server holds no session for us (we left, or
      // an older server cleared it on a heartbeat timeout). Same answer.
      if (e && (e.statusCode === 404 || /session_expired/i.test(e.message || ''))) this._sessionId = null;
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
   * polls and re-finds the same /restart event, bounces again — restart loop.
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

  // ------------------------------------------------------------------
  // Plan / execute mode
  // ------------------------------------------------------------------

  /**
   * The mode (execute | plan) in effect for `channel` right now: the running
   * turn's own mode when its message carried one, else the adapter default
   * from `set_mode`. Adapters should prefer this over `this._mode` wherever
   * they know the channel -- callbacks of a long-lived per-channel process
   * included.
   */
  _modeFor(channel) {
    const m = channel && this._turnModeOverride ? this._turnModeOverride[channel] : null;
    return m || this._defaultMode || 'execute';
  }

  /**
   * `this._mode` as a bare read: inside a turn it is that turn's mode (the
   * turn's async context carries its channel); outside any turn -- control
   * polling, status reports -- it is the adapter default. Assigning it sets
   * the default, as `set_mode` does.
   */
  get _mode() {
    const scope = turnScope.getStore();
    if (scope && scope.adapter === this) return this._modeFor(scope.channel);
    return this._defaultMode || 'execute';
  }

  set _mode(value) {
    this._defaultMode = value;
  }

  /**
   * Take the turn's mode from the message: the workspace attaches the
   * thread's Fix/Review choice as `metadata.agent_mode` to every message it
   * sends, so one agent can review in one thread and fix in another, and the
   * choice survives an adapter restart. Agents stamp their own messages with
   * their effective mode too, so a handoff inside a Review thread stays in
   * review. Anything else leaves the default in charge.
   */
  _enterTurnMode(channel, msg) {
    if (!this._turnModeOverride) this._turnModeOverride = {};
    // A delegated lane carries its profile's mode, and that wins over the
    // message's: a Review lane stays read-only whatever the delegator was in.
    const lane = this._laneDispatch(msg);
    const m = (lane && TURN_MODES.has(lane.mode) && lane.mode) || (msg && msg.metadata && msg.metadata.agent_mode);
    if (typeof m === 'string' && TURN_MODES.has(m)) this._turnModeOverride[channel] = m;
    else delete this._turnModeOverride[channel];
  }

  _exitTurnMode(channel) {
    if (this._turnModeOverride) delete this._turnModeOverride[channel];
  }

  /** Run one turn's handler with its channel attached to the async context. */
  _runInTurnScope(channel, fn) {
    return turnScope.run({ adapter: this, channel }, fn);
  }

  /**
   * Env vars the CLI spawned for this channel's current turn must get on top
   * of agentEnv -- a parallel lane's own PORT. Adapters merge it into the env
   * they spawn with; one that keeps a long-lived process per channel must
   * restart it when this differs from what the process was spawned with.
   */
  _turnEnv(channel) {
    const extra = channel && this._turnEnvOverride ? this._turnEnvOverride[channel] : null;
    return extra ? { ...extra } : {};
  }

  /** A stable comparison key for `_turnEnv(channel)` ('' when there is none). */
  _turnEnvKey(channel) {
    const env = this._turnEnv(channel);
    const keys = Object.keys(env).sort();
    return keys.length ? JSON.stringify(keys.map((k) => [k, env[k]])) : '';
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
          // Only the fallback: a message carrying metadata.agent_mode still
          // decides its own turn (see _enterTurnMode).
          const newMode = payload.mode || 'execute';
          if (TURN_MODES.has(newMode) && newMode !== this._defaultMode) {
            const oldMode = this._defaultMode;
            this._defaultMode = newMode;
            this._log(`Default mode changed: ${oldMode} -> ${newMode}`);
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
   * per-adapter actions (`stop`, `restart`, …); always call
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
   * show installing → installed / failed. Errors are logged loudly and
   * surfaced as a `failed` status — never swallowed.
   *
   * payload: { action: "skill.install", skill: { id, name, source_repo, source_path } }
   */
  async _handleSkillInstall(payload) {
    const installer = require('../skill-installer');
    const skill = (payload && payload.skill) || null;
    const skillId = skill && (skill.id || skill.skill_id);
    if (!skillId) {
      this._log('skill.install: missing skill metadata in payload — ignoring');
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
      this._log(`skill.install: SUCCESS "${skillId}" → ${result.path}${result.partial ? ' (partial)' : ''}`);
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
      this._log('skill.uninstall: missing skill metadata in payload — ignoring');
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
          this._log(`Poll #${pollCount} failed (${this._pollFailures}x consecutively): ${e.message} — backing off ${backoff}ms`);
        }
        await this._sleep(backoff);
        continue;
      }
      this._pollFailures = 0;
      this._cursorPolled = true;

      if (rawCursor) this._lastEventId = rawCursor;

      // Only the first poll after resuming a stored cursor carries the replay;
      // events older than the saved cursor were handled before the restart
      // (they come back when the stored id no longer exists server-side).
      const replayFloor = this._replayFloorMs;
      this._replayFloorMs = null;

      // Deduplicate
      const incoming = [];
      for (const msg of messages) {
        const msgId = msg.id || msg.messageId;
        if (msgId && this._processedIds.has(msgId)) continue;
        if (replayFloor !== null && replayFloor !== undefined) {
          const at = Date.parse(msg.createdAt || '');
          if (Number.isFinite(at) && at < replayFloor) {
            if (msgId) this._processedIds.add(msgId);
            continue;
          }
        }
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
          if (queueId) {
            // `cancelQueuedMessage`, NOT `_cancelQueuedMessage`.
            //
            // The underscored name has never existed -- this was the only
            // reference to it in the repo. So dismissing a queued message from
            // the composer threw `TypeError: this._cancelQueuedMessage is not a
            // function` inside the poll loop, which took the adapter down with
            // it: the agent dropped offline and had to be reconnected by hand.
            //
            // Awaited and guarded for the same reason. A rejected promise here
            // is an unhandled rejection in the same loop, and cancelling one
            // queued item must never be able to end the session.
            try {
              await this.cancelQueuedMessage(channel, queueId);
            } catch (e) {
              this._log(`Cancel queued message failed: ${e.message}`);
            }
          }
          continue;
        }

        // 方案 2 落地：禁止 Agent 自动对系统连线或非目标消息打招呼。
        // 只有当消息来自用户 (human)，或者显式 @ 当前 Agent / 指定 targetAgents 时才激活回应。
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

        /*
          AN OPEN DECISION CARD HOLDS THE FLOOR.

          When an agent ends a turn with a ```decision block, the workspace
          renders an ApprovalCard and waits for a person to pick. Nothing
          stopped the OTHER agents in the channel from answering meanwhile,
          so the question was routinely overtaken by a reply to it before
          anyone had chosen -- and whatever the human then picked landed in a
          conversation that had already moved on.

          Per channel and best effort: the gate opens when a message carrying
          decision questions goes by, and closes on an explicit
          `decision_response`, or on the human simply saying something else,
          which is them moving on. The agent that ASKED is never gated by its
          own question.
        */
        const decisionChannel = msg.sessionId || this.channelName || 'general';
        this._openDecisions = this._openDecisions || {};
        const carriesDecision =
          (Array.isArray(msg.metadata?.questions) && msg.metadata.questions.length > 0) ||
          (Array.isArray(msg.metadata?.decision_questions) && msg.metadata.decision_questions.length > 0);

        if (carriesDecision) {
          this._openDecisions[decisionChannel] = { by: msg.senderName || msg.senderId || 'agent' };
        } else if (msg.metadata?.decision_response || isHuman) {
          delete this._openDecisions[decisionChannel];
        }

        const openDecision = this._openDecisions[decisionChannel];
        if (openDecision && !carriesDecision && openDecision.by !== this.agentName) {
          this._log(`Holding: decision card from ${openDecision.by} in ${decisionChannel} is unanswered`);
          if (msgId) this._processedIds.add(msgId);
          continue;
        }

        const hopChannel = msg.sessionId || this.channelName || 'general';
        this._agentHopCounts = this._agentHopCounts || {};

        // Authoritative orchestration messages (pipeline relay, self-correction retry, or queue-wake):
        // When targeted at this agent, these MUST bypass all heuristic filters (wrap-up regex,
        // action regex, hop count guards) because their content naturally contains status summaries
        // like "Prior Stage Deliverables: completed" which would otherwise trigger the wrap-up drop.
        const isPipelineRelay = msg.metadata?.pipeline_step && msg.metadata?.auto_relay;
        const isSelfCorrection = msg.metadata?.pipeline_step && msg.metadata?.self_correct;
        const isQueuedWake = msg.metadata?.queued_wake;
        if ((isPipelineRelay || isSelfCorrection || isQueuedWake) && (targetedMe || mentionsMe)) {
          this._log(`Accepting pipeline ${isPipelineRelay ? 'relay' : isSelfCorrection ? 'self-correction' : 'queue-wake'} message for ${this.agentName}`);
          incoming.push(msg);
          continue;
        }

        if (isHuman) {
          this._agentHopCounts[hopChannel] = 0;

          // If the human message explicitly targets specific agent(s) via @mention, /agent or targetAgents,
          // other agents who were NOT mentioned/targeted MUST NOT process or interrupt this message.
          const explicitTargeted = (Array.isArray(msg.targetAgents) && msg.targetAgents.length > 0) || (Array.isArray(rawTargetAgents) && rawTargetAgents.length > 0);
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
          //    `targetedMe` is the authoritative signal here  —the server already
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
            this._log(`Ignoring agent message from ${msg.senderName}: hop limit (${MAX_AGENT_HOPS_WITHOUT_HUMAN}) reached in channel ${hopChannel} without a human message — likely ping-pong loop`);
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

      // Right away once something was dispatched -- that is the moment a
      // restart must not replay -- otherwise throttled.
      this._persistCursor(incoming.length > 0);

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
        await this.sendStatus(channel, 'message queued · will process after current task', {
          queued_message: (msg.content || '').slice(0, 200),
          queue_id: queueId,
        });
      } catch {}
      return;
    }

    // Run channel worker (don't await — parallel execution)
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
  async _resolveKnowledgeMentions(content, { autoRag = true } = {}) {
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
              `\n---\n📁 [系统附带知识库文档: ${entry.title || slug} (@knowledge:${slug})]\n${entry.content || ''}\n---`
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
    if (autoRag && this.client && this.workspaceId && this.token && typeof this.client.searchKnowledge === 'function') {
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
              `\n---\n📁 [相关知识库参考: ${r.title} > ${r.section} (@knowledge:${r.slug})]\n${r.snippet}\n---`
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

  /*
    Whether the turn in progress on a channel ended in an error.

    _releaseStaleTodos needs it to close a stranded row HONESTLY: a turn that
    failed did not do the work, and a turn that succeeded almost certainly did.
    Set from two places because failures arrive two ways — thrown out of
    _handleMessage (caught below), or caught inside an adapter and reported via
    sendError, which is how pi, claude and most others end a failed turn.
  */
  _markTurnFailed(channel) {
    if (!this._turnFailed) this._turnFailed = new Set();
    this._turnFailed.add(channel);
  }

  _beginTurn(channel) {
    if (this._turnFailed) this._turnFailed.delete(channel);
  }

  /*
    TURN STATE, IN THE AGENT'S OWN WORDS.

    The workspace used to guess whether an agent was working from which
    message came last, so a turn cut off by a crash left a thinking event
    behind and looked busy forever. The agent now says so: running when a turn
    starts, idle or error when it ends. Fire-and-forget -- a report never
    delays or fails the turn -- but chained per channel, so a fast turn's idle
    can never overtake its own running on the way to the server.
  */
  _reportTurnState(channel, state, error) {
    if (!this.client || typeof this.client.reportAgentTurn !== 'function') return Promise.resolve(null);
    const turn = { channel, state };
    if (error) turn.error = String(error).slice(0, 1000);
    if (!this._turnReportChain) this._turnReportChain = {};
    const prev = this._turnReportChain[channel] || Promise.resolve();
    const next = prev
      .then(() => this.client.reportAgentTurn(this.workspaceId, this.agentName, turn, this.token))
      .catch(() => null);
    this._turnReportChain[channel] = next;
    next.then(() => {
      if (this._turnReportChain[channel] === next) delete this._turnReportChain[channel];
    });
    return next;
  }

  _noteTurnError(channel, text) {
    if (!this._turnErrors) this._turnErrors = {};
    const t = String(text || '').trim();
    if (t) this._turnErrors[channel] = t.slice(0, 1000);
  }

  _turnStarted(channel) {
    if (!this._runningTurns) this._runningTurns = new Set();
    this._runningTurns.add(channel);
    if (this._turnErrors) delete this._turnErrors[channel];
    this._reportTurnState(channel, 'running');
  }

  _turnEnded(channel) {
    if (this._runningTurns) this._runningTurns.delete(channel);
    const failed = Boolean(this._turnFailed && this._turnFailed.has(channel));
    if (failed) {
      this._reportTurnState(channel, 'error', (this._turnErrors && this._turnErrors[channel]) || 'turn failed');
    } else {
      this._reportTurnState(channel, 'idle');
    }
  }

  /**
   * End every turn still in flight when the adapter stops: idle for a clean
   * stop (errorText null), error otherwise. Waits at most 2s for the reports.
   */
  async _endRunningTurns(errorText) {
    if (!this._runningTurns || this._runningTurns.size === 0) return;
    const channels = [...this._runningTurns];
    this._runningTurns.clear();
    const reports = channels.map((ch) => this._reportTurnState(ch, errorText ? 'error' : 'idle', errorText || undefined));
    let timer;
    await Promise.race([
      Promise.allSettled(reports),
      new Promise((resolve) => { timer = setTimeout(resolve, 2000); }),
    ]);
    clearTimeout(timer);
  }

  async _channelWorker(channel, msg) {
    this._channelBusy.add(channel);
    this._beginTurn(channel);
    this._turnStarted(channel);
    const turnStartedAt = Date.now();
    this._enterTurnMode(channel, msg);
    const lane = this._enterParallelLane(channel, msg);
    try {
      if (msg && typeof msg.content === 'string') {
        msg.content = await this._resolveKnowledgeMentions(msg.content, { autoRag: !isSystemMessage(msg) });
      }
      await this._runInTurnScope(channel, () => this._handleMessage(msg));
    } catch (e) {
      this._log(`Error in channel worker for ${channel}: ${e.message}`);
      this._noteTurnError(channel, e.message);
      this._markTurnFailed(channel);
      try { await this.sendError(channel, `Agent error: ${e.message}`); } catch {}
    } finally {
      this._turnEnded(channel);
      await this._releaseStaleTodos(channel, 'turn ended');
      this._registerFilesTouchedSince(channel, turnStartedAt).catch(() => {});
      if (lane) await this._exitParallelLane(channel, lane);
      this._exitTurnMode(channel);
    }

    // Drain queue
    while (true) {
      const queue = this._channelQueues[channel];
      if (!queue || queue.length === 0) break;
      const nextMsg = queue.shift();
      if (nextMsg._queueId) {
        try { await this.sendStatus(channel, 'processing queued message', { queue_id: nextMsg._queueId, queue_status: 'processed' }); } catch {}
      }
      this._beginTurn(channel);
      this._turnStarted(channel);
      const queuedStartedAt = Date.now();
      this._enterTurnMode(channel, nextMsg);
      const queuedLane = this._enterParallelLane(channel, nextMsg);
      try {
        if (nextMsg && typeof nextMsg.content === 'string') {
          nextMsg.content = await this._resolveKnowledgeMentions(nextMsg.content, { autoRag: !isSystemMessage(nextMsg) });
        }
        await this._runInTurnScope(channel, () => this._handleMessage(nextMsg));
      } catch (e) {
        this._log(`Error processing queued message in ${channel}: ${e.message}`);
        this._noteTurnError(channel, e.message);
        this._markTurnFailed(channel);
        try { await this.sendError(channel, `Agent error: ${e.message}`); } catch {}
      } finally {
        this._turnEnded(channel);
        await this._releaseStaleTodos(channel, 'queued turn ended');
        this._registerFilesTouchedSince(channel, queuedStartedAt).catch(() => {});
        if (queuedLane) await this._exitParallelLane(channel, queuedLane);
        this._exitTurnMode(channel);
      }
    }
    this._channelBusy.delete(channel);
  }

  // ------------------------------------------------------------------
  // Parallel batch lanes
  // ------------------------------------------------------------------

  /**
   * If this message dispatches a lane of a parallel batch to THIS agent, set
   * the turn up for it: run in the lane's worktree, and prefix the message
   * with what this agent's part is and how to behave next to the others.
   * Returns the lane (with batch id) or null.
   */
  /** This agent's entry in a message's `parallel_batch.lanes`, or null. */
  _laneDispatch(msg) {
    const pb = msg && msg.metadata && msg.metadata.parallel_batch;
    if (!pb || !pb.batch_id || !pb.lanes || typeof pb.lanes !== 'object') return null;
    const key = Object.keys(pb.lanes).find((k) => k.toLowerCase() === String(this.agentName).toLowerCase());
    return key ? pb.lanes[key] : null;
  }

  _enterParallelLane(channel, msg) {
    const pb = msg && msg.metadata && msg.metadata.parallel_batch;
    const dispatch = this._laneDispatch(msg);
    if (!dispatch) return null;
    const lane = { ...dispatch, batchId: pb.batch_id, isolation: pb.isolation, others: Object.keys(pb.lanes).length - 1 };
    // The profile's model, the same way the composer's per-agent model choice
    // arrives (metadata.agent_models), so every adapter that honours that
    // honours this -- for the first dispatch, retries and resumes alike.
    if (lane.model && msg.metadata) {
      msg.metadata.agent_models = { ...(msg.metadata.agent_models || {}), [this.agentName]: lane.model };
    }
    const delegator = typeof pb.delegated_by === 'string' && pb.delegated_by ? pb.delegated_by : null;
    this._activeLanes = this._activeLanes || {};
    this._activeLanes[channel] = lane;

    if (lane.working_dir) {
      if (fs.existsSync(lane.working_dir)) {
        this._turnDirOverride = this._turnDirOverride || {};
        this._turnDirOverride[channel] = lane.working_dir;
      } else {
        this._log(`Parallel: lane worktree ${lane.working_dir} is missing; running in the channel folder`);
      }
    }
    this._lastReply = this._lastReply || {};
    delete this._lastReply[channel];

    // A resume is the agent's own timer waking it back into a lane it paused
    // (see _deferParallelLane). Same folder and rules; the headline says so,
    // because the conversation already holds the original brief.
    let headline;
    if (pb.resume) headline = '[Parallel batch] Resuming your part after the wait you scheduled. Pick up where you left off.';
    else if (delegator && lane.others === 0) headline = `[Delegated] @${delegator} handed you this task to do on your own.`;
    else if (delegator) headline = `[Delegated] @${delegator} split work between ${lane.others + 1} agents working at the same time; this is your part.`;
    else headline = `[Parallel batch] You are one of ${lane.others + 1} agents working at the same time on separate parts.`;
    const lines = [
      headline,
      '',
      'Your part:',
      lane.task || '(see the message below)',
      '',
    ];
    if (lane.mode === 'plan') {
      lines.push('This is a review: read, run read-only checks and report. Do not modify any files.');
    }
    if (lane.working_dir) {
      const others = lane.others > 0 ? 'The other agents are editing their own copies.' : 'The main checkout is not yours to change.';
      lines.push(`Work only inside ${lane.working_dir} -- your own git worktree on branch ${lane.branch}. ${others} Do not commit, merge, push or switch branches: your changes are committed and merged for you when you finish.`);
    } else if (lane.scope) {
      lines.push(`The other agents share this folder. Change files only under ${lane.scope}.`);
    } else {
      lines.push('The other agents share this folder. Change only what your part needs.');
    }
    // A per-lane port keeps two lanes' dev servers off each other's 3000/5173.
    // The brief tells the agent, and PORT in the spawned CLI's env makes the
    // usual dev servers pick it up on their own: a per-turn, per-channel
    // override (never agentEnv, which every channel shares) that CLI adapters
    // merge in via _turnEnv, restarting a long-lived process when it differs.
    const port = Number(lane.port);
    if (Number.isInteger(port) && port > 0) {
      this._turnEnvOverride = this._turnEnvOverride || {};
      this._turnEnvOverride[channel] = { PORT: String(port) };
      lines.push(`If you start a dev server or any listening process, use port ${port} -- other agents are using other ports.`);
    }
    if (delegator) {
      // The batch tells the delegator when every lane is done. A lane that
      // also @mentions it wakes it once per lane, mid-batch, for nothing.
      lines.push(`Finish with a short summary of what you did and found. It is delivered to @${delegator} automatically when all parts are done -- do not @mention anyone in it.`, '', '---', '');
    } else {
      lines.push('Finish with a short summary of what you changed.', '', '---', '');
    }
    if (msg && typeof msg.content === 'string') msg.content = lines.join('\n') + msg.content;
    this._log(`Parallel: lane of batch ${String(lane.batchId).slice(0, 8)}${lane.working_dir ? ` in ${lane.working_dir}` : ''}`);
    return lane;
  }

  /**
   * Stop any long-lived process this adapter keeps for `channel` whose cwd is
   * the lane's worktree. Per-turn CLIs have already exited; adapters that keep
   * a process alive across turns (ACP) override this.
   */
  async _releaseLaneProcess(_channel) {}

  /** The lane this channel's current turn is running, or null. */
  activeParallelLane(channel) {
    return (this._activeLanes && this._activeLanes[channel]) || null;
  }

  /**
   * Keep the current lane open past the end of this turn.
   *
   * For an agent that pauses itself -- Antigravity's `schedule` tool ("come
   * back when tsc finishes") ends the CLI run -- the turn ending is not the
   * lane ending. Reporting it done would commit half the work, count the lane
   * as finished, and let the wake-up run outside the worktree with no brief.
   * The caller must have arranged the wake-up to carry the lane (a timer with
   * `parallel_batch_id`); if that never fires, the backend's lane timeout
   * still fails the lane.
   */
  _deferParallelLane(channel) {
    this._deferredLanes = this._deferredLanes || new Set();
    this._deferredLanes.add(channel);
  }

  /** Report the lane's end to the backend, which commits and, last, merges. */
  async _exitParallelLane(channel, lane) {
    if (this._turnDirOverride) delete this._turnDirOverride[channel];
    if (this._turnEnvOverride) delete this._turnEnvOverride[channel];
    if (this._activeLanes) delete this._activeLanes[channel];
    if (this._deferredLanes && this._deferredLanes.delete(channel)) {
      try { await this._releaseLaneProcess(channel); } catch {}
      this._log(`Parallel: lane of batch ${String(lane.batchId).slice(0, 8)} paused; it resumes when its wake-up fires`);
      return;
    }
    const failed = Boolean(this._turnFailed && this._turnFailed.has(channel));
    const reply = (this._lastReply && this._lastReply[channel]) || '';
    // Before reporting: the last lane's report triggers the merge, which
    // removes the worktree -- and a process still running with its cwd in
    // there pins the directory (Windows refuses to delete it).
    try { await this._releaseLaneProcess(channel); } catch {}
    try {
      await this.client.completeParallelLane(this.workspaceId, lane.batchId, this.agentName, {
        status: failed ? 'failed' : 'done',
        error: failed ? 'the turn ended with an error' : '',
        reply: String(reply).slice(0, 4000),
      }, this.token);
    } catch (e) {
      this._log(`Parallel: could not report lane completion: ${e && e.message ? e.message : e}`);
    }
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
   * pay a network round trip — call after computing `channel` for a message,
   * not once at adapter startup, since the binding is per-thread not per-agent.
   */
  /**
   * The directory to spawn a CLI in, synchronously, for adapters whose spawn
   * site cannot await: a parallel lane's worktree for this turn, else the
   * channel folder _resolveWorkingDir last resolved (call it earlier in the
   * turn to warm the cache), else the agent's own folder.
   */
  _cwdFor(channel) {
    if (this._turnDirOverride && this._turnDirOverride[channel]) return this._turnDirOverride[channel];
    const cached = this._workingDirCache && this._workingDirCache.get(channel);
    if (cached && cached.value) return cached.value;
    return this.workingDir || defaultAgentWorkdir(this.agentName);
  }

  async _resolveWorkingDir(channel, messageText = '') {
    // A parallel lane runs this one turn in its own worktree. Checked before
    // the cache, and never written to it, so the next turn is back home.
    if (this._turnDirOverride && this._turnDirOverride[channel]) return this._turnDirOverride[channel];
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
        const match = messageText.match(/(?:工作目录|working\s*dir|directory|folder)[:：=\s]*([a-zA-Z]:\\[^\s"',;\n\r]+|\/[^\s"',;\n\r]+)/i)
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
  // Context reporting
  // ------------------------------------------------------------------

  /**
   * Report how full THIS agent's own context is in `channel`, as its CLI
   * measured it on the turn that just ended.
   *
   * The context belongs to the agent: each adapter resumes a per-channel CLI
   * session, and that session is what the model sees and what the CLI compacts.
   * So adapters report what their CLI measured -- prompt tokens of the LAST
   * model call (cache reads included), the window if the CLI states one -- and
   * report nothing rather than a guess when it does not. The backend fills a
   * missing window from the model name and labels it as a lookup.
   *
   * Fire-and-forget: it must never delay or fail a reply.
   *
   * @param {string} channel
   * @param {{promptTokens?: number, contextWindow?: number, model?: string, compacted?: boolean}} ctx
   */
  reportContext(channel, ctx) {
    if (!channel || !ctx || !this.client || typeof this.client.reportAgentContext !== 'function') return;
    const promptTokens = Number(ctx.promptTokens) > 0 ? Math.round(Number(ctx.promptTokens)) : 0;
    const contextWindow = Number(ctx.contextWindow) > 0 ? Math.round(Number(ctx.contextWindow)) : 0;
    const compacted = !!ctx.compacted;
    if (!promptTokens && !contextWindow && !compacted) return;
    const payload = { channel, prompt_tokens: promptTokens, context_window: contextWindow, compacted };
    if (ctx.model) payload.model = String(ctx.model);
    this.client.reportAgentContext(this.workspaceId, this.agentName, payload, this.token).catch(() => {});
  }

  /**
   * Build the channel-context prefix for one turn.
   *
   * Shared by the adapters that resume their own CLI session (claude, pi) and
   * by hermes for a plain recent-conversation recap. The prefix goes into the
   * USER message, not the system prompt: the session persists user messages,
   * so what is pushed in once stays known -- which is what lets the cursor
   * skip it next time. `_recapCursor` (channel -> last messageId accounted
   * for) is in-memory, so after a restart the first turn is a full recap.
   *
   * We are only *delivered* messages that @mention us (see BaseAdapter's
   * addressing filter), so everything else said in the channel — including
   * whole analyses posted by sibling agents — never reaches the CLI session.
   * A message like "@claude 你对以上分析怎么看" then resolves "以上" against
   * our own last turn instead of the message it actually points at. Pushing
   * the gap in is the only fix: the agent cannot know it is missing context,
   * so `workspace_get_history` (a pull) is never called.
   *
   * Two shapes, both keyed off `_recapCursor`:
   * - `full` (fresh CLI, or the cursor fell out of the fetch window): the
   *   old behaviour — a tail recap of the recent conversation, own messages
   *   included, since the new session has no history at all.
   * - incremental (a live/resumed session): only what was posted after the
   *   cursor, minus our own posts. Normally one to three lines.
   *
   * The cursor advances on every call, injected or not, so nothing replays.
   * Returns null when there is nothing worth adding.
   */
  async _buildChannelContext(channelName, opts = {}) {
    const {
      currentMessage = '',
      currentMessageId = null,
      full = false,
      // What a `full` recap opens with. The default fits an adapter whose
      // session was lost; one that keeps no session says so instead.
      fullIntro = 'You previously worked in this channel but your prior session is no ' +
        'longer available, so here is the recent conversation for context:',
    } = opts;
    if (!this._recapCursor) this._recapCursor = {};

    const messages = await this.client.getRecentMessages(
      this.workspaceId, channelName, this.token, 60
    );
    if (!messages || messages.length === 0) return null;

    const cursor = full ? null : this._recapCursor[channelName];

    let startIdx = 0;
    let incremental = false;
    if (cursor) {
      const idx = messages.findIndex((m) => m.messageId === cursor);
      if (idx === -1) {
        // Cursor aged out of the window — fall back to a tail recap rather
        // than replaying all 60 messages.
        startIdx = Math.max(0, messages.length - RECAP_TAIL_LINES);
      } else {
        startIdx = idx + 1;
        incremental = true;
      }
    } else {
      startIdx = Math.max(0, messages.length - RECAP_TAIL_LINES);
    }

    // Advance the cursor before any early return: these messages are now
    // accounted for whether or not they made it into the prefix.
    const ids = new Set();
    for (const m of messages) if (m.messageId) ids.add(m.messageId);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].messageId) { this._recapCursor[channelName] = messages[i].messageId; break; }
    }
    // The message we are handling may not have propagated to the events API
    // yet; pin the cursor to it so the next turn doesn't echo it back at us.
    if (currentMessageId && !ids.has(currentMessageId)) {
      this._recapCursor[channelName] = currentMessageId;
    }

    const lines = [];
    for (let i = startIdx; i < messages.length; i++) {
      const m = messages[i];
      const mt = m.messageType || 'chat';
      if (mt === 'status' || mt === 'thinking' || mt === 'loading') continue;
      const text = (m.content || '').trim();
      if (!text) continue;
      // Exclude the message being handled — the caller appends it below.
      if (currentMessageId ? m.messageId === currentMessageId : text === currentMessage) continue;
      // Our own posts are already in a live session's history.
      if (incremental && m.senderType !== 'human' && m.senderName === this.agentName) continue;
      const who = m.senderType === 'human'
        ? (m.senderName || 'user')
        : (m.senderName || 'agent');
      const truncated = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
      lines.push(`[${who}] ${truncated}`);
    }
    if (lines.length === 0) return null;

    const tail = lines.slice(-RECAP_TAIL_LINES).join('\n');
    if (!incremental) {
      return `${fullIntro}\n\n${tail}`;
    }
    return (
      '## Channel context you have not seen\n' +
      'Posted in this channel after your last turn. These were not delivered ' +
      'to you (only messages that @mention you are), so they are NOT in your ' +
      'conversation history:\n\n' +
      tail + '\n\n' +
      'The message below is the one addressed to you. If it refers to "the ' +
      'above", "that analysis", "the previous message" or anything similar, ' +
      'it means the channel messages above — not your own earlier work.'
    );
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
   *   progress — not chain-of-thought.
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
   *   NOT pass it — that is the whole distinction.
   */
  async sendThinking(channel, content, opts) {
    // Skip empty thinking traces entirely.
    if (!content || !content.trim()) return;
    const isReplyPreview = Boolean(opts && opts.isReplyPreview);

    if (!this._thinkingBuffers) {
      this._thinkingBuffers = new Map();
    }
    const bufKey = `${channel}:${isReplyPreview ? 'preview' : 'thinking'}`;
    let entry = this._thinkingBuffers.get(bufKey);
    if (!entry) {
      entry = {
        chunks: [],
        timer: null,
        promise: null,
        resolve: null,
      };
      this._thinkingBuffers.set(bufKey, entry);
    }

    entry.chunks.push(content);

    if (!entry.timer) {
      entry.promise = new Promise((res) => {
        entry.resolve = res;
      });
      entry.timer = setTimeout(() => {
        this._flushThinkingBuffer(channel, bufKey, isReplyPreview);
      }, 150);
    }
    return entry.promise;
  }

  async _flushThinkingBuffer(channel, bufKey, isReplyPreview) {
    if (!this._thinkingBuffers) return;
    const entry = this._thinkingBuffers.get(bufKey);
    if (!entry) return;
    this._thinkingBuffers.delete(bufKey);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const combinedContent = entry.chunks.join('');
    if (!combinedContent.trim()) {
      if (entry.resolve) entry.resolve();
      return;
    }
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, combinedContent, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'thinking',
        metadata: {
          agent_mode: this._mode,
          ...(isReplyPreview ? { reply_preview: true } : {}),
        },
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    } finally {
      if (entry.resolve) entry.resolve();
    }
  }

  async flushAllThinkingBuffers() {
    if (!this._thinkingBuffers || this._thinkingBuffers.size === 0) return;
    const entries = Array.from(this._thinkingBuffers.entries());
    for (const [bufKey, entry] of entries) {
      const parts = bufKey.split(':');
      const channel = parts[0];
      const isReplyPreview = bufKey.endsWith(':preview');
      await this._flushThinkingBuffer(channel, bufKey, isReplyPreview);
    }
  }

  /**
   * Report a tool call as STRUCTURE rather than as a sentence.
   *
   * The workspace has always been able to render one properly — a named card
   * with expandable arguments and a failed badge — off
   * `metadata.tool_name` / `tool_args` / `tool_status` / `tool_summary`.
   * Nothing ever set them. All seventeen adapters parsed the tool call out of
   * their CLI's event stream, threw the structure away, and sent a sentence:
   * pi sent `sendStatus(channel, 'bash > git status')`. The frontend's
   * `parseMessageStep` therefore always fell through to `parseStepContent`,
   * the branch its own comment calls "legacy text", which only recognises a
   * literal `**Using tool:** \`name\` \`\`\`args\`\`\`` shape that two of the
   * seventeen happened to emit.
   *
   * So this is not a new capability, it is the missing end of an existing one.
   * Adapters already hold `name` and `args` at the call site; they just need
   * somewhere structured to put them.
   *
   * `status` is 'running' | 'ok' | 'failed'.
   *
   * ONE CALL PER MESSAGE, because one message is one line. `parseMessageStep`
   * turns every message it is handed into its own `EventLine`, and nothing in
   * the frontend reads `tool_call_id` — grep it, `intermediate-steps.tsx` never
   * mentions the key. So sending a 'running' and then an 'ok' for the same call
   * draws TWO lines; it does not resolve the first. Send the status the adapter
   * is actually sure of, once: a CLI that reports a command after it ran (codex)
   * can send 'ok'/'failed' immediately, while one that only announces a start
   * (claude, amp) sends 'running' and leaves it there. `id` is still carried, so
   * the day the frontend does correlate a pair, this side already feeds it.
   *
   * @param {string} channel
   * @param {object} call
   * @param {string} call.name
   * @param {object|string} [call.args]
   * @param {'running'|'ok'|'failed'} [call.status]
   * @param {string} [call.id]     - stable across the start/end pair
   * @param {string} [call.summary] - one line; derived by the workspace if omitted
   */
  async sendToolCall(channel, call) {
    await this.flushAllThinkingBuffers();
    const name = call && typeof call.name === 'string' ? call.name.trim() : '';
    if (!name) return;

    // A readable line is still sent as the message body: it is what a client
    // that does not understand the metadata shows, and what lands in exports
    // and the daemon log.
    const detail = toolCallDetail(call.args);
    const text = detail ? `${name} ${detail}` : name;

    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, text, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'thinking',
        metadata: {
          agent_mode: this._mode,
          tool_name: name,
          ...(call.args !== undefined && call.args !== null ? { tool_args: call.args } : {}),
          ...(call.status ? { tool_status: call.status } : {}),
          ...(call.id ? { tool_call_id: String(call.id) } : {}),
          ...(call.summary ? { tool_summary: String(call.summary) } : {}),
        },
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  async sendResponse(channel, content) {
    await this.flushAllThinkingBuffers();
    // Promote an explicit ```decision block into metadata the workspace renders
    // as an interactive card. Sits here rather than in each adapter because
    // every adapter funnels its final reply through this one method — the
    // per-adapter streaming paths (sendThinking/sendStatus) deliberately do NOT
    // parse, since a card that appears mid-stream and then moves is worse than
    // one that appears once at the end.
    const decision = extractDecisionQuestions(content);
    const questions = decision.questions;
    if (decision.invalid > 0) {
      this._log(
        `Decision block ignored (${decision.invalid} malformed) — left as text ` +
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
        `non-loopback) — left as text`
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

    /*
      The final reply is retried on a transient failure. Every adapter calls
      this as `try { await this.sendResponse(...) } catch {}`, so one network
      blip or backend restart at the end of a long turn silently threw the
      whole answer away. One client_message_id across attempts makes the retry
      safe: if the first POST landed and only its response was lost, the server
      returns the existing event instead of posting a second copy.
    */
    this._lastReply = this._lastReply || {};
    this._lastReply[channel] = body;
    const clientMessageId = `${this.agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const delays = [1000, 3000, 8000];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.sendMessage(this.workspaceId, channel, this.token, body, {
          senderType: 'agent',
          senderName: this.agentName,
          sessionId: this._sessionId,
          clientMessageId,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
        return;
      } catch (e) {
        if (e instanceof SessionRevokedError) {
          this._onSessionRevoked();
          return;
        }
        const sc = e && e.statusCode;
        const transient = sc == null || sc >= 500 || sc === 429;
        if (!transient || attempt >= delays.length) {
          this._log(`Reply could not be posted to ${channel} after ${attempt + 1} attempt(s): ${e && e.message}`);
          throw e;
        }
        this._log(`Reply post failed (${e && e.message}); retrying in ${delays[attempt] / 1000}s`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
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

  /*
    A turn that ends leaves its to-do list behind.

    The workspace prompt has agents write the list BEFORE doing the work, so a
    turn that dies strands an `in_progress` row with no process behind it —
    observed on the board as a task sitting "In Progress" for 19 hours after a
    pi turn failed on an upstream 422. Nothing is running, so nothing may
    claim to be.

    Runs after EVERY turn, not only failed ones: `_channelWorker` serialises
    turns per channel, so by the time this fires the turn is over either way.
    An agent that finished properly has already closed its rows and this is a
    no-op; one that crashed, was stopped, or simply forgot gets corrected.

    Demote, don't annotate or cancel: the server's status vocabulary is only
    pending|in_progress|completed|cancelled (no `blocked`), the task itself is
    usually still real and worth keeping — so cancelling it would throw away
    work the user may want — and the only actual lie is "this is running".
    Contrast `cleanupTodos`, which DOES cancel everything and is for teardown.
  */
  async _releaseStaleTodos(channelName, reason) {
    try {
      if (!this.client || !this.workspaceId) return;
      const source = `52hz:${this.agentName}`;
      const data = await this.client.getTodos(this.workspaceId, channelName, this.token, {
        agent: this.agentName,
      });
      const todos = (data && data.todos) || [];
      const mine = todos.filter((t) => !t.source || t.source === source || t.createdBy === source);
      if (!mine.some((t) => t.status === 'in_progress')) return;

      /*
        A SCOPED TASK BELONGS TO A PARALLEL BATCH, AND A BATCH OUTLIVES A TURN.

        This demotion exists because agents write a board and then leave rows
        stranded at in_progress. That is right for every mode where one agent
        speaks per turn — but a parallel batch is precisely work that stays
        in_progress across several turns while other agents run beside it, and
        demoting it every turn would make the board lie in the other direction.

        The scope is the signal, rather than asking the server for the channel's
        orchestration mode: a scope only exists because somebody declared this
        task part of a split, it needs no extra request per turn, and a channel
        that leaves parallel mode simply stops creating them.
      */
      /*
        CLOSE THE ROW, DON'T PARK IT.

        This used to demote a stranded in_progress row to `pending`. That fixed
        the lie ("something is running") by telling a different one: the task
        now sat on the board as "waiting", forever, reminding the user about work
        that had either been done or had failed. Nothing ever moved it on again.

        The turn's outcome says which:
        - it ended in an error → the work was not done. `cancelled`, with the
          reason in `error` — the server has no `failed` status, and `error` is
          the field it keeps for exactly this.
        - it ended cleanly → the commoner case, and the one this function was
          first written for, is an agent that finished and forgot to close its
          own row. `completed`, which the board lets the user clear.
        A wrong `completed` costs one click to reopen; a wrong `pending` cost
        a permanent reminder nobody could explain.
      */
      const failed = Boolean(this._turnFailed && this._turnFailed.has(channelName));
      const closedStatus = failed ? 'cancelled' : 'completed';
      const next = mine.map((t) => ({
        content: t.content,
        status: t.status === 'in_progress' && !t.scope ? closedStatus : t.status,
        ...(t.status === 'in_progress' && !t.scope && failed
          ? { error: 'The turn ended with an error before this was finished.' }
          : (t.error ? { error: t.error } : {})),
        assignee: t.assignee,
        priority: t.priority,
        // Carried through because PutTodos is delete-and-reinsert: a field that
        // is not sent back is erased. Priority was lost exactly this way once,
        // and losing a scope would leave every batch permanently blocked as
        // "unscoped", which reads as a conflict that cannot be resolved.
        scope: t.scope,
        due_date: t.dueDate || t.due_date,
      }));
      if (!next.some((t, i) => t.status !== mine[i].status)) return;
      await this.client.putTodos(this.workspaceId, channelName, this.token, next, { source });
      this._log(`Released stale in_progress to-dos after turn ended: ${reason}`);
    } catch (e) {
      this._log(`Could not release stale to-dos: ${e.message}`);
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
    this._noteTurnError(channel, error);
    this._markTurnFailed(channel);
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
   * Cached for the lifetime of the adapter — restart to pick up a flip.
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
