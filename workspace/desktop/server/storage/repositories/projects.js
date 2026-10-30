const crypto = require('crypto');

class ProjectsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  create({ id, name, path: projectPath, gitBranch = null, gitOrigin = null, isActive = 1 }) {
    const projectId = id || `proj_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO projects (id, name, path, git_branch, git_origin, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      name,
      projectPath,
      gitBranch,
      gitOrigin,
      isActive ? 1 : 0,
      now,
      now
    );

    return this.get(projectId);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, name, path, git_branch, git_origin, is_active, created_at, updated_at
      FROM projects
      WHERE id = ?
    `).get(id);

    if (!row) return null;
    return this.mapRow(row);
  }

  getByPath(projectPath) {
    const row = this.db.prepare(`
      SELECT id, name, path, git_branch, git_origin, is_active, created_at, updated_at
      FROM projects
      WHERE path = ?
    `).get(projectPath);

    if (!row) return null;
    return this.mapRow(row);
  }

  list({ activeOnly = false } = {}) {
    let sql = 'SELECT id, name, path, git_branch, git_origin, is_active, created_at, updated_at FROM projects';
    if (activeOnly) {
      sql += ' WHERE is_active = 1';
    }
    sql += ' ORDER BY updated_at DESC';

    return this.db.prepare(sql).all().map(row => this.mapRow(row));
  }

  update(id, fields = {}) {
    const allowed = ['name', 'path', 'git_branch', 'git_origin', 'is_active'];
    const sets = [];
    const params = [];

    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = ?`);
      if (key === 'is_active') {
        params.push(fields[key] ? 1 : 0);
      } else {
        params.push(fields[key]);
      }
    }

    if (sets.length === 0) return this.get(id);

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`
      UPDATE projects SET ${sets.join(', ')} WHERE id = ?
    `).run(...params);

    return this.get(id);
  }

  delete(id) {
    const project = this.get(id);
    if (!project) return false;

    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return true;
  }

  mapRow(row) {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      gitBranch: row.git_branch,
      gitOrigin: row.git_origin,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { ProjectsRepository };
