const crypto = require('node:crypto');

class HumanInteractionsRepository {
  constructor(manager) { this.manager = manager; }
  get db() { return this.manager.db; }
  map(row) {
    if (!row) return null;
    return { id: row.id, runId: row.run_id, attemptId: row.attempt_id, channel: row.channel,
      agentId: row.agent_id, agentName: row.agent_name, nativeRequestId: row.native_request_id,
      nativeSession: row.native_session, kind: row.kind, state: row.state,
      questions: JSON.parse(row.questions_json), answer: row.answer_json ? JSON.parse(row.answer_json) : null,
      idempotencyKey: row.idempotency_key, version: row.version, ownerPid: row.owner_pid,
      expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at, receipt: row.receipt };
  }
  get(id) { return this.map(this.db.prepare('SELECT * FROM human_interactions WHERE id=?').get(id)); }
  list({ channel = null, runId = null } = {}) {
    return this.db.prepare(`SELECT * FROM human_interactions WHERE (? IS NULL OR channel=?)
      AND (? IS NULL OR run_id=?) ORDER BY CASE WHEN state IN ('waiting','answered','sent') THEN 0 ELSE 1 END,
      created_at DESC, id DESC LIMIT 100`)
      .all(channel, channel, runId, runId).map(row => this.map(row));
  }
  create(spec) {
    const id = `interaction-${crypto.randomUUID()}`, now = Date.now();
    this.db.prepare(`INSERT INTO human_interactions
      (id,run_id,attempt_id,channel,agent_id,agent_name,native_request_id,native_session,kind,questions_json,owner_pid,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, spec.runId, spec.attemptId, spec.channel,
        spec.agentId, spec.agentName, String(spec.nativeRequestId), spec.nativeSession || null,
        spec.kind, JSON.stringify(spec.questions), process.pid, now + spec.timeoutMs, now, now);
    return this.get(id);
  }
  transition(id, from, state, { answer, idempotencyKey, version, receipt = null } = {}) {
    const res = this.db.prepare(`UPDATE human_interactions SET state=?, version=version+1,updated_at=?,receipt=?,
      answer_json=COALESCE(?,answer_json),idempotency_key=COALESCE(?,idempotency_key)
      WHERE id=? AND state=? AND (? IS NULL OR version=?)`).run(state, Date.now(), receipt,
        answer === undefined ? null : JSON.stringify(answer), idempotencyKey || null, id, from, version ?? null, version ?? null);
    return res.changes ? this.get(id) : null;
  }
}
module.exports = { HumanInteractionsRepository };
