const crypto = require('crypto');

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Approximation: Chinese/CJK characters ~1.5 chars/token; Western ~3.8 chars/token
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.ceil((cjkCount / 1.5) + (nonCjkCount / 3.8));
}

class AttachmentsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  record({
    id,
    sessionId = null,
    fileName,
    filePath,
    mimeType = 'application/octet-stream',
    sizeBytes = 0,
    contentHash = null,
    tokenEstimate = null,
  }) {
    if (!fileName || !filePath) throw new Error('Attachment fileName and filePath are required');
    const attachmentId = id || `att_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO attachments (
        id, session_id, file_name, file_path, mime_type, size_bytes, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachmentId,
      sessionId,
      fileName,
      filePath,
      mimeType,
      sizeBytes || 0,
      contentHash,
      now
    );

    return this.get(attachmentId);
  }

  get(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    return row ? this._mapRow(row) : null;
  }

  listForSession(sessionId) {
    if (!sessionId) return [];
    const rows = this.db.prepare('SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at DESC').all(sessionId);
    return rows.map(r => this._mapRow(r));
  }

  delete(id) {
    const res = this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    return res.changes > 0;
  }

  _mapRow(r) {
    return {
      id: r.id,
      sessionId: r.session_id,
      fileName: r.file_name,
      filePath: r.file_path,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes || 0),
      contentHash: r.content_hash,
      createdAt: r.created_at,
    };
  }
}

module.exports = { AttachmentsRepository, estimateTokens };
