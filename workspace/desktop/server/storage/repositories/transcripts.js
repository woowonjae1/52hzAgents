const crypto = require('crypto');

class TranscriptsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  setRef({ sessionId, filePath, lineOffset = 0, byteOffset = 0 }) {
    const existing = this.getRef(sessionId);
    const now = new Date().toISOString();

    if (existing) {
      this.db.prepare(`
        UPDATE transcript_refs
        SET file_path = ?, line_offset = ?, byte_offset = ?, updated_at = ?
        WHERE session_id = ?
      `).run(filePath, lineOffset, byteOffset, now, sessionId);
      return this.getRef(sessionId);
    }

    const id = `tr_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO transcript_refs (id, session_id, file_path, line_offset, byte_offset, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, filePath, lineOffset, byteOffset, now);

    return this.getRef(sessionId);
  }

  getRef(sessionId) {
    const row = this.db.prepare(`
      SELECT id, session_id, file_path, line_offset, byte_offset, updated_at
      FROM transcript_refs
      WHERE session_id = ?
    `).get(sessionId);

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      lineOffset: row.line_offset,
      byteOffset: row.byte_offset,
      updatedAt: row.updated_at,
    };
  }

  deleteRef(sessionId) {
    const res = this.db.prepare('DELETE FROM transcript_refs WHERE session_id = ?').run(sessionId);
    return res.changes > 0;
  }
}

module.exports = { TranscriptsRepository };
