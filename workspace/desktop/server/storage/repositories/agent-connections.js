'use strict';

const crypto = require('node:crypto');

const ALLOWED_CONNECTION_KINDS = new Set([
  'native-pi',
  'native-codex',
  'native-antigravity',
  'native-openclaw',
  'native-hermes',
]);

const fail = (message, status = 400, code = 'INVALID_CONNECTION') =>
  Object.assign(new Error(message), { status, code });

class AgentConnectionsRepository {
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  list({ includeDisabled = false } = {}) {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_connections ${
          includeDisabled ? '' : "WHERE status = 'registered'"
        } ORDER BY created_at ASC, id ASC`
      )
      .all();
    return rows.map(row => this.mapRow(row));
  }

  get(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw fail('Invalid connection ID.');
    const row = this.db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(id);
    return row ? this.mapRow(row) : null;
  }

  requireRegistered(id) {
    const conn = this.get(id);
    if (!conn) throw fail('Agent connection not found.', 404, 'CONNECTION_NOT_FOUND');
    if (conn.status !== 'registered') {
      throw fail('This Agent connection is disabled.', 409, 'CONNECTION_DISABLED');
    }
    return conn;
  }

  listSources(connectionId) {
    return this.db
      .prepare('SELECT * FROM agent_config_sources WHERE connection_id = ? ORDER BY source_key ASC')
      .all(connectionId)
      .map(s => ({
        id: s.id,
        connectionId: s.connection_id,
        sourceKey: s.source_key,
        scope: s.scope,
        format: s.format,
        canonicalPath: s.canonical_path,
        contentSha256: s.content_sha256 || null,
        holdsSecret: Boolean(s.holds_secret),
        updatedAt: s.updated_at,
      }));
  }

  listSharedMembers(connectionId) {
    return this.db
      .prepare(
        'SELECT id, name, role, status, runtime_binding_json FROM agent_definitions WHERE connection_id = ? ORDER BY created_at ASC, id ASC'
      )
      .all(connectionId)
      .map(r => {
        let runtimeModel = null;
        try {
          runtimeModel = JSON.parse(r.runtime_binding_json)?.model || null;
        } catch {}
        return {
          id: r.id,
          name: r.name,
          role: r.role,
          status: r.status,
          runtimeModel,
        };
      });
  }

  create(input) {
    if (!input || typeof input !== 'object') throw fail('Connection input must be an object.');
    const {
      kind,
      displayName,
      environment = 'local',
      installationRef,
      configDir = null,
      nativeProfile = null,
      capabilitySnapshot = {},
      sources = [],
    } = input;

    if (!ALLOWED_CONNECTION_KINDS.has(kind)) {
      throw fail(`Unsupported Agent connection kind: ${kind}`);
    }
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80) {
      throw fail('Invalid connection displayName.');
    }
    if (!['local', 'wsl', 'remote'].includes(environment)) {
      throw fail('Invalid connection environment.');
    }
    if (typeof installationRef !== 'string' || !installationRef.trim()) {
      throw fail('installationRef is required.');
    }

    const id = `conn-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    return this.manager.transaction(db => {
      db.prepare(
        `INSERT INTO agent_connections (
          id, kind, display_name, environment, installation_ref, config_dir, native_profile,
          capability_snapshot_json, status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', 1, ?, ?)`
      ).run(
        id,
        kind,
        displayName.trim(),
        environment,
        installationRef.trim(),
        configDir,
        nativeProfile,
        JSON.stringify(capabilitySnapshot || {}),
        now,
        now
      );

      for (const src of sources) {
        const srcId = `cfgsrc-${crypto.randomUUID()}`;
        db.prepare(
          `INSERT INTO agent_config_sources (
            id, connection_id, source_key, scope, format, canonical_path, content_sha256, holds_secret, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          srcId,
          id,
          src.sourceKey,
          src.scope || 'global',
          src.format,
          src.canonicalPath,
          src.contentSha256 || null,
          src.holdsSecret ? 1 : 0,
          now
        );
      }

      return this.get(id);
    });
  }

  updateSourceHash(connectionId, sourceKey, sha256) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE agent_config_sources SET content_sha256 = ?, updated_at = ? WHERE connection_id = ? AND source_key = ?'
      )
      .run(sha256 || null, now, connectionId, sourceKey);
  }

  updateCapabilities(id, capabilitySnapshot) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE agent_connections SET capability_snapshot_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?'
      )
      .run(JSON.stringify(capabilitySnapshot || {}), now, id);
    return this.get(id);
  }

  delete(id, expectedRevision) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw fail('expectedRevision is required.');
    }
    return this.manager.transaction(db => {
      const existing = this.get(id);
      if (!existing) throw fail('Connection not found.', 404, 'CONNECTION_NOT_FOUND');
      if (existing.revision !== expectedRevision) {
        throw fail('Connection changed. Reload before deleting.', 409, 'CONNECTION_CONFLICT');
      }
      if (db.prepare('SELECT 1 FROM agent_definitions WHERE connection_id = ? LIMIT 1').get(id)) {
        throw fail('Connection is still linked to an Agent member.', 409, 'CONNECTION_IN_USE');
      }
      db.prepare('DELETE FROM agent_connections WHERE id = ?').run(id);
      return true;
    });
  }

  createChange({ id = `cfgchg-${crypto.randomUUID()}`, connectionId, state = 'prepared', scope = 'global', redactedPatch, files, actor = 'user' }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_config_changes (
          id, connection_id, state, scope, redacted_patch_json, files_json, apply_result_json, actor, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        id,
        connectionId,
        state,
        scope,
        JSON.stringify(redactedPatch || []),
        JSON.stringify(files || []),
        actor,
        now,
        now
      );
    return this.getChange(id);
  }

  updateChangeState(id, state, { files, applyResult } = {}) {
    const now = new Date().toISOString();
    const existing = this.getChange(id);
    if (!existing) throw fail('Config change record not found.', 404, 'CHANGE_NOT_FOUND');
    this.db
      .prepare(
        `UPDATE agent_config_changes
         SET state = ?, files_json = ?, apply_result_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        state,
        files !== undefined ? JSON.stringify(files) : JSON.stringify(existing.files),
        applyResult !== undefined ? JSON.stringify(applyResult) : existing.applyResult ? JSON.stringify(existing.applyResult) : null,
        now,
        id
      );
    return this.getChange(id);
  }

  getChange(id) {
    const row = this.db.prepare('SELECT * FROM agent_config_changes WHERE id = ?').get(id);
    return row ? this.mapChangeRow(row) : null;
  }

  listChanges(connectionId, { limit = 20 } = {}) {
    return this.db
      .prepare('SELECT * FROM agent_config_changes WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(connectionId, limit)
      .map(r => this.mapChangeRow(r));
  }

  hasBrokenChangeState(connectionId) {
    const row = this.db
      .prepare(
        "SELECT id, state, apply_result_json FROM agent_config_changes WHERE connection_id = ? AND state IN ('applying','apply_failed') ORDER BY created_at DESC LIMIT 1"
      )
      .get(connectionId);
    if (!row) return null;
    if (row.apply_result_json) {
      try {
        const res = JSON.parse(row.apply_result_json);
        if (res.saveStatus === 'conflict' || res.retryable === true) {
          return null;
        }
      } catch (_) {}
    }
    return row;
  }

  mapChangeRow(row) {
    return {
      id: row.id,
      connectionId: row.connection_id,
      state: row.state,
      scope: row.scope,
      redactedPatch: JSON.parse(row.redacted_patch_json),
      files: JSON.parse(row.files_json),
      applyResult: row.apply_result_json ? JSON.parse(row.apply_result_json) : null,
      actor: row.actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      environment: row.environment,
      installationRef: row.installation_ref,
      configDir: row.config_dir || null,
      nativeProfile: row.native_profile || null,
      capabilitySnapshot: JSON.parse(row.capability_snapshot_json || '{}'),
      status: row.status,
      revision: row.revision,
      sources: this.listSources(row.id),
      sharedMembers: this.listSharedMembers(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { AgentConnectionsRepository, ALLOWED_CONNECTION_KINDS };
