const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync, backup } = require('node:sqlite');

async function evaluate() {
  const results = {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron || 'standalone',
      platform: process.platform,
      arch: process.arch,
    },
    sqlite: {},
    tests: {},
  };

  const db = new DatabaseSync(':memory:');

  // 1. Version
  const ver = db.prepare('SELECT sqlite_version() AS version').get();
  results.sqlite.version = ver.version;

  // 2. Foreign Keys
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER, pid INTEGER REFERENCES parent(id));
    INSERT INTO parent VALUES (1);
  `);
  let fkBlocked = false;
  try {
    db.exec('INSERT INTO child VALUES (10, 999);');
  } catch (err) {
    fkBlocked = err.message.includes('FOREIGN KEY');
  }
  results.tests.foreign_keys = fkBlocked;

  // 3. Transactions & Rollback
  db.exec('BEGIN;');
  db.exec('INSERT INTO parent VALUES (2);');
  db.exec('ROLLBACK;');
  const countAfterRollback = db.prepare('SELECT count(*) AS c FROM parent WHERE id = 2').get().c;
  results.tests.transaction_rollback = (countAfterRollback === 0);

  // 4. BigInt support
  const bigStmt = db.prepare('SELECT 9007199254740993 AS val');
  bigStmt.setReadBigInts(true);
  const bigVal = bigStmt.get().val;
  results.tests.bigint = (bigVal === 9007199254740993n);

  // 5. FTS5 with Trigram (Chinese substring search)
  db.exec(`
    CREATE VIRTUAL TABLE fts_docs USING fts5(content, tokenize="trigram");
    INSERT INTO fts_docs VALUES ('修复桌面端SQLite存储层与迁移流程');
    INSERT INTO fts_docs VALUES ('普通英文文档 English text');
  `);
  const ftsMatch = db.prepare('SELECT content FROM fts_docs WHERE fts_docs MATCH ?').all('存储层');
  results.tests.fts5_trigram_chinese = (ftsMatch.length === 1 && ftsMatch[0].content.includes('SQLite存储层'));

  // 6. WAL mode on disk file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-sqlite-eval-'));
  const fileDbPath = path.join(tmpDir, 'test-wal.db');
  const fileDb = new DatabaseSync(fileDbPath);
  fileDb.exec('PRAGMA journal_mode = WAL;');
  const walMode = fileDb.prepare('PRAGMA journal_mode').get().journal_mode;
  results.tests.wal_mode = (walMode.toLowerCase() === 'wal');

  // 7. Busy timeout
  fileDb.exec('PRAGMA busy_timeout = 5000;');
  const busyTimeout = fileDb.prepare('PRAGMA busy_timeout').get().timeout;
  results.tests.busy_timeout = (busyTimeout === 5000);

  // 8. Online Backup API
  fileDb.exec("CREATE TABLE test_data(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO test_data VALUES(1, 'saved');");
  const backupPath = path.join(tmpDir, 'test-backup.db');
  await backup(fileDb, backupPath);
  fileDb.close();

  const backupDb = new DatabaseSync(backupPath);
  const restored = backupDb.prepare('SELECT name FROM test_data WHERE id = 1').get();
  backupDb.close();
  results.tests.online_backup = (restored && restored.name === 'saved');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(JSON.stringify(results, null, 2));
  return results;
}

evaluate().catch(err => {
  console.error('SQLite evaluation failed:', err);
  process.exit(1);
});
