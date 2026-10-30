const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class BackupManager {
  /**
   * @param {import('./index').Storage} storage
   * @param {string} baseDir - Directory where backups are stored
   */
  constructor(storage, baseDir) {
    this.storage = storage;
    this.baseDir = baseDir || (storage.manager.dbPath !== ':memory:' ? path.dirname(storage.manager.dbPath) : process.cwd());
    this.backupsDir = path.join(this.baseDir, 'backups');
  }

  /**
   * Run SQLite integrity and foreign key checks.
   * @returns {{ ok: boolean, integrity: string[], foreignKeyViolations: Array<any> }}
   */
  checkIntegrity() {
    const integrityRows = this.storage.db.prepare('PRAGMA integrity_check').all();
    const isIntegrityOk = integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok';

    const fkRows = this.storage.db.prepare('PRAGMA foreign_key_check').all();
    const isFkOk = fkRows.length === 0;

    return {
      ok: isIntegrityOk && isFkOk,
      integrity: integrityRows.map(r => r.integrity_check),
      foreignKeyViolations: fkRows,
    };
  }

  /**
   * Create a hot online backup using SQLite backup API.
   * @param {Object} [options]
   * @param {string} [options.label]
   * @param {number} [options.maxRotations=5]
   * @param {boolean} [options.includePackage=true]
   * @returns {Promise<{ backupPath: string, checksum: string, sizeBytes: number, createdAt: string, metadata: Object }>}
   */
  async createBackup({ label = 'manual', maxRotations = 5, includePackage = true } = {}) {
    if (this.storage.manager.dbPath === ':memory:') {
      throw new Error('Cannot backup in-memory database to file using online backup API.');
    }

    fs.mkdirSync(this.backupsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `backup-${label}-${timestamp}.sqlite`;
    const backupPath = path.join(this.backupsDir, backupFileName);

    // Perform hot backup
    await this.storage.backup(backupPath);

    // Calculate checksum and size
    const fileBytes = fs.readFileSync(backupPath);
    const checksum = crypto.createHash('sha256').update(fileBytes).digest('hex');
    const sizeBytes = fileBytes.length;
    const createdAt = new Date().toISOString();

    let packageInfo = null;
    if (includePackage) {
      const packageDir = path.join(this.backupsDir, `backup-${label}-${timestamp}-package`);
      fs.mkdirSync(packageDir, { recursive: true });
      const packageFiles = {};

      const hashFile = (absPath) => {
        const bytes = fs.readFileSync(absPath);
        return crypto.createHash('sha256').update(bytes).digest('hex');
      };

      const copyDirRecursiveWithHashes = (srcRoot, destRoot, relPrefix) => {
        let count = 0;
        if (!fs.existsSync(srcRoot)) return count;
        fs.mkdirSync(destRoot, { recursive: true });
        const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
        for (const entry of entries) {
          const srcEntry = path.join(srcRoot, entry.name);
          const destEntry = path.join(destRoot, entry.name);
          const relEntry = path.posix.join(relPrefix, entry.name);
          if (entry.isDirectory()) {
            count += copyDirRecursiveWithHashes(srcEntry, destEntry, relEntry);
          } else if (entry.isFile()) {
            fs.copyFileSync(srcEntry, destEntry);
            packageFiles[relEntry] = hashFile(destEntry);
            count++;
          }
        }
        return count;
      };

      // 1. Snapshot companion directories recursively if present
      const companionDirs = ['checkpoints', 'attachments', 'files', 'pi-sessions', 'pi'];
      const dirCounts = {};
      for (const dirName of companionDirs) {
        const srcDir = path.join(this.baseDir, dirName);
        const destDir = path.join(packageDir, dirName);
        dirCounts[dirName] = copyDirRecursiveWithHashes(srcDir, destDir, dirName);
      }

      // 2. Snapshot configs and credentials
      const configFiles = [
        'connections.json',
        'workspace-store.json',
        'credentials.json',
        'config.json',
        'settings.json',
        'data.json',
      ];
      const includedConfigs = [];
      for (const cf of configFiles) {
        const srcCf = path.join(this.baseDir, cf);
        if (fs.existsSync(srcCf)) {
          try {
            if (fs.statSync(srcCf).isFile()) {
              const destCf = path.join(packageDir, cf);
              fs.copyFileSync(srcCf, destCf);
              packageFiles[cf] = hashFile(destCf);
              includedConfigs.push(cf);
            }
          } catch (_) {}
        }
      }

      packageInfo = {
        packageDir: path.basename(packageDir),
        checkpointsCount: dirCounts.checkpoints || 0,
        attachmentsCount: dirCounts.attachments || 0,
        filesCount: dirCounts.files || 0,
        piCount: (dirCounts['pi-sessions'] || 0) + (dirCounts.pi || 0),
        configs: includedConfigs,
        files: packageFiles,
      };
    }

    const metadata = {
      sourceDb: this.storage.manager.dbPath,
      label,
      checksum,
      sizeBytes,
      createdAt,
      package: packageInfo,
    };

    fs.writeFileSync(`${backupPath}.meta.json`, JSON.stringify(metadata, null, 2));

    // Rotate older backups if exceeding maxRotations
    if (maxRotations > 0) {
      this.rotateBackups(maxRotations);
    }

    return {
      backupPath,
      checksum,
      sizeBytes,
      createdAt,
      metadata,
    };
  }

  /**
   * List available backups sorted newest first.
   * @returns {Array<{ path: string, name: string, sizeBytes: number, createdAt: string, metadata?: Object }>}
   */
  listBackups() {
    if (!fs.existsSync(this.backupsDir)) return [];

    const files = fs.readdirSync(this.backupsDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite'))
      .sort((a, b) => b.localeCompare(a)); // Newest first

    return files.map(file => {
      const fullPath = path.join(this.backupsDir, file);
      const metaPath = `${fullPath}.meta.json`;
      let meta = null;
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch (_) {}
      }

      const stat = fs.statSync(fullPath);
      return {
        path: fullPath,
        name: file,
        sizeBytes: stat.size,
        createdAt: meta?.createdAt || stat.mtime.toISOString(),
        metadata: meta,
      };
    });
  }

  /**
   * Rotate backups keeping the most recent `maxKeep` files.
   * @param {number} maxKeep
   */
  rotateBackups(maxKeep = 5) {
    const list = this.listBackups();
    if (list.length <= maxKeep) return;

    const toDelete = list.slice(maxKeep);
    for (const b of toDelete) {
      try {
        fs.unlinkSync(b.path);
        const meta = `${b.path}.meta.json`;
        if (fs.existsSync(meta)) fs.unlinkSync(meta);
        const pkgDir = b.path.replace(/\.sqlite$/, '-package');
        if (fs.existsSync(pkgDir)) {
          fs.rmSync(pkgDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  }

  /**
   * Restore database from a given backup file.
   * Tests backup integrity, creates rollback copy, restores, and re-initializes storage repositories.
   * @param {string} backupPath
   * @returns {boolean}
   */
  restoreFromBackup(backupPath) {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found at ${backupPath}`);
    }

    const { DatabaseSync } = require('node:sqlite');

    // 1. Verify backup file integrity before touching active database
    try {
      const testDb = new DatabaseSync(backupPath, { readOnly: true });
      try {
        const rows = testDb.prepare('PRAGMA integrity_check').all();
        if (!rows.length || rows[0].integrity_check !== 'ok') {
          throw new Error('Backup file failed SQLite integrity check: ' + (rows[0]?.integrity_check || 'unknown'));
        }
      } finally {
        testDb.close();
      }
    } catch (err) {
      throw new Error(`Invalid backup database file: ${err.message}`);
    }

    // Verify backup checksum if metadata exists
    const metaPath = `${backupPath}.meta.json`;
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.checksum) {
          const bytes = fs.readFileSync(backupPath);
          const computed = crypto.createHash('sha256').update(bytes).digest('hex');
          if (computed !== meta.checksum) {
            throw new Error(`Backup file checksum verification failed! Expected: ${meta.checksum}, got: ${computed}`);
          }
        }
      } catch (err) {
        throw new Error(`Corrupted backup metadata: ${err.message}`);
      }
    }

    // STRICT CHECK: Verify all companion package files BEFORE touching active state!
    const pkgDir = backupPath.replace(/\.sqlite$/, '-package');
    if (meta?.package) {
      if (!fs.existsSync(pkgDir)) {
        throw new Error('Invalid backup package: companion package directory is missing');
      }
      if (meta.package.files && typeof meta.package.files === 'object') {
        for (const [relPath, expectedHash] of Object.entries(meta.package.files)) {
          const fullPkgFilePath = path.join(pkgDir, relPath);
          if (!fs.existsSync(fullPkgFilePath)) {
            throw new Error(`Invalid backup package: missing companion file ${relPath}`);
          }
          const fileBytes = fs.readFileSync(fullPkgFilePath);
          const actualHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
          if (actualHash !== expectedHash) {
            throw new Error(`Backup companion package file tampered or corrupted: ${relPath}`);
          }
        }
      }
    }

    const activeDbPath = this.storage.manager.dbPath;
    if (activeDbPath === ':memory:') {
      throw new Error('Cannot restore to in-memory database path.');
    }

    // 2. Flushes WAL and closes concurrent connections to ensure consistency
    if (this.storage?.db && !this.storage?.manager?.isClosed) {
      try {
        this.storage.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (_) {}
    }

    const { closeDatabasesUnder } = require('./database');
    closeDatabasesUnder(path.dirname(activeDbPath));
    this.storage.close();

    const companionDirs = ['checkpoints', 'attachments', 'files', 'pi-sessions', 'pi'];
    const companionConfigs = [
      'connections.json',
      'workspace-store.json',
      'credentials.json',
      'config.json',
      'settings.json',
      'data.json',
    ];

    // Record original pre-restore state of existing files and directories
    const existingDirs = new Set();
    for (const dirName of companionDirs) {
      if (fs.existsSync(path.join(this.baseDir, dirName))) {
        existingDirs.add(dirName);
      }
    }
    const existingConfigs = new Set();
    for (const cf of companionConfigs) {
      const p = path.join(this.baseDir, cf);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        existingConfigs.add(cf);
      }
    }

    // 3. Preserve current DB and companion files as rollback copy
    const rollbackId = `corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const corruptDest = `${activeDbPath}.${rollbackId}`;
    const rollbackPkgDir = `${activeDbPath}.${rollbackId}-package`;

    const copyDirRecursive = (srcDir, destDir) => {
      if (!fs.existsSync(srcDir)) return;
      fs.mkdirSync(destDir, { recursive: true });
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcEntry = path.join(srcDir, entry.name);
        const destEntry = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          copyDirRecursive(srcEntry, destEntry);
        } else if (entry.isFile()) {
          fs.copyFileSync(srcEntry, destEntry);
        }
      }
    };

    try {
      if (fs.existsSync(activeDbPath)) {
        fs.copyFileSync(activeDbPath, corruptDest);
        if (fs.existsSync(`${activeDbPath}-wal`)) {
          fs.copyFileSync(`${activeDbPath}-wal`, `${corruptDest}-wal`);
        }
      }

      // Snapshot active workspace companion files (including nested subdirectories) into rollback directory
      fs.mkdirSync(rollbackPkgDir, { recursive: true });
      for (const dirName of companionDirs) {
        const activeSub = path.join(this.baseDir, dirName);
        if (fs.existsSync(activeSub)) {
          copyDirRecursive(activeSub, path.join(rollbackPkgDir, dirName));
        }
      }
      for (const cf of existingConfigs) {
        fs.copyFileSync(path.join(this.baseDir, cf), path.join(rollbackPkgDir, cf));
      }
    } catch (err) {
      throw new Error(`Failed to create rollback backup before restore: ${err.message}`);
    }

    // Clean up active WAL/SHM locks
    try { fs.unlinkSync(`${activeDbPath}-wal`); } catch (_) {}
    try { fs.unlinkSync(`${activeDbPath}-shm`); } catch (_) {}

    // Helper for recursive clean sync of a companion directory
    const cleanSyncDir = (srcDir, targetDir, hadTargetOriginally = true) => {
      if (!fs.existsSync(srcDir)) {
        if (!hadTargetOriginally && fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        return;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
      const srcMap = new Map(srcEntries.map(e => [e.name, e]));

      if (fs.existsSync(targetDir)) {
        for (const existing of fs.readdirSync(targetDir, { withFileTypes: true })) {
          const srcEntry = srcMap.get(existing.name);
          const toRemove = path.join(targetDir, existing.name);
          if (!srcEntry || srcEntry.isDirectory() !== existing.isDirectory()) {
            fs.rmSync(toRemove, { recursive: true, force: true });
          }
        }
      }
      for (const entry of srcEntries) {
        const srcPath = path.join(srcDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
          cleanSyncDir(srcPath, targetPath, true);
        } else if (entry.isFile()) {
          fs.copyFileSync(srcPath, targetPath);
        }
      }
    };

    // 4. Overwrite active DB with backup, restore companion package, and reconnect
    try {
      fs.copyFileSync(backupPath, activeDbPath);

      // Restore companion package (checkpoints, configs, attachments, files, pi sessions)
      if (fs.existsSync(pkgDir)) {
        for (const dirName of companionDirs) {
          const pkgSub = path.join(pkgDir, dirName);
          if (fs.existsSync(pkgSub)) {
            cleanSyncDir(pkgSub, path.join(this.baseDir, dirName), true);
          }
        }

        for (const cf of companionConfigs) {
          const pkgCf = path.join(pkgDir, cf);
          if (fs.existsSync(pkgCf)) {
            fs.copyFileSync(pkgCf, path.join(this.baseDir, cf));
          }
        }
      }

      this.storage.reconnect(activeDbPath);
      try { fs.rmSync(rollbackPkgDir, { recursive: true, force: true }); } catch (_) {}
      return true;
    } catch (err) {
      let rollbackError = null;
      try {
        if (fs.existsSync(corruptDest)) {
          fs.copyFileSync(corruptDest, activeDbPath);
          if (fs.existsSync(`${corruptDest}-wal`)) {
            fs.copyFileSync(`${corruptDest}-wal`, `${activeDbPath}-wal`);
          }
        }
        if (fs.existsSync(rollbackPkgDir)) {
          for (const dirName of companionDirs) {
            cleanSyncDir(
              path.join(rollbackPkgDir, dirName),
              path.join(this.baseDir, dirName),
              existingDirs.has(dirName)
            );
          }
          for (const cf of companionConfigs) {
            const rbCf = path.join(rollbackPkgDir, cf);
            const activeCf = path.join(this.baseDir, cf);
            if (existingConfigs.has(cf) && fs.existsSync(rbCf)) {
              fs.copyFileSync(rbCf, activeCf);
            } else if (!existingConfigs.has(cf) && fs.existsSync(activeCf)) {
              fs.unlinkSync(activeCf);
            }
          }
        }
        this.storage.reconnect(activeDbPath);
        try { fs.rmSync(rollbackPkgDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.unlinkSync(corruptDest); } catch (_) {}
        try { fs.unlinkSync(`${corruptDest}-wal`); } catch (_) {}
      } catch (rbErr) {
        rollbackError = rbErr;
      }
      if (rollbackError) {
        throw new Error(`Failed to restore backup: ${err.message}. Rollback also failed: ${rollbackError.message}. Manual recovery required.`);
      }
      throw new Error(`Failed to restore backup: ${err.message}. Rolled back to previous full workspace state.`);
    }
  }
}

module.exports = { BackupManager };
