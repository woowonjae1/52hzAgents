const crypto = require('crypto');

class TimersRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  /**
   * Create a new timer.
   */
  create(data) {
    const id = data.id || `timer-${crypto.randomUUID()}`;
    const channelName = data.channel_name || data.channel || 'general';
    const message = data.message || '';
    const delaySeconds = Number(data.delay_seconds ?? data.delaySeconds ?? 0);
    const now = new Date();
    const firesAt = data.fires_at || new Date(now.getTime() + delaySeconds * 1000).toISOString();
    const createdBy = data.source || data.created_by || 'human:user';
    const createdAt = now.toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO timers (id, channel_name, message, delay_seconds, fires_at, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `);

    stmt.run(id, channelName, message, delaySeconds, firesAt, createdBy, createdAt);

    return this.get(id);
  }

  /**
   * Get timer by ID.
   */
  get(id) {
    const stmt = this.db.prepare(`SELECT * FROM timers WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return null;
    return this._normalize(row);
  }

  /**
   * List timers, optionally by channel.
   */
  list(filter = {}) {
    let sql = `SELECT * FROM timers WHERE status = 'active'`;
    const params = [];

    const channel = filter.channel_name || filter.channel;
    if (channel) {
      sql += ` AND channel_name = ?`;
      params.push(channel);
    }

    sql += ` ORDER BY fires_at ASC`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((r) => this._normalize(r));
  }

  /**
   * Delete / cancel a timer.
   */
  delete(id) {
    const stmt = this.db.prepare(`DELETE FROM timers WHERE id = ?`);
    const res = stmt.run(id);
    return res.changes > 0;
  }

  /**
   * Get due timers that need to be fired.
   */
  getDueTimers(now = new Date()) {
    const nowIso = now.toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM timers
      WHERE status = 'active' AND fires_at <= ?
      ORDER BY fires_at ASC
    `);
    const rows = stmt.all(nowIso);
    return rows.map((r) => this._normalize(r));
  }

  /**
   * Mark a timer as fired.
   */
  markFired(id) {
    const stmt = this.db.prepare(`UPDATE timers SET status = 'fired' WHERE id = ?`);
    const res = stmt.run(id);
    return res.changes > 0;
  }

  _normalize(row) {
    return {
      id: row.id,
      channel_name: row.channel_name,
      channelName: row.channel_name,
      message: row.message,
      delay_seconds: row.delay_seconds,
      delaySeconds: row.delay_seconds,
      fires_at: row.fires_at,
      firesAt: row.fires_at,
      status: row.status,
      created_by: row.created_by,
      createdBy: row.created_by,
      created_at: row.created_at,
      createdAt: row.created_at,
    };
  }
}

module.exports = { TimersRepository };
