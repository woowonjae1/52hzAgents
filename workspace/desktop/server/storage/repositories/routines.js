const crypto = require('crypto');

class RoutinesRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  /**
   * Calculate next ISO timestamp for a routine given a starting timestamp.
   * @param {Object} routine
   * @param {Date} [fromTime]
   * @returns {string}
   */
  calculateNextFireTime(routine, fromTime = new Date()) {
    const fromMs = fromTime.getTime();

    // 1. Interval-based schedule
    if (routine.schedule_interval_minutes && routine.schedule_interval_minutes > 0) {
      return new Date(fromMs + routine.schedule_interval_minutes * 60 * 1000).toISOString();
    }

    // 2. Daily / Specific days schedule
    const hour = Number(routine.schedule_hour || 0);
    const minute = Number(routine.schedule_minute || 0);
    let days = null;
    if (routine.schedule_days && Array.isArray(routine.schedule_days)) {
      days = routine.schedule_days;
    } else if (routine.schedule_days_json) {
      try {
        const parsed = JSON.parse(routine.schedule_days_json);
        if (Array.isArray(parsed) && parsed.length > 0) days = parsed;
      } catch (_) {}
    }

    // Search from today up to 14 days ahead
    const target = new Date(fromTime);
    target.setUTCHours(hour, minute, 0, 0);

    // If target is today but already in the past, move to tomorrow
    if (target.getTime() <= fromMs) {
      target.setUTCDate(target.getUTCDate() + 1);
    }

    // If days of week are specified, find the next matching day
    if (days && days.length > 0) {
      for (let i = 0; i < 14; i++) {
        const dayOfWeek = target.getUTCDay(); // 0 is Sunday, 1 is Monday...
        // Support both 0-6 and 1-7 conventions
        if (days.includes(dayOfWeek) || (dayOfWeek === 0 && days.includes(7))) {
          break;
        }
        target.setUTCDate(target.getUTCDate() + 1);
      }
    }

    return target.toISOString();
  }

  /**
   * Create a new scheduled routine.
   */
  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const name = data.name || 'Unnamed Routine';
    const channelName = data.channel_name || data.channel || 'general';
    const message = data.message || '';
    const description = data.description || null;
    const sessionId = data.session_id || null;
    const context = data.context || null;
    const scheduleHour = Number(data.schedule_hour ?? data.hour ?? 0);
    const scheduleMinute = Number(data.schedule_minute ?? data.minute ?? 0);
    const scheduleIntervalMinutes = data.schedule_interval_minutes ?? data.interval_minutes ?? null;
    const timezone = data.timezone || 'UTC';
    const createdBy = data.requested_by || data.created_by || 'human:user';

    let scheduleDaysJson = null;
    if (data.schedule_days || data.days) {
      const days = data.schedule_days || data.days;
      scheduleDaysJson = Array.isArray(days) ? JSON.stringify(days) : String(days);
    }

    // Agent-created routines might start in pending_approval
    let status = data.status || 'active';
    if (!data.status && (createdBy.startsWith('agent:') || data.requested_by === 'agent')) {
      status = 'pending_approval';
    }

    const routineForCalc = {
      schedule_hour: scheduleHour,
      schedule_minute: scheduleMinute,
      schedule_days_json: scheduleDaysJson,
      schedule_interval_minutes: scheduleIntervalMinutes,
      timezone,
    };
    const nextFiresAt = status === 'active' ? this.calculateNextFireTime(routineForCalc, new Date()) : null;

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_routines (
        id, name, description, session_id, channel_name, message, context,
        schedule_hour, schedule_minute, schedule_days_json, schedule_interval_minutes,
        timezone, status, next_fires_at, last_fired_at, run_count,
        consecutive_failures, created_by, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, NULL, 0,
        0, ?, ?, ?
      )
    `);

    stmt.run(
      id, name, description, sessionId, channelName, message, context,
      scheduleHour, scheduleMinute, scheduleDaysJson, scheduleIntervalMinutes,
      timezone, status, nextFiresAt, createdBy, now, now
    );

    return this.get(id);
  }

  /**
   * Get routine by ID.
   */
  get(id) {
    const stmt = this.db.prepare(`SELECT * FROM scheduled_routines WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return null;
    return this._normalize(row);
  }

  /**
   * List routines with optional filters.
   */
  list(filter = {}) {
    let sql = `SELECT * FROM scheduled_routines WHERE 1=1`;
    const params = [];

    if (filter.channel_name || filter.channel) {
      sql += ` AND channel_name = ?`;
      params.push(filter.channel_name || filter.channel);
    }
    if (filter.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }

    sql += ` ORDER BY created_at DESC`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((r) => this._normalize(r));
  }

  /**
   * Update routine fields.
   */
  update(id, patch) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Routine not found: ${id}`);

    const now = new Date().toISOString();
    const name = patch.name !== undefined ? patch.name : existing.name;
    const message = patch.message !== undefined ? patch.message : existing.message;
    const description = patch.description !== undefined ? patch.description : existing.description;
    const context = patch.context !== undefined ? patch.context : existing.context;
    const scheduleHour = patch.hour !== undefined ? patch.hour : (patch.schedule_hour !== undefined ? patch.schedule_hour : existing.schedule_hour);
    const scheduleMinute = patch.minute !== undefined ? patch.minute : (patch.schedule_minute !== undefined ? patch.schedule_minute : existing.schedule_minute);

    let scheduleIntervalMinutes = existing.schedule_interval_minutes;
    if (patch.scheduleMode === 'daily') {
      scheduleIntervalMinutes = null;
    } else if (patch.scheduleMode === 'interval') {
      scheduleIntervalMinutes = patch.intervalMinutes ?? patch.interval_minutes ?? existing.schedule_interval_minutes;
    } else if (patch.intervalMinutes !== undefined || patch.interval_minutes !== undefined) {
      scheduleIntervalMinutes = patch.intervalMinutes ?? patch.interval_minutes;
    }

    let scheduleDaysJson = existing.schedule_days_json;
    if (patch.days !== undefined || patch.schedule_days !== undefined) {
      const days = patch.days ?? patch.schedule_days;
      scheduleDaysJson = days ? (Array.isArray(days) ? JSON.stringify(days) : String(days)) : null;
    }

    const timezone = patch.timezone !== undefined ? patch.timezone : existing.timezone;
    const status = patch.status !== undefined ? patch.status : existing.status;

    let nextFiresAt = existing.next_fires_at;
    if (status === 'active') {
      nextFiresAt = this.calculateNextFireTime({
        schedule_hour: scheduleHour,
        schedule_minute: scheduleMinute,
        schedule_days_json: scheduleDaysJson,
        schedule_interval_minutes: scheduleIntervalMinutes,
        timezone,
      }, new Date());
    } else {
      nextFiresAt = null;
    }

    const stmt = this.db.prepare(`
      UPDATE scheduled_routines SET
        name = ?, message = ?, description = ?, context = ?,
        schedule_hour = ?, schedule_minute = ?, schedule_interval_minutes = ?,
        schedule_days_json = ?, timezone = ?, status = ?, next_fires_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      name, message, description, context,
      scheduleHour, scheduleMinute, scheduleIntervalMinutes,
      scheduleDaysJson, timezone, status, nextFiresAt,
      now, id
    );

    return this.get(id);
  }

  /**
   * Delete routine by ID.
   */
  delete(id) {
    const stmt = this.db.prepare(`DELETE FROM scheduled_routines WHERE id = ?`);
    const res = stmt.run(id);
    return res.changes > 0;
  }

  /**
   * Toggle routine status between active and paused.
   */
  toggle(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Routine not found: ${id}`);

    const newStatus = existing.status === 'active' ? 'paused' : 'active';
    return this.update(id, { status: newStatus });
  }

  /**
   * Approve a pending routine.
   */
  approve(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Routine not found: ${id}`);
    if (existing.status !== 'pending_approval') {
      const err = new Error(`Routine ${id} is not pending approval`);
      err.status = 409;
      throw err;
    }
    return this.update(id, { status: 'active' });
  }

  /**
   * Reject a pending routine.
   */
  reject(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Routine not found: ${id}`);
    if (existing.status !== 'pending_approval') {
      const err = new Error(`Routine ${id} is not pending approval`);
      err.status = 409;
      throw err;
    }
    return this.update(id, { status: 'cancelled' });
  }

  /**
   * Fetch routines that are active and due for execution.
   */
  getDueRoutines(now = new Date()) {
    const nowIso = now.toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_routines
      WHERE status = 'active' AND next_fires_at IS NOT NULL AND next_fires_at <= ?
      ORDER BY next_fires_at ASC
    `);
    const rows = stmt.all(nowIso);
    return rows.map((r) => this._normalize(r));
  }

  /**
   * Record routine execution start.
   */
  recordRun(routineId, { channel_name, trigger_message, run_id = null }) {
    const routine = this.get(routineId);
    if (!routine) throw new Error(`Routine not found: ${routineId}`);

    const runRecordId = crypto.randomUUID();
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO routine_runs (
        id, routine_id, run_id, channel_name, trigger_message, status, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?)
    `);
    insertStmt.run(runRecordId, routineId, run_id, channel_name || routine.channel_name, trigger_message || routine.message, now);

    const updateRoutineStmt = this.db.prepare(`
      UPDATE scheduled_routines SET
        run_count = run_count + 1,
        last_run_id = ?,
        last_run_status = 'running',
        last_fired_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    updateRoutineStmt.run(runRecordId, now, now, routineId);

    return {
      id: runRecordId,
      routine_id: routineId,
      run_id,
      channel_name: channel_name || routine.channel_name,
      trigger_message: trigger_message || routine.message,
      status: 'running',
      started_at: now,
      completed_at: null,
    };
  }

  /**
   * Record routine execution completion.
   */
  completeRun(runRecordId, { status = 'completed', error = null, result = null, errorMessage = null, outcome = null } = {}) {
    const finalError = error || errorMessage || null;
    const finalResult = result || outcome || null;
    const now = new Date().toISOString();
    const getStmt = this.db.prepare(`SELECT * FROM routine_runs WHERE id = ?`);
    const runRow = getStmt.get(runRecordId);
    if (!runRow) return null;

    const updateRunStmt = this.db.prepare(`
      UPDATE routine_runs SET
        status = ?,
        error = ?,
        result = ?,
        completed_at = ?
      WHERE id = ?
    `);
    updateRunStmt.run(status, finalError ? String(finalError) : null, finalResult ? String(finalResult) : null, now, runRecordId);

    const routine = this.get(runRow.routine_id);
    if (routine) {
      const consecutiveFailures = status === 'completed' ? 0 : (routine.consecutive_failures + 1);
      const nextFiresAt = routine.status === 'active' ? this.calculateNextFireTime(routine, new Date()) : null;

      const updateRoutineStmt = this.db.prepare(`
        UPDATE scheduled_routines SET
          last_run_status = ?,
          last_run_error = ?,
          consecutive_failures = ?,
          next_fires_at = ?,
          updated_at = ?
        WHERE id = ?
      `);
      updateRoutineStmt.run(
        status,
        finalError ? String(finalError) : null,
        consecutiveFailures,
        nextFiresAt,
        now,
        routine.id
      );
    }

    if (typeof this.onRunCompleted === 'function') {
      try {
        this.onRunCompleted(runRow.routine_id, runRecordId, status);
      } catch (_) {}
    }

    return {
      ...runRow,
      status,
      error: finalError,
      result: finalResult,
      completed_at: now,
    };
  }

  /**
   * List routine execution runs.
   */
  listRuns(routineId = null, limit = 50) {
    let sql = `SELECT * FROM routine_runs`;
    const params = [];
    if (routineId) {
      sql += ` WHERE routine_id = ?`;
      params.push(routineId);
    }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((r) => ({
      id: r.id,
      routine_id: r.routine_id,
      routineId: r.routine_id,
      run_id: r.run_id,
      channel_name: r.channel_name,
      channelName: r.channel_name,
      trigger_message: r.trigger_message,
      triggerMessage: r.trigger_message,
      status: r.status,
      started_at: r.started_at,
      startedAt: r.started_at,
      completed_at: r.completed_at,
      completedAt: r.completed_at,
      error: r.error,
      result: r.result,
    }));
  }

  /**
   * Crash recovery: marks any runs left in 'running' as failed.
   */
  recoverOrphanedRuns() {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE routine_runs
      SET status = 'failed', error = 'Orphaned run after server restart', completed_at = ?
      WHERE status = 'running'
    `);
    const res = stmt.run(now);

    const updateRoutinesStmt = this.db.prepare(`
      UPDATE scheduled_routines
      SET last_run_status = 'failed', last_run_error = 'Orphaned run after server restart', updated_at = ?
      WHERE last_run_status = 'running'
    `);
    updateRoutinesStmt.run(now);

    return res.changes;
  }

  _normalize(row) {
    let days = null;
    if (row.schedule_days_json) {
      try {
        days = JSON.parse(row.schedule_days_json);
      } catch (_) {}
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      session_id: row.session_id,
      channel_name: row.channel_name,
      message: row.message,
      context: row.context,
      schedule_hour: row.schedule_hour,
      schedule_minute: row.schedule_minute,
      schedule_days: days,
      schedule_days_json: row.schedule_days_json,
      schedule_interval_minutes: row.schedule_interval_minutes,
      timezone: row.timezone,
      status: row.status,
      next_fires_at: row.next_fires_at,
      last_fired_at: row.last_fired_at,
      run_count: row.run_count,
      last_run_id: row.last_run_id,
      last_run_status: row.last_run_status,
      last_run_error: row.last_run_error,
      consecutive_failures: row.consecutive_failures,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

module.exports = { RoutinesRepository };
