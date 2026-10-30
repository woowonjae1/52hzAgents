const crypto = require('crypto');

class MessagesRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  append({ id, sessionId, role, senderName, senderType, content, metadata, inReplyTo, timestamp }) {
    const messageId = id || `msg_${crypto.randomUUID()}`;

    // Deduplication check
    const existing = this.get(messageId);
    if (existing) {
      return { ...existing, duplicate: true };
    }

    const ts = timestamp || Date.now();
    const now = new Date(ts).toISOString();
    const metaJson = metadata !== undefined && metadata !== null ? JSON.stringify(metadata) : null;

    this.db.prepare(`
      INSERT INTO messages (id, session_id, role, sender_name, sender_type, content, metadata_json, in_reply_to, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      sessionId,
      role || 'user',
      senderName || 'User',
      senderType || 'human',
      content || '',
      metaJson,
      inReplyTo || null,
      ts,
      now
    );

    return this.get(messageId);
  }

  create(params) {
    return this.append(params);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, session_id, role, sender_name, sender_type, content, metadata_json, in_reply_to, timestamp, created_at
      FROM messages
      WHERE id = ?
    `).get(id);

    if (!row) return null;
    return this.mapRow(row);
  }

  list({ sessionId, cursor, limit = 100, order = 'ASC' } = {}) {
    let sql = 'SELECT id, session_id, role, sender_name, sender_type, content, metadata_json, in_reply_to, timestamp, created_at FROM messages WHERE session_id = ?';
    const params = [sessionId];

    if (cursor) {
      const cursorRow = this.db.prepare('SELECT timestamp, id FROM messages WHERE id = ?').get(cursor);
      if (cursorRow) {
        if (order.toUpperCase() === 'DESC') {
          sql += ' AND (timestamp < ? OR (timestamp = ? AND id < ?))';
        } else {
          sql += ' AND (timestamp > ? OR (timestamp = ? AND id > ?))';
        }
        params.push(cursorRow.timestamp, cursorRow.timestamp, cursorRow.id);
      }
    }

    sql += ` ORDER BY timestamp ${order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}, id ${order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params).map(row => this.mapRow(row));
  }

  search(queryText, { sessionId, limit = 20 } = {}) {
    if (!queryText || !queryText.trim()) return [];

    let sql = `
      SELECT m.id, m.session_id, m.role, m.sender_name, m.sender_type, m.content, m.metadata_json, m.in_reply_to, m.timestamp, m.created_at
      FROM messages_fts f
      JOIN messages m ON f.message_id = m.id
      WHERE messages_fts MATCH ?
    `;
    const params = [queryText.trim()];

    if (sessionId) {
      sql += ' AND m.session_id = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params).map(row => this.mapRow(row));
  }

  update(id, fields = {}) {
    const allowed = ['content', 'role', 'metadata'];
    const sets = [];
    const params = [];

    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) continue;
      if (key === 'metadata') {
        sets.push('metadata_json = ?');
        params.push(fields.metadata ? JSON.stringify(fields.metadata) : null);
      } else {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }

    if (sets.length === 0) return this.get(id);

    params.push(id);
    this.db.prepare(`
      UPDATE messages SET ${sets.join(', ')} WHERE id = ?
    `).run(...params);

    return this.get(id);
  }

  delete(id) {
    const res = this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return res.changes > 0;
  }

  mapRow(row) {
    return {
      id: row.id,
      messageId: row.id,
      sessionId: row.session_id,
      role: row.role,
      senderName: row.sender_name,
      senderType: row.sender_type,
      content: row.content,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      inReplyTo: row.in_reply_to,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }
}

module.exports = { MessagesRepository };
