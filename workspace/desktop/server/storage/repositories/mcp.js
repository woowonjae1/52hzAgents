const crypto = require('crypto');

class McpRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  listServers({ enabledOnly = false } = {}) {
    let sql = 'SELECT * FROM mcp_servers';
    if (enabledOnly) {
      sql += ' WHERE enabled = 1';
    }
    sql += ' ORDER BY name ASC';
    const rows = this.db.prepare(sql).all();
    return rows.map(r => this._mapServer(r));
  }

  getServer(idOrName) {
    if (!idOrName) return null;
    const row = this.db.prepare(`
      SELECT * FROM mcp_servers
      WHERE id = ? OR name = ?
    `).get(idOrName, idOrName);

    return row ? this._mapServer(row) : null;
  }

  registerServer({
    id,
    name,
    transport = 'stdio',
    command = null,
    args = [],
    env = {},
    url = null,
    autoStart = 0,
    enabled = 1,
  }) {
    if (!name || typeof name !== 'string') throw new Error('MCP server name is required');
    const serverId = id || `mcp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO mcp_servers (
        id, name, transport, command, args_json, env_json, url, status,
        enabled, auto_start, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        transport = excluded.transport,
        command = excluded.command,
        args_json = excluded.args_json,
        env_json = excluded.env_json,
        url = excluded.url,
        enabled = excluded.enabled,
        auto_start = excluded.auto_start,
        updated_at = excluded.updated_at
    `).run(
      serverId,
      name.trim(),
      transport,
      command,
      JSON.stringify(args || []),
      JSON.stringify(env || {}),
      url,
      enabled ? 1 : 0,
      autoStart ? 1 : 0,
      now,
      now
    );

    return this.getServer(serverId);
  }

  updateServerStatus(idOrName, status, errorMessage = null) {
    const existing = this.getServer(idOrName);
    if (!existing) return null;
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE mcp_servers SET
        status = ?,
        error_message = ?,
        updated_at = ?
      WHERE id = ?
    `).run(status, errorMessage, now, existing.id);

    return this.getServer(existing.id);
  }

  deleteServer(idOrName) {
    const existing = this.getServer(idOrName);
    if (!existing) return false;
    const res = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(existing.id);
    return res.changes > 0;
  }

  syncTools(serverId, tools = []) {
    const now = new Date().toISOString();
    return this.manager.transaction(db => {
      // Clear existing tools for this server
      db.prepare('DELETE FROM mcp_tools WHERE server_id = ?').run(serverId);

      const insertStmt = db.prepare(`
        INSERT INTO mcp_tools (
          id, server_id, name, description, input_schema_json, requires_approval, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const tool of tools) {
        const toolId = `tool_${crypto.randomUUID()}`;
        insertStmt.run(
          toolId,
          serverId,
          tool.name,
          tool.description || '',
          JSON.stringify(tool.inputSchema || tool.parameters || {}),
          tool.requiresApproval ? 1 : 0,
          now
        );
      }

      return this.listTools(serverId);
    });
  }

  listTools(serverId = null) {
    let sql = 'SELECT * FROM mcp_tools';
    const params = [];
    if (serverId) {
      sql += ' WHERE server_id = ?';
      params.push(serverId);
    }
    sql += ' ORDER BY name ASC';
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._mapTool(r));
  }

  getTool(toolName, serverId = null) {
    let sql = 'SELECT * FROM mcp_tools WHERE name = ?';
    const params = [toolName];
    if (serverId) {
      sql += ' AND server_id = ?';
      params.push(serverId);
    }
    const row = this.db.prepare(sql).get(...params);
    return row ? this._mapTool(row) : null;
  }

  _mapServer(r) {
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: r.args_json ? JSON.parse(r.args_json) : [],
      env: r.env_json ? JSON.parse(r.env_json) : {},
      url: r.url,
      status: r.status,
      errorMessage: r.error_message,
      enabled: Boolean(r.enabled),
      autoStart: Boolean(r.auto_start),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  _mapTool(r) {
    return {
      id: r.id,
      serverId: r.server_id,
      name: r.name,
      description: r.description,
      inputSchema: r.input_schema_json ? JSON.parse(r.input_schema_json) : {},
      requiresApproval: Boolean(r.requires_approval),
      updatedAt: r.updated_at,
    };
  }
}

module.exports = { McpRepository };
