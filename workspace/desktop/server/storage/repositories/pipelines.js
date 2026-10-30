const crypto = require('crypto');

class PipelinesRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  /**
   * Get pipeline for a channel.
   * If none exists or not active, returns { active: false, supported: true }.
   */
  get(channelId) {
    const stmt = this.db.prepare(`SELECT * FROM channel_pipelines WHERE channel_id = ?`);
    const row = stmt.get(channelId);
    if (!row) return { active: false, supported: true };
    return this._normalize(row);
  }

  /**
   * Create or update a pipeline for a channel.
   */
  save(channelId, { steps = [], started_by = 'human:user', max_total_retries = 3 }) {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT * FROM channel_pipelines WHERE channel_id = ?`).get(channelId);
    const id = existing ? existing.id : crypto.randomUUID();

    // Initialize step statuses: first step is 'running' (or 'pending' if no steps), others 'pending'
    const formattedSteps = steps.map((s, idx) => ({
      agent: s.agent || 'pi-agent',
      instruction: s.instruction || '',
      status: idx === 0 ? 'running' : 'pending',
      retry_count: 0,
      max_retries: s.max_retries || 2,
      last_error: null,
      deliverable: null,
    }));

    const stepsJson = JSON.stringify(formattedSteps);

    const stmt = this.db.prepare(`
      INSERT INTO channel_pipelines (
        id, channel_id, active, status, current_index, total_retries, max_total_retries,
        started_by, steps_json, created_at, updated_at
      ) VALUES (?, ?, 1, 'running', 0, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        active = 1,
        status = 'running',
        current_index = 0,
        total_retries = 0,
        max_total_retries = excluded.max_total_retries,
        started_by = excluded.started_by,
        steps_json = excluded.steps_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(id, channelId, max_total_retries, started_by, stepsJson, now, now);

    return this.get(channelId);
  }

  /**
   * Halt / pause a pipeline.
   */
  halt(channelId) {
    const existing = this.get(channelId);
    if (!existing || !existing.active) {
      const err = new Error(`No active pipeline found for channel: ${channelId}`);
      err.status = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE channel_pipelines
      SET status = 'paused', updated_at = ?
      WHERE channel_id = ?
    `);
    stmt.run(now, channelId);

    return this.get(channelId);
  }

  /**
   * Resume a paused pipeline.
   */
  resume(channelId) {
    const existing = this.get(channelId);
    if (!existing || !existing.active) {
      const err = new Error(`No active pipeline found for channel: ${channelId}`);
      err.status = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE channel_pipelines
      SET status = 'running', updated_at = ?
      WHERE channel_id = ?
    `);
    stmt.run(now, channelId);

    return this.get(channelId);
  }

  /**
   * Advance to the next step.
   * If current step was the last one, mark pipeline as completed.
   */
  advance(channelId, deliverable = null) {
    const pipeline = this.get(channelId);
    if (!pipeline || !pipeline.active) {
      throw new Error(`No active pipeline found for channel: ${channelId}`);
    }

    const steps = [...(pipeline.steps || [])];
    const currentIndex = pipeline.current_index;

    if (currentIndex < steps.length) {
      steps[currentIndex].status = 'done';
      if (deliverable) {
        steps[currentIndex].deliverable = deliverable;
      }
    }

    const nextIndex = currentIndex + 1;
    const isCompleted = nextIndex >= steps.length;
    if (!isCompleted) {
      steps[nextIndex].status = 'running';
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE channel_pipelines
      SET
        current_index = ?,
        active = ?,
        status = ?,
        steps_json = ?,
        updated_at = ?
      WHERE channel_id = ?
    `);

    stmt.run(
      nextIndex,
      isCompleted ? 0 : 1,
      isCompleted ? 'completed' : 'running',
      JSON.stringify(steps),
      now,
      channelId
    );

    return this.get(channelId);
  }

  /**
   * Fail or retry the current step.
   */
  failStep(channelId, error = '') {
    const pipeline = this.get(channelId);
    if (!pipeline || !pipeline.active) {
      throw new Error(`No active pipeline found for channel: ${channelId}`);
    }

    const steps = [...(pipeline.steps || [])];
    const currentIndex = pipeline.current_index;
    if (currentIndex >= steps.length) {
      return pipeline;
    }

    const currentStep = steps[currentIndex];
    currentStep.retry_count = (currentStep.retry_count || 0) + 1;
    currentStep.last_error = error;
    const totalRetries = (pipeline.total_retries || 0) + 1;

    let pipelineStatus = pipeline.status;
    let active = 1;

    if (currentStep.retry_count <= (currentStep.max_retries || 2) && totalRetries < (pipeline.max_total_retries || 3)) {
      currentStep.status = 'retrying';
    } else {
      currentStep.status = 'failed';
      pipelineStatus = 'failed';
      active = 0;
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE channel_pipelines
      SET
        total_retries = ?,
        active = ?,
        status = ?,
        steps_json = ?,
        updated_at = ?
      WHERE channel_id = ?
    `);

    stmt.run(
      totalRetries,
      active,
      pipelineStatus,
      JSON.stringify(steps),
      now,
      channelId
    );

    return this.get(channelId);
  }

  _normalize(row) {
    let steps = [];
    if (row.steps_json) {
      try {
        steps = JSON.parse(row.steps_json);
      } catch (_) {}
    }

    return {
      id: row.id,
      channel_id: row.channel_id,
      channelId: row.channel_id,
      active: Boolean(row.active),
      status: row.status,
      current_index: row.current_index,
      total_retries: row.total_retries,
      max_total_retries: row.max_total_retries,
      started_by: row.started_by,
      steps,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

module.exports = { PipelinesRepository };
