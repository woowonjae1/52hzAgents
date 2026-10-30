const crypto = require('crypto');

class ArtifactsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  record({
    id,
    runId = null,
    sessionId = null,
    name,
    filePath,
    artifactType = 'file',
    sizeBytes = 0,
    metadata = null,
  }) {
    if (!name || !filePath) throw new Error('Artifact name and filePath are required');
    const artifactId = id || `art_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO run_artifacts (
        id, run_id, session_id, name, file_path, artifact_type, size_bytes, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      runId,
      sessionId,
      name,
      filePath,
      artifactType,
      sizeBytes || 0,
      metadata ? JSON.stringify(metadata) : null,
      now
    );

    return this.get(artifactId);
  }

  get(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM run_artifacts WHERE id = ?').get(id);
    return row ? this._mapRow(row) : null;
  }

  listForSession(sessionId) {
    if (!sessionId) return [];
    const rows = this.db.prepare('SELECT * FROM run_artifacts WHERE session_id = ? ORDER BY created_at DESC').all(sessionId);
    return rows.map(r => this._mapRow(r));
  }

  listForRun(runId) {
    if (!runId) return [];
    const rows = this.db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at DESC').all(runId);
    return rows.map(r => this._mapRow(r));
  }

  _mapRow(r) {
    return {
      id: r.id,
      runId: r.run_id,
      sessionId: r.session_id,
      name: r.name,
      filePath: r.file_path,
      artifactType: r.artifact_type,
      sizeBytes: Number(r.size_bytes || 0),
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
      createdAt: r.created_at,
    };
  }
}

module.exports = { ArtifactsRepository };
