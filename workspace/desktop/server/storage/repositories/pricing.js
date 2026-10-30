const crypto = require('crypto');

/**
 * Model Pricing Catalog (Package G2).
 * Stores provider pricing, custom price overrides, and calculates request costs.
 * Crucial rule: If price is unknown, cost MUST be null/unknown, never fabricated as zero.
 */

const PRESET_PRICES = [
  // OpenAI
  { provider: 'openai', modelId: 'gpt-4o', input: 2.50, output: 10.00, cacheRead: 1.25, currency: 'USD' },
  { provider: 'openai', modelId: 'gpt-4o-mini', input: 0.15, output: 0.60, cacheRead: 0.075, currency: 'USD' },
  { provider: 'openai', modelId: 'o1', input: 15.00, output: 60.00, cacheRead: 7.50, currency: 'USD' },
  { provider: 'openai', modelId: 'o3-mini', input: 1.10, output: 4.40, cacheRead: 0.55, currency: 'USD' },

  // Anthropic
  { provider: 'anthropic', modelId: 'claude-3-5-sonnet', input: 3.00, output: 15.00, cacheRead: 0.30, currency: 'USD' },
  { provider: 'anthropic', modelId: 'claude-3-5-haiku', input: 0.80, output: 4.00, cacheRead: 0.08, currency: 'USD' },
  { provider: 'anthropic', modelId: 'claude-3-opus', input: 15.00, output: 75.00, cacheRead: 1.50, currency: 'USD' },

  // DeepSeek
  { provider: 'deepseek', modelId: 'deepseek-chat', input: 0.14, output: 0.28, cacheRead: 0.014, currency: 'USD' },
  { provider: 'deepseek', modelId: 'deepseek-reasoner', input: 0.55, output: 2.19, cacheRead: 0.14, currency: 'USD' },

  // Google Gemini
  { provider: 'gemini', modelId: 'gemini-2.0-flash', input: 0.10, output: 0.40, cacheRead: 0.025, currency: 'USD' },
  { provider: 'gemini', modelId: 'gemini-1.5-pro', input: 1.25, output: 5.00, cacheRead: 0.30, currency: 'USD' },
  { provider: 'gemini', modelId: 'gemini-1.5-flash', input: 0.075, output: 0.30, cacheRead: 0.01875, currency: 'USD' },

  // Ollama / Local (Explicit zero-cost)
  { provider: 'ollama', modelId: '*', input: 0.00, output: 0.00, cacheRead: 0.00, currency: 'USD' },
];

class PricingRepository {
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
      INSERT OR IGNORE INTO model_pricing (
        id, provider, model_id, input_cost_per_million, output_cost_per_million,
        cache_read_cost_per_million, currency, source, effective_from, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of PRESET_PRICES) {
      const id = `preset:${p.provider}:${p.modelId}`;
      insertStmt.run(
        id,
        p.provider.toLowerCase(),
        p.modelId.toLowerCase(),
        p.input,
        p.output,
        p.cacheRead || 0,
        p.currency,
        'preset',
        '2026-01-01T00:00:00Z',
        now,
        now
      );
    }
  }

  get(provider, modelId) {
    if (!provider || !modelId) return null;
    const cleanProvider = String(provider).toLowerCase();
    const cleanModel = String(modelId).toLowerCase();

    // 1. Check exact match
    let row = this.db.prepare(`
      SELECT * FROM model_pricing
      WHERE provider = ? AND model_id = ?
      ORDER BY source = 'user_custom' DESC, effective_from DESC
      LIMIT 1
    `).get(cleanProvider, cleanModel);

    // 2. Check prefix wildcard (e.g. gpt-4o matches gpt-4o-2024-08-06)
    if (!row) {
      const candidates = this.db.prepare(`
        SELECT * FROM model_pricing
        WHERE provider = ?
        ORDER BY LENGTH(model_id) DESC
      `).all(cleanProvider);

      for (const cand of candidates) {
        if (cand.model_id === '*' || cleanModel.startsWith(cand.model_id)) {
          row = cand;
          break;
        }
      }
    }

    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      modelId: row.model_id,
      inputCostPerMillion: row.input_cost_per_million,
      outputCostPerMillion: row.output_cost_per_million,
      cacheReadCostPerMillion: row.cache_read_cost_per_million,
      currency: row.currency,
      source: row.source,
      effectiveFrom: row.effective_from,
    };
  }

  calculateCost({
    provider,
    modelId,
    promptTokens = 0,
    completionTokens = 0,
    cacheReadTokens = 0,
  }) {
    const rule = this.get(provider, modelId);
    if (!rule) {
      return {
        estimatedCost: null,
        isCostKnown: false,
        currency: null,
        pricingVersion: null,
      };
    }

    const uncachedPromptTokens = Math.max(0, (promptTokens || 0) - (cacheReadTokens || 0));
    const inputCost = (uncachedPromptTokens * rule.inputCostPerMillion) / 1_000_000;
    const outputCost = ((completionTokens || 0) * rule.outputCostPerMillion) / 1_000_000;
    const cacheCost = ((cacheReadTokens || 0) * rule.cacheReadCostPerMillion) / 1_000_000;
    const total = inputCost + outputCost + cacheCost;

    return {
      estimatedCost: Number(total.toFixed(6)),
      isCostKnown: true,
      currency: rule.currency,
      pricingVersion: rule.id,
    };
  }

  setCustomPrice({
    provider,
    modelId,
    inputCostPerMillion,
    outputCostPerMillion,
    cacheReadCostPerMillion = 0,
    currency = 'USD',
  }) {
    if (!provider || !modelId) throw new Error('Provider and modelId required');
    const cleanProvider = String(provider).toLowerCase();
    const cleanModel = String(modelId).toLowerCase();
    const id = `custom:${cleanProvider}:${cleanModel}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO model_pricing (
        id, provider, model_id, input_cost_per_million, output_cost_per_million,
        cache_read_cost_per_million, currency, source, effective_from, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user_custom', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        input_cost_per_million = excluded.input_cost_per_million,
        output_cost_per_million = excluded.output_cost_per_million,
        cache_read_cost_per_million = excluded.cache_read_cost_per_million,
        currency = excluded.currency,
        updated_at = excluded.updated_at
    `).run(
      id,
      cleanProvider,
      cleanModel,
      inputCostPerMillion,
      outputCostPerMillion,
      cacheReadCostPerMillion,
      currency.toUpperCase(),
      now,
      now,
      now
    );

    return this.get(cleanProvider, cleanModel);
  }

  list({ provider = null } = {}) {
    let sql = `SELECT * FROM model_pricing`;
    const params = [];
    if (provider) {
      sql += ` WHERE provider = ?`;
      params.push(String(provider).toLowerCase());
    }
    sql += ` ORDER BY provider ASC, model_id ASC`;

    return this.db.prepare(sql).all(...params).map(row => ({
      id: row.id,
      provider: row.provider,
      modelId: row.model_id,
      inputCostPerMillion: row.input_cost_per_million,
      outputCostPerMillion: row.output_cost_per_million,
      cacheReadCostPerMillion: row.cache_read_cost_per_million,
      currency: row.currency,
      source: row.source,
      effectiveFrom: row.effective_from,
    }));
  }
}

module.exports = { PricingRepository };
