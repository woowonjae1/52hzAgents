const crypto = require('crypto');

class SessionsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  create({ id, projectId, title, mode = 'chat', status = 'active', workingDir, master, runtimeConfig, agentId = 'agent-local' }) {
    const sessionId = id || `sess_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const configJson = runtimeConfig ? JSON.stringify(runtimeConfig) : null;

    this.db.prepare(`
      INSERT INTO sessions (id, project_id, title, mode, status, working_dir, master, runtime_config_json, last_event_at, created_at, updated_at, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, projectId || null, title || 'New Session', mode, status, workingDir || null, master || null, configJson, Date.now(), now, now, agentId);

    return this.get(sessionId);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, project_id, title, mode, status, working_dir, master, runtime_config_json, last_event_at, created_at, updated_at, agent_id
      FROM sessions
      WHERE id = ?
    `).get(id);

    if (!row) return null;
    return this.mapRow(row);
  }

  list({ projectId, status = 'active', limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT id, project_id, title, mode, status, working_dir, master, runtime_config_json, last_event_at, created_at, updated_at, agent_id FROM sessions';
    const conditions = [];
    const params = [];

    if (projectId) {
      conditions.push('project_id = ?');
      params.push(projectId);
    }
    if (status && status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY COALESCE(last_event_at, 0) DESC, updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params).map(row => this.mapRow(row));
  }

  update(id, fields = {}) {
    const allowed = ['title', 'mode', 'status', 'working_dir', 'master', 'runtime_config', 'project_id', 'agent_id'];
    const sets = [];
    const params = [];

    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) continue;
      if (fields[key] === undefined) continue;
      if (key === 'runtime_config') {
        sets.push('runtime_config_json = ?');
        params.push(fields.runtime_config ? JSON.stringify(fields.runtime_config) : null);
      } else {
        sets.push(`${key} = ?`);
        params.push(fields[key] ?? null);
      }
    }

    if (sets.length === 0) return this.get(id);

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`
      UPDATE sessions SET ${sets.join(', ')} WHERE id = ?
    `).run(...params);

    return this.get(id);
  }

  touch(id, timestamp = Date.now()) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE sessions SET last_event_at = ?, updated_at = ? WHERE id = ?
    `).run(timestamp, now, id);
  }

  archive(id) {
    return this.update(id, { status: 'archived' });
  }

  delete(id) {
    const res = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return res.changes > 0;
  }

  mapRow(row) {
    return {
      id: row.id,
      sessionId: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      title: row.title,
      mode: row.mode,
      status: row.status,
      workingDir: row.working_dir,
      master: row.master,
      runtimeConfig: row.runtime_config_json ? JSON.parse(row.runtime_config_json) : null,
      lastEventAt: row.last_event_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { SessionsRepository };
