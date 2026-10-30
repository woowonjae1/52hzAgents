const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');

const activeManagers = new Set();

/**
 * Explicit helper to safely checkpoint and close open databases within a target directory.
 * Preserves directory boundary (requires path separator). Does not monkey-patch global fs.
 * @param {string} targetDir
 */
function closeDatabasesUnder(targetDir) {
  if (!targetDir) return;
  try {
    const resolvedTarget = path.resolve(String(targetDir)).toLowerCase();
    for (const manager of Array.from(activeManagers)) {
      if (manager.dbPath === ':memory:') continue;
      const resolvedDb = path.resolve(manager.dbPath).toLowerCase();
      if (resolvedDb === resolvedTarget || resolvedDb.startsWith(resolvedTarget + path.sep)) {
        manager.close();
      }
    }
  } catch (_) {}
}

class DatabaseManager {
  /**
   * @param {string} dbPath - Absolute file path or ':memory:'
   * @param {Object} [options]
   * @param {boolean} [options.readOnly=false]
   * @param {string} [options.migrationsDir]
   */
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.options = options;
    this.migrationsDir = options.migrationsDir || path.join(__dirname, 'migrations');
    this.isClosed = false;

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath, {
      readOnly: options.readOnly || false,
    });
    activeManagers.add(this);

    this.configurePragmas();
    this.migrate();
  }

  configurePragmas() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);

    // Journal mode WAL cannot be set on in-memory DBs
    if (this.dbPath !== ':memory:') {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -64000;
      `);
    }
  }

  /**
   * Run a function inside a transaction or nested savepoint.
   * @template T
   * @param {(db: DatabaseSync) => T} fn
   * @returns {T}
   */
  transaction(fn) {
    if (this._inTransaction) {
      const sp = `sp_${crypto.randomBytes(4).toString('hex')}`;
      this.db.exec(`SAVEPOINT ${sp};`);
      try {
        const result = fn(this.db);
        this.db.exec(`RELEASE SAVEPOINT ${sp};`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
        throw err;
      }
    }

    this._inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (_) {}
      throw err;
    } finally {
      this._inTransaction = false;
    }
  }

  /**
   * Apply versioned migrations from migrations directory.
   */
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );
    `);

    if (!fs.existsSync(this.migrationsDir)) {
      return;
    }

    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const applied = new Map(
      this.db.prepare('SELECT version, checksum FROM schema_migrations').all()
        .map(row => [row.version, row.checksum])
    );

    // 1. Check for Downgrade / Incompatible Future Schema
    const availableVersions = files.map(f => {
      const m = f.match(/^(\d+)[-_]/);
      return m ? parseInt(m[1], 10) : 0;
    }).filter(v => v > 0);
    const maxAvailable = availableVersions.length > 0 ? Math.max(...availableVersions) : 0;
    const maxApplied = applied.size > 0 ? Math.max(...applied.keys()) : 0;

    if (maxApplied > maxAvailable) {
      throw new Error(
        `Database schema version (${maxApplied}) is newer than the highest version supported by this client (${maxAvailable}). Please update 52hzAgents to avoid database corruption.`
      );
    }

    // 2. Identify pending migrations
    const pending = files.filter(f => {
      const match = f.match(/^(\d+)[-_](.+)\.sql$/);
      if (!match) return false;
      const v = parseInt(match[1], 10);
      return !applied.has(v);
    });

    // 3. Pre-migration Auto-Backup (if database already has data and there are pending migrations)
    if (this.dbPath !== ':memory:' && applied.size > 0 && pending.length > 0) {
      try {
        const backupDir = path.join(path.dirname(this.dbPath), 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `backup-preupgrade-v${maxApplied}-${stamp}.sqlite`);
        fs.copyFileSync(this.dbPath, backupPath);
        const meta = {
          sourceDb: this.dbPath,
          label: 'preupgrade',
          fromVersion: maxApplied,
          pendingVersions: pending.map(p => {
            const m = p.match(/^(\d+)[-_]/);
            return m ? parseInt(m[1], 10) : 0;
          }),
          createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(`${backupPath}.meta.json`, JSON.stringify(meta, null, 2));
        this.lastPreUpgradeBackup = backupPath;
      } catch (err) {
        console.warn(`[DatabaseManager] Warning: Pre-migration auto-backup failed: ${err.message}`);
      }
    }

    for (const file of files) {
      const match = file.match(/^(\d+)[-_](.+)\.sql$/);
      if (!match) continue;

      const version = parseInt(match[1], 10);
      const name = match[2];
      const filePath = path.join(this.migrationsDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(content).digest('hex');

      if (applied.has(version)) {
        const existingChecksum = applied.get(version);
        if (existingChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file}. Existing: ${existingChecksum}, Current: ${checksum}`
          );
        }
        continue;
      }

      this.transaction(db => {
        db.exec(content);
        db.prepare(`
          INSERT INTO schema_migrations (version, name, applied_at, checksum)
          VALUES (?, ?, ?, ?)
        `).run(version, name, new Date().toISOString(), checksum);
      });
    }
  }

  /**
   * Create an online hot backup of the database to destPath.
   * @param {string} destPath
   * @returns {Promise<void>}
   */
  async backup(destPath) {
    if (this.dbPath === ':memory:') {
      throw new Error('Cannot backup in-memory database to file using SQLite backup API.');
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await sqliteBackup(this.db, destPath);
  }

  /**
   * Get current highest schema version applied to this database.
   * @returns {number}
   */
  getSchemaVersion() {
    try {
      const row = this.db.prepare('SELECT MAX(version) as max_version FROM schema_migrations').get();
      return row && row.max_version ? Number(row.max_version) : 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * List all applied migrations.
   * @returns {Array<{ version: number, name: string, appliedAt: string, checksum: string }>}
   */
  getMigrations() {
    try {
      return this.db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version ASC').all()
        .map(row => ({
          version: Number(row.version),
          name: row.name,
          appliedAt: row.applied_at,
          checksum: row.checksum,
        }));
    } catch (_) {
      return [];
    }
  }

  close() {
    this.isClosed = true;
    activeManagers.delete(this);
    try {
      this.db.close();
    } catch (_) {}
  }
}

module.exports = { DatabaseManager, closeDatabasesUnder };
