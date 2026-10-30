const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../index');
const { redactSecrets, redactObject } = require('../privacy');
const { RuntimeTools } = require('../runtime-tools');

function makeTempDir(prefix = '52hz-security-test-') {
  const dir = path.join(process.cwd(), '.tmp', `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('Permissions, Desktop Security & Execution Isolation (Package E)', async (t) => {
  const tempDir = makeTempDir();
  const staticDir = path.join(__dirname, '..', '..', 'resources', 'public');
  let serverInstance = null;
  let serverPort = 0;

  t.before(async () => {
    const { server, port } = await startServer({
      port: 0,
      userDataPath: tempDir,
      staticDir,
    });
    serverInstance = server;
    serverPort = port;
  });

  t.after(async () => {
    if (serverInstance && typeof serverInstance.shutdown === 'function') {
      await serverInstance.shutdown();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('E1: Structured Permissions & Approval Expiry/Invalidation', () => {
    const mockBroadcaster = { broadcast: () => {} };
    const mockStore = { data: { runtime_tools: [], events: [] }, storage: null, save: () => {} };
    const runtimeTools = new RuntimeTools(mockStore, mockBroadcaster);

    const run = {
      tools: new Map(),
      controller: new AbortController(),
    };

    const toolCallId = 'tc_sec_1';
    run.tools.set(toolCallId, {
      id: toolCallId,
      name: 'execute_command',
      status: 'starting',
    });

    const request = {
      toolCallId,
      cwd: tempDir,
      command: 'npm install malicious-pkg',
    };

    const abortController = new AbortController();

    // 1. Pending approval registered
    const approvalPromise = runtimeTools.approve('sess_sec', run, request, abortController.signal);
    assert.equal(runtimeTools.pending.size, 1);

    // 2. Reject approval decision from wrong session
    const [approvalId] = runtimeTools.pending.keys();
    assert.throws(() => {
      runtimeTools.decide(approvalId, 'wrong_session', true);
    }, /Approval expired or does not belong to this session/);

    // 3. Reject invalid non-boolean decision
    assert.throws(() => {
      runtimeTools.decide(approvalId, 'sess_sec', 'maybe');
    }, /Choose approve or deny/);

    // 4. Aborting cancels the approval immediately
    abortController.abort();
    return approvalPromise.then((allowed) => {
      assert.equal(allowed, false);
      assert.equal(runtimeTools.pending.size, 0);
    });
  });

  await t.test('E2: Local HTTP Security, DNS Rebinding & Payload Guards', async () => {
    // 1. DNS Rebinding / Forbidden Host Header
    const rebindingRes = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: serverPort,
        path: '/v1/settings/connections',
        method: 'GET',
        headers: {
          Host: 'attacker.evil.com', // Evil host header
        },
      }, (res) => {
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.equal(rebindingRes, 403, 'Expected 403 Forbidden on untrusted Host header');

    // 2. Malformed JSON Body returns 400
    const malformedRes = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: serverPort,
        path: '/v1/settings/connections',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, (res) => {
        resolve(res.statusCode);
      });
      req.write('{ broken json... ');
      req.end();
    });
    assert.equal(malformedRes, 400, 'Expected 400 Bad Request on malformed JSON payload');

    // 3. Trusted local request succeeds
    const trustedRes = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: serverPort,
        path: '/v1/settings/connections',
        method: 'GET',
      }, (res) => {
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.equal(trustedRes, 200, 'Expected 200 OK for trusted local request');
  });

  await t.test('E5: Privacy & Log Redaction', () => {
    const rawApiKey = 'sk-proj-abc12345678901234567890abcdef';
    const rawBearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const logText = `Calling model with ${rawApiKey} and authorization header ${rawBearer}. Password was "SuperSecret123!".`;

    const redacted = redactSecrets(logText, [rawApiKey]);
    assert.ok(!redacted.includes(rawApiKey), 'API key must be masked');
    assert.ok(!redacted.includes('eyJhbGciOiJIUzI1Ni'), 'Bearer token must be masked');
    assert.ok(redacted.includes('sk-***[REDACTED]') || redacted.includes('[REDACTED]'));

    // Redact nested object
    const nestedConfig = {
      provider: 'openai',
      credentials: {
        apiKey: 'sk-12345678901234567890',
        nested: {
          token: 'secret-token-value',
          normal: 'visible-metadata',
        },
      },
    };

    const sanitized = redactObject(nestedConfig);
    assert.equal(sanitized.credentials.apiKey, '[REDACTED]');
    assert.equal(sanitized.credentials.nested.token, '[REDACTED]');
    assert.equal(sanitized.credentials.nested.normal, 'visible-metadata');
  });
});
