const crypto = require('crypto');

class EventsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  append({ id, eventId, sessionId, type, source, target, payload, metadata, timestamp }) {
    const eid = eventId || id || `evt_${crypto.randomUUID()}`;

    // Deduplication check
    const existing = this.get(eid);
    if (existing) {
      return { ...existing, duplicate: true };
    }

    const ts = timestamp || Date.now();
    const now = new Date(ts).toISOString();
    const payloadJson = payload !== undefined && payload !== null ? JSON.stringify(payload) : null;
    const metadataJson = metadata !== undefined && metadata !== null ? JSON.stringify(metadata) : null;

    let sessId = sessionId || null;
    if (!sessId && target && typeof target === 'string' && target.startsWith('channel/')) {
      sessId = target.replace(/^channel\//, '');
    }

    if (sessId) {
      const exists = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessId);
      if (!exists) {
        this.db.prepare(`
          INSERT INTO sessions (id, title, mode, status, created_at, updated_at)
          VALUES (?, ?, 'chat', 'active', ?, ?)
        `).run(sessId, sessId, now, now);
      }
    }

    const res = this.db.prepare(`
      INSERT INTO events (event_id, session_id, type, source, target, payload_json, metadata_json, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eid,
      sessId,
      type || 'workspace.event',
      source || 'system',
      target || null,
      payloadJson,
      metadataJson,
      ts,
      now
    );

    return {
      seq: Number(res.lastInsertRowid),
      id: eid,
      eventId: eid,
      sessionId: sessId,
      type: type || 'workspace.event',
      source: source || 'system',
      target: target || null,
      payload: payload || null,
      metadata: metadata || null,
      timestamp: ts,
      createdAt: now,
    };
  }

  listBySession(sessionId, options = {}) {
    return this.list({ ...options, sessionId });
  }

  get(eventId) {
    const row = this.db.prepare(`
      SELECT seq, event_id, session_id, type, source, target, payload_json, metadata_json, timestamp, created_at
      FROM events
      WHERE event_id = ?
    `).get(eventId);

    if (!row) return null;
    return this.mapRow(row);
  }

  list({ sessionId, target, type, after, before, afterSeq, limit = 100 } = {}) {
    let sql = 'SELECT seq, event_id, session_id, type, source, target, payload_json, metadata_json, timestamp, created_at FROM events';
    const conditions = [];
    const params = [];

    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }
    if (target) {
      conditions.push('target = ?');
      params.push(target);
    }
    if (type) {
      conditions.push('type LIKE ?');
      params.push(`${type}%`);
    }
    if (afterSeq !== undefined) {
      conditions.push('seq > ?');
      params.push(afterSeq);
    }
    if (after) {
      const cursor = this.get(after);
      if (cursor) {
        conditions.push('seq > ?');
        params.push(cursor.seq);
      } else if (Number.isFinite(Number(after))) {
        conditions.push('timestamp > ?');
        params.push(Number(after));
      }
    }
    if (before) {
      const cursor = this.get(before);
      if (cursor) {
        conditions.push('seq < ?');
        params.push(cursor.seq);
      } else if (Number.isFinite(Number(before))) {
        conditions.push('timestamp < ?');
        params.push(Number(before));
      }
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY seq ASC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params).map(row => this.mapRow(row));
  }

  getLatestPerChannel() {
    const rows = this.db.prepare(`
      SELECT e.seq, e.event_id, e.session_id, e.type, e.source, e.target, e.payload_json, e.metadata_json, e.timestamp, e.created_at
      FROM events e
      INNER JOIN (
        SELECT target, MAX(seq) AS max_seq
        FROM events
        WHERE target LIKE 'channel/%'
        GROUP BY target
      ) latest ON e.target = latest.target AND e.seq = latest.max_seq
    `).all();

    return rows.map(r => this.mapRow(r));
  }

  prune(maxKeep = 50000) {
    const totalRow = this.db.prepare('SELECT count(*) as count FROM events').get();
    if (totalRow.count > maxKeep) {
      const excess = totalRow.count - maxKeep;
      this.db.prepare(`
        DELETE FROM events WHERE seq IN (
          SELECT seq FROM events ORDER BY seq ASC LIMIT ?
        )
      `).run(excess);
    }
  }

  mapRow(row) {
    return {
      seq: Number(row.seq),
      id: row.event_id,
      eventId: row.event_id,
      event_id: row.event_id,
      network: '52hz',
      sessionId: row.session_id,
      type: row.type,
      source: row.source,
      target: row.target,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }
}

module.exports = { EventsRepository };
