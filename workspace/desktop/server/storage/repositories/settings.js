class SettingsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  get(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    if (!row) return defaultValue;

    try {
      return JSON.parse(row.value_json);
    } catch (_) {
      return defaultValue;
    }
  }

  set(key, value) {
    const now = new Date().toISOString();
    const json = JSON.stringify(value);

    this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, json, now);

    return value;
  }

  delete(key) {
    const res = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return res.changes > 0;
  }

  listAll() {
    const rows = this.db.prepare('SELECT key, value_json, updated_at FROM settings').all();
    const result = {};
    for (const r of rows) {
      try {
        result[r.key] = JSON.parse(r.value_json);
      } catch (_) {
        result[r.key] = null;
      }
    }
    return result;
  }
}

module.exports = { SettingsRepository };
