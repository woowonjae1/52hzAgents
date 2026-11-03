'use strict';

const crypto = require('node:crypto');

const fail = (message, status = 400, code = 'INVALID_SESSION_BINDING') =>
  Object.assign(new Error(message), { status, code });

function buildBindingKey({ channel, contextKey = null, agentId, connectionId = null, adapterKind }) {
  const ch = String(channel || '').trim();
  const ctx = String(contextKey || 'default').trim() || 'default';
  const agent = String(agentId || '').trim();
  const conn = String(connectionId || adapterKind || 'native').trim();
  if (!ch || !agent) throw fail('channel and agentId are required for native session binding.');
  return `${ch}::${ctx}::${agent}::${conn}`;
}

class NativeSessionBindingsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
  }

  get db() {
    return this.manager.db;
  }

  mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      bindingKey: row.binding_key,
      channel: row.channel,
      contextKey: row.context_key || null,
      agentId: row.agent_id,
      connectionId: row.connection_id || null,
      adapterKind: row.adapter_kind,
      nativeSessionId: row.native_session_id || null,
      nativeSessionFile: row.native_session_file || null,
      sessionDir: row.session_dir || null,
      lastLeafId: row.last_leaf_id || null,
      activeRunId: row.active_run_id || null,
      activeAttemptId: row.active_attempt_id || null,
      lockState: row.lock_state,
      effectiveModel: row.effective_model || null,
      effectiveProvider: row.effective_provider || null,
      configFingerprint: row.config_fingerprint || null,
      attemptCount: Number(row.attempt_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(id) {
    if (!id) return null;
    return this.mapRow(
      this.db.prepare('SELECT * FROM native_session_bindings WHERE id = ?').get(String(id))
    );
  }

  getByKey(bindingKey) {
    if (!bindingKey) return null;
    return this.mapRow(
      this.db.prepare('SELECT * FROM native_session_bindings WHERE binding_key = ?').get(String(bindingKey))
    );
  }

  listByChannel(channel) {
    return this.db
      .prepare('SELECT * FROM native_session_bindings WHERE channel = ? ORDER BY updated_at DESC')
      .all(String(channel || ''))
      .map(row => this.mapRow(row));
  }

  listByAgent(agentId) {
    return this.db
      .prepare('SELECT * FROM native_session_bindings WHERE agent_id = ? ORDER BY updated_at DESC')
      .all(String(agentId || ''))
      .map(row => this.mapRow(row));
  }

  resolveOrCreate({
    channel,
    contextKey = null,
    agentId,
    connectionId = null,
    adapterKind,
    sessionDir = null,
  }) {
    const bindingKey = buildBindingKey({ channel, contextKey, agentId, connectionId, adapterKind });
    return this.manager.transaction(db => {
      const existing = db
        .prepare('SELECT * FROM native_session_bindings WHERE binding_key = ?')
        .get(bindingKey);
      if (existing) {
        if (sessionDir && !existing.session_dir) {
          const now = new Date().toISOString();
          db.prepare('UPDATE native_session_bindings SET session_dir = ?, updated_at = ? WHERE id = ?')
            .run(sessionDir, now, existing.id);
          return this.get(existing.id);
        }
        return this.mapRow(existing);
      }

      const id = `nsb-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO native_session_bindings (
          id, binding_key, channel, context_key, agent_id, connection_id, adapter_kind,
          native_session_id, native_session_file, session_dir, last_leaf_id,
          active_run_id, active_attempt_id, lock_state,
          effective_model, effective_provider, config_fingerprint,
          attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, 'idle', NULL, NULL, NULL, 0, ?, ?)
      `).run(
        id,
        bindingKey,
        String(channel),
        contextKey ? String(contextKey) : null,
        String(agentId),
        connectionId ? String(connectionId) : null,
        String(adapterKind),
        sessionDir ? String(sessionDir) : null,
        now,
        now
      );
      return this.get(id);
    });
  }

  acquireWriteLock(bindingId, { runId, attemptId = null } = {}) {
    if (!bindingId || !runId) throw fail('bindingId and runId are required to acquire write lock.');
    return this.manager.transaction(db => {
      const row = db.prepare('SELECT * FROM native_session_bindings WHERE id = ?').get(String(bindingId));
      if (!row) throw fail('Native session binding not found.', 404, 'SESSION_BINDING_NOT_FOUND');

      if (row.lock_state === 'locked' && row.active_run_id && row.active_run_id !== runId) {
        const oldRun = row.active_run_id
          ? db.prepare('SELECT id, status FROM runs WHERE id = ?').get(row.active_run_id)
          : null;
        const isOldRunDead = Boolean(oldRun) && ['completed', 'failed', 'cancelled', 'aborted', 'timed_out'].includes(oldRun.status);
        if (!isOldRunDead) {
          throw fail(
            `该原生会话正在被运行 "${row.active_run_id}" 占用，拒绝并发写入同一会话。`,
            409,
            'NATIVE_SESSION_BUSY'
          );
        }
      }
      if (row.lock_state === 'broken') {
        throw fail('该原生会话处于损坏或串线保护状态，无法继续写入。', 409, 'NATIVE_SESSION_BROKEN');
      }

      if (row.native_session_file) {
        const fileConflict = db
          .prepare(`
            SELECT id, active_run_id FROM native_session_bindings
            WHERE native_session_file = ? AND id != ? AND lock_state = 'locked'
          `)
          .get(row.native_session_file, row.id);
        if (fileConflict) {
          throw fail(
            `原生会话文件 "${row.native_session_file}" 正在被另一个任务 (${fileConflict.active_run_id}) 写入，拒绝并发写入。`,
            409,
            'NATIVE_SESSION_FILE_BUSY'
          );
        }
      }

      const nextCount = Number(row.attempt_count || 0) + 1;
      const nextAttemptId = attemptId || `attempt-${nextCount}-${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE native_session_bindings
        SET lock_state = 'locked',
            active_run_id = ?,
            active_attempt_id = ?,
            attempt_count = ?,
            updated_at = ?
        WHERE id = ?
      `).run(String(runId), String(nextAttemptId), nextCount, now, row.id);

      return this.get(row.id);
    });
  }

  recordSessionHandshake(
    bindingId,
    {
      runId,
      nativeSessionId = null,
      nativeSessionFile = null,
      effectiveModel = null,
      effectiveProvider = null,
      configFingerprint = null,
    } = {}
  ) {
    let mismatchError = null;
    try {
      return this.manager.transaction(db => {
        const row = db.prepare('SELECT * FROM native_session_bindings WHERE id = ?').get(String(bindingId));
        if (!row) throw fail('Native session binding not found.', 404, 'SESSION_BINDING_NOT_FOUND');
        if (runId && row.active_run_id && row.active_run_id !== runId) {
          throw fail('Native session lock is owned by a different run.', 409, 'NATIVE_SESSION_LOCK_MISMATCH');
        }

        if (row.native_session_id && nativeSessionId && row.native_session_id !== nativeSessionId) {
          mismatchError = fail(
            `原生会话绑定不一致（期望 ${row.native_session_id}，实际返回 ${nativeSessionId}），已阻止串线写入。`,
            409,
            'NATIVE_SESSION_MISMATCH'
          );
          throw mismatchError;
        }

        if (nativeSessionFile) {
          const fileConflict = db
            .prepare(`
              SELECT id, active_run_id FROM native_session_bindings
              WHERE native_session_file = ? AND id != ? AND lock_state = 'locked'
            `)
            .get(String(nativeSessionFile), row.id);
          if (fileConflict) {
            throw fail(
              `原生会话文件 "${nativeSessionFile}" 已被另一运行 (${fileConflict.active_run_id}) 锁定，已拒绝写入。`,
              409,
              'NATIVE_SESSION_FILE_BUSY'
            );
          }
        }

        const now = new Date().toISOString();
        db.prepare(`
          UPDATE native_session_bindings
          SET native_session_id = COALESCE(?, native_session_id),
              native_session_file = COALESCE(?, native_session_file),
              effective_model = COALESCE(?, effective_model),
              effective_provider = COALESCE(?, effective_provider),
              config_fingerprint = COALESCE(?, config_fingerprint),
              updated_at = ?
        WHERE id = ?
      `).run(
        nativeSessionId ? String(nativeSessionId) : null,
        nativeSessionFile ? String(nativeSessionFile) : null,
        effectiveModel ? String(effectiveModel) : null,
        effectiveProvider ? String(effectiveProvider) : null,
        configFingerprint ? String(configFingerprint) : null,
        now,
        row.id
      );

      return this.get(row.id);
    });
  } catch (err) {
    if (mismatchError || err.code === 'NATIVE_SESSION_MISMATCH') {
      const now = new Date().toISOString();
      try {
        this.manager.db.prepare(`
          UPDATE native_session_bindings
          SET lock_state = 'broken',
              updated_at = ?
          WHERE id = ?
        `).run(now, String(bindingId));
      } catch (_) {}
    }
    throw err;
  }
}

  releaseWriteLock(bindingId, { runId = null, nextState = 'idle', lastLeafId = null } = {}) {
    if (!bindingId) return null;
    if (!['idle', 'awaiting_input', 'broken'].includes(nextState)) {
      throw fail(`Invalid next lock state: ${nextState}`);
    }
    return this.manager.transaction(db => {
      const row = db.prepare('SELECT * FROM native_session_bindings WHERE id = ?').get(String(bindingId));
      if (!row) return null;
      if (runId && row.active_run_id && row.active_run_id !== runId) {
        return this.mapRow(row);
      }
      const now = new Date().toISOString();
      if (row.lock_state === 'broken' && nextState !== 'broken') {
        db.prepare(`
          UPDATE native_session_bindings
          SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
              active_attempt_id = NULL,
              last_leaf_id = COALESCE(?, last_leaf_id),
              updated_at = ?
          WHERE id = ?
        `).run(runId ? String(runId) : null, lastLeafId ? String(lastLeafId) : null, now, row.id);
        return this.get(row.id);
      }
      if (row.lock_state === 'broken' && nextState !== 'broken') {
        db.prepare(`
          UPDATE native_session_bindings
          SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
              active_attempt_id = NULL,
              last_leaf_id = COALESCE(?, last_leaf_id),
              updated_at = ?
          WHERE id = ?
        `).run(runId ? String(runId) : null, lastLeafId ? String(lastLeafId) : null, now, row.id);
        return this.get(row.id);
      }
      const keepActive = nextState === 'awaiting_input';
      db.prepare(`
        UPDATE native_session_bindings
        SET lock_state = ?,
            active_run_id = ?,
            active_attempt_id = ?,
            last_leaf_id = COALESCE(?, last_leaf_id),
            updated_at = ?
        WHERE id = ?
      `).run(
        nextState,
        keepActive ? row.active_run_id : null,
        keepActive ? row.active_attempt_id : null,
        lastLeafId ? String(lastLeafId) : null,
        now,
        row.id
      );
      return this.get(row.id);
    });
  }

  releaseAllActiveLocks() {
    const now = new Date().toISOString();
    // Only release locks where the associated run is confirmed dead or orphaned (not actively running/queued).
    // Never unlock an active run whose database state is running or queued.
    this.db.prepare(`
      UPDATE native_session_bindings
      SET lock_state = 'idle', active_run_id = NULL, active_attempt_id = NULL, updated_at = ?
      WHERE lock_state = 'locked' AND (
        active_run_id IS NULL OR
        active_run_id NOT IN (SELECT id FROM runs WHERE status IN ('running', 'queued'))
      )
    `).run(now);
  }
}

module.exports = {
  NativeSessionBindingsRepository,
  buildBindingKey,
};
