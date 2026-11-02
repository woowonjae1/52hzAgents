const crypto = require('crypto');

class OrchestrationRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  // -------------------------------------------------------------
  // 1. Work Profiles (N1: 受控角色与工作画像)
  // -------------------------------------------------------------

  listProfiles({ workspaceId = '52hz' } = {}) {
    const stmt = this.db.prepare(`
      SELECT * FROM work_profiles WHERE workspace_id = ? ORDER BY created_at ASC
    `);
    const rows = stmt.all(workspaceId);
    return rows.map((r) => this._normalizeProfile(r));
  }

  getProfile(id) {
    const stmt = this.db.prepare(`SELECT * FROM work_profiles WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return null;
    return this._normalizeProfile(row);
  }

  createProfile(data) {
    const id = data.id || `profile-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const workspaceId = data.workspace_id || '52hz';
    const name = data.name || 'Unnamed Profile';
    const agent = data.agent || 'pi-agent';
    const role = data.role || 'implementer';
    const model = data.model || '';
    const mode = data.mode || 'execute';
    const description = data.description || '';
    const allowedToolsJson = JSON.stringify(data.allowed_tools || data.tools || []);
    const budgetTokens = Number(data.budget_tokens || 0);
    const budgetCostMicros = Number(data.budget_cost_micros || 0);

    const stmt = this.db.prepare(`
      INSERT INTO work_profiles (
        id, workspace_id, name, agent, role, model, mode, description,
        allowed_tools_json, budget_tokens, budget_cost_micros, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, workspaceId, name, agent, role, model, mode, description,
      allowedToolsJson, budgetTokens, budgetCostMicros, now, now
    );

    return this.getProfile(id);
  }

  updateProfile(id, data) {
    const existing = this.getProfile(id);
    if (!existing) throw new Error(`Work profile not found: ${id}`);

    const now = new Date().toISOString();
    const name = data.name !== undefined ? data.name : existing.name;
    const agent = data.agent !== undefined ? data.agent : existing.agent;
    const role = data.role !== undefined ? data.role : existing.role;
    const model = data.model !== undefined ? data.model : existing.model;
    const mode = data.mode !== undefined ? data.mode : existing.mode;
    const description = data.description !== undefined ? data.description : existing.description;
    const allowedToolsJson = data.allowed_tools !== undefined
      ? JSON.stringify(data.allowed_tools)
      : (data.tools !== undefined ? JSON.stringify(data.tools) : (existing.allowed_tools_json || JSON.stringify(existing.allowed_tools || [])));
    const budgetTokens = data.budget_tokens !== undefined ? Number(data.budget_tokens) : existing.budget_tokens;
    const budgetCostMicros = data.budget_cost_micros !== undefined ? Number(data.budget_cost_micros) : existing.budget_cost_micros;

    const stmt = this.db.prepare(`
      UPDATE work_profiles SET
        name = ?, agent = ?, role = ?, model = ?, mode = ?, description = ?,
        allowed_tools_json = ?, budget_tokens = ?, budget_cost_micros = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      name, agent, role, model, mode, description,
      allowedToolsJson, budgetTokens, budgetCostMicros, now, id
    );

    return this.getProfile(id);
  }

  deleteProfile(id) {
    const stmt = this.db.prepare(`DELETE FROM work_profiles WHERE id = ?`);
    const res = stmt.run(id);
    return res.changes > 0;
  }

  // -------------------------------------------------------------
  // 2. Parallel Batches & Scope Conflicts (N2: 分阶段引入并行与防冲突)
  // -------------------------------------------------------------

  /**
   * Check if scopes overlap between two workers when not in worktree isolation.
   */
  detectScopeConflicts(workers = []) {
    const conflicts = [];
    for (let i = 0; i < workers.length; i++) {
      for (let j = i + 1; j < workers.length; j++) {
        const w1 = workers[i];
        const w2 = workers[j];
        const s1 = (w1.scope || '').trim().replace(/\\/g, '/').toLowerCase();
        const s2 = (w2.scope || '').trim().replace(/\\/g, '/').toLowerCase();

        if (!s1 || !s2) {
          // Empty scope in shared mode is a global project overlap conflict
          conflicts.push({
            assignee_a: w1.assignee || w1.agent,
            scope_a: s1 || '(all)',
            assignee_b: w2.assignee || w2.agent,
            scope_b: s2 || '(all)',
            reason: 'One or more workers lack an isolated directory scope in shared mode.',
          });
          continue;
        }

        const overlap = s1 === s2 || s1.startsWith(s2 + '/') || s2.startsWith(s1 + '/');
        if (overlap) {
          conflicts.push({
            assignee_a: w1.assignee || w1.agent,
            scope_a: s1,
            assignee_b: w2.assignee || w2.agent,
            scope_b: s2,
            reason: `Conflicting directory scope: '${s1}' overlaps with '${s2}'`,
          });
        }
      }
    }
    return conflicts;
  }

  /**
   * Get active parallel batch view for channel matching frontend ParallelBatch shape.
   */
  getParallelBatch(channelName, workspaceId = '52hz', batchId = null) {
    // 1. Fetch latest batch for this channel
    const stmt = this.db.prepare(`
      SELECT * FROM parallel_batches
      WHERE channel_name = ? AND workspace_id = ?
      ${batchId ? 'AND id = ?' : ''}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const batchRow = stmt.get(...[channelName, workspaceId, ...(batchId ? [batchId] : [])]);

    if (!batchRow) {
      return {
        mode: 'agent',
        state: 'idle',
        workers: [],
        conflicts: [],
        done: 0,
        total: 0,
        isolated: true,
        review_agent: '',
        run: null,
      };
    }

    const batch = this._normalizeBatch(batchRow);

    // 2. Fetch lanes
    const lanesStmt = this.db.prepare(`
      SELECT * FROM parallel_lanes WHERE batch_id = ? ORDER BY started_at ASC
    `);
    const laneRows = lanesStmt.all(batch.id);
    const lanes = laneRows.map((r) => this._normalizeLane(r));

    // 3. Fetch conflicts
    const conflictsStmt = this.db.prepare(`
      SELECT * FROM parallel_conflicts WHERE batch_id = ?
    `);
    const conflictRows = conflictsStmt.all(batch.id);
    const conflicts = conflictRows.map((c) => ({
      file_path: c.file_path,
      details: c.details,
      ...(() => {
        try {
          return JSON.parse(c.conflicting_lanes_json);
        } catch (_) {
          return {};
        }
      })(),
    }));

    // 4. Calculate progress and batch state
    const doneLanes = lanes.filter((l) => l.status !== 'running').length;
    const totalLanes = lanes.length;

    let state = 'running';
    if (batch.status === 'done') {
      state = 'done';
    } else if (batch.status === 'failed') {
      state = 'failed';
    } else if (batch.status === 'cancelled') {
      state = 'cancelled';
    } else if (batch.status === 'blocked' || conflicts.length > 0) {
      state = 'blocked';
    } else if (batch.status === 'review') {
      state = 'blocked';
    }

    const workers = lanes.map((l) => ({
      assignee: l.agent,
      task: l.task,
      scope: l.scope,
      status: l.status,
    }));

    return {
      mode: 'agent',
      state,
      workers,
      conflicts,
      done: doneLanes,
      total: totalLanes,
      isolated: batch.isolation === 'worktree',
      review_agent: batch.review_agent,
      run: {
        batch,
        lanes,
      },
    };
  }

  /**
   * Create and launch a parallel batch with multiple worker lanes.
   */
  createBatch({
    channel_name,
    workspace_id = '52hz',
    origin = 'board',
    isolation = 'worktree',
    repo_dir = '',
    base_branch = 'main',
    review_agent = '',
    delegated_by = '',
    workers = [],
    parent_run_id = null,
    total_budget_tokens = 0,
  }) {
    const id = `batch-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    // Check scope conflicts if not isolated via git worktrees
    let conflicts = [];
    if (isolation !== 'worktree') {
      conflicts = this.detectScopeConflicts(workers);
    }

    const status = conflicts.length > 0 ? 'blocked' : 'running';

    return this.manager.transaction((db) => {
      // 1. Insert Batch record
      const insertBatch = db.prepare(`
        INSERT INTO parallel_batches (
          id, workspace_id, channel_name, parent_run_id, isolation, origin,
          repo_dir, base_branch, status, summary, review_agent, delegated_by,
          total_budget_tokens, used_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?)
      `);

      insertBatch.run(
        id, workspace_id, channel_name, parent_run_id, isolation, origin,
        repo_dir, base_branch, status, review_agent, delegated_by,
        total_budget_tokens, now
      );

      // 2. Insert Lane records
      const insertLane = db.prepare(`
        INSERT INTO parallel_lanes (
          id, batch_id, agent, role, task, scope, worktree_path, branch,
          status, error, commit_hash, reply, diffstat, changed_files,
          attempts, port, started_at, review_status, reviewer, profile, mode, model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', 1, 0, ?, '', '', ?, ?, ?)
      `);

      let anyLaneFailed = false;
      let allLanesFailed = workers.length > 0;

      for (const w of workers) {
        const laneId = `lane-${crypto.randomUUID()}`;
        const agent = w.agent || w.assignee || 'worker';
        const role = w.role || 'implementer';
        const task = w.task || w.content || '';
        const scope = w.scope || '';
        let worktreePath = w.worktree_path || '';
        const branch = w.branch || `parallel/${agent}/${id.slice(-6)}`;
        const profile = w.profile || '';
        const mode = w.mode || 'execute';
        const model = w.model || '';

        let laneStatus = 'running';
        let laneError = '';

        // If isolated via worktrees and repo_dir is specified, create and strictly verify the isolated git worktree
        if (isolation === 'worktree' && repo_dir) {
          if (!fs.existsSync(repo_dir)) {
            laneStatus = 'failed';
            laneError = `Repository directory does not exist: ${repo_dir}`;
          } else {
            if (!worktreePath) {
              worktreePath = path.join(os.tmpdir(), `52hz-worktree-${id.slice(-6)}-${agent}-${crypto.randomBytes(4).toString('hex')}`);
            }
            try {
              this._execGitSync(repo_dir, ['worktree', 'add', '-b', branch, worktreePath, base_branch || 'HEAD']);
            } catch (wtErr) {
              try {
                this._execGitSync(repo_dir, ['worktree', 'add', worktreePath, branch]);
              } catch (wtErr2) {
                laneStatus = 'failed';
                laneError = `Failed to create git worktree: ${wtErr2.message || wtErr.message}`;
              }
            }
            if (laneStatus !== 'failed' && !fs.existsSync(worktreePath)) {
              laneStatus = 'failed';
              laneError = `Worktree path was not created: ${worktreePath}`;
            }
          }
        }

        if (laneStatus === 'failed') {
          anyLaneFailed = true;
        } else {
          allLanesFailed = false;
        }

        insertLane.run(
          laneId, id, agent, role, task, scope, worktreePath, branch,
          laneStatus, laneError, now, profile, mode, model
        );
      }

      if (allLanesFailed && workers.length > 0) {
        db.prepare(`UPDATE parallel_batches SET status = 'failed', summary = 'All lanes failed to initialize isolated worktrees' WHERE id = ?`).run(id);
      } else if (anyLaneFailed) {
        db.prepare(`UPDATE parallel_batches SET status = 'blocked', summary = 'One or more lanes failed to initialize isolated worktrees' WHERE id = ?`).run(id);
      }

      // 3. Record conflicts if any
      if (conflicts.length > 0) {
        const insertConflict = db.prepare(`
          INSERT INTO parallel_conflicts (id, batch_id, file_path, conflicting_lanes_json, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const conf of conflicts) {
          const cId = `conflict-${crypto.randomUUID()}`;
          insertConflict.run(
            cId,
            id,
            conf.scope_a || '',
            JSON.stringify(conf),
            conf.reason,
            now
          );
        }
      }

      return this.getParallelBatch(channel_name, workspace_id);
    });
  }

  /**
   * Complete a lane's execution.
   */
  completeLane(batchId, agent, {
    status = 'done',
    reply = '',
    commit_hash = '',
    diffstat = '',
    changed_files = '',
    error = '',
    tokens = 0,
  } = {}) {
    const now = new Date().toISOString();

    return this.manager.transaction((db) => {
      const updateLane = db.prepare(`
        UPDATE parallel_lanes SET
          status = ?, reply = ?, commit_hash = ?, diffstat = ?, changed_files = ?,
          error = ?, finished_at = ?
        WHERE batch_id = ? AND (id = ? OR agent = ?)
      `);
      updateLane.run(status, reply, commit_hash, diffstat, changed_files, error, now, batchId, agent, agent);

      if (tokens > 0) {
        db.prepare(`UPDATE parallel_batches SET used_tokens = used_tokens + ? WHERE id = ?`).run(tokens, batchId);
      }

      // Check if all lanes are finished
      const lanes = db.prepare(`SELECT * FROM parallel_lanes WHERE batch_id = ?`).all(batchId);
      const allFinished = lanes.every((l) => l.status !== 'running');

      if (allFinished) {
        const batch = db.prepare(`SELECT * FROM parallel_batches WHERE id = ?`).get(batchId);
        // If reviewAgent is set, transition to 'review'; else transition to 'review' if git worktrees need merge
        const nextStatus = batch.isolation === 'worktree' ? 'review' : 'done';
        db.prepare(`UPDATE parallel_batches SET status = ?, finished_at = ? WHERE id = ?`).run(nextStatus, now, batchId);
      }

      const updatedBatch = db.prepare(`SELECT * FROM parallel_batches WHERE id = ?`).get(batchId);
      return this.getParallelBatch(updatedBatch.channel_name, updatedBatch.workspace_id);
    });
  }

  /**
   * Retry a failed lane in a batch.
   */
  retryParallelLane(batchId, agent) {
    return this.manager.transaction((db) => {
      db.prepare(`
        UPDATE parallel_lanes SET
          status = 'running',
          error = '',
          attempts = attempts + 1,
          finished_at = NULL
        WHERE batch_id = ? AND (id = ? OR agent = ?)
      `).run(batchId, agent, agent);

      db.prepare(`
        UPDATE parallel_batches SET status = 'running', finished_at = NULL WHERE id = ?
      `).run(batchId);

      const batch = db.prepare(`SELECT * FROM parallel_batches WHERE id = ?`).get(batchId);
      return this.getParallelBatch(batch.channel_name, batch.workspace_id);
    });
  }

  _execGitSync(root, args) {
    const { execFileSync } = require('child_process');
    try {
      return execFileSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], {
        windowsHide: true,
        timeout: 15000,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const error = new Error(`git ${args.join(' ')} failed: ${err.stderr ? err.stderr.toString().trim() : err.message}`);
      error.stdout = err.stdout ? err.stdout.toString() : '';
      error.stderr = err.stderr ? err.stderr.toString() : '';
      error.status = err.status;
      throw error;
    }
  }

  /**
   * Merge batch worktrees into the base branch upon user approval.
   */
  mergeParallelBatch(batchId) {
    const fs = require('fs');
    const batchRow = this.db.prepare(`SELECT * FROM parallel_batches WHERE id = ?`).get(batchId);
    if (!batchRow) throw new Error(`Batch not found: ${batchId}`);
    const lanes = this.db.prepare(`SELECT * FROM parallel_lanes WHERE batch_id = ?`).all(batchId);

    // Fail-fast if any lane is in failed or running state
    const failedLanes = lanes.filter(l => l.status === 'failed');
    if (failedLanes.length > 0) {
      throw new Error(`Cannot merge batch: ${failedLanes.length} lane(s) are in failed state. Resolve conflicts or discard before merging.`);
    }
    const runningLanes = lanes.filter(l => l.status === 'running');
    if (runningLanes.length > 0) {
      throw new Error(`Cannot merge batch: ${runningLanes.length} lane(s) are still running.`);
    }
    const conflicts = this.db.prepare(`SELECT id, file_path FROM parallel_conflicts WHERE batch_id = ?`).all(batchId);
    if (conflicts.length > 0) {
      throw new Error(`Cannot merge batch: ${conflicts.length} unresolved conflict(s) exist. Resolve conflicts or discard before merging.`);
    }

    // If git worktrees and repo_dir exist, integrate branches
    if (batchRow.repo_dir && fs.existsSync(batchRow.repo_dir)) {
      for (const lane of lanes) {
        if (lane.status === 'done' && lane.branch) {
          try {
            this._execGitSync(batchRow.repo_dir, ['merge', '--no-ff', lane.branch, '-m', `Merge lane ${lane.agent}`]);
          } catch (mergeErr) {
            // Merge failed (conflict, dirty state, etc.)
            let conflictFiles = [];
            try {
              const diffOutput = this._execGitSync(batchRow.repo_dir, ['diff', '--name-only', '--diff-filter=U']);
              if (diffOutput) {
                conflictFiles = diffOutput.trim().split(/\r?\n/).filter(Boolean);
              }
            } catch (_) {}

            // Immediately abort merge to return main repository to clean state
            try {
              this._execGitSync(batchRow.repo_dir, ['merge', '--abort']);
            } catch (_) {}

            const now = new Date().toISOString();
            const cId = `conflict-${crypto.randomUUID()}`;
            this.db.prepare(`
              INSERT INTO parallel_conflicts (id, batch_id, file_path, conflicting_lanes_json, details, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              cId,
              batchId,
              conflictFiles.join(', ') || lane.branch,
              JSON.stringify({ agent: lane.agent, branch: lane.branch, conflictFiles }),
              `Git merge conflict merging ${lane.branch}: ${mergeErr.message}`,
              now
            );

            // Mark lane as failed with merge conflict error, mark batch as blocked
            this.db.prepare(`
              UPDATE parallel_lanes SET status = 'failed', error = ? WHERE id = ?
            `).run(`Merge conflict: ${mergeErr.message}`, lane.id);

            this.db.prepare(`
              UPDATE parallel_batches SET status = 'blocked' WHERE id = ?
            `).run(batchId);

            // Crucial: DO NOT delete or force-remove worktree! Worktree preserved for manual inspection/resolution.
            throw new Error(`Git merge failed for lane ${lane.agent} on branch ${lane.branch}. Worktree preserved at ${lane.worktree_path || 'unknown'}: ${mergeErr.message}`);
          }

          // Merge succeeded! Only now clean up worktree
          if (lane.worktree_path && fs.existsSync(lane.worktree_path)) {
            try {
              this._execGitSync(batchRow.repo_dir, ['worktree', 'remove', lane.worktree_path]);
            } catch (_) {
              // Non-fatal if worktree directory was already cleaned or has harmless untracked files
            }
          }
        }
      }
    }

    const now = new Date().toISOString();
    return this.manager.transaction((db) => {
      // Mark done lanes as merged
      db.prepare(`
        UPDATE parallel_lanes SET status = 'merged' WHERE batch_id = ? AND status = 'done'
      `).run(batchId);

      // Verify that all lanes in the batch are now merged or discarded
      const unmergedCount = db.prepare(`
        SELECT COUNT(*) as count FROM parallel_lanes
        WHERE batch_id = ? AND status NOT IN ('merged', 'discarded')
      `).get(batchId).count;

      if (unmergedCount > 0) {
        db.prepare(`UPDATE parallel_batches SET status = 'blocked' WHERE id = ?`).run(batchId);
        throw new Error(`Cannot mark batch done: ${unmergedCount} lane(s) remain unmerged or in error.`);
      }

      db.prepare(`
        UPDATE parallel_batches SET status = 'done', finished_at = ? WHERE id = ?
      `).run(now, batchId);

      return this.getParallelBatch(batchRow.channel_name, batchRow.workspace_id);
    });
  }

  /**
   * Discard all lane worktrees and branches.
   */
  discardParallelBatch(batchId) {
    const fs = require('fs');
    const batchRow = this.db.prepare(`SELECT * FROM parallel_batches WHERE id = ?`).get(batchId);
    if (!batchRow) throw new Error(`Batch not found: ${batchId}`);
    const lanes = this.db.prepare(`SELECT * FROM parallel_lanes WHERE batch_id = ?`).all(batchId);

    if (batchRow.repo_dir && fs.existsSync(batchRow.repo_dir)) {
      for (const lane of lanes) {
        if (lane.worktree_path && fs.existsSync(lane.worktree_path)) {
          let hasUncommitted = false;
          try {
            const statusOutput = this._execGitSync(lane.worktree_path, ['status', '--porcelain']);
            if (statusOutput && statusOutput.trim().length > 0) {
              hasUncommitted = true;
            }
          } catch (_) {}

          if (hasUncommitted) {
            console.warn(`[Orchestration] Preserving worktree for lane ${lane.id} at ${lane.worktree_path} due to uncommitted changes.`);
          } else {
            try {
              this._execGitSync(batchRow.repo_dir, ['worktree', 'remove', lane.worktree_path]);
            } catch (_) {}
          }
        }
        if (lane.branch) {
          try {
            this._execGitSync(batchRow.repo_dir, ['branch', '-D', lane.branch]);
          } catch (_) {}
        }
      }
    }

    const now = new Date().toISOString();
    return this.manager.transaction((db) => {
      db.prepare(`
        UPDATE parallel_lanes SET status = 'discarded' WHERE batch_id = ?
      `).run(batchId);

      db.prepare(`
        UPDATE parallel_batches SET status = 'done', finished_at = ? WHERE id = ?
      `).run(now, batchId);

      return this.getParallelBatch(batchRow.channel_name, batchRow.workspace_id);
    });
  }

  /**
   * Stop running batch.
   */
  stopParallelBatch(batchId) {
    const now = new Date().toISOString();
    return this.manager.transaction((db) => {
      db.prepare(`
        UPDATE parallel_lanes SET status = 'failed', error = 'Stopped by user', finished_at = ?
        WHERE batch_id = ? AND status = 'running'
      `).run(now, batchId);

      db.prepare(`
        UPDATE parallel_batches SET status = 'done', finished_at = ? WHERE id = ?
      `).run(now, batchId);

      const batch = db.prepare(`SELECT * FROM parallel_batches WHERE id = ?`).get(batchId);
      return this.getParallelBatch(batch.channel_name, batch.workspace_id);
    });
  }

  /**
   * Lane Review operations (N3: 审阅、意见退回与最终集成)
   */
  retryLaneReview(batchId, agent) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE parallel_lanes SET review_status = 'running', review_started_at = ?
      WHERE batch_id = ? AND (id = ? OR agent = ?)
    `);
    stmt.run(now, batchId, agent, agent);
  }

  completeLaneReview(batchId, agent, {
    status = 'approved',
    notes = '',
    reviewer = 'reviewer',
    info = '',
  } = {}) {
    const stmt = this.db.prepare(`
      UPDATE parallel_lanes SET
        review_status = ?,
        review_notes = ?,
        reviewer = ?,
        review_info = ?
      WHERE batch_id = ? AND (id = ? OR agent = ?)
    `);
    stmt.run(status, notes, reviewer, info, batchId, agent, agent);
  }

  sendBackParallelLane(batchId, agent) {
    const stmt = this.db.prepare(`
      UPDATE parallel_lanes SET
        status = 'running',
        review_status = 'changes_requested',
        finished_at = NULL
      WHERE batch_id = ? AND (id = ? OR agent = ?)
    `);
    stmt.run(batchId, agent, agent);
  }

  // -------------------------------------------------------------
  // Normalization Helpers
  // -------------------------------------------------------------

  _normalizeProfile(row) {
    let allowedTools = [];
    if (row.allowed_tools_json) {
      try {
        allowedTools = JSON.parse(row.allowed_tools_json);
      } catch (_) {}
    }
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      workspaceId: row.workspace_id,
      name: row.name,
      agent: row.agent,
      role: row.role,
      model: row.model,
      mode: row.mode,
      description: row.description,
      allowed_tools: allowedTools,
      allowedTools,
      allowed_tools_json: row.allowed_tools_json || '[]',
      budget_tokens: row.budget_tokens,
      budget_cost_micros: row.budget_cost_micros,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  _normalizeBatch(row) {
    return {
      runtime_version: row.runtime_version || 0,
      base_commit: row.base_commit || '',
      id: row.id,
      workspace_id: row.workspace_id,
      workspaceId: row.workspace_id,
      channel_name: row.channel_name,
      channelName: row.channel_name,
      parent_run_id: row.parent_run_id,
      isolation: row.isolation,
      origin: row.origin,
      repo_dir: row.repo_dir,
      base_branch: row.base_branch,
      status: row.status,
      summary: row.summary,
      review_agent: row.review_agent,
      delegated_by: row.delegated_by,
      total_budget_tokens: row.total_budget_tokens,
      used_tokens: row.used_tokens,
      created_at: row.created_at,
      finished_at: row.finished_at,
    };
  }

  _normalizeLane(row) {
    return {
      agent_id: row.agent_id || null,
      agent_name: row.agent_snapshot_json ? JSON.parse(row.agent_snapshot_json).name : row.agent,
      context_key: row.context_key || null,
      delivery: row.delivery_json ? JSON.parse(row.delivery_json) : null,
      used_tokens: row.used_tokens || 0,
      id: row.id,
      batch_id: row.batch_id,
      agent: row.agent,
      role: row.role,
      task: row.task,
      scope: row.scope,
      worktree_path: row.worktree_path,
      branch: row.branch,
      status: row.status,
      error: row.error,
      commit: row.commit_hash,
      commit_hash: row.commit_hash,
      reply: row.reply,
      diffstat: row.diffstat,
      changed_files: row.changed_files,
      attempts: row.attempts,
      port: row.port,
      started_at: row.started_at,
      finished_at: row.finished_at,
      review_status: row.review_status,
      reviewer: row.reviewer,
      review_notes: row.review_notes,
      review_info: row.review_info,
      review_channel: row.review_channel,
      reviewed_commit: row.reviewed_commit,
      review_started_at: row.review_started_at,
      profile: row.profile,
      mode: row.mode,
      model: row.model,
    };
  }
}

module.exports = { OrchestrationRepository };
