const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { createStorage } = require('./index');
const { McpManager } = require('../mcp-client');
const { estimateTokens } = require('./repositories/attachments');

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '52hz-m5-test-')));
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('Milestone M5: Extensibility (Packages J, K, L)', async (t) => {
  let tmpDir;
  let storage;

  t.beforeEach(() => {
    tmpDir = makeTempDir();
    storage = createStorage({ dbPath: path.join(tmpDir, 'test-m5.db') });
  });

  t.afterEach(() => {
    if (storage) storage.close();
    cleanTempDir(tmpDir);
  });

  await t.test('Package L: Knowledge entries & Trigram FTS5 full-text search', async () => {
    // 1. Create knowledge entries (Chinese and English)
    const entry1 = storage.knowledge.create({
      title: '代码规范与命名约定',
      category: 'guidelines',
      description: '团队内部的前后端命名与编码规范',
      content: '所有文件统一使用 UTF-8 编码。React 组件采用 PascalCase 命名，通用工具函数采用 camelCase。',
    });
    assert.ok(entry1.id);
    assert.strictEqual(entry1.title, '代码规范与命名约定');
    assert.ok(entry1.slug.includes('代码规范与命名约定'));

    const entry2 = storage.knowledge.create({
      title: 'SQLite WAL and Concurrency Architecture',
      category: 'architecture',
      description: 'Overview of WAL mode and transactions',
      content: 'Using PRAGMA journal_mode = WAL allows concurrent readers and non-blocking writes.',
    });
    assert.ok(entry2.id);

    // 2. List entries with category filter
    const listGuide = storage.knowledge.list({ category: 'guidelines' });
    assert.strictEqual(listGuide.total, 1);
    assert.strictEqual(listGuide.entries[0].title, '代码规范与命名约定');

    // 3. FTS5 Trigram search (Chinese keyword)
    const searchZh = storage.knowledge.search({ q: '命名约定' });
    assert.strictEqual(searchZh.total_matches, 1);
    assert.strictEqual(searchZh.results[0].title, '代码规范与命名约定');
    assert.ok(searchZh.results[0].snippet.includes('命名'));

    // 4. FTS5 Trigram search (English keyword)
    const searchEn = storage.knowledge.search({ q: 'concurrency' });
    assert.strictEqual(searchEn.total_matches, 1);
    assert.strictEqual(searchEn.results[0].title, 'SQLite WAL and Concurrency Architecture');

    // 5. Update entry and verify FTS sync
    storage.knowledge.update(entry1.id, {
      content: '更新规范：新增 Rust 与 Python 统一格式化要求。',
    });
    const searchUpdated = storage.knowledge.search({ q: '格式化要求' });
    assert.strictEqual(searchUpdated.total_matches, 1);
    assert.strictEqual(searchUpdated.results[0].entry_id, entry1.id);

    // 6. Delete entry and verify FTS cleanup
    storage.knowledge.delete(entry2.id);
    const searchDeleted = storage.knowledge.search({ q: 'concurrency' });
    assert.strictEqual(searchDeleted.total_matches, 0);
  });

  await t.test('Package J: MCP Client, Protocol Handshake & Tool Conversion', async () => {
    // 1. Register MCP server in SQLite
    const server = storage.mcp.registerServer({
      name: 'weather-service',
      transport: 'stdio',
      command: 'node',
      args: ['weather-server.js'],
      enabled: 1,
    });
    assert.ok(server.id);
    assert.strictEqual(server.name, 'weather-service');
    assert.strictEqual(server.status, 'stopped');

    // 2. Create in-process Mock MCP server
    const mockMcpHandler = async (msg) => {
      if (msg.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-weather', version: '1.0.0' },
          },
        };
      }
      if (msg.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'get_current_weather',
                description: 'Get real-time weather information for a city',
                inputSchema: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
          },
        };
      }
      if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params;
        if (name === 'get_current_weather') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `Weather in ${args.city}: Sunny, 24°C` }],
              isError: false,
            },
          };
        }
      }
      return { jsonrpc: '2.0', id: msg.id, error: { message: 'Method not found' } };
    };

    // 3. Connect via McpManager
    const mcpManager = new McpManager({ storage });
    const client = await mcpManager.startServer(server, mockMcpHandler);
    assert.strictEqual(client.status, 'running');
    assert.strictEqual(client.tools.length, 1);
    assert.strictEqual(client.tools[0].name, 'get_current_weather');

    // Check DB status synced
    const dbServer = storage.mcp.getServer('weather-service');
    assert.strictEqual(dbServer.status, 'running');

    // Check tools cached in SQLite
    const cachedTools = storage.mcp.listTools(server.id);
    assert.strictEqual(cachedTools.length, 1);
    assert.strictEqual(cachedTools[0].name, 'get_current_weather');

    // 4. Test tool call through McpManager
    const callRes = await mcpManager.callTool('weather-service', 'get_current_weather', { city: 'Tokyo' });
    assert.strictEqual(callRes.content[0].text, 'Weather in Tokyo: Sunny, 24°C');

    // 5. Test conversion to Pi Agent compatible tools
    const piTools = mcpManager.getPiTools();
    assert.strictEqual(piTools.length, 1);
    assert.strictEqual(piTools[0].name, 'mcp__weather-service__get_current_weather');
    assert.ok(piTools[0].description.includes('[MCP: weather-service]'));

    // Execute Pi tool format
    const output = await piTools[0].execute({ city: 'Beijing' });
    assert.strictEqual(output, 'Weather in Beijing: Sunny, 24°C');

    mcpManager.stopAll();
  });

  await t.test('Package K: Attachments metadata, Token estimation & Run Artifacts', async () => {
    // 0. Create prerequisite session and run to satisfy foreign keys
    storage.sessions.create({ id: 'session-alpha', title: 'Alpha Session' });
    storage.runs.create({ id: 'run-101', sessionId: 'session-alpha' });

    // 1. Token estimation
    const enTokens = estimateTokens('Hello world! This is a test sentence for token counting.');
    assert.ok(enTokens > 5 && enTokens < 20);

    const zhTokens = estimateTokens('这是一个用于估算中文 Token 的测试句子。');
    assert.ok(zhTokens > 5 && zhTokens < 25);

    // 2. Attachments recording
    const att = storage.attachments.record({
      sessionId: 'session-alpha',
      fileName: 'spec.pdf',
      filePath: '/storage/uploads/spec.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1048576,
      contentHash: 'sha256-dummy-hash',
    });
    assert.ok(att.id);
    assert.strictEqual(att.fileName, 'spec.pdf');

    const attList = storage.attachments.listForSession('session-alpha');
    assert.strictEqual(attList.length, 1);
    assert.strictEqual(attList[0].sizeBytes, 1048576);

    // 3. Run Artifacts recording
    const artifact = storage.artifacts.record({
      runId: 'run-101',
      sessionId: 'session-alpha',
      name: 'architecture-diagram.svg',
      filePath: '/outputs/architecture-diagram.svg',
      artifactType: 'image',
      sizeBytes: 45000,
      metadata: { width: 800, height: 600 },
    });
    assert.ok(artifact.id);
    assert.strictEqual(artifact.name, 'architecture-diagram.svg');
    assert.strictEqual(artifact.artifactType, 'image');

    const runArtifacts = storage.artifacts.listForRun('run-101');
    assert.strictEqual(runArtifacts.length, 1);
    assert.strictEqual(runArtifacts[0].metadata.width, 800);
  });

  await t.test('HTTP API integration for Knowledge, MCP, and Artifacts', async () => {
    // Create prerequisite session to satisfy foreign keys
    storage.sessions.create({ id: 'sess-test', title: 'HTTP Test Session' });

    const { Store } = require('../store');
    const store = new Store(tmpDir);
    store.storage = storage;

    const mcpManager = new McpManager({ storage });

    // Mock MCP server for HTTP tests
    const mockHandler = async (msg) => {
      if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } };
      if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', inputSchema: {} }] } };
      if (msg.method === 'tools/call') return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } };
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    };

    // Spin up mini server
    const server = http.createServer(async (req, res) => {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const pathname = parsed.pathname;
      const query = Object.fromEntries(parsed.searchParams);

      function sendJson(status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }

      function parseBody() {
        return new Promise(resolve => {
          let b = '';
          req.on('data', c => b += c);
          req.on('end', () => resolve(b ? JSON.parse(b) : {}));
        });
      }

      // Knowledge
      if (pathname === '/v1/knowledge' && req.method === 'POST') {
        const body = await parseBody();
        const created = store.storage.knowledge.create(body);
        return sendJson(200, created);
      }
      if (pathname === '/v1/knowledge' && req.method === 'GET') {
        const list = store.storage.knowledge.list(query);
        return sendJson(200, { entries: list.entries, total: list.total, supported: true });
      }
      if (pathname === '/v1/knowledge/search' && req.method === 'GET') {
        const s = store.storage.knowledge.search({ q: query.q || query.query });
        return sendJson(200, { ...s, supported: true });
      }

      // MCP
      if (pathname === '/v1/mcp/servers' && req.method === 'POST') {
        const body = await parseBody();
        const s = store.storage.mcp.registerServer(body);
        return sendJson(200, s);
      }
      if (pathname === '/v1/mcp/servers' && req.method === 'GET') {
        return sendJson(200, { servers: store.storage.mcp.listServers() });
      }
      if (pathname === '/v1/mcp/tools/call' && req.method === 'POST') {
        const body = await parseBody();
        const result = await mcpManager.callTool(body.serverName, body.toolName, body.arguments);
        return sendJson(200, { result });
      }

      // Artifacts
      if (pathname === '/v1/artifacts' && req.method === 'POST') {
        const body = await parseBody();
        const art = store.storage.artifacts.record(body);
        return sendJson(200, art);
      }
      if (pathname === '/v1/artifacts' && req.method === 'GET') {
        return sendJson(200, { artifacts: store.storage.artifacts.listForSession(query.sessionId) });
      }

      sendJson(404, { error: 'Not found' });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Knowledge API
      const createRes = await requestJson(`${base}/v1/knowledge`, {
        method: 'POST',
        body: { title: '项目架构总览', content: '本项目由 Electron 客户端和内置 Node 服务构成。' },
      });
      assert.strictEqual(createRes.status, 200);
      assert.strictEqual(createRes.body.title, '项目架构总览');

      const listRes = await requestJson(`${base}/v1/knowledge`);
      assert.strictEqual(listRes.status, 200);
      assert.strictEqual(listRes.body.total, 1);
      assert.strictEqual(listRes.body.supported, true);

      const searchRes = await requestJson(`${base}/v1/knowledge/search?q=架构总览`);
      assert.strictEqual(searchRes.status, 200);
      assert.strictEqual(searchRes.body.total_matches, 1);

      // 2. MCP API
      const mcpRes = await requestJson(`${base}/v1/mcp/servers`, {
        method: 'POST',
        body: { name: 'test-mcp-srv', transport: 'stdio' },
      });
      assert.strictEqual(mcpRes.status, 200);
      assert.strictEqual(mcpRes.body.name, 'test-mcp-srv');

      // Start mock MCP server
      await mcpManager.startServer({ id: mcpRes.body.id, name: 'test-mcp-srv' }, mockHandler);

      const callRes = await requestJson(`${base}/v1/mcp/tools/call`, {
        method: 'POST',
        body: { serverName: 'test-mcp-srv', toolName: 'ping', arguments: {} },
      });
      assert.strictEqual(callRes.status, 200);
      assert.strictEqual(callRes.body.result.content[0].text, 'pong');

      // 3. Artifacts API
      const artRes = await requestJson(`${base}/v1/artifacts`, {
        method: 'POST',
        body: { sessionId: 'sess-test', name: 'summary.md', filePath: '/docs/summary.md' },
      });
      assert.strictEqual(artRes.status, 200);
      assert.strictEqual(artRes.body.name, 'summary.md');

      const artList = await requestJson(`${base}/v1/artifacts?sessionId=sess-test`);
      assert.strictEqual(artList.status, 200);
      assert.strictEqual(artList.body.artifacts.length, 1);
    } finally {
      mcpManager.stopAll();
      server.close();
    }
  });
});
