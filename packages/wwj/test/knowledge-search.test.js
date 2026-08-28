'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { McpServer } = require('../src/mcp-server');
const BaseAdapter = require('../src/adapters/base');

test('McpServer exposes workspace_search_knowledge tool', () => {
  const mcp = new McpServer({
    workspaceId: 'test-ws',
    token: 'test-token',
    agentName: 'test-agent',
  });

  const tools = mcp.tools;
  const searchTool = tools.find((t) => t.name === 'workspace_search_knowledge');
  assert.ok(searchTool, 'workspace_search_knowledge tool should be present');
  assert.equal(searchTool.inputSchema.properties.query.type, 'string');
  assert.deepEqual(searchTool.inputSchema.required, ['query']);
});

test('McpServer executes workspace_search_knowledge and formats response', async () => {
  const mockWs = {
    searchKnowledge: async (wsId, token, opts) => {
      assert.equal(wsId, 'test-ws');
      assert.equal(opts.query, 'JWT');
      return {
        query: 'JWT',
        total_matches: 1,
        results: [
          {
            chunk_id: 'jwt-spec#1',
            entry_id: 'e1',
            slug: 'jwt-spec',
            title: 'JWT Specification',
            category: 'api',
            section: 'Authentication > Expiration',
            section_path: ['Authentication', 'Expiration'],
            snippet: 'JWT tokens expire in 2 hours.',
            score: 0.92,
          },
        ],
      };
    },
  };

  const mcp = new McpServer({
    workspaceId: 'test-ws',
    token: 'test-token',
    agentName: 'test-agent',
    wsClient: mockWs,
  });

  const res = await mcp._dispatch('workspace_search_knowledge', { query: 'JWT' });
  assert.ok(res.content && res.content[0]);
  assert.ok(res.content[0].text.includes('JWT Specification > Authentication > Expiration'));
  assert.ok(res.content[0].text.includes('@knowledge:jwt-spec'));
  assert.ok(res.content[0].text.includes('92%'));
  assert.ok(res.content[0].text.includes('JWT tokens expire in 2 hours.'));
});

test('BaseAdapter auto-RAG injects relevant knowledge snippet when query matches', async () => {
  const mockClient = {
    searchKnowledge: async (wsId, token, opts) => {
      return {
        query: opts.query,
        results: [
          {
            slug: 'db-rules',
            title: 'Database Rules',
            section: 'Connection Pool',
            snippet: 'Max open connections is 50.',
            score: 0.85,
          },
        ],
      };
    },
  };

  const adapter = new BaseAdapter({
    workspaceId: 'test-ws',
    token: 'test-token',
    agentName: 'test-agent',
    client: mockClient,
  });

  const prompt = 'What is our max connection pool limit?';
  const resolved = await adapter._resolveKnowledgeMentions(prompt);

  assert.ok(resolved.includes('📁 [相关知识库参考: Database Rules > Connection Pool (@knowledge:db-rules)]'));
  assert.ok(resolved.includes('Max open connections is 50.'));
  assert.ok(resolved.includes(prompt));
});
