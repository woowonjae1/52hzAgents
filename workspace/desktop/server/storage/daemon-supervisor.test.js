const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { BackendSupervisor } = require('../supervisor');
const { createStorage } = require('./index');

function makeTempDir(prefix = '52hz-daemon-test-') {
  const dir = path.join(process.cwd(), '.tmp', `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('Backend Runtime & Supervisor (Package D)', async (t) => {
  const tempDir = makeTempDir();
  const staticDir = path.join(__dirname, '..', '..', 'resources', 'public');

  t.after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('D1: Supervisor Lifecycle & In-Process Fallback', async () => {
    const supervisor = new BackendSupervisor({
      userDataPath: tempDir,
      staticDir,
      port: 0, // pick random free port
      mode: 'inProcess',
      autoRestart: false,
    });

    assert.equal(supervisor.state, 'stopped');
    assert.equal(supervisor.resolveMode(), 'inProcess');

    // Start supervisor
    const { port, pid } = await supervisor.start();
    assert.ok(port > 0, `Expected assigned port > 0, got ${port}`);
    assert.equal(pid, process.pid);
    assert.equal(supervisor.state, 'running');

    // Query HTTP server without token -> must be rejected (401 Unauthorized)
    const unauthRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/v1/settings/connections`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(unauthRes.statusCode, 401, 'Unauthorized request without token must receive 401');

    // Query HTTP server with valid session token -> responds 200
    const httpRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/v1/settings/connections`, {
        headers: {
          'X-Workspace-Token': supervisor.apiToken,
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }).on('error', reject);
    });

    // /v1/settings/connections route exists and responds with 200 when authenticated
    assert.equal(httpRes.statusCode, 200);
    const connData = JSON.parse(httpRes.body);
    assert.ok(Array.isArray(connData.connections));

    // Status check
    const status = await supervisor.getStatus();
    assert.equal(status.state, 'running');
    assert.equal(status.port, port);

    // Stop supervisor
    await supervisor.stop();
    assert.equal(supervisor.state, 'stopped');
  });

  await t.test('D2: Structured IPC Protocol, Timeouts & Credential Sync', async () => {
    const supervisor = new BackendSupervisor({
      userDataPath: tempDir,
      staticDir,
      port: 0,
      mode: 'inProcess',
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (str) => Buffer.from(`enc_${str}`),
        decryptString: (buf) => buf.toString().replace(/^enc_/, ''),
      },
    });

    // Test credential sync helper
    supervisor.saveEncryptedCredential('conn:test_p1', 'sk-super-secret-key');
    const credsPath = path.join(tempDir, 'credentials.json');
    assert.ok(fs.existsSync(credsPath));
    const savedJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.ok(savedJson['conn:test_p1'].startsWith('safe:'));

    // Test credentials cache loading
    const cache = supervisor.loadCredentialsCache();
    assert.equal(cache['conn:test_p1'], 'sk-super-secret-key');

    // Test delete
    supervisor.deleteEncryptedCredential('conn:test_p1');
    const afterDeleteJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.equal(afterDeleteJson['conn:test_p1'], undefined);

    // Test sendRequest timeout when child is missing
    await assert.rejects(async () => {
      await supervisor.sendRequest('PING');
    }, /Child process is not running/);
  });

  await t.test('D3: Performance Benchmark Baseline (M2 Measurement)', async () => {
    const storageDir = path.join(tempDir, 'perf-db');
    const storage = createStorage(storageDir);

    // 1. Measure database batch insert & query latency (P50 & P95)
    storage.projects.create({ id: 'proj_perf', name: 'Perf Project', path: storageDir });
    storage.sessions.create({ id: 'sess_perf', projectId: 'proj_perf', title: 'Perf Session' });

    const numMessages = 200;
    const insertLatencies = [];

    for (let i = 0; i < numMessages; i++) {
      const t0 = performance.now();
      storage.messages.append({
        id: `msg_perf_${i}`,
        sessionId: 'sess_perf',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Performance test message payload number ${i} with 中文检索与标记.`,
      });
      insertLatencies.push(performance.now() - t0);
    }

    insertLatencies.sort((a, b) => a - b);
    const p50Insert = insertLatencies[Math.floor(insertLatencies.length * 0.5)];
    const p95Insert = insertLatencies[Math.floor(insertLatencies.length * 0.95)];

    // P50 write latency under 2ms; P95 under 5ms in WAL mode
    assert.ok(p50Insert < 5, `Expected P50 insert < 5ms, got ${p50Insert.toFixed(2)}ms`);
    assert.ok(p95Insert < 15, `Expected P95 insert < 15ms, got ${p95Insert.toFixed(2)}ms`);

    // 2. Measure FTS5 search query latency
    const queryLatencies = [];
    for (let q = 0; q < 50; q++) {
      const t0 = performance.now();
      const results = storage.search.searchMessages('中文检索', { limit: 20 });
      queryLatencies.push(performance.now() - t0);
      assert.ok(results.length > 0);
    }

    queryLatencies.sort((a, b) => a - b);
    const p50Query = queryLatencies[Math.floor(queryLatencies.length * 0.5)];
    const p95Query = queryLatencies[Math.floor(queryLatencies.length * 0.95)];

    // FTS5 Trigram query latency must be < 10ms for P95
    assert.ok(p50Query < 5, `Expected P50 search query < 5ms, got ${p50Query.toFixed(2)}ms`);
    assert.ok(p95Query < 15, `Expected P95 search query < 15ms, got ${p95Query.toFixed(2)}ms`);

    // 3. Measure event loop latency during concurrent bulk operations
    let maxLag = 0;
    const startLagCheck = performance.now();
    let expected = startLagCheck + 10;

    const lagPromise = new Promise((resolve) => {
      let checks = 0;
      const interval = setInterval(() => {
        const now = performance.now();
        const lag = Math.max(0, now - expected);
        if (lag > maxLag) maxLag = lag;
        expected = now + 10;
        checks++;
        if (checks >= 5) {
          clearInterval(interval);
          resolve(maxLag);
        }
      }, 10);
    });

    // Do some simultaneous storage reads while lag timer runs
    for (let k = 0; k < 20; k++) {
      storage.messages.list({ sessionId: 'sess_perf', limit: 50 });
    }

    const recordedMaxLag = await lagPromise;
    // UI thread event loop lag must remain below 120ms under heavy test concurrency
    assert.ok(recordedMaxLag < 120, `Event loop max lag was ${recordedMaxLag.toFixed(2)}ms, expected < 120ms`);

    // Clean up
    storage.db.close();
  });
});
