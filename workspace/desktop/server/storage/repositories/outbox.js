class OutboxRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  enqueue({ eventId, sessionId = null, topic, payload }) {
    const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const now = new Date().toISOString();

    const result = this.db.prepare(`
      INSERT INTO outbox (event_id, session_id, topic, payload_json, status, retry_count, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?)
    `).run(eventId, sessionId, topic, payloadJson, now);

    return Number(result.lastInsertRowid);
  }

  fetchPending(limit = 50) {
    return this.db.prepare(`
      SELECT id, event_id, session_id, topic, payload_json, status, retry_count, created_at
      FROM outbox
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT ?
    `).all(limit).map(row => {
      let payload = null;
      try {
        payload = JSON.parse(row.payload_json);
      } catch (_) {
        payload = row.payload_json;
      }
      return {
        id: row.id,
        eventId: row.event_id,
        sessionId: row.session_id,
        topic: row.topic,
        payload,
        status: row.status,
        retryCount: row.retry_count,
        createdAt: row.created_at,
      };
    });
  }

  markProcessed(id) {
    this.db.prepare("UPDATE outbox SET status = 'processed' WHERE id = ?").run(id);
  }

  markFailed(id) {
    this.db.prepare(`
      UPDATE outbox
      SET status = 'failed', retry_count = retry_count + 1
      WHERE id = ?
    `).run(id);
  }

  purgeProcessed(olderThanDays = 7) {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    return this.db.prepare(`
      DELETE FROM outbox
      WHERE status = 'processed' AND created_at < ?
    `).run(cutoff).changes;
  }
}

module.exports = { OutboxRepository };
