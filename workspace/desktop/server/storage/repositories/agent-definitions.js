const crypto = require('node:crypto');
const { POLICY_KEYS, validatePolicyPatch, policyOf } = require('../../agent-policy');
const { describeExecution } = require('../../agents/legacy-mapping');

const DEFAULT_AGENT_ID = 'agent-local';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const CONNECTION_TO_RUNTIME_KIND = Object.freeze({
  'native-pi': 'pi',
  'native-codex': 'codex',
  'native-antigravity': 'antigravity',
  'native-openclaw': 'pi',
  'native-hermes': 'pi',
});

function validateRuntimePolicy(kind, policy, hasNativeConnection = false) {
  if ((kind !== 'pi' || hasNativeConnection) && policy.modelResource) {
    throw fail('Native Agents use their client configuration, not a model connection.');
  }
  if (kind !== 'pi' && policy.defaultMode === 'chat') {
    throw fail('Native Agents currently require plan or agent mode.');
  }
}

function validateIdentity(input, { create = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Agent must be an object.');
  const allowed = new Set(['name', 'description', 'role', 'status', 'runtimeKind', 'runtimeModel', 'connectionId', 'expectedRevision', ...POLICY_KEYS]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw fail(`Unsupported Agent field: ${key}`);
  }
  const values = {};
  if (input.connectionId !== undefined) {
    if (input.connectionId !== null && (typeof input.connectionId !== 'string' || !input.connectionId.trim() || input.connectionId.length > 128)) {
      throw fail('Invalid Agent connectionId.');
    }
    values.connectionId = input.connectionId?.trim() || null;
  }
  if (input.runtimeModel !== undefined) {
    if (input.runtimeModel !== null && (typeof input.runtimeModel !== 'string' || !input.runtimeModel.trim() || input.runtimeModel.length > 200 || /[\r\n\0]/.test(input.runtimeModel))) throw fail('Invalid native client resource.');
    values.runtimeModel = input.runtimeModel?.trim() || null;
  }
  if (input.runtimeKind !== undefined) {
    if (!['pi', 'codex', 'antigravity', 'gemini'].includes(input.runtimeKind)) throw fail('Unsupported Agent runtime.');
    values.runtimeKind = input.runtimeKind;
  }
  for (const [key, max] of [['name', 80], ['description', 4000], ['role', 120]]) {
    if (input[key] === undefined && !(create && key === 'name')) continue;
    if (typeof input[key] !== 'string' || input[key].length > max ||
        (key !== 'description' && !input[key].trim())) throw fail(`Invalid Agent ${key}.`);
    values[key] = input[key].trim();
  }
  if (input.status !== undefined) {
    if (!['active', 'disabled'].includes(input.status)) throw fail('Invalid Agent status.');
    values.status = input.status;
  }
  return values;
}

class AgentDefinitionsRepository {
  constructor(manager) { this.manager = manager; this.db = manager.db; }

  list({ includeDisabled = false } = {}) {
    return this.db.prepare(`SELECT * FROM agent_definitions ${includeDisabled ? '' : "WHERE status = 'active'"}
      ORDER BY built_in DESC, created_at, id`).all().map(row => this.mapRow(row));
  }

  get(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw fail('Invalid Agent ID.');
    const row = this.db.prepare('SELECT * FROM agent_definitions WHERE id = ?').get(id);
    return row ? this.mapRow(row) : null;
  }

  requireActive(id) {
    const agent = this.get(id);
    if (!agent) throw fail('Agent not found.', 404);
    if (agent.status !== 'active') throw fail('This Agent is disabled. Choose an active Agent.', 409);
    return agent;
  }

  resolveConnection(connectionId) {
    if (!connectionId) return null;
    const conn = this.db.prepare('SELECT id, kind, display_name, config_dir, status FROM agent_connections WHERE id = ?').get(connectionId);
    if (!conn) throw fail('Choose an existing Agent connection.', 400);
    return conn;
  }

  create(input) {
    const values = validateIdentity(input, { create: true });
    const conn = this.resolveConnection(values.connectionId);
    const derivedKind = conn ? CONNECTION_TO_RUNTIME_KIND[conn.kind] || 'pi' : (values.runtimeKind || 'pi');
    if (conn && values.runtimeKind && values.runtimeKind !== derivedKind) {
      throw fail('Agent runtimeKind conflicts with the selected connection.', 400);
    }
    const policy = validatePolicyPatch(input);
    validateRuntimePolicy(derivedKind, policy, Boolean(conn));
    const isNative = Boolean(conn) || derivedKind !== 'pi';
    const id = `agent-${crypto.randomUUID()}`, now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_definitions (id, name, description, role, status, connection_id, created_at, updated_at, execution_policy_json, runtime_binding_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      values.name,
      values.description || '',
      values.role || 'assistant',
      values.status || 'active',
      conn ? conn.id : null,
      now,
      now,
      JSON.stringify(policy),
      JSON.stringify({ kind: derivedKind, model: isNative ? values.runtimeModel || null : null })
    );
    return this.get(id);
  }

  update(id, input) {
    const values = validateIdentity(input);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw fail('expectedRevision is required.');
    if (!Object.keys(values).length && !POLICY_KEYS.some(key => input[key] !== undefined)) throw fail('No Agent changes supplied.');
    return this.manager.transaction(db => {
      const existing = this.get(id);
      if (!existing) throw fail('Agent not found.', 404);
      if (existing.revision !== input.expectedRevision) throw fail('Agent changed. Reload before saving.', 409);
      if (existing.builtIn && values.status === 'disabled') throw fail('The default Agent cannot be disabled.', 409);
      if (existing.builtIn && ((values.runtimeKind && values.runtimeKind !== existing.runtimeKind) || values.connectionId)) {
        throw fail('Create a separate Agent to use another runtime.', 409);
      }
      const next = { ...existing, ...values };
      const conn = next.connectionId ? this.resolveConnection(next.connectionId) : null;
      const effectiveKind = conn ? CONNECTION_TO_RUNTIME_KIND[conn.kind] || 'pi' : next.runtimeKind;
      const policy = validatePolicyPatch(input, policyOf(existing));
      validateRuntimePolicy(effectiveKind, policy, Boolean(conn));
      const isNative = Boolean(conn) || effectiveKind !== 'pi';
      db.prepare(`UPDATE agent_definitions SET name = ?, description = ?, role = ?, status = ?, connection_id = ?,
        revision = revision + 1, updated_at = ?, execution_policy_json = ?, runtime_binding_json = ? WHERE id = ?`).run(
        next.name,
        next.description,
        next.role,
        next.status,
        conn ? conn.id : null,
        new Date().toISOString(),
        JSON.stringify(policy),
        JSON.stringify({ kind: effectiveKind, model: isNative ? next.runtimeModel || null : null }),
        id
      );
      return this.get(id);
    });
  }

  delete(id, expectedRevision) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw fail('expectedRevision is required.');
    return this.manager.transaction(db => {
      const agent = this.get(id);
      if (!agent) throw fail('Agent not found.', 404);
      if (agent.revision !== expectedRevision) throw fail('Agent changed. Reload before deleting.', 409);
      if (agent.builtIn) throw fail('The default Agent cannot be deleted.', 409);
      if (db.prepare('SELECT 1 FROM sessions WHERE agent_id = ? LIMIT 1').get(id)) {
        throw fail('Agent is assigned to a session. Reassign its sessions before deleting.', 409);
      }
      if (db.prepare(`SELECT 1 FROM parallel_batches b LEFT JOIN parallel_lanes l ON l.batch_id = b.id
        WHERE b.runtime_version = 1 AND b.status IN ('running','review','blocked')
        AND (l.agent_id = ? OR json_extract(b.review_snapshot_json, '$.id') = ?) LIMIT 1`).get(id, id) ||
          db.prepare(`SELECT 1 FROM channel_pipelines p, json_each(p.steps_json) s
            WHERE p.active = 1 AND json_extract(s.value, '$.agent_id') = ? LIMIT 1`).get(id)) {
        throw fail('Agent is assigned to an unfinished collaboration task.', 409);
      }
      db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
      return true;
    });
  }

  mapRow(row) {
    const binding = JSON.parse(row.runtime_binding_json);
    const conn = row.connection_id
      ? this.db.prepare('SELECT id, kind, display_name, config_dir, status FROM agent_connections WHERE id = ?').get(row.connection_id)
      : null;
    return { id: row.id, name: row.name, description: row.description, role: row.role,
      runtimeKind: binding.kind, runtimeModel: binding.model || null,
      connectionId: row.connection_id || null,
      // Derived view only (R0/R1 mapping rules); not stored and never writable.
      execution: describeExecution(binding.kind, conn),
      status: row.status, revision: row.revision, builtIn: Boolean(row.built_in),
      ...JSON.parse(row.execution_policy_json),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}

module.exports = { AgentDefinitionsRepository, DEFAULT_AGENT_ID };
