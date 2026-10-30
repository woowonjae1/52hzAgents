const crypto = require('crypto');

const PHASES = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  GENERATING: 'generating',
  EXECUTING: 'executing',
  WAITING_APPROVAL: 'waiting_approval',
  COMPACTING: 'compacting',
  CANCELLING: 'cancelling',
  FINISHED: 'finished',
});

const OUTCOMES = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  INTERRUPTED: 'interrupted',
  APPROVAL_DENIED: 'approval_denied',
  APPROVAL_EXPIRED: 'approval_expired',
  STEP_LIMITED: 'step_limited',
});

const ALLOWED_TRANSITIONS = Object.freeze({
  queued: ['preparing', 'generating', 'cancelling', 'finished'],
  preparing: ['generating', 'executing', 'cancelling', 'finished'],
  generating: ['executing', 'waiting_approval', 'compacting', 'cancelling', 'finished'],
  executing: ['generating', 'waiting_approval', 'compacting', 'cancelling', 'finished'],
  waiting_approval: ['executing', 'cancelling', 'finished'],
  compacting: ['generating', 'executing', 'cancelling', 'finished'],
  cancelling: ['finished'],
  finished: [], // Terminal phase
});

class RunsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  static get PHASES() {
    return PHASES;
  }

  static get OUTCOMES() {
    return OUTCOMES;
  }

  create({
    id,
    sessionId,
    agentName = 'agent',
    modelId = null,
    mode = 'chat',
    clientMessageId = null,
    configSnapshot = null,
    phase = PHASES.QUEUED,
  }) {
    const runId = id || `run_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const snapshotJson = configSnapshot ? JSON.stringify(configSnapshot) : null;
    const initialStatus = phase === PHASES.FINISHED ? 'completed' : (phase === PHASES.QUEUED ? 'queued' : 'running');

    this.db.prepare(`
      INSERT INTO runs (
        id, session_id, agent_name, model_id, mode, status, phase, version,
        client_message_id, outcome, error_message, config_snapshot_json,
        heartbeat_at, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, NULL)
    `).run(
      runId,
      sessionId,
      agentName,
      modelId,
      mode,
      initialStatus,
      phase,
      clientMessageId,
      snapshotJson,
      Date.now(),
      now
    );

    return this.get(runId);
  }

  /**
   * Compare-and-swap state machine transition.
   * Ensures deterministic phase progressions and prevents race conditions.
   */
  transition(id, {
    expectedPhase = null,
    nextPhase,
    outcome = null,
    errorMessage = null,
    evidence = null,
  }) {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Run ${id} not found`);
    }

    // Terminal phase check
    if (current.phase === PHASES.FINISHED) {
      // If already finished and attempting another transition, reject unless idempotent cancellation
      if (nextPhase === PHASES.FINISHED && current.outcome === outcome) {
        return current;
      }
      throw new Error(`Cannot transition run ${id} from terminal phase 'finished' (current outcome: ${current.outcome})`);
    }

    // CAS check on expectedPhase
    if (expectedPhase && current.phase !== expectedPhase) {
      throw new Error(`Run state transition conflict: expected phase '${expectedPhase}', found '${current.phase}' for run ${id}`);
    }

    // Allowed transition check
    const allowed = ALLOWED_TRANSITIONS[current.phase] || [];
    if (!allowed.includes(nextPhase)) {
      throw new Error(`Invalid phase transition from '${current.phase}' to '${nextPhase}' for run ${id}`);
    }

    const sets = ['phase = ?', 'version = version + 1', 'heartbeat_at = ?'];
    const params = [nextPhase, Date.now()];

    let normalizedOutcome = outcome;
    if (outcome === 'success') normalizedOutcome = OUTCOMES.SUCCEEDED;

    // Sync legacy status column for backward compatibility
    let legacyStatus = 'running';
    if (nextPhase === PHASES.QUEUED) legacyStatus = 'queued';
    else if (nextPhase === PHASES.FINISHED) {
      legacyStatus = (normalizedOutcome === OUTCOMES.SUCCEEDED || normalizedOutcome === 'success' || normalizedOutcome === 'finished') ? 'completed' : 'failed';
    } else if (nextPhase === PHASES.CANCELLING) legacyStatus = 'cancelling';

    sets.push('status = ?');
    params.push(legacyStatus);

    if (normalizedOutcome !== null) {
      sets.push('outcome = ?');
      params.push(normalizedOutcome);
    }

    if (errorMessage !== null) {
      sets.push('error_message = ?');
      params.push(errorMessage);
    }

    if (evidence !== null) {
      sets.push('evidence_json = ?');
      params.push(typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
    }

    if (nextPhase === PHASES.FINISHED) {
      sets.push('ended_at = ?');
      params.push(new Date().toISOString());
    }

    params.push(id);
    params.push(current.version);

    const sql = `UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND version = ?`;
    const res = this.db.prepare(sql).run(...params);

    if (res.changes === 0) {
      throw new Error(`Run state transition race condition: version ${current.version} modified concurrently for run ${id}`);
    }

    return this.get(id);
  }

  start(id) {
    if (typeof id === 'string') {
      const run = this.get(id);
      if (!run) throw new Error(`Run ${id} not found`);
      return this.transition(id, {
        nextPhase: PHASES.GENERATING,
      });
    }
    return this.create({ ...id, phase: PHASES.GENERATING });
  }

  heartbeat(id, leaseMs = 30000) {
    const now = Date.now();
    const expiresAt = now + leaseMs;
    this.db.prepare(`
      UPDATE runs
      SET heartbeat_at = ?, lease_expires_at = ?
      WHERE id = ? AND phase != 'finished'
    `).run(now, expiresAt, id);
  }

  finish(id, { outcome = OUTCOMES.SUCCEEDED, errorMessage = null, evidence = null } = {}) {
    return this.transition(id, {
      nextPhase: PHASES.FINISHED,
      outcome,
      errorMessage,
      evidence,
    });
  }

  complete(id, options = {}) {
    return this.finish(id, options);
  }

  cancel(id) {
    const run = this.get(id);
    if (!run || run.phase === PHASES.FINISHED) return run;

    // Transition directly to cancelling or finished
    try {
      this.transition(id, {
        nextPhase: PHASES.CANCELLING,
      });
    } catch (_) {}

    return this.finish(id, {
      outcome: OUTCOMES.CANCELLED,
      errorMessage: 'Task was cancelled by user',
    });
  }

  /**
   * Scan and recover any active/interrupted runs after app restart or unexpected exit.
   * Marks uncompleted runs as interrupted and identifies unverified tool calls.
   * @returns {Array<Object>} List of recovered runs
   */
  recoverInterrupted() {
    const uncompletedRows = this.db.prepare(`
      SELECT id, session_id, agent_name, model_id, mode, status, phase, version,
             client_message_id, outcome, error_message, config_snapshot_json,
             heartbeat_at, lease_expires_at, evidence_json, started_at, ended_at
      FROM runs
      WHERE phase != 'finished'
    `).all();

    const recovered = [];
    const now = new Date().toISOString();

    for (const row of uncompletedRows) {
      // Find tools that were in 'running' state
      const unfinishedTools = this.db.prepare(`
        SELECT id, tool_name, args_json, path
        FROM tool_calls
        WHERE run_id = ? AND status = 'running'
      `).all(row.id);

      // Mark running tools as requiring verification
      if (unfinishedTools.length > 0) {
        this.db.prepare(`
          UPDATE tool_calls
          SET status = 'unknown_outcome', requires_verification = 1, ended_at = ?
          WHERE run_id = ? AND status = 'running'
        `).run(Date.now(), row.id);
      }

      let existingEvidence = {};
      if (row.evidence_json) {
        try { existingEvidence = JSON.parse(row.evidence_json); } catch (_) {}
      }

      const recoveredEvidence = {
        ...existingEvidence,
        run_id: row.id,
        outcome: OUTCOMES.INTERRUPTED,
        interrupted: true,
        recovered_at: now,
        requires_verification: unfinishedTools.length > 0,
        unverified_tools: unfinishedTools.map(t => ({
          id: t.id,
          name: t.tool_name,
          path: t.path,
        })),
      };

      this.db.prepare(`
        UPDATE runs
        SET phase = 'finished',
            status = 'failed',
            outcome = ?,
            evidence_json = ?,
            ended_at = ?
        WHERE id = ?
      `).run(OUTCOMES.INTERRUPTED, JSON.stringify(recoveredEvidence), now, row.id);

      recovered.push(this.get(row.id));
    }

    return recovered;
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, session_id, agent_name, model_id, mode, status, phase, version,
             client_message_id, outcome, error_message, config_snapshot_json,
             heartbeat_at, lease_expires_at, evidence_json, started_at, ended_at
      FROM runs
      WHERE id = ?
    `).get(id);

    if (!row) return null;
    return this.mapRow(row);
  }

  getByClientMessageId(clientMessageId) {
    const row = this.db.prepare(`
      SELECT id, session_id, agent_name, model_id, mode, status, phase, version,
             client_message_id, outcome, error_message, config_snapshot_json,
             heartbeat_at, lease_expires_at, evidence_json, started_at, ended_at
      FROM runs
      WHERE client_message_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(clientMessageId);

    if (!row) return null;
    return this.mapRow(row);
  }

  active(sessionId) {
    const rows = this.db.prepare(`
      SELECT id, session_id, agent_name, model_id, mode, status, phase, version,
             client_message_id, outcome, error_message, config_snapshot_json,
             heartbeat_at, lease_expires_at, evidence_json, started_at, ended_at
      FROM runs
      WHERE session_id = ? AND phase != 'finished'
      ORDER BY started_at DESC
    `).all(sessionId);

    return rows.map(r => this.mapRow(r));
  }

  list(sessionId, limit = 50) {
    const rows = this.db.prepare(`
      SELECT id, session_id, agent_name, model_id, mode, status, phase, version,
             client_message_id, outcome, error_message, config_snapshot_json,
             heartbeat_at, lease_expires_at, evidence_json, started_at, ended_at
      FROM runs
      WHERE session_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(sessionId, limit);

    return rows.map(r => this.mapRow(r));
  }

  mapRow(row) {
    let configSnapshot = null;
    if (row.config_snapshot_json) {
      try { configSnapshot = JSON.parse(row.config_snapshot_json); } catch (_) {}
    }

    let evidence = null;
    if (row.evidence_json) {
      try { evidence = JSON.parse(row.evidence_json); } catch (_) {}
    }

    return {
      id: row.id,
      runId: row.id,
      sessionId: row.session_id,
      agentName: row.agent_name,
      modelId: row.model_id,
      mode: row.mode,
      status: row.status,
      phase: row.phase,
      version: row.version,
      clientMessageId: row.client_message_id,
      outcome: row.outcome,
      errorMessage: row.error_message,
      configSnapshot,
      evidence,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}

module.exports = {
  RunsRepository,
  PHASES,
  OUTCOMES,
  ALLOWED_TRANSITIONS,
};
