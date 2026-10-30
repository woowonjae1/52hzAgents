const crypto = require('crypto');

class UsageRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  recordModelRequest({
    id,
    runId,
    sessionId,
    provider,
    modelId,
    purpose = 'generate',
    promptTokens = null,
    completionTokens = null,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    totalTokens = null,
    latencyMs = null,
    estimatedCost = null,
    currency = 'USD',
    pricingVersion = null,
    rawUsageJson = null,
    status = 'completed',
    createdAt = new Date().toISOString(),
  }) {
    const requestId = id || `req_${crypto.randomUUID()}`;
    const calculatedTotal = totalTokens !== null ? totalTokens : (
      (promptTokens || 0) + (completionTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
    );

    this.db.prepare(`
      INSERT INTO model_requests (
        id, run_id, session_id, provider, model_id, purpose,
        prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, latency_ms, estimated_cost, currency, pricing_version, raw_usage_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      runId || null,
      sessionId,
      provider,
      modelId,
      purpose,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      calculatedTotal,
      latencyMs,
      estimatedCost,
      currency,
      pricingVersion,
      typeof rawUsageJson === 'object' && rawUsageJson !== null ? JSON.stringify(rawUsageJson) : rawUsageJson,
      status,
      createdAt
    );

    return this.getModelRequest(requestId);
  }

  getModelRequest(id) {
    const row = this.db.prepare(`
      SELECT * FROM model_requests WHERE id = ?
    `).get(id);

    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      provider: row.provider,
      modelId: row.model_id,
      purpose: row.purpose,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      latencyMs: row.latency_ms,
      estimatedCost: row.estimated_cost,
      currency: row.currency,
      pricingVersion: row.pricing_version,
      rawUsage: row.raw_usage_json ? JSON.parse(row.raw_usage_json) : null,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  listModelRequestsByRun(runId) {
    return this.db.prepare(`
      SELECT * FROM model_requests
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all(runId).map(row => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      provider: row.provider,
      modelId: row.model_id,
      purpose: row.purpose,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
      latencyMs: row.latency_ms,
      estimatedCost: row.estimated_cost,
      currency: row.currency,
      pricingVersion: row.pricing_version,
      rawUsage: row.raw_usage_json ? JSON.parse(row.raw_usage_json) : null,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  recordUsage({
    id,
    sessionId,
    runId = null,
    model,
    promptTokens = 0,
    completionTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    totalTokens = null,
    estimatedCost = null,
    currency = 'USD',
    createdAt = new Date().toISOString(),
  }) {
    const usageId = id || `usg_${crypto.randomUUID()}`;
    const calculatedTotal = totalTokens !== null ? totalTokens : (
      (promptTokens || 0) + (completionTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
    );

    this.db.prepare(`
      INSERT INTO usage_records (
        id, session_id, run_id, model,
        prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, estimated_cost, currency, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usageId,
      sessionId,
      runId,
      model,
      promptTokens || 0,
      completionTokens || 0,
      cacheReadTokens || 0,
      cacheWriteTokens || 0,
      calculatedTotal,
      estimatedCost,
      currency,
      createdAt
    );

    return usageId;
  }

  getSummaryForSession(sessionId) {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(total_tokens), 0) AS grand_total_tokens,
        COALESCE(SUM(estimated_cost), 0) AS total_estimated_cost,
        COUNT(CASE WHEN estimated_cost IS NULL AND total_tokens > 0 THEN 1 END) AS unknown_cost_count,
        COUNT(*) AS record_count
      FROM usage_records
      WHERE session_id = ?
    `);
    const row = stmt.get(sessionId);

    const modelBreakdown = this.db.prepare(`
      SELECT
        model,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(total_tokens) AS total_tokens,
        SUM(estimated_cost) AS estimated_cost,
        COUNT(CASE WHEN estimated_cost IS NULL AND total_tokens > 0 THEN 1 END) AS unknown_cost_count,
        COUNT(*) AS call_count
      FROM usage_records
      WHERE session_id = ?
      GROUP BY model
    `).all(sessionId);

    const hasUnknownCost = Number(row.unknown_cost_count) > 0;

    return {
      sessionId,
      promptTokens: Number(row.total_prompt_tokens),
      completionTokens: Number(row.total_completion_tokens),
      cacheReadTokens: Number(row.total_cache_read_tokens),
      cacheWriteTokens: Number(row.total_cache_write_tokens),
      totalTokens: Number(row.grand_total_tokens),
      estimatedCost: hasUnknownCost ? null : Number(Number(row.total_estimated_cost).toFixed(4)),
      hasUnknownCost,
      recordCount: Number(row.record_count),
      byModel: modelBreakdown.map(m => ({
        model: m.model,
        promptTokens: Number(m.prompt_tokens),
        completionTokens: Number(m.completion_tokens),
        cacheReadTokens: Number(m.cache_read_tokens),
        cacheWriteTokens: Number(m.cache_write_tokens),
        totalTokens: Number(m.total_tokens),
        estimatedCost: Number(m.unknown_cost_count) > 0 ? null : Number(Number(m.estimated_cost).toFixed(4)),
        hasUnknownCost: Number(m.unknown_cost_count) > 0,
        callCount: Number(m.call_count),
      })),
    };
  }
}

module.exports = { UsageRepository };
