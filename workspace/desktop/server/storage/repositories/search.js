class SearchRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  /**
   * Search messages using trigram full-text search.
   * Joins with the messages table to return full message details and rank.
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.sessionId]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   */
  searchMessages(query, { sessionId = null, limit = 50, offset = 0 } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return [];
    }

    const trimmed = query.trim();
    // Sanitize query by wrapping words or phrase in quotes to avoid FTS5 syntax errors
    const sanitized = `"${trimmed.replace(/"/g, '""')}"`;

    let sql = `
      SELECT
        m.id,
        m.session_id,
        m.role,
        m.sender_name,
        m.sender_type,
        m.content,
        m.metadata_json,
        m.timestamp,
        m.created_at,
        snippet(messages_fts, 2, '<b>', '</b>', '...', 32) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.message_id
      WHERE messages_fts MATCH ?
    `;

    const params = [sanitized];

    if (sessionId) {
      sql += ' AND m.session_id = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY rank ASC, m.timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params);
      return rows.map(r => {
        let metadata = null;
        if (r.metadata_json) {
          try {
            metadata = JSON.parse(r.metadata_json);
          } catch (_) {
            metadata = r.metadata_json;
          }
        }
        return {
          id: r.id,
          sessionId: r.session_id,
          role: r.role,
          senderName: r.sender_name,
          senderType: r.sender_type,
          content: r.content,
          metadata,
          timestamp: r.timestamp,
          createdAt: r.created_at,
          snippet: r.snippet,
          rank: r.rank,
        };
      });
    } catch (err) {
      // If FTS match fails due to malformed expression or too short trigram (< 3 chars)
      // fall back to LIKE search
      return this.fallbackLikeSearch(trimmed, { sessionId, limit, offset });
    }
  }

  fallbackLikeSearch(query, { sessionId = null, limit = 50, offset = 0 } = {}) {
    let sql = `
      SELECT id, session_id, role, sender_name, sender_type, content, metadata_json, timestamp, created_at
      FROM messages
      WHERE content LIKE ?
    `;
    const params = [`%${query}%`];

    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params).map(r => {
      let metadata = null;
      if (r.metadata_json) {
        try {
          metadata = JSON.parse(r.metadata_json);
        } catch (_) {
          metadata = r.metadata_json;
        }
      }
      return {
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        senderName: r.sender_name,
        senderType: r.sender_type,
        content: r.content,
        metadata,
        timestamp: r.timestamp,
        createdAt: r.created_at,
        snippet: null,
        rank: 0,
      };
    });
  }
}

module.exports = { SearchRepository };
