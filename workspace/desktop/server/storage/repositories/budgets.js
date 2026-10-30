/**
 * Budget Control Repository (Package G3).
 * Enforces per-run tokens, steps, time limits, and per-session cost thresholds.
 */

class BudgetsRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
    this._ensureGlobalBudget();
  }

  _ensureGlobalBudget() {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO budget_limits (
        id, target_type, target_id, max_tokens_per_run, max_steps_per_run,
        max_duration_seconds, max_cost_per_session, max_cost_per_day,
        currency, action_on_exceed, created_at, updated_at
      ) VALUES ('global', 'global', 'global', 128000, 30, 600, 10.0, 50.0, 'USD', 'block', ?, ?)
    `).run(now, now);
  }

  get(targetType = 'global', targetId = 'global') {
    const row = this.db.prepare(`
      SELECT * FROM budget_limits
      WHERE target_type = ? AND target_id = ?
    `).get(targetType, targetId);

    if (!row) {
      if (targetType !== 'global') {
        return this.get('global', 'global');
      }
      return null;
    }

    return {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      maxTokensPerRun: row.max_tokens_per_run,
      maxStepsPerRun: row.max_steps_per_run,
      maxDurationSeconds: row.max_duration_seconds,
      maxCostPerSession: row.max_cost_per_session,
      maxCostPerDay: row.max_cost_per_day,
      currency: row.currency,
      actionOnExceed: row.action_on_exceed,
    };
  }

  getForSession(sessionId) {
    const sessionBudget = this.get('session', sessionId);
    if (sessionBudget && sessionBudget.targetType === 'session') {
      return sessionBudget;
    }
    return this.get('global', 'global');
  }

  setForSession(sessionId, {
    maxTokensPerRun = null,
    maxStepsPerRun = 30,
    maxDurationSeconds = 600,
    maxCostPerSession = null,
    currency = 'USD',
    actionOnExceed = 'block',
  } = {}) {
    const id = `session:${sessionId}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO budget_limits (
        id, target_type, target_id, max_tokens_per_run, max_steps_per_run,
        max_duration_seconds, max_cost_per_session, currency, action_on_exceed,
        created_at, updated_at
      ) VALUES (?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_type, target_id) DO UPDATE SET
        max_tokens_per_run = excluded.max_tokens_per_run,
        max_steps_per_run = excluded.max_steps_per_run,
        max_duration_seconds = excluded.max_duration_seconds,
        max_cost_per_session = excluded.max_cost_per_session,
        currency = excluded.currency,
        action_on_exceed = excluded.action_on_exceed,
        updated_at = excluded.updated_at
    `).run(
      id,
      sessionId,
      maxTokensPerRun,
      maxStepsPerRun,
      maxDurationSeconds,
      maxCostPerSession,
      currency,
      actionOnExceed,
      now,
      now
    );

    return this.getForSession(sessionId);
  }

  checkPreflight({
    sessionId,
    runId = null,
    currentStepCount = 0,
    elapsedMs = 0,
    runTokens = 0,
    sessionCost = 0,
    concurrentReservedCost = 0,
    reservedCost = 0,
    reservedTokens = 0,
  }) {
    const budget = this.getForSession(sessionId);
    if (!budget) return { allowed: true };

    // 1. Step count check
    if (budget.maxStepsPerRun && currentStepCount >= budget.maxStepsPerRun) {
      return {
        allowed: false,
        reason: 'step_limit_exceeded',
        message: `Run step limit exceeded (${currentStepCount} >= ${budget.maxStepsPerRun})`,
        limit: budget.maxStepsPerRun,
        current: currentStepCount,
      };
    }

    // 2. Duration check
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    if (budget.maxDurationSeconds && elapsedSeconds >= budget.maxDurationSeconds) {
      return {
        allowed: false,
        reason: 'duration_exceeded',
        message: `Run time limit exceeded (${elapsedSeconds}s >= ${budget.maxDurationSeconds}s)`,
        limit: budget.maxDurationSeconds,
        current: elapsedSeconds,
      };
    }

    // 3. Token budget check (including pre-request token reservation)
    const effectiveTokens = runTokens + reservedTokens;
    if (budget.maxTokensPerRun && effectiveTokens >= budget.maxTokensPerRun) {
      return {
        allowed: false,
        reason: 'token_limit_exceeded',
        message: `Token limit exceeded (${effectiveTokens} >= ${budget.maxTokensPerRun})`,
        limit: budget.maxTokensPerRun,
        current: effectiveTokens,
      };
    }

    // 4. Session cost budget check (including pre-request cost reservation)
    const effectiveSessionCost = sessionCost + reservedCost;
    if (budget.maxCostPerSession && effectiveSessionCost >= budget.maxCostPerSession) {
      return {
        allowed: false,
        reason: 'cost_limit_exceeded',
        message: `Session cost budget reached ($${effectiveSessionCost.toFixed(2)} >= $${budget.maxCostPerSession.toFixed(2)})`,
        limit: budget.maxCostPerSession,
        current: effectiveSessionCost,
      };
    }

    // 5. Daily cost budget check (including in-flight concurrent reservations)
    if (budget.maxCostPerDay) {
      const today = new Date().toISOString().slice(0, 10);
      let pastDailyCost = 0;
      try {
        const row = this.db.prepare(`
          SELECT COALESCE(SUM(estimated_cost), 0) as daily_cost
          FROM usage_records
          WHERE DATE(created_at) = DATE(?)
        `).get(today);
        pastDailyCost = row?.daily_cost || 0;
      } catch (_) {}

      let persistedSessionCost = 0;
      try {
        const row = this.db.prepare(`
          SELECT COALESCE(SUM(estimated_cost), 0) as s_cost
          FROM usage_records
          WHERE session_id = ? AND DATE(created_at) = DATE(?)
        `).get(sessionId, today);
        persistedSessionCost = row?.s_cost || 0;
      } catch (_) {}

      const totalDailyCost = (pastDailyCost - persistedSessionCost) + sessionCost + reservedCost + concurrentReservedCost;
      if (totalDailyCost >= budget.maxCostPerDay) {
        return {
          allowed: false,
          reason: 'daily_cost_limit_exceeded',
          message: `Daily cost budget reached ($${totalDailyCost.toFixed(2)} >= $${budget.maxCostPerDay.toFixed(2)})`,
          limit: budget.maxCostPerDay,
          current: totalDailyCost,
        };
      }
    }

    return { allowed: true };
  }
}

module.exports = { BudgetsRepository };
