const crypto = require('crypto');

class ToolsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  recordStart({
    id,
    runId,
    sessionId,
    toolName,
    args = null,
    status = 'running',
    path = null,
    startedAt = Date.now(),
  }) {
    const toolCallId = id || `tc_${crypto.randomUUID()}`;
    const argsJson = args !== null && typeof args === 'object' ? JSON.stringify(args) : (args || null);

    this.db.prepare(`
      INSERT INTO tool_calls (
        id, run_id, session_id, tool_name, args_json, status, path, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolCallId,
      runId || null,
      sessionId,
      toolName,
      argsJson,
      status,
      path,
      startedAt
    );

    return this.get(toolCallId);
  }

  recordEnd({
    id,
    status = 'completed',
    output = null,
    outputTruncated = false,
    patch = null,
    patchTruncated = false,
    path = null,
    exitCode = null,
    durationMs = null,
    endedAt = Date.now(),
  }) {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Tool call ${id} not found`);
    }

    const calculatedDuration = durationMs !== null ? durationMs : (
      existing.startedAt ? Math.max(0, endedAt - existing.startedAt) : null
    );

    this.db.prepare(`
      UPDATE tool_calls
      SET status = ?,
          output = COALESCE(?, output),
          output_truncated = ?,
          patch = COALESCE(?, patch),
          patch_truncated = ?,
          path = COALESCE(?, path),
          exit_code = COALESCE(?, exit_code),
          duration_ms = COALESCE(?, duration_ms),
          ended_at = ?
      WHERE id = ?
    `).run(
      status,
      output,
      outputTruncated ? 1 : 0,
      patch,
      patchTruncated ? 1 : 0,
      path,
      exitCode,
      calculatedDuration,
      endedAt,
      id
    );

    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, run_id, session_id, tool_name, args_json, status,
             output, output_truncated, patch, patch_truncated, path,
             exit_code, duration_ms, started_at, ended_at
      FROM tool_calls
      WHERE id = ?
    `).get(id);

    if (!row) return null;
    return this.mapRow(row);
  }

  listBySession(sessionId, { limit = 100, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT id, run_id, session_id, tool_name, args_json, status,
             output, output_truncated, patch, patch_truncated, path,
             exit_code, duration_ms, started_at, ended_at
      FROM tool_calls
      WHERE session_id = ?
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset).map(row => this.mapRow(row));
  }

  listByRun(runId) {
    return this.db.prepare(`
      SELECT id, run_id, session_id, tool_name, args_json, status,
             output, output_truncated, patch, patch_truncated, path,
             exit_code, duration_ms, started_at, ended_at
      FROM tool_calls
      WHERE run_id = ?
      ORDER BY started_at ASC
    `).all(runId).map(row => this.mapRow(row));
  }

  recordApproval({
    id,
    toolCallId,
    sessionId,
    decision,
    decidedAt = Date.now(),
    expiresAt = null,
  }) {
    const approvalId = id || `appr_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO approval_records (id, tool_call_id, session_id, decision, decided_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(approvalId, toolCallId, sessionId, decision, decidedAt, expiresAt);

    return this.getApproval(toolCallId);
  }

  getApproval(toolCallId) {
    const row = this.db.prepare(`
      SELECT id, tool_call_id, session_id, decision, decided_at, expires_at
      FROM approval_records
      WHERE tool_call_id = ?
      ORDER BY decided_at DESC
      LIMIT 1
    `).get(toolCallId);

    if (!row) return null;
    return {
      id: row.id,
      toolCallId: row.tool_call_id,
      sessionId: row.session_id,
      decision: row.decision,
      decidedAt: row.decided_at,
      expiresAt: row.expires_at,
    };
  }

  mapRow(row) {
    let args = null;
    if (row.args_json) {
      try {
        args = JSON.parse(row.args_json);
      } catch (_) {
        args = row.args_json;
      }
    }

    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      toolName: row.tool_name,
      args,
      status: row.status,
      output: row.output,
      outputTruncated: Boolean(row.output_truncated),
      patch: row.patch,
      patchTruncated: Boolean(row.patch_truncated),
      path: row.path,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}

module.exports = { ToolsRepository };
