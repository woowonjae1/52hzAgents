/**
 * Model Capabilities Catalog Repository (Package F1).
 * Tracks context window size, max output tokens, tool call support,
 * vision support, reasoning capabilities, and verification timestamps.
 */

const PRESET_CAPABILITIES = [
  // OpenAI
  {
    connectionId: 'openai',
    modelId: 'gpt-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: 1,
    supportsVision: 1,
    supportsReasoning: 0,
    capabilityStatus: 'declared',
  },
  {
    connectionId: 'openai',
    modelId: 'gpt-4o-mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: 1,
    supportsVision: 1,
    supportsReasoning: 0,
    capabilityStatus: 'declared',
  },
  {
    connectionId: 'openai',
    modelId: 'o1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsTools: 1,
    supportsVision: 1,
    supportsReasoning: 1,
    capabilityStatus: 'declared',
  },
  {
    connectionId: 'openai',
    modelId: 'o3-mini',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsTools: 1,
    supportsVision: 0,
    supportsReasoning: 1,
    capabilityStatus: 'declared',
  },

  // Anthropic
  {
    connectionId: 'anthropic',
    modelId: 'claude-3-5-sonnet',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsTools: 1,
    supportsVision: 1,
    supportsReasoning: 0,
    capabilityStatus: 'declared',
  },
  {
    connectionId: 'anthropic',
    modelId: 'claude-3-5-haiku',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsTools: 1,
    supportsVision: 1,
    supportsReasoning: 0,
    capabilityStatus: 'declared',
  },

  // DeepSeek
  {
    connectionId: 'deepseek',
    modelId: 'deepseek-chat',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsTools: 1,
    supportsVision: 0,
    supportsReasoning: 0,
    capabilityStatus: 'declared',
  },
  {
    connectionId: 'deepseek',
    modelId: 'deepseek-reasoner',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsTools: 0, // DeepSeek R1 reasoning does not support tool calling directly
    supportsVision: 0,
    supportsReasoning: 1,
    capabilityStatus: 'declared',
  },
];

class CapabilitiesRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
    this._ensurePresets();
  }

  _ensurePresets() {
    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO model_capabilities (
        id, connection_id, model_id, context_window, max_output_tokens,
        supports_tools, supports_vision, supports_reasoning,
        capability_status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of PRESET_CAPABILITIES) {
      const id = `${c.connectionId}:${c.modelId}`.toLowerCase();
      insertStmt.run(
        id,
        c.connectionId.toLowerCase(),
        c.modelId.toLowerCase(),
        c.contextWindow,
        c.maxOutputTokens,
        c.supportsTools,
        c.supportsVision,
        c.supportsReasoning,
        c.capabilityStatus,
        JSON.stringify({}),
        now,
        now
      );
    }
  }

  get(connectionId, modelId) {
    if (!connectionId || !modelId) return null;
    const cleanConn = String(connectionId).toLowerCase();
    const cleanModel = String(modelId).toLowerCase();
    const id = `${cleanConn}:${cleanModel}`;

    let row = this.db.prepare(`
      SELECT * FROM model_capabilities WHERE id = ?
    `).get(id);

    if (!row) {
      // Fallback: search by modelId across any connection
      row = this.db.prepare(`
        SELECT * FROM model_capabilities WHERE model_id = ? LIMIT 1
      `).get(cleanModel);
    }

    if (!row) {
      return {
        connectionId: cleanConn,
        modelId: cleanModel,
        contextWindow: 128000, // safe default
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        capabilityStatus: 'unknown',
        verifiedAt: null,
      };
    }

    return {
      id: row.id,
      connectionId: row.connection_id,
      modelId: row.model_id,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      supportsTools: Boolean(row.supports_tools),
      supportsVision: Boolean(row.supports_vision),
      supportsReasoning: Boolean(row.supports_reasoning),
      capabilityStatus: row.capability_status,
      verifiedAt: row.verified_at,
    };
  }

  set(connectionId, modelId, capabilities = {}) {
    if (!connectionId || !modelId) throw new Error('connectionId and modelId required');
    const cleanConn = String(connectionId).toLowerCase();
    const cleanModel = String(modelId).toLowerCase();
    const id = `${cleanConn}:${cleanModel}`;
    const now = new Date().toISOString();

    const current = this.get(cleanConn, cleanModel);
    const contextWindow = capabilities.contextWindow !== undefined ? capabilities.contextWindow : current.contextWindow;
    const maxOutputTokens = capabilities.maxOutputTokens !== undefined ? capabilities.maxOutputTokens : current.maxOutputTokens;
    const supportsTools = capabilities.supportsTools !== undefined ? (capabilities.supportsTools ? 1 : 0) : (current.supportsTools ? 1 : 0);
    const supportsVision = capabilities.supportsVision !== undefined ? (capabilities.supportsVision ? 1 : 0) : (current.supportsVision ? 1 : 0);
    const supportsReasoning = capabilities.supportsReasoning !== undefined ? (capabilities.supportsReasoning ? 1 : 0) : (current.supportsReasoning ? 1 : 0);
    const capabilityStatus = capabilities.capabilityStatus || current.capabilityStatus || 'declared';
    const verifiedAt = capabilities.verifiedAt || (capabilityStatus === 'verified' ? now : current.verifiedAt);

    this.db.prepare(`
      INSERT INTO model_capabilities (
        id, connection_id, model_id, context_window, max_output_tokens,
        supports_tools, supports_vision, supports_reasoning,
        capability_status, verified_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        context_window = excluded.context_window,
        max_output_tokens = excluded.max_output_tokens,
        supports_tools = excluded.supports_tools,
        supports_vision = excluded.supports_vision,
        supports_reasoning = excluded.supports_reasoning,
        capability_status = excluded.capability_status,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `).run(
      id,
      cleanConn,
      cleanModel,
      contextWindow,
      maxOutputTokens,
      supportsTools,
      supportsVision,
      supportsReasoning,
      capabilityStatus,
      verifiedAt,
      JSON.stringify(capabilities.metadata || {}),
      now,
      now
    );

    return this.get(cleanConn, cleanModel);
  }

  listByConnection(connectionId) {
    if (!connectionId) return [];
    const cleanConn = String(connectionId).toLowerCase();
    return this.db.prepare(`
      SELECT * FROM model_capabilities
      WHERE connection_id = ?
      ORDER BY model_id ASC
    `).all(cleanConn).map(row => ({
      id: row.id,
      connectionId: row.connection_id,
      modelId: row.model_id,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      supportsTools: Boolean(row.supports_tools),
      supportsVision: Boolean(row.supports_vision),
      supportsReasoning: Boolean(row.supports_reasoning),
      capabilityStatus: row.capability_status,
      verifiedAt: row.verified_at,
    }));
  }
}

module.exports = { CapabilitiesRepository };
