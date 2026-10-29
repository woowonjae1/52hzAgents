const crypto = require('crypto');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const tail = value => String(value || '').slice(-64 * 1024);

// Approval promises are deliberately memory-only. Restarting never replays commands.
class RuntimeTools {
  constructor(store, broadcaster) {
    this.store = store; this.broadcaster = broadcaster; this.pending = new Map();
    store.data.runtime_tools ||= [];
    for (const row of store.data.runtime_tools) {
      if (['running', 'pending'].includes(row.status)) { row.status = 'interrupted'; row.output = tail(`${row.output}\nInterrupted by app restart; command outcome may be unknown.`); this.snapshot(row); }
    }
    store.save();
  }
  list(channel) { return this.store.data.runtime_tools.filter(row => row.channel === channel); }
  snapshot(row) {
    const event = this.store.data.events.find(event => event.metadata?.runtime_tool?.id === row.id);
    if (event) event.metadata.runtime_tool = structuredClone(row);
  }
  get(id, channel) {
    const row = this.store.data.runtime_tools.find(row => row.id === id && row.channel === channel);
    if (!row) throw fail('Tool execution not found in this session.', 404);
    return row;
  }
  publish(row, save = true) {
    row.updated_at = Date.now();
    if (save) { this.snapshot(row); this.store.save(); }
    this.broadcaster.broadcast({ type: 'workspace.runtime.tool.updated', target: `channel/${row.channel}`, payload: { ...row } });
  }
  event(channel, run, value) {
    run.tools ||= new Map();
    let row = run.tools.get(value.toolCallId);
    if (value.phase === 'start') {
      row = { id: crypto.randomUUID(), channel, run_id: run.runId, tool_call_id: value.toolCallId,
        tool: value.tool, args: value.args, status: 'running', output: '', started_at: Date.now() };
      run.tools.set(value.toolCallId, row); run.currentTool = row;
      this.store.data.runtime_tools.push(row);
      if (this.store.data.runtime_tools.length > 1000) {
        const index = this.store.data.runtime_tools.findIndex(item => !['running', 'pending'].includes(item.status));
        if (index >= 0) this.store.data.runtime_tools.splice(index, 1);
      }
      this.broadcaster.broadcast(this.store.addEvent({ type: 'workspace.message.posted', source: `52hz:${run.agent}`,
        target: `channel/${channel}`, payload: { content: value.tool, sender_name: run.agent, sender_type: 'agent' },
        metadata: { runtime_tool: structuredClone(row) } }));
    }
    if (!row) return;
    if (value.output !== undefined) { row.output = tail(value.output); row.output_truncated = value.output.length > 64 * 1024; }
    if (value.phase === 'end') {
      row.status = run.controller.signal.aborted ? 'cancelled' : ['denied','expired'].includes(row.status) ? row.status : value.isError ? 'failed' : 'completed';
      row.duration_ms = value.durationMs; row.details = value.details;
      if (Number.isFinite(value.structuredContent?.wall_time_seconds)) row.duration_ms = value.structuredContent.wall_time_seconds * 1000;
      if (value.structuredContent) row.result = { exit_code: value.structuredContent.exit_code, wall_time_seconds: value.structuredContent.wall_time_seconds };
      row.ended_at = Date.now();
    }
    // Stream output in memory; durable snapshots are written at boundaries only.
    if (value.phase !== 'update' || Date.now() - (row.last_publish || 0) > 200) {
      row.last_publish = Date.now(); this.publish(row, value.phase !== 'update');
    }
  }
  mutation(channel, run, change) {
    const row = run.currentTool;
    if (row) { row.patch = String(change.patch).slice(0, 128 * 1024); row.patch_truncated = change.patch.length > 128 * 1024; row.path = change.path; this.publish(row); }
    this.broadcaster.broadcast({ type: 'workspace.project.files.changed', target: `channel/${channel}`, payload: { path: change.path } });
  }
  approve(channel, run, request, signal) {
    const row = run.tools?.get(request.toolCallId);
    if (!row || signal.aborted || run.controller.signal.aborted) return Promise.resolve(false);
    row.approval_id = crypto.randomUUID(); row.cwd = request.cwd; row.status = 'pending';
    return new Promise(resolve => {
      let timer;
      const finish = (allowed, status) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); run.controller.signal.removeEventListener('abort', abort);
        this.pending.delete(row.approval_id); row.status = status; this.publish(row); resolve(allowed);
      };
      const abort = () => finish(false, 'cancelled');
      this.pending.set(row.approval_id, { channel, row, finish });
      signal.addEventListener('abort', abort, { once: true }); run.controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(false, 'expired'), 5 * 60_000); timer.unref?.();
      this.publish(row);
    });
  }
  decide(id, channel, granted) {
    const pending = this.pending.get(id);
    if (!pending || pending.channel !== channel || pending.row.status !== 'pending') throw fail('Approval expired or does not belong to this session.');
    if (typeof granted !== 'boolean') throw fail('Choose approve or deny.', 400);
    pending.finish(granted, granted ? 'running' : 'denied'); return pending.row;
  }
  cancel(run) {
    for (const row of run.tools?.values() || []) if (['running', 'pending'].includes(row.status)) { row.status = 'cancelled'; this.publish(row); }
  }
}
module.exports = { RuntimeTools };
