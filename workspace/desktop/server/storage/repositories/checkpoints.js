const crypto = require('crypto');

class CheckpointsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  create({
    id,
    sessionId,
    projectId = null,
    reason = null,
    commitSha = null,
    directory = null,
    fileCount = 0,
    files = [],
    createdAt = new Date().toISOString(),
  }) {
    const checkpointId = id || `ckpt_${crypto.randomUUID()}`;
    const totalFiles = files.length > 0 ? files.length : fileCount;

    return this.manager.transaction(db => {
      db.prepare(`
        INSERT INTO checkpoints (id, session_id, project_id, reason, commit_sha, directory, file_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        sessionId,
        projectId,
        reason,
        commitSha,
        directory,
        totalFiles,
        createdAt
      );

      if (files.length > 0) {
        const insertFile = db.prepare(`
          INSERT INTO checkpoint_files (checkpoint_id, file_path, before_hash, after_hash, patch_text)
          VALUES (?, ?, ?, ?, ?)
        `);

        for (const file of files) {
          insertFile.run(
            checkpointId,
            file.filePath || file.path,
            file.beforeHash || null,
            file.afterHash || null,
            file.patchText || file.patch || null
          );
        }
      }

      return this.get(checkpointId);
    });
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, session_id, project_id, reason, commit_sha, directory, file_count, created_at
      FROM checkpoints
      WHERE id = ?
    `).get(id);

    if (!row) return null;

    const files = this.db.prepare(`
      SELECT id, file_path, before_hash, after_hash, patch_text
      FROM checkpoint_files
      WHERE checkpoint_id = ?
      ORDER BY id ASC
    `).all(id).map(f => ({
      id: f.id,
      filePath: f.file_path,
      beforeHash: f.before_hash,
      afterHash: f.after_hash,
      patchText: f.patch_text,
    }));

    return {
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      reason: row.reason,
      commitSha: row.commit_sha,
      directory: row.directory,
      fileCount: row.file_count,
      createdAt: row.created_at,
      files,
    };
  }

  listBySession(sessionId, { limit = 50, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT id, session_id, project_id, reason, commit_sha, directory, file_count, created_at
      FROM checkpoints
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset).map(row => ({
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      reason: row.reason,
      commitSha: row.commit_sha,
      directory: row.directory,
      fileCount: row.file_count,
      createdAt: row.created_at,
    }));
  }

  delete(id) {
    const res = this.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
    return res.changes > 0;
  }
}

module.exports = { CheckpointsRepository };
