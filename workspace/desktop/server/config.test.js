const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { CredentialVault } = require('./credential-vault');
const { ConfigManager, normalizeUrl } = require('./config-manager');
const { ConnectionTester, categorizeError } = require('./connection-tester');
const testStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };

test('CredentialVault persists encrypted values using an injected safeStorage engine', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '52hz-vault-test-'));
  try {
    const vault = new CredentialVault(tmpDir, testStorage);
    assert.equal(vault.has('test-key'), false);
    assert.equal(vault.get('test-key'), null);

    vault.set('test-key', 'sk-ant-test-secret-12345');
    assert.equal(vault.has('test-key'), true);
    assert.equal(vault.get('test-key'), 'sk-ant-test-secret-12345');

    // Reload from disk
    const reloaded = new CredentialVault(tmpDir, testStorage);
    assert.equal(reloaded.has('test-key'), true);
    assert.equal(reloaded.get('test-key'), 'sk-ant-test-secret-12345');

    // Delete
    reloaded.delete('test-key');
    assert.equal(reloaded.has('test-key'), false);
    assert.equal(reloaded.get('test-key'), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('normalizeUrl normalizes base URLs correctly across protocols', () => {
  assert.equal(normalizeUrl('https://api.deepseek.com', 'openai'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeUrl('https://api.deepseek.com/v1/', 'openai'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeUrl('https://api.openai.com/v1/chat/completions', 'openai'), 'https://api.openai.com/v1');
  assert.equal(normalizeUrl('https://api.anthropic.com/v1', 'anthropic'), 'https://api.anthropic.com');
  assert.equal(normalizeUrl('https://api.anthropic.com/v1/messages', 'anthropic'), 'https://api.anthropic.com');
  assert.equal(normalizeUrl('http://127.0.0.1:11434/', 'ollama'), 'http://127.0.0.1:11434');
});

test('ConfigManager supports 3-tier config, env fallbacks and keep/replace/delete credential actions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '52hz-config-test-'));
  try {
    const vault = new CredentialVault(tmpDir, testStorage);
    const mockEnv = { DEEPSEEK_API_KEY: 'sk-env-deepseek-key' };
    const cm = new ConfigManager(tmpDir, vault, mockEnv);

    const initial = cm.getConnections();
    const deepseek = initial.find(c => c.id === 'deepseek');
    assert.ok(deepseek);
    assert.equal(deepseek.hasCredential, true);
    assert.equal(deepseek.source, 'env');

    // User saves custom connection with 'replace' credentialAction
    cm.saveConnection({
      id: 'my-custom-proxy',
      name: 'My Custom OneAPI',
      protocol: 'openai',
      baseUrl: 'https://oneapi.example.com',
      defaultModel: 'gpt-4o',
      credentialAction: 'replace',
      credentialValue: 'sk-custom-oneapi-secret',
    });

    const conn = cm.getConnection('my-custom-proxy');
    assert.ok(conn);
    assert.equal(conn.baseUrl, 'https://oneapi.example.com/v1');
    assert.equal(conn.hasCredential, true);
    assert.equal(conn.source, 'user');
    assert.equal(cm.getConnectionSecret('my-custom-proxy'), 'sk-custom-oneapi-secret');

    // Update with 'keep' credentialAction (does not alter secret)
    cm.saveConnection({
      id: 'my-custom-proxy',
      name: 'Renamed OneAPI',
      protocol: 'openai',
      baseUrl: 'https://oneapi.example.com/v1',
      defaultModel: 'claude-3-5-sonnet',
      credentialAction: 'keep',
    });
    assert.equal(cm.getConnection('my-custom-proxy').name, 'Renamed OneAPI');
    assert.equal(cm.getConnectionSecret('my-custom-proxy'), 'sk-custom-oneapi-secret');

    // Update with 'delete' credentialAction
    cm.saveConnection({
      id: 'my-custom-proxy',
      credentialAction: 'delete',
    });
    assert.equal(cm.getConnection('my-custom-proxy').hasCredential, false);
    assert.equal(cm.getConnectionSecret('my-custom-proxy'), '');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('categorizeError accurately maps error status and messages', () => {
  assert.equal(categorizeError(401).code, 'AUTH_FAILED');
  assert.equal(categorizeError(403).code, 'AUTH_FAILED');
  assert.equal(categorizeError(404).code, 'MODEL_NOT_FOUND');
  assert.equal(categorizeError(200, 'model does not exist').code, 'MODEL_NOT_FOUND');
  assert.equal(categorizeError(500).code, 'SERVER_ERROR');
  assert.equal(categorizeError(0, 'ETIMEDOUT').code, 'TIMEOUT');
});
