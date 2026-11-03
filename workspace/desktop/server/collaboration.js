const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { restrictMode } = require('./agent-policy');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const canonical = value => {
  const resolved = fs.realpathSync.native(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Owns dispatch provenance, Agent binding, Git delivery and review transitions. */
class Collaboration {
  constructor(store, runner, broadcaster) {
    this.store = store; this.runner = runner; this.broadcaster = broadcaster;
    this.root = path.resolve(store.userDataPath, 'collaboration-worktrees');
    fs.mkdirSync(this.root, { recursive: true });
    this.recover();
  }
  get db() { return this.store.storage.db; }
  get repository() { return this.store.storage.orchestration; }
  actor(reference) {
    if (typeof reference !== 'string' || !reference) throw fail('Choose a saved Agent ID for each task.', 400);
    const profile = this.repository.getProfile(reference);
    const agent = this.store.storage.agentDefinitions.requireActive(profile ? profile.agent : reference);
    if (agent.runtimeKind === 'pi' && !agent.modelResource) throw fail(`Configure a model resource for Agent ${agent.name} before collaboration.`, 400);
    this.runner.validateDefinitionResource(agent);
    const result = structuredClone(agent);
    if (profile) {
      result.defaultMode = restrictMode(profile.mode === 'plan' ? 'plan' : 'agent', result.maxMode);
      result.instructions += `\n\nWork profile: ${profile.name}. ${profile.description || ''}`;
      // Profiles may narrow tools/budgets, but never create another Agent identity.
      result.profileTools = profile.allowed_tools?.length ? profile.allowed_tools : null;
      result.profileId = profile.id;
      if (profile.model && profile.model !== result.modelResource?.modelId) throw fail('Update the Agent model resource instead of overriding it through a legacy profile.', 400);
      for (const [key, value] of [['maxTokensPerRun', profile.budget_tokens], ['maxCostPerRun', profile.budget_cost_micros / 1e6]]) {
        if (value > 0) result.limits[key] = Math.min(result.limits[key] || Infinity, value);
      }
    }
    // Nested delegation would otherwise bypass a bounded collaboration batch.
    result.permissions.delegate = false;
    return result;
  }
  actorConfig(agent) {
    return this.runner.validateConfig({ provider: agent.modelResource?.connectionId, model: agent.modelResource?.modelId, mode: agent.defaultMode, autoCompact: true }, agent);
  }
  git(root, args) { return this.repository._execGitSync(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args]); }
  assertIdle(root) {
    const target = canonical(root), overlaps = other => other && (other === target || other.startsWith(target + path.sep) || target.startsWith(other + path.sep));
    if ([...this.runner.restoring].some(overlaps) || [...this.runner.active.values()].some(run => run.snapshot.workingDir && overlaps(canonical(run.snapshot.workingDir)))) {
      throw fail('This worktree is executing or restoring. Wait before changing its delivery.');
    }
  }
  owned(root, repo) {
    if (!root || !fs.existsSync(root)) throw fail('Isolated worktree is missing; execution is blocked.');
    const actual = canonical(root), managed = canonical(this.root);
    if (!actual.startsWith(managed + path.sep) || actual === canonical(repo)) throw fail('Worktree is outside the application-managed directory.');
    if (canonical(this.git(root, ['rev-parse', '--show-toplevel']).trim()) !== actual) throw fail('Invalid isolated worktree root.');
    const common = cwd => canonical(path.resolve(cwd, this.git(cwd, ['rev-parse', '--git-common-dir']).trim()));
    if (common(root) !== common(repo)) throw fail('Worktree belongs to a different repository.');
    return actual;
  }
  batch(id) {
    const row = this.db.prepare('SELECT * FROM parallel_batches WHERE id = ?').get(id);
    if (!row || row.runtime_version !== 1) throw fail('Legacy batch is read-only. Create a new batch with saved Agent IDs.');
    return row;
  }
  lane(batchId, reference) {
    this.batch(batchId);
    const byId = this.db.prepare('SELECT * FROM parallel_lanes WHERE batch_id = ? AND id = ?').get(batchId, reference);
    if (byId) return byId;
    const rows = this.db.prepare('SELECT * FROM parallel_lanes WHERE batch_id = ? AND agent = ?').all(batchId, reference);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw fail('Multiple lanes match this agent name. Use the specific lane ID.', 400);
    throw fail('Lane not found.', 404);
  }
  view(batchId) {
    const batch = this.batch(batchId);
    const view = this.repository.getParallelBatch(batch.channel_name, batch.workspace_id, batchId);
    view.run.lanes = view.run.lanes.map(lane => {
      const row = this.db.prepare('SELECT * FROM parallel_lanes WHERE id = ?').get(lane.id);
      const actor = JSON.parse(row.agent_snapshot_json);
      return { ...lane, agent_id: row.agent_id, agent_name: actor.name, agent_revision: actor.revision,
        run_id: row.run_id, context_key: row.context_key, used_tokens: row.used_tokens,
        delivery: row.delivery_json ? JSON.parse(row.delivery_json) : null };
    });
    view.workers = view.workers.map((worker, index) => ({ ...worker, agent_id: view.run.lanes[index].agent_id, display_name: view.run.lanes[index].agent_name }));
    return view;
  }
  publish(batchId) {
    const view = this.view(batchId);
    this.broadcaster.broadcast({ type: 'workspace.parallel.updated', target: `channel/${view.run.batch.channel_name}`, payload: view });
    return view;
  }
  start(channel, input = {}, parentRun = null) {
    if ((this.runner.isRecoveryBlocked?.() || this.runner.isRecoveryLocked?.())) throw fail('System recovery is in progress; collaboration cannot be started.', 409);
    if (!this.store.getChannel(channel)) throw fail('Session not found.', 404);
    if (parentRun?.snapshot.collaboration) throw fail('Nested collaboration is disabled.');
    const workers = input.workers || [];
    if (!Array.isArray(workers) || workers.length < 1 || workers.length > 4) throw fail('Choose 1–4 worker tasks.', 400);
    if (input.isolation && input.isolation !== 'worktree') throw fail('Parallel execution requires isolated Git worktrees.', 400);
    const prepared = workers.map((worker, index) => {
      if (typeof worker.task !== 'string' || !worker.task.trim() || worker.task.length > 16000) throw fail('Each worker needs a task of at most 16000 characters.', 400);
      if (worker.scope !== undefined && (typeof worker.scope !== 'string' || worker.scope.length > 500)) throw fail('Invalid worker scope.', 400);
      const actor = this.actor(worker.agent_id || worker.profile || worker.agent || worker.assignee);
      const config = this.actorConfig(actor);
      this.runner.validateNativeExecution?.(actor, config, { channel, execution: { kind: 'lane' } });
      return { actor, config, task: worker.task, alias: `worker-${index + 1}`, scope: worker.scope || '' };
    });
    const reviewReference = input.review_agent !== undefined ? input.review_agent : this.store.getChannel(channel).review_agent;
    const reviewer = reviewReference ? this.actor(reviewReference) : null;
    if (reviewer) this.runner.validateNativeExecution?.(reviewer, this.actorConfig(reviewer), { channel, execution: { kind: 'review' } });
    const project = this.store.getChannel(channel).working_dir;
    if (!project || !fs.existsSync(project)) throw fail('Choose a Git project before starting collaboration.', 400);
    const repo = this.git(project, ['rev-parse', '--show-toplevel']).trim();
    if (canonical(repo) !== canonical(project)) throw fail('Choose the Git repository root as the project folder.', 400);
    const base = this.git(repo, ['rev-parse', 'HEAD']).trim();
    const branch = this.git(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
    const tokenLimit = input.total_budget_tokens ?? 128000;
    if (!Number.isInteger(tokenLimit) || tokenLimit < 1 || tokenLimit > 1000000) throw fail('Invalid collaboration Token limit.', 400);
    if (this.db.prepare("SELECT 1 FROM parallel_batches WHERE channel_name = ? AND runtime_version = 1 AND status IN ('running','review','blocked')").get(channel)) throw fail('Finish or discard the current collaboration batch first.');
    const group = crypto.randomUUID();
    const result = this.repository.createBatch({ channel_name: channel, workspace_id: '52hz', origin: parentRun ? 'agent' : 'board', isolation: 'worktree', repo_dir: repo,
      base_branch: base, review_agent: reviewer?.id || '', parent_run_id: parentRun?.runId || null, total_budget_tokens: tokenLimit,
      workers: prepared.map((worker, index) => ({ agent: worker.alias, task: worker.task, scope: worker.scope,
        branch: `52hz/collaboration/${group}/${index + 1}`, worktree_path: path.join(this.root, group, `worker-${index + 1}`) })),
    });
    const id = result.run.batch.id;
    this.store.storage.transaction(db => {
      db.prepare('UPDATE parallel_batches SET runtime_version = 1, base_commit = ?, base_branch = ?, review_snapshot_json = ? WHERE id = ?')
        .run(base, branch, reviewer ? JSON.stringify(reviewer) : null, id);
      result.run.lanes.forEach((lane, index) => db.prepare('UPDATE parallel_lanes SET agent_id = ?, agent_snapshot_json = ? WHERE id = ?')
        .run(prepared[index].actor.id, JSON.stringify(prepared[index].actor), lane.id));
    });
    this.publish(id); this.dispatch(id); return this.view(id);
  }
  dispatch(batchId) {
    const batch = this.batch(batchId);
    if (!['running', 'blocked'].includes(batch.status)) return;
    for (const lane of this.db.prepare("SELECT * FROM parallel_lanes WHERE batch_id = ? AND status = 'running' AND run_id IS NULL AND dispatch_event_id IS NULL").all(batchId)) {
      const id = `collaboration-${crypto.randomUUID()}`;
      const contextKey = `${batchId}:${lane.id}:attempt:${lane.attempts}`;
      this.db.prepare('UPDATE parallel_lanes SET dispatch_event_id = ?, context_key = ? WHERE id = ? AND dispatch_event_id IS NULL').run(id, contextKey, lane.id);
      const actor = JSON.parse(lane.agent_snapshot_json);
      const saved = this.store.addEvent({ id, type: 'workspace.message.posted', source: `orchestration:lane:${lane.id}`, target: `channel/${batch.channel_name}`,
        payload: { content: `${lane.task}${lane.review_notes ? `\n\nPrevious review feedback:\n${lane.review_notes}` : ''}`, sender_name: actor.name, sender_type: 'agent' },
        metadata: { batch_id: batchId, lane_id: lane.id, agent: lane.agent, worktree_path: lane.worktree_path } });
      this.broadcaster.broadcast(saved);
      queueMicrotask(() => this.runner.handleUserMessage(saved).catch(error => this.failDispatch(batchId, lane.id, error)));
    }
  }
  resolve(event, channel) {
    if (event.metadata?.pipeline_id) return this.resolvePipeline(event, channel);
    const laneId = event.metadata?.lane_id;
    const lane = laneId && this.db.prepare('SELECT * FROM parallel_lanes WHERE id = ?').get(laneId);
    if (!lane) throw fail('Unbound collaboration task; no Agent execution is allowed.');
    const batch = this.batch(lane.batch_id);
    const review = lane.review_event_id === event.id;
    if (batch.channel_name !== channel || (lane.dispatch_event_id !== event.id && !review)) throw fail('Collaboration dispatch provenance does not match.');
    if (review ? lane.review_status !== 'running' || lane.review_run_id : lane.status !== 'running' || lane.claim_token) return null;
    this.owned(lane.worktree_path, batch.repo_dir);
    const actor = JSON.parse(review ? lane.review_snapshot_json : lane.agent_snapshot_json);
    this.store.storage.agentDefinitions.requireActive(actor.id);
    if (review) { actor.maxMode = restrictMode('plan', actor.maxMode); actor.defaultMode = actor.maxMode; Object.assign(actor.permissions, { writeFiles: false, executeCommands: false, delegate: false, mcp: false }); }
    return { kind: review ? 'review' : 'lane', batchId: batch.id, laneId: lane.id,
      actor, config: this.actorConfig(actor), projectDir: lane.worktree_path,
      contextKey: review ? `${lane.context_key}:review:${event.id}` : lane.context_key,
      executionKey: `${channel}:lane:${lane.id}${review ? ':review' : ''}`, reviewedCommit: review ? lane.commit_hash : null };
  }
  begin(context, runId) {
    if (context.kind === 'pipeline') {
      return this.store.storage.transaction(() => {
        const pipeline = this.store.storage.pipelines.get(context.channel), step = pipeline.steps[pipeline.current_index];
        if (!pipeline.active || step.dispatch_event_id !== context.eventId || step.run_id) return false;
        step.run_id = runId;
        this.db.prepare('UPDATE channel_pipelines SET steps_json = ? WHERE id = ?').run(JSON.stringify(pipeline.steps), pipeline.id);
        return true;
      });
    }
    const field = context.kind === 'review' ? 'review_run_id' : 'claim_token';
    return this.db.prepare(`UPDATE parallel_lanes SET ${field} = ? WHERE id = ? AND ${field} IS NULL`).run(runId, context.laneId).changes === 1;
  }
  attach(context, runId) {
    if (context.kind === 'lane') this.db.prepare('UPDATE parallel_lanes SET run_id = ? WHERE id = ? AND claim_token = ?').run(runId, context.laneId, runId);
  }
  reserve(context, run, tokens) {
    return this.store.storage.transaction(db => {
      const batch = this.batch(context.batchId);
      if (['done', 'failed', 'cancelled'].includes(batch.status)) return { allowed: false, message: 'Collaboration was stopped.' };
      // Review uses the same batch budget; writer and reviewer are never concurrent for one lane.
      const lane = db.prepare('SELECT * FROM parallel_lanes WHERE id = ?').get(context.laneId);
      const total = db.prepare('SELECT SUM(used_tokens + attempt_tokens + reserved_tokens) AS tokens FROM parallel_lanes WHERE batch_id = ?').get(context.batchId).tokens || 0;
      const proposed = total - lane.attempt_tokens - lane.reserved_tokens + (run.usage?.total_tokens || 0) + tokens;
      if (batch.total_budget_tokens && proposed >= batch.total_budget_tokens) return { allowed: false, message: 'Collaboration Token budget reached.' };
      db.prepare('UPDATE parallel_lanes SET attempt_tokens = ?, reserved_tokens = ? WHERE id = ?').run(run.usage?.total_tokens || 0, tokens, context.laneId);
      return { allowed: true };
    });
  }
  settle(context, run) {
    this.store.storage.transaction(db => {
      const tokens = run.usage?.total_tokens || 0;
      const added = db.prepare('INSERT OR IGNORE INTO collaboration_run_usage (run_id, lane_id, tokens) VALUES (?, ?, ?)').run(run.runId, context.laneId, tokens);
      if (added.changes) db.prepare('UPDATE parallel_lanes SET used_tokens = used_tokens + ?, attempt_tokens = 0, reserved_tokens = 0 WHERE id = ?').run(tokens, context.laneId);
      db.prepare('UPDATE parallel_batches SET used_tokens = (SELECT SUM(used_tokens) FROM parallel_lanes WHERE batch_id = ?) WHERE id = ?').run(context.batchId, context.batchId);
    });
  }
  capture(batch, lane) {
    this.owned(lane.worktree_path, batch.repo_dir);
    if (this.git(lane.worktree_path, ['status', '--porcelain']).trim()) {
      this.git(lane.worktree_path, ['add', '--all', '--', '.']);
      this.git(lane.worktree_path, ['-c', 'user.name=52hzAgents', '-c', 'user.email=agent@52hz.local', 'commit', '-m', `Task delivery ${lane.id}`]);
    }
    const commit = this.git(lane.worktree_path, ['rev-parse', 'HEAD']).trim();
    return { baseCommit: batch.base_commit, commit,
      changedFiles: this.git(lane.worktree_path, ['diff', '--name-only', '-z', batch.base_commit, commit]).split('\0').filter(Boolean),
      diffstat: this.git(lane.worktree_path, ['diff', '--stat', batch.base_commit, commit]).trim() };
  }
  finish(context, run, record, result) {
    if (context.kind === 'pipeline') return this.finishPipeline(context, run, record, result);
    const batch = this.batch(context.batchId), lane = this.lane(batch.id, context.laneId);
    this.settle(context, run);
    if (context.kind === 'review') {
      let verdict = 'failed', notes = result?.content || record.error?.message || '';
      if (record.outcome === 'finished' && !result?.isError) {
        try {
          const parsed = JSON.parse(notes.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
          if (['approved', 'changes_requested'].includes(parsed.verdict) && typeof parsed.notes === 'string') { verdict = parsed.verdict; notes = parsed.notes; }
        } catch { /* Non-structured text is never an approval. */ }
      }
      try { this.owned(lane.worktree_path, batch.repo_dir); if (this.git(lane.worktree_path, ['rev-parse', 'HEAD']).trim() !== context.reviewedCommit || this.git(lane.worktree_path, ['status', '--porcelain']).trim()) verdict = 'failed'; }
      catch (error) { verdict = 'failed'; notes += `\n${error.message}`; }
      if (['cancelled', 'interrupted'].includes(record.outcome)) verdict = 'cancelled';
      this.db.prepare('UPDATE parallel_lanes SET review_status = ?, review_notes = ?, reviewer = ?, reviewed_commit = ? WHERE id = ? AND review_run_id = ?')
        .run(verdict, notes, context.actor.id, context.reviewedCommit, lane.id, run.runId);
    } else if (lane.run_id === run.runId && lane.status === 'running') {
      let success = record.outcome === 'finished' && !result?.isError;
      let delivery = null, error = record.error?.message || result?.content || '';
      if (success) { try { delivery = this.capture(batch, lane); } catch (err) { success = false; error = err.message; record.outcome = 'failed'; record.error = { code: 'DELIVERY_FAILED', message: error }; } }
      this.db.prepare(`UPDATE parallel_lanes SET status = ?, reply = ?, error = ?, commit_hash = ?, diffstat = ?, changed_files = ?, delivery_json = ?, finished_at = ? WHERE id = ? AND run_id = ?`)
        .run(success ? 'done' : 'failed', result?.content || '', success ? '' : error, delivery?.commit || '', delivery?.diffstat || '', delivery?.changedFiles.join('\n') || '', delivery ? JSON.stringify(delivery) : null, new Date().toISOString(), lane.id, run.runId);
    }
    this.refresh(batch.id); this.publish(batch.id);
  }
  afterRun(context) {
    if (context.kind === 'pipeline') { this.dispatchPipeline(context.channel); return; }
    if (context.kind !== 'lane') return;
    const batch = this.batch(context.batchId), lane = this.lane(batch.id, context.laneId);
    if (batch.status !== 'cancelled' && batch.review_snapshot_json && lane.status === 'done' && !lane.review_status) {
      try { this.review(batch.id, lane.id); } catch (error) { this.db.prepare("UPDATE parallel_lanes SET review_status = 'failed', review_notes = ? WHERE id = ?").run(error.message, lane.id); this.publish(batch.id); }
    }
  }
  refresh(batchId) {
    const batch = this.batch(batchId);
    if (['done', 'cancelled'].includes(batch.status)) return;
    const lanes = this.db.prepare('SELECT status FROM parallel_lanes WHERE batch_id = ?').all(batchId);
    const status = lanes.some(lane => lane.status === 'running') ? 'running' : lanes.some(lane => lane.status === 'failed') ? 'blocked' : 'review';
    this.db.prepare('UPDATE parallel_batches SET status = ? WHERE id = ?').run(status, batchId);
  }
  failDispatch(batchId, laneId, error) {
    this.db.prepare("UPDATE parallel_lanes SET status = 'failed', error = ? WHERE id = ? AND run_id IS NULL").run(error.message, laneId);
    this.refresh(batchId); this.publish(batchId);
  }
  review(batchId, reference) {
    const batch = this.batch(batchId), lane = this.lane(batchId, reference);
    this.assertIdle(lane.worktree_path);
    if (!batch.review_snapshot_json) throw fail('Choose a reviewer Agent when creating the batch.', 400);
    if (lane.status !== 'done' || lane.review_status === 'running') throw fail('The lane is not ready for review.');
    this.owned(lane.worktree_path, batch.repo_dir);
    if (this.git(lane.worktree_path, ['status', '--porcelain']).trim()) throw fail('Lane changed after delivery. Retry before review.');
    const id = `review-${crypto.randomUUID()}`, referenceActor = JSON.parse(batch.review_snapshot_json);
    const actor = this.actor(referenceActor.profileId || referenceActor.id);
    const patch = this.git(lane.worktree_path, ['diff', '--no-ext-diff', '--no-textconv', batch.base_commit, lane.commit_hash]).slice(0, 32000);
    this.db.prepare("UPDATE parallel_lanes SET review_status = 'running', review_event_id = ?, review_run_id = NULL, review_snapshot_json = ? WHERE id = ?").run(id, JSON.stringify(actor), lane.id);
    const saved = this.store.addEvent({ id, type: 'workspace.message.posted', source: `orchestration:review:${lane.id}`, target: `channel/${batch.channel_name}`,
      payload: { content: `Review delivery ${lane.commit_hash} against ${batch.base_commit}. Inspect the actual diff below (up to 32000 characters; read files for further context). Do not change files or run commands. Return only JSON {"verdict":"approved"|"changes_requested","notes":"evidence and findings"}.\nTask: ${lane.task}\nAuthor delivery:\n${lane.reply}\nChanged files:\n${lane.changed_files}\nActual diff:\n${patch}`, sender_name: actor.name, sender_type: 'agent' },
      metadata: { batch_id: batchId, lane_id: lane.id } });
    this.broadcaster.broadcast(saved);
    queueMicrotask(() => this.runner.handleUserMessage(saved).catch(error => {
      this.db.prepare("UPDATE parallel_lanes SET review_status = 'failed', review_notes = ? WHERE id = ?").run(error.message, lane.id); this.publish(batchId);
    }));
    return this.view(batchId);
  }
  humanReview(batchId, reference, input) {
    const lane = this.lane(batchId, reference), batch = this.batch(batchId);
    this.assertIdle(lane.worktree_path);
    if (lane.status !== 'done' || lane.review_status === 'running') throw fail('Wait for this lane to finish before reviewing.');
    if (!['approved', 'changes_requested'].includes(input.verdict || input.status)) throw fail('Invalid review verdict.', 400);
    this.owned(lane.worktree_path, batch.repo_dir);
    if (this.git(lane.worktree_path, ['rev-parse', 'HEAD']).trim() !== lane.commit_hash || this.git(lane.worktree_path, ['status', '--porcelain']).trim()) throw fail('Delivery changed; review is stale.');
    this.db.prepare('UPDATE parallel_lanes SET review_status = ?, review_notes = ?, reviewer = ?, reviewed_commit = ? WHERE id = ?')
      .run(input.verdict || input.status, String(input.notes || '').slice(0, 16000), 'human:user', lane.commit_hash, lane.id);
    return this.publish(batchId);
  }
  retry(batchId, reference) {
    const batch = this.batch(batchId), lane = this.lane(batchId, reference);
    this.assertIdle(lane.worktree_path);
    if (batch.status === 'done' || lane.status === 'running' || lane.review_status === 'running') throw fail('This lane cannot be retried now.');
    if (this.db.prepare("SELECT 1 FROM parallel_batches WHERE channel_name = ? AND runtime_version = 1 AND id != ? AND status IN ('running','review','blocked')").get(batch.channel_name, batchId)) throw fail('Another batch is active in this session.');
    this.owned(lane.worktree_path, batch.repo_dir);
    const previous = JSON.parse(lane.agent_snapshot_json);
    const actor = this.actor(previous.profileId || lane.agent_id);
    this.db.prepare(`UPDATE parallel_lanes SET status = 'running', agent_id = ?, agent_snapshot_json = ?, run_id = NULL, claim_token = NULL, dispatch_event_id = NULL, attempts = attempts + 1,
      review_status = '', review_run_id = NULL, review_event_id = NULL, reviewed_commit = '', delivery_json = NULL, error = '', reserved_tokens = 0, attempt_tokens = 0 WHERE id = ?`).run(actor.id, JSON.stringify(actor), lane.id);
    this.db.prepare('DELETE FROM parallel_conflicts WHERE batch_id = ?').run(batchId);
    this.db.prepare("UPDATE parallel_batches SET status = 'running', finished_at = NULL WHERE id = ?").run(batchId);
    this.dispatch(batchId); return this.publish(batchId);
  }
  async stop(batchId) {
    const batch = this.batch(batchId);
    if (batch.status === 'done') throw fail('Batch is already integrated.');
    this.db.prepare("UPDATE parallel_batches SET status = 'cancelled' WHERE id = ?").run(batchId);
    const active = [...this.runner.active.values()].filter(run => run.snapshot.collaboration?.batchId === batchId);
    for (const run of active) run.controller.abort();
    await Promise.all(active.map(run => run.done));
    this.db.prepare("UPDATE parallel_lanes SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, review_status = CASE WHEN review_status = 'running' THEN 'cancelled' ELSE review_status END, error = CASE WHEN status = 'running' THEN 'Stopped by user' ELSE error END, reserved_tokens = 0, attempt_tokens = 0 WHERE batch_id = ?").run(batchId);
    return this.publish(batchId);
  }
  merge(batchId) {
    const batch = this.batch(batchId), lanes = this.db.prepare('SELECT * FROM parallel_lanes WHERE batch_id = ?').all(batchId);
    if (batch.status !== 'review' || !lanes.length || lanes.some(lane => lane.status !== 'done' || lane.review_status === 'running')) throw fail('Complete all lanes and reviews before integration.');
    this.assertIdle(batch.repo_dir);
    for (const lane of lanes) {
      this.assertIdle(lane.worktree_path);
      this.owned(lane.worktree_path, batch.repo_dir);
      if (!lane.commit_hash || this.git(lane.worktree_path, ['rev-parse', 'HEAD']).trim() !== lane.commit_hash || this.git(lane.worktree_path, ['status', '--porcelain']).trim()) throw fail('A delivery changed after review. Retry or review it again.');
      if ((batch.review_snapshot_json || lane.review_status) && (lane.review_status !== 'approved' || lane.reviewed_commit !== lane.commit_hash)) throw fail('Every required review must approve the current delivery.');
    }
    const unchanged = () => {
      if (this.git(batch.repo_dir, ['rev-parse', 'HEAD']).trim() !== batch.base_commit || this.git(batch.repo_dir, ['symbolic-ref', '--short', 'HEAD']).trim() !== batch.base_branch || this.git(batch.repo_dir, ['status', '--porcelain']).trim()) throw fail('Source project changed or has uncommitted files. Integration is blocked.');
    };
    unchanged();
    const integration = path.join(this.root, crypto.randomUUID(), 'integration');
    const branch = `52hz/integration/${crypto.randomUUID()}`;
    this.git(batch.repo_dir, ['worktree', 'add', '-b', branch, integration, batch.base_commit]);
    this.db.prepare('UPDATE parallel_batches SET integration_path = ? WHERE id = ?').run(integration, batchId);
    try {
      for (const lane of lanes) this.git(integration, ['-c', 'user.name=52hzAgents', '-c', 'user.email=agent@52hz.local', 'merge', '--no-ff', lane.commit_hash, '-m', `Integrate ${lane.agent_id}`]);
      const head = this.git(integration, ['rev-parse', 'HEAD']).trim();
      unchanged(); this.git(batch.repo_dir, ['merge', '--ff-only', head]);
      this.store.storage.transaction(db => {
        db.prepare("UPDATE parallel_lanes SET status = 'merged' WHERE batch_id = ?").run(batchId);
        db.prepare("UPDATE parallel_batches SET status = 'done', finished_at = ? WHERE id = ?").run(new Date().toISOString(), batchId);
      });
      return this.publish(batchId);
    } catch (error) {
      let files = ''; try { files = this.git(integration, ['diff', '--name-only', '--diff-filter=U']).trim(); this.git(integration, ['merge', '--abort']); } catch {}
      this.db.prepare('INSERT INTO parallel_conflicts (id, batch_id, file_path, conflicting_lanes_json, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), batchId, files, '{}', error.message, new Date().toISOString());
      this.db.prepare("UPDATE parallel_batches SET status = 'blocked' WHERE id = ?").run(batchId);
      throw fail(`Integration failed; source and worker worktrees are preserved. ${error.message}`);
    }
  }
  async discard(batchId) {
    await this.stop(batchId);
    this.cleanup(batchId);
    this.db.prepare("UPDATE parallel_lanes SET status = 'discarded' WHERE batch_id = ?").run(batchId);
    this.db.prepare("UPDATE parallel_batches SET status = 'done', finished_at = ? WHERE id = ?").run(new Date().toISOString(), batchId);
    return this.publish(batchId);
  }
  cleanup(batchId) {
    const batch = this.batch(batchId), paths = this.db.prepare('SELECT worktree_path FROM parallel_lanes WHERE batch_id = ?').all(batchId).map(row => row.worktree_path);
    if (!['done', 'cancelled'].includes(batch.status)) throw fail('Finish or stop the batch before cleaning worktrees.');
    if (batch.integration_path) paths.push(batch.integration_path);
    // Preflight every worktree before deleting any. Git also refuses dirty/ignored files.
    for (const directory of paths) {
      if (!fs.existsSync(directory)) continue;
      this.assertIdle(directory);
      this.owned(directory, batch.repo_dir);
      if (this.git(directory, ['status', '--porcelain', '--ignored']).trim()) throw fail('Worktree contains uncommitted or ignored files. It was retained.');
    }
    for (const directory of paths) if (fs.existsSync(directory)) this.git(batch.repo_dir, ['worktree', 'remove', directory]);
    return this.publish(batchId);
  }
  restoreTarget(channel, runId) {
    // Use the persisted execution snapshot, never a caller-provided worktree path.
    const saved = this.store.storage.runs.get(runId), context = saved?.configSnapshot?.collaboration;
    if (saved?.sessionId !== channel || context?.kind !== 'lane') throw fail('No worker checkpoint is bound to this run.');
    const batch = this.batch(context.batchId), lane = this.lane(batch.id, context.laneId);
    if (batch.channel_name !== channel || lane.run_id !== runId) throw fail('This checkpoint belongs to an older task attempt.');
    if (batch.status === 'done' || ['merged', 'discarded', 'running'].includes(lane.status) || lane.review_status === 'running') throw fail('Stop this task and its review before restoring; integrated deliveries cannot be restored here.');
    const root = this.owned(lane.worktree_path, batch.repo_dir);
    if (canonical(saved.configSnapshot.workingDir) !== root) throw fail('Worker checkpoint provenance does not match.');
    return { root, batchId: batch.id, laneId: lane.id };
  }
  invalidateRestoredDelivery(channel, runId) {
    const target = this.restoreTarget(channel, runId);
    this.db.prepare(`UPDATE parallel_lanes SET status = 'failed', error = 'Checkpoint restored; retry this task before review or merge.',
      delivery_json = NULL, commit_hash = '', diffstat = '', changed_files = '', review_status = '', reviewed_commit = '', review_notes = '', review_run_id = NULL, review_event_id = NULL WHERE id = ? AND run_id = ?`).run(target.laneId, runId);
    this.refresh(target.batchId); this.publish(target.batchId);
  }
  cancelSession(channel) {
    this.db.prepare("UPDATE parallel_batches SET status = 'cancelled' WHERE runtime_version = 1 AND channel_name = ? AND status IN ('running','review','blocked')").run(channel);
    this.db.prepare("UPDATE channel_pipelines SET active = 0, status = 'cancelled' WHERE channel_id = ? AND active = 1").run(channel);
  }
  recover() {
    if (!this.store.storage) return;
    this.db.prepare("UPDATE parallel_lanes SET status = 'failed', error = 'Interrupted by application restart', reserved_tokens = 0, attempt_tokens = 0 WHERE batch_id IN (SELECT id FROM parallel_batches WHERE runtime_version = 1) AND status = 'running'").run();
    this.db.prepare("UPDATE parallel_lanes SET review_status = 'failed', review_notes = 'Review interrupted by restart' WHERE batch_id IN (SELECT id FROM parallel_batches WHERE runtime_version = 1) AND review_status = 'running'").run();
    this.db.prepare("UPDATE parallel_batches SET status = 'blocked' WHERE runtime_version = 1 AND status = 'running'").run();
    for (const row of this.db.prepare("SELECT * FROM channel_pipelines WHERE active = 1").all()) {
      const steps = JSON.parse(row.steps_json);
      for (const step of steps) if (step.actor_snapshot && step.status === 'running') { step.status = 'retrying'; step.run_id = null; step.dispatch_event_id = null; step.last_error = 'Interrupted by restart'; }
      this.db.prepare("UPDATE channel_pipelines SET status = 'paused', steps_json = ? WHERE id = ?").run(JSON.stringify(steps), row.id);
    }
  }
  startPipeline(channel, input) {
    if ((this.runner.isRecoveryBlocked?.() || this.runner.isRecoveryLocked?.())) throw fail('System recovery is in progress; pipelines cannot be started.', 409);
    if (!this.store.getChannel(channel)) throw fail('Session not found.', 404);
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 12) throw fail('Choose 1–12 pipeline steps.', 400);
    if (this.store.storage.pipelines.get(channel).active || [...this.runner.active.values()].some(run => run.snapshot.channel === channel)) throw fail('Stop existing session tasks before starting a pipeline.');
    const actors = input.steps.map(step => {
      if (typeof step.instruction !== 'string' || !step.instruction.trim() || step.instruction.length > 16000) throw fail('Every pipeline step needs an instruction.', 400);
      const actor = this.actor(step.agent_id || step.agent);
      this.runner.validateNativeExecution?.(actor, this.actorConfig(actor), { channel, execution: { kind: 'pipeline' } });
      return actor;
    });
    const saved = this.store.storage.pipelines.save(channel, input);
    saved.steps.forEach((step, index) => { step.agent = actors[index].id; step.agent_id = actors[index].id; step.actor_snapshot = actors[index]; });
    this.db.prepare('UPDATE channel_pipelines SET id = ?, steps_json = ? WHERE channel_id = ?').run(crypto.randomUUID(), JSON.stringify(saved.steps), channel);
    this.dispatchPipeline(channel);
    return this.store.storage.pipelines.get(channel);
  }
  dispatchPipeline(channel) {
    const pipeline = this.store.storage.pipelines.get(channel), step = pipeline.steps?.[pipeline.current_index];
    if (!pipeline.active || pipeline.status !== 'running' || !step || step.dispatch_event_id || step.run_id) return;
    if (!step.actor_snapshot) { this.db.prepare("UPDATE channel_pipelines SET status = 'paused' WHERE channel_id = ?").run(channel); return; }
    const id = `pipeline-${crypto.randomUUID()}`;
    step.dispatch_event_id = id;
    this.db.prepare('UPDATE channel_pipelines SET steps_json = ? WHERE id = ?').run(JSON.stringify(pipeline.steps), pipeline.id);
    const prior = pipeline.steps.slice(0, pipeline.current_index).map((item, index) => `Step ${index + 1}, Agent ${item.actor_snapshot.name}:\n${item.deliverable || ''}`).join('\n\n');
    const saved = this.store.addEvent({ id, type: 'workspace.message.posted', source: `pipeline:${pipeline.id}`, target: `channel/${channel}`,
      payload: { content: `${prior ? `Prior deliverables:\n${prior}\n\n` : ''}${step.instruction}`, sender_name: step.actor_snapshot.name, sender_type: 'pipeline' },
      metadata: { pipeline_id: pipeline.id, step_index: pipeline.current_index } });
    this.broadcaster.broadcast(saved);
    queueMicrotask(() => this.runner.handleUserMessage(saved).catch(error => {
      const current = this.store.storage.pipelines.get(channel), currentStep = current.steps?.[current.current_index];
      if (current.id !== pipeline.id || currentStep?.dispatch_event_id !== id || currentStep.run_id) return;
      this.store.storage.pipelines.failStep(channel, error.message);
      this.db.prepare("UPDATE channel_pipelines SET status = 'paused' WHERE channel_id = ? AND active = 1").run(channel);
    }));
  }
  resolvePipeline(event, channel) {
    const pipeline = this.store.storage.pipelines.get(channel), step = pipeline.steps?.[pipeline.current_index];
    if (!pipeline.active || pipeline.id !== event.metadata.pipeline_id || !step?.actor_snapshot || step.dispatch_event_id !== event.id) throw fail('Unbound or stale pipeline dispatch.');
    if (step.run_id || pipeline.status !== 'running') return null;
    this.store.storage.agentDefinitions.requireActive(step.agent_id);
    return { kind: 'pipeline', channel, pipelineId: pipeline.id, eventId: event.id, stepIndex: pipeline.current_index,
      actor: structuredClone(step.actor_snapshot), config: this.actorConfig(step.actor_snapshot), projectDir: this.store.getChannel(channel).working_dir,
      contextKey: `${pipeline.id}:step:${pipeline.current_index}:attempt:${step.retry_count}`, executionKey: channel };
  }
  finishPipeline(context, run, record, result) {
    const pipeline = this.store.storage.pipelines.get(context.channel), step = pipeline.steps?.[context.stepIndex];
    if (!pipeline.active || pipeline.id !== context.pipelineId || step?.run_id !== run.runId || pipeline.current_index !== context.stepIndex) return;
    const wasPaused = pipeline.status === 'paused';
    if (record.outcome === 'finished' && !result?.isError) {
      const advanced = this.store.storage.pipelines.advance(context.channel, result.content);
      if (wasPaused && advanced.active) this.db.prepare("UPDATE channel_pipelines SET status = 'paused' WHERE id = ?").run(pipeline.id);
    } else {
      this.store.storage.pipelines.failStep(context.channel, record.error?.message || result?.content || record.outcome);
      this.db.prepare("UPDATE channel_pipelines SET status = 'paused' WHERE id = ? AND active = 1").run(pipeline.id);
    }
    this.broadcaster.broadcast({ type: 'workspace.pipeline.updated', target: `channel/${context.channel}`, payload: this.store.storage.pipelines.get(context.channel) });
  }
  resumePipeline(channel) {
    const pipeline = this.store.storage.pipelines.get(channel), step = pipeline.steps?.[pipeline.current_index];
    if (!step?.actor_snapshot) throw fail('Legacy pipeline requires saved Agent IDs. Create a new pipeline.');
    if (step.status === 'retrying') { step.actor_snapshot = this.actor(step.actor_snapshot.profileId || step.agent_id); step.agent_id = step.actor_snapshot.id; step.dispatch_event_id = null; step.run_id = null;
      this.db.prepare('UPDATE channel_pipelines SET steps_json = ? WHERE id = ?').run(JSON.stringify(pipeline.steps), pipeline.id); }
    else if (!step.run_id && step.dispatch_event_id) {
      step.dispatch_event_id = null;
      this.db.prepare('UPDATE channel_pipelines SET steps_json = ? WHERE id = ?').run(JSON.stringify(pipeline.steps), pipeline.id);
    }
    this.store.storage.pipelines.resume(channel); this.dispatchPipeline(channel); return this.store.storage.pipelines.get(channel);
  }
  deliveryDiff(batchId, reference) {
    const batch = this.batch(batchId), lane = this.lane(batchId, reference);
    if (!lane.commit_hash) {
      return {
        available: false,
        reason: '该任务尚未产生交付 commit。',
        baseCommit: batch.base_commit,
        deliveryCommit: null,
        files: [],
        diff: '',
        truncated: false,
      };
    }
    let cwd = lane.worktree_path;
    if (!fs.existsSync(cwd)) cwd = batch.repo_dir;
    if (!fs.existsSync(cwd)) {
      return {
        available: false,
        reason: '底层 Git 仓库已不存在，无法读取交付 Diff。',
        baseCommit: batch.base_commit,
        deliveryCommit: lane.commit_hash,
        files: lane.changed_files ? lane.changed_files.split('\n').filter(Boolean) : [],
        diff: '',
        truncated: false,
      };
    }
    try {
      const filesOutput = this.git(cwd, ['diff', '--name-status', '-z', batch.base_commit, lane.commit_hash]);
      const files = [];
      const parts = filesOutput.split('\0').filter(Boolean);
      for (let i = 0; i < parts.length; i += 2) {
        if (parts[i] && parts[i + 1]) {
          files.push({ status: parts[i], path: parts[i + 1] });
        }
      }
      const MAX_DIFF_BYTES = 64 * 1024;
      const rawDiff = this.git(cwd, ['diff', '--no-ext-diff', '--no-textconv', batch.base_commit, lane.commit_hash]);
      const truncated = rawDiff.length > MAX_DIFF_BYTES;
      const diff = truncated ? rawDiff.slice(0, MAX_DIFF_BYTES) + '\n\n[Diff 已截断，超出 64KB 上限]' : rawDiff;
      return {
        available: true,
        baseCommit: batch.base_commit,
        deliveryCommit: lane.commit_hash,
        diffstat: lane.diffstat,
        files,
        diff,
        truncated,
      };
    } catch (err) {
      return {
        available: false,
        reason: '读取 Git Diff 失败: ' + err.message,
        baseCommit: batch.base_commit,
        deliveryCommit: lane.commit_hash,
        files: lane.changed_files ? lane.changed_files.split('\n').filter(Boolean) : [],
        diff: '',
        truncated: false,
      };
    }
  }
}
module.exports = { Collaboration };
