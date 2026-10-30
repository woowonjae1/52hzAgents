const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { DatabaseManager } = require('./database');
const { createStorage } = require('./index');
const { getVersionInfo, getPackageMeta } = require('../version');
const { Store } = require('../store');

function makeTempDir(prefix = '52hz-dist-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

test('Packaging & Distribution (Package I)', async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = makeTempDir();
  });

  t.afterEach(() => {
    cleanTempDir(tmpDir);
  });

  await t.test('I1: Version metadata and release channels', async () => {
    const pkg = getPackageMeta();
    assert.ok(pkg.version, 'package.json must specify version');
    assert.strictEqual(pkg.name, '52hzagents-desktop');

    // Default stable channel
    const defaultInfo = getVersionInfo({ userDataPath: tmpDir });
    assert.strictEqual(defaultInfo.appName, '52hzAgents');
    assert.strictEqual(defaultInfo.appVersion, pkg.version);
    assert.strictEqual(defaultInfo.channel, 'stable');
    assert.strictEqual(defaultInfo.platform, process.platform);
    assert.ok(defaultInfo.schemaVersion >= 3);
    assert.ok(defaultInfo.sqliteVersion);
    assert.ok(defaultInfo.nodeVersion);

    // Custom beta channel via env
    process.env.OPENAGENTS_RELEASE_CHANNEL = 'beta';
    try {
      const betaInfo = getVersionInfo({ userDataPath: tmpDir });
      assert.strictEqual(betaInfo.channel, 'beta');
    } finally {
      delete process.env.OPENAGENTS_RELEASE_CHANNEL;
    }
  });

  await t.test('I2 & I3: Decoupled userData and package.json build configurations', async () => {
    const pkg = getPackageMeta();
    const buildConfig = pkg.build;
    assert.ok(buildConfig, 'build config must exist in package.json');

    // Verify NSIS configuration
    const nsis = buildConfig.nsis;
    assert.ok(nsis, 'NSIS configuration must exist');
    assert.strictEqual(nsis.oneClick, false, 'Should allow standard custom installation wizard');
    assert.strictEqual(nsis.allowToChangeInstallationDirectory, true, 'User must be able to choose install path');
    assert.strictEqual(nsis.deleteAppDataOnUninstall, false, 'Uninstall MUST NOT delete user database or configs');

    // Verify Portable configuration
    const portable = buildConfig.portable;
    assert.ok(portable, 'Portable target config must exist');
    assert.ok(portable.artifactName.includes('portable'));

    // Verify target includes both NSIS and Portable
    assert.ok(buildConfig.win.target.includes('nsis'));
    assert.ok(buildConfig.win.target.includes('portable'));
  });

  await t.test('I4: Downgrade guard prevents older clients from opening newer schema databases', async () => {
    const dbPath = path.join(tmpDir, 'test-downgrade.db');
    const migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });

    // 1. Client creates DB with schema version 1
    fs.writeFileSync(path.join(migrationsDir, '001-base.sql'), 'CREATE TABLE test_table (id TEXT PRIMARY KEY);');
    const mgr1 = new DatabaseManager(dbPath, { migrationsDir });
    assert.strictEqual(mgr1.getSchemaVersion(), 1);
    mgr1.close();

    // 2. Future client upgrades DB to version 99
    const futureMgr = new DatabaseManager(dbPath, { migrationsDir });
    futureMgr.db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (99, ?, ?, ?)')
      .run('future', new Date().toISOString(), 'fake-checksum-99');
    assert.strictEqual(futureMgr.getSchemaVersion(), 99);
    futureMgr.close();

    // 3. Old client (only knowing migrations up to 1) opens the DB -> Must be rejected!
    assert.throws(
      () => {
        new DatabaseManager(dbPath, { migrationsDir });
      },
      /Database schema version \(99\) is newer than the highest version supported by this client/
    );
  });

  await t.test('I4: Pre-migration auto-backup is taken before applying upgrades', async () => {
    const dbPath = path.join(tmpDir, 'test-auto-backup.db');
    const migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });

    // Step 1: Initialize at version 1
    fs.writeFileSync(path.join(migrationsDir, '001-init.sql'), 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);');
    const mgr1 = new DatabaseManager(dbPath, { migrationsDir });
    mgr1.db.prepare('INSERT INTO users VALUES (?, ?)').run('u1', 'Alice');
    assert.strictEqual(mgr1.getSchemaVersion(), 1);
    mgr1.close();

    // Step 2: New version 2 migration arrives
    fs.writeFileSync(path.join(migrationsDir, '002-add-role.sql'), 'ALTER TABLE users ADD COLUMN role TEXT DEFAULT "user";');

    // Step 3: Initializing database triggers migration upgrade from v1 to v2
    const mgr2 = new DatabaseManager(dbPath, { migrationsDir });
    assert.strictEqual(mgr2.getSchemaVersion(), 2);
    assert.ok(mgr2.lastPreUpgradeBackup, 'lastPreUpgradeBackup path should be recorded');
    assert.ok(fs.existsSync(mgr2.lastPreUpgradeBackup), 'Pre-upgrade backup file must exist');

    // Verify backup metadata
    const metaPath = `${mgr2.lastPreUpgradeBackup}.meta.json`;
    assert.ok(fs.existsSync(metaPath), 'Backup meta file must exist');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.strictEqual(meta.label, 'preupgrade');
    assert.strictEqual(meta.fromVersion, 1);
    assert.deepStrictEqual(meta.pendingVersions, [2]);

    // Verify data in upgraded DB
    const row = mgr2.db.prepare('SELECT id, name, role FROM users WHERE id = ?').get('u1');
    assert.strictEqual(row.name, 'Alice');
    assert.strictEqual(row.role, 'user');
    mgr2.close();
  });

  await t.test('I1: HTTP /v1/system/version and /v1/app/version endpoints', async () => {
    const store = new Store(tmpDir);
    const storage = createStorage({ dbPath: ':memory:' });
    store.storage = storage;

    // Spin up mini server with the handler logic from server/index.js
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      if (parsedUrl.pathname === '/v1/system/version' || parsedUrl.pathname === '/v1/app/version') {
        const info = getVersionInfo({ storage: store.storage, userDataPath: store.userDataPath || store.dir });
        const json = JSON.stringify(info);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(json);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetchJson(`http://127.0.0.1:${port}/v1/system/version`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.appName, '52hzAgents');
      assert.strictEqual(res.body.channel, 'stable');
      assert.strictEqual(path.resolve(res.body.userDataPath).toLowerCase(), path.resolve(tmpDir).toLowerCase());
      assert.ok(res.body.schemaVersion >= 3);

      const resApp = await fetchJson(`http://127.0.0.1:${port}/v1/app/version`);
      assert.strictEqual(resApp.status, 200);
      assert.strictEqual(resApp.body.appName, '52hzAgents');
    } finally {
      server.close();
      storage.close();
    }
  });
});
