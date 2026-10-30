const crypto = require('crypto');

class WorktreesRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  create({
    id,
    sessionId = null,
    projectId,
    branchName,
    worktreeDir,
    status = 'active',
    baseCommit = null,
  }) {
    const worktreeId = id || `wt_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO managed_worktrees (
        id, session_id, project_id, branch_name, worktree_dir, status, base_commit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      worktreeId,
      sessionId,
      projectId,
      branchName,
      worktreeDir,
      status,
      baseCommit,
      now,
      now
    );

    return this.get(worktreeId);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, session_id, project_id, branch_name, worktree_dir, status, base_commit, created_at, updated_at
      FROM managed_worktrees
      WHERE id = ?
    `).get(id);

    if (!row) return null;
    return this.mapRow(row);
  }

  getByDir(worktreeDir) {
    const row = this.db.prepare(`
      SELECT id, session_id, project_id, branch_name, worktree_dir, status, base_commit, created_at, updated_at
      FROM managed_worktrees
      WHERE worktree_dir = ?
    `).get(worktreeDir);

    if (!row) return null;
    return this.mapRow(row);
  }

  listByProject(projectId) {
    return this.db.prepare(`
      SELECT id, session_id, project_id, branch_name, worktree_dir, status, base_commit, created_at, updated_at
      FROM managed_worktrees
      WHERE project_id = ?
      ORDER BY updated_at DESC
    `).all(projectId).map(row => this.mapRow(row));
  }

  update(id, fields = {}) {
    const allowed = ['session_id', 'status', 'branch_name', 'base_commit'];
    const sets = [];
    const params = [];

    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }

    if (sets.length === 0) return this.get(id);

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`
      UPDATE managed_worktrees SET ${sets.join(', ')} WHERE id = ?
    `).run(...params);

    return this.get(id);
  }

  delete(id) {
    const res = this.db.prepare('DELETE FROM managed_worktrees WHERE id = ?').run(id);
    return res.changes > 0;
  }

  mapRow(row) {
    return {
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      branchName: row.branch_name,
      worktreeDir: row.worktree_dir,
      status: row.status,
      baseCommit: row.base_commit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { WorktreesRepository };
