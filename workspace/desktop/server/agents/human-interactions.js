'use strict';
const error = (message, code = 'INTERACTION_CONFLICT', status = 409) => Object.assign(new Error(message), { code, status });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

class HumanInteractions {
  constructor(storage, publish = () => {}) {
    this.storage = storage;
    this.publish = publish;
    this.live = new Map();
    this.recover();
  }
  recover({ force = false } = {}) {
    if (!this.repo) return;
    // A new RPC process cannot consume requests addressed to an earlier one.
    const rows = this.repo.db.prepare(`SELECT id,run_id,owner_pid FROM human_interactions
      WHERE state IN ('waiting','answered','sent')`).all();
    for (const row of rows) {
      const run = this.storage.runs.get(row.run_id);
      if (force || !alive(row.owner_pid) || run?.phase === 'finished') this.invalidate(row.id, '原执行进程已退出或系统已恢复，请重新发起任务；不会自动重投答案。');
    }
  }
  get repo() { return this.storage?.humanInteractions; }
  isWaiting(runId) { return [...this.live.values()].some(e => e.row.runId === runId && !e.transportWritten); }
  changed(row) { if (row) this.publish({ type: 'workspace.interaction.updated', target: `channel/${row.channel}`, payload: row }); return row; }
  request(spec, { signal, onWaiting = () => {}, onResumed = () => {} } = {}) {
    if (!this.repo) return Promise.reject(error('持久化问答不可用。', 'INTERACTIONS_UNAVAILABLE', 503));
    if (signal?.aborted) return Promise.reject(error('任务已停止。', 'ABORT_ERR'));
    const row = this.repo.create({ ...spec, timeoutMs: Math.max(1, Math.min(spec.timeoutMs ?? 15 * 60 * 1000, 60 * 60 * 1000)) });
    return new Promise((resolve, reject) => {
      const entry = { row, resolve, reject, signal, onResumed, settled: false };
      entry.abort = () => this.invalidate(row.id, '任务已停止，原生请求已失效。');
      entry.timer = setTimeout(() => {
        this.changed(this.repo.transition(row.id, 'waiting', 'expired', { receipt: '问题已超时，未自动授权。' }));
        this.settle(row.id, { cancelled: true, interactionId: row.id });
      }, Math.max(1, row.expiresAt - Date.now()));
      entry.timer.unref?.();
      this.live.set(row.id, entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      onWaiting(row.kind);
      this.changed(row);
      if (signal?.aborted) entry.abort();
    });
  }
  settle(id, value, failure) {
    const entry = this.live.get(id);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    failure ? entry.reject(failure) : entry.resolve(value);
  }
  answer(id, body, action = 'answer') {
    const row = this.repo.get(id);
    if (!row) throw error('问题不存在。', 'INTERACTION_NOT_FOUND', 404);
    if (body.attemptId !== row.attemptId) throw error('执行尝试已变化，请刷新后重试。', 'STALE_INTERACTION_ATTEMPT');
    if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey || body.idempotencyKey.length > 128) throw error('缺少有效的幂等标识。', 'INVALID_ANSWER', 400);
    let value = {};
    if (action === 'cancel') value = { cancelled: true };
    else if (row.kind === 'approval') {
      if (action !== 'decision' || typeof body.confirmed !== 'boolean') throw error('权限确认必须通过独立授权入口。', 'INVALID_APPROVAL', 400);
      value = { confirmed: body.confirmed };
    } else {
      if (action !== 'answer') throw error('普通问题不能作为权限授权。', 'INVALID_ANSWER', 400);
      const answers = body.answers;
      if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== row.questions.length) throw error('请回答所有问题。', 'INVALID_ANSWER', 400);
      value = { answers: {} };
      for (const q of row.questions) {
        const answer = answers[q.id];
        if (!Array.isArray(answer) || answer.length !== 1 || typeof answer[0] !== 'string' || !answer[0].trim() || answer[0].length > 20000
          || (!q.allowFreeInput && !q.options?.some(o => o.label === answer[0]))) throw error('答案无效或不在允许的选项中。', 'INVALID_ANSWER', 400);
        Object.defineProperty(value.answers, q.id, { value: [answer[0]], enumerable: true });
      }
    }
    if (row.idempotencyKey === body.idempotencyKey && JSON.stringify(row.answer) === JSON.stringify(value)) return row;
    const live = this.live.get(id);
    if (row.state !== 'waiting' || !live || live.settled || live.signal?.aborted) throw error('原生请求已结束或失效，请勿重复投递。');
    if (Date.now() >= row.expiresAt) {
      this.changed(this.repo.transition(id, 'waiting', 'expired'));
      this.settle(id, { cancelled: true, interactionId: id });
      throw error('问题已过期。', 'INTERACTION_EXPIRED');
    }
    if (!Number.isInteger(body.expectedVersion)) throw error('缺少问题版本。', 'INVALID_ANSWER', 400);
    const updated = this.repo.transition(id, 'waiting', 'answered', { version: body.expectedVersion, answer: value, idempotencyKey: body.idempotencyKey });
    if (!updated) throw error('问题状态已变化，请刷新后重试。');
    this.changed(updated);
    this.settle(id, { ...value, interactionId: id });
    return updated;
  }
  sent(id) {
    const row = this.repo.get(id);
    if (!row) return;
    this.changed(this.repo.transition(id, 'answered', row.answer?.cancelled ? 'cancelled' : 'sent',
      { receipt: '答案已写入原生进程通道；协议未提供逐条消费确认。' }));
    const entry = this.live.get(id);
    if (entry && !entry.transportWritten) {
      entry.transportWritten = true;
      if (!this.isWaiting(entry.row.runId)) entry.onResumed();
      if (row.answer?.cancelled) this.live.delete(id);
    }
  }
  progress(runId) {
    for (const [id, entry] of this.live) if (entry.row.runId === runId) {
      const updated = this.repo.transition(id, 'sent', 'continued', { receipt: '发送答案后已收到原任务继续运行的事件。' });
      if (updated) { this.changed(updated); this.live.delete(id); }
    }
  }
  invalidate(id, reason) {
    const row = this.repo.get(id);
    if (!row) return;
    if (['waiting','answered','sent'].includes(row.state)) this.changed(this.repo.transition(id, row.state,
      row.state === 'waiting' ? 'invalidated' : 'delivery_unknown', { receipt: reason }));
    this.settle(id, null, error(reason, 'INTERACTION_INVALIDATED'));
    this.live.delete(id);
  }
  finish(runId) {
    for (const [id, entry] of this.live) if (entry.row.runId === runId) this.invalidate(id, '原任务已结束；不会自动向新进程重投答案或授权。');
  }
  close() { for (const id of [...this.live.keys()]) this.invalidate(id, '服务已停止，原生请求已失效。'); }
}
module.exports = { HumanInteractions };
