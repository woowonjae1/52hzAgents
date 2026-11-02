const crypto = require('node:crypto');
const { POLICY_KEYS, validatePolicyPatch, policyOf } = require('../../agent-policy');

const DEFAULT_AGENT_ID = 'agent-local';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function validateIdentity(input, { create = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Agent must be an object.');
  const allowed = new Set(['name', 'description', 'role', 'status', 'expectedRevision', ...POLICY_KEYS]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw fail(`Unsupported Agent field: ${key}`);
  }
  const values = {};
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

  create(input) {
    const values = validateIdentity(input, { create: true });
    const policy = validatePolicyPatch(input);
    const id = `agent-${crypto.randomUUID()}`, now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_definitions (id, name, description, role, status, created_at, updated_at, execution_policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, values.name, values.description || '', values.role || 'assistant', values.status || 'active', now, now, JSON.stringify(policy));
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
      const next = { ...existing, ...values };
      const policy = validatePolicyPatch(input, policyOf(existing));
      db.prepare(`UPDATE agent_definitions SET name = ?, description = ?, role = ?, status = ?,
        revision = revision + 1, updated_at = ?, execution_policy_json = ? WHERE id = ?`).run(next.name, next.description, next.role, next.status, new Date().toISOString(), JSON.stringify(policy), id);
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
    return { id: row.id, name: row.name, description: row.description, role: row.role,
      runtimeKind: row.runtime_kind, status: row.status, revision: row.revision, builtIn: Boolean(row.built_in),
      ...JSON.parse(row.execution_policy_json),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}

module.exports = { AgentDefinitionsRepository, DEFAULT_AGENT_ID };
