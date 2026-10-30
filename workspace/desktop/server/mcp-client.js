const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class McpProcessClient extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.id - Server ID
   * @param {string} options.name - Server Name
   * @param {string} [options.command]
   * @param {string[]} [options.args]
   * @param {Object} [options.env]
   * @param {Function} [options.inProcessHandler] - For testing/mocking in-process MCP servers
   */
  constructor({ id, name, command, args = [], env = {}, inProcessHandler = null }) {
    super();
    this.id = id;
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.inProcessHandler = inProcessHandler;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.tools = [];
    this.status = 'stopped';
  }

  async start() {
    if (this.inProcessHandler) {
      this.status = 'running';
      const initRes = await this.inProcessHandler({
        jsonrpc: '2.0',
        id: ++this.seq,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      });
      const toolsRes = await this.inProcessHandler({
        jsonrpc: '2.0',
        id: ++this.seq,
        method: 'tools/list',
        params: {},
      });
      this.tools = (toolsRes.result && toolsRes.result.tools) || [];
      return { status: 'running', tools: this.tools };
    }

    if (!this.command) {
      throw new Error(`Cannot start MCP server ${this.name}: no command specified`);
    }

    return new Promise((resolve, reject) => {
      try {
        this.child = spawn(this.command, this.args, {
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        this.status = 'running';

        this.child.stdout.on('data', chunk => {
          this.buffer += chunk.toString('utf8');
          const lines = this.buffer.split('\n');
          this.buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve: reqResolve, reject: reqReject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) {
                  reqReject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                  reqResolve(msg.result);
                }
              }
            } catch (_) {}
          }
        });

        this.child.on('error', err => {
          this.status = 'error';
          this.emit('error', err);
        });

        this.child.on('exit', code => {
          this.status = 'stopped';
          this.emit('exit', code);
          for (const { reject: reqReject } of this.pending.values()) {
            reqReject(new Error(`MCP server ${this.name} exited with code ${code}`));
          }
          this.pending.clear();
        });

        // Initialize handshake
        this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: '52hzAgents', version: '1.0.0' },
        })
          .then(() => {
            this.notify('notifications/initialized');
            return this.request('tools/list', {});
          })
          .then(res => {
            this.tools = (res && res.tools) || [];
            resolve({ status: 'running', tools: this.tools });
          })
          .catch(err => {
            this.stop();
            reject(err);
          });
      } catch (err) {
        this.status = 'error';
        reject(err);
      }
    });
  }

  request(method, params = {}, timeoutMs = 15000) {
    if (this.inProcessHandler) {
      return Promise.resolve(
        this.inProcessHandler({
          jsonrpc: '2.0',
          id: ++this.seq,
          method,
          params,
        })
      ).then(res => {
        if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
        return res.result;
      });
    }

    if (!this.child || this.status !== 'running') {
      return Promise.reject(new Error(`MCP server ${this.name} is not running`));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: val => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.child.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    if (this.inProcessHandler) {
      this.inProcessHandler({ jsonrpc: '2.0', method, params });
      return;
    }
    if (!this.child || this.status !== 'running') return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.child.stdin.write(payload);
  }

  async callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  stop() {
    this.status = 'stopped';
    if (this.child) {
      try {
        this.child.kill();
      } catch (_) {}
      this.child = null;
    }
    for (const { reject: reqReject } of this.pending.values()) {
      reqReject(new Error(`MCP server ${this.name} stopped`));
    }
    this.pending.clear();
  }
}

function isMcpToolReadOnly(toolDef, context = {}) {
  if (!toolDef || typeof toolDef !== 'object') return false;

  // 1. Explicitly declared false in ANY recognized standard or annotation field -> mutating
  if (
    toolDef.readOnly === false ||
    toolDef.readOnlyHint === false ||
    toolDef.isReadOnly === false ||
    toolDef.annotations?.readOnly === false ||
    toolDef.annotations?.readOnlyHint === false ||
    toolDef.hints?.readOnly === false ||
    toolDef.hints?.readOnlyHint === false
  ) {
    return false;
  }

  // 2. Dangerous or mutating operation keywords in tool name override any self-reported true
  const name = (toolDef.name || '').toLowerCase();
  const dangerousPatterns = /(sql|exec|run|eval|script|cmd|command|shell|terminal|mutation|mutate|write|create|update|delete|set|remove|apply|drop|truncate|alter|insert|modify|patch|post|put|send|upload|manage|kill|stop|start|restart|destroy|purge|grant|revoke)/i;
  if (dangerousPatterns.test(name)) {
    return false;
  }

  // 3. Application-level trusted authorization check:
  // External MCP tools cannot bypass approval purely based on external self-reported metadata or prefix names.
  // Explicit application trust is strictly required from context records.
  const isAppTrusted =
    context.trusted === true ||
    context.appTrusted === true ||
    (Array.isArray(context.trustedTools) && (context.trustedTools.includes(toolDef.name) || context.trustedTools.includes(name))) ||
    (Array.isArray(context.trustedServers) && context.trustedServers.includes(context.serverName || ''));

  if (!isAppTrusted) {
    return false;
  }

  // 4. Explicitly declared true in standard or annotation fields (only after passing dangerous pattern check)
  if (
    toolDef.readOnly === true ||
    toolDef.readOnlyHint === true ||
    toolDef.isReadOnly === true ||
    toolDef.annotations?.readOnly === true ||
    toolDef.annotations?.readOnlyHint === true ||
    toolDef.hints?.readOnly === true ||
    toolDef.hints?.readOnlyHint === true
  ) {
    return true;
  }

  // 5. Strictly safe read-only prefixes for tools that did not explicitly self-report
  if (/^(read_|get_|list_|search_|describe_|fetch_|view_|find_)/.test(name)) {
    return true;
  }

  // 6. Default fail-closed
  return false;
}

class McpManager {
  /**
   * @param {Object} options
   * @param {import('./storage').Storage} [options.storage]
   */
  constructor({ storage = null } = {}) {
    this.storage = storage;
    this.clients = new Map();
  }

  async startServer(serverConfig, inProcessHandler = null) {
    const existing = this.clients.get(serverConfig.name);
    if (existing && existing.status === 'running') {
      return existing;
    }

    const client = new McpProcessClient({
      id: serverConfig.id,
      name: serverConfig.name,
      command: serverConfig.command,
      args: serverConfig.args,
      env: serverConfig.env,
      inProcessHandler,
    });

    try {
      const res = await client.start();
      this.clients.set(serverConfig.name, client);

      if (this.storage) {
        this.storage.mcp.updateServerStatus(serverConfig.name, 'running');
        this.storage.mcp.syncTools(serverConfig.id, res.tools || []);
      }

      return client;
    } catch (err) {
      if (this.storage) {
        this.storage.mcp.updateServerStatus(serverConfig.name, 'error', err.message);
      }
      throw err;
    }
  }

  async callTool(serverName, toolName, args = {}) {
    const client = this.clients.get(serverName);
    if (!client || client.status !== 'running') {
      throw new Error(`MCP server ${serverName} is not active`);
    }
    return client.callTool(toolName, args);
  }

  stopServer(serverName) {
    const client = this.clients.get(serverName);
    if (client) {
      client.stop();
      this.clients.delete(serverName);
      if (this.storage) {
        this.storage.mcp.updateServerStatus(serverName, 'stopped');
      }
      return true;
    }
    return false;
  }

  stopAll() {
    for (const [name, client] of this.clients.entries()) {
      client.stop();
      if (this.storage) {
        this.storage.mcp.updateServerStatus(name, 'stopped');
      }
    }
    this.clients.clear();
  }

  /**
   * Get all tools from active MCP servers converted to Pi Agent tool definitions.
   * @param {Object} [options]
   * @param {Function} [options.requestApproval]
   * @returns {Array<Object>}
   */
  getPiTools(options = {}) {
    const requestApproval = options?.requestApproval || null;
    const trustedServers = options?.trustedServers || null;
    const trustedTools = options?.trustedTools || null;
    const isAppTrusted = options?.trusted === true;
    const tools = [];
    for (const [serverName, client] of this.clients.entries()) {
      if (client.status !== 'running') continue;
      const serverTrusted = isAppTrusted || (Array.isArray(trustedServers) && trustedServers.includes(serverName));
      for (const t of client.tools) {
        const readOnly = isMcpToolReadOnly(t, { trusted: serverTrusted, trustedTools, serverName });
        let boundApproval = requestApproval;
        tools.push({
          name: `mcp__${serverName}__${t.name}`,
          description: `[MCP: ${serverName}] ${t.description || t.name}${readOnly ? ' (read-only)' : ' (requires approval)'}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          isReadOnly: readOnly,
          bindApproval: (fn) => { boundApproval = fn; },
          execute: async (...params) => {
            const toolCallId = params.length >= 2 && typeof params[0] === 'string' ? params[0] : null;
            const args = params.length >= 2 && typeof params[0] === 'string' ? params[1] : params[0] || {};
            const signal = params.length >= 3 ? params[2] : null;

            if (!readOnly && typeof boundApproval === 'function') {
              const allowed = await boundApproval({
                toolCallId,
                tool: `mcp__${serverName}__${t.name}`,
                args,
                server: serverName,
                mcpTool: t.name,
              }, signal);
              if (!allowed) {
                if (toolCallId) {
                  return {
                    content: [{ type: 'text', text: `MCP tool ${serverName}:${t.name} was denied by the user.` }],
                    details: { denied: true },
                    isError: true,
                    terminate: true,
                  };
                }
                throw new Error(`MCP tool ${serverName}:${t.name} execution was denied by the user.`);
              }
            }

            try {
              const res = await client.callTool(t.name, args);
              let text = '';
              if (res && Array.isArray(res.content)) {
                text = res.content.map(c => (c.text ? c.text : JSON.stringify(c))).join('\n');
              } else {
                text = typeof res === 'string' ? res : JSON.stringify(res);
              }
              if (toolCallId) {
                return {
                  content: [{ type: 'text', text }],
                  isError: Boolean(res?.isError),
                };
              }
              return text;
            } catch (err) {
              if (toolCallId) {
                return {
                  content: [{ type: 'text', text: `MCP Error: ${err.message}` }],
                  isError: true,
                };
              }
              throw err;
            }
          },
        });
      }
    }
    return tools;
  }
}

module.exports = {
  McpProcessClient,
  McpManager,
  isMcpToolReadOnly,
};
