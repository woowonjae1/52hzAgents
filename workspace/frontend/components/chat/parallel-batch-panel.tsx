'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, GitMerge, GitBranch, XCircle, RotateCw, PauseCircle, Trash2, FileDiff, ShieldCheck, Clock, SkipForward, Undo2, MessagesSquare, Ban, FolderMinus, Check, X, FileText, Plus, Bot, Video, FileCode } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import type { ParallelBatch, ParallelWorker, ParallelRun, ParallelLane, LaneReviewStatus, DeliveryDiffResult, EvidenceCitation } from '@/lib/api/orchestration';
import type { AgentDefinition } from '@/lib/api/agent-definitions';
import { useWorkspace } from '@/lib/workspace-context';
import { toast } from '@/lib/toast';

/**
 * What a parallel batch is doing, as lanes.
 *
 * In every other mode the transcript IS the progress: one agent speaks at a
 * time, so reading top to bottom tells you where things stand. Parallel breaks
 * that — several agents write into one thread at once, and "who has what, how
 * far along" stops being legible by reading. This panel is that missing view:
 * one lane per assignee, their scope, and their progress.
 *
 * It also shows the batch refusing to start. A blocked batch is not an error
 * state to hide; it is the mode doing its job, and the user needs to see which
 * two scopes overlap in order to fix the split.
 */

interface Props {
  channelName: string;
  /** Only rendered for a thread actually in parallel mode. */
  active: boolean;
  className?: string;
  onReviewStateChange?: (reviewNeeded: boolean) => void;
}

const POLL_MS = 4000;

export function ParallelBatchPanel({ channelName, active, className, onReviewStateChange }: Props) {
  const [batch, setBatch] = React.useState<ParallelBatch | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const isReviewing = Boolean(batch?.run?.batch.status === 'review');
  React.useEffect(() => {
    onReviewStateChange?.(isReviewing);
  }, [isReviewing, onReviewStateChange]);

  React.useEffect(() => {
    if (!channelName) {
      setBatch(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const next = await workspaceApi.getParallelBatch(channelName);
        if (!cancelled) {
          if ((next as ParallelBatch & { supported?: boolean })?.supported === false) {
            setBatch(null);
            setError(null);
            return;
          }
          const isLiveOrReview = next?.run && ['running', 'review', 'blocked', 'cancelled'].includes(next.run.batch.status);
          if (active || isLiveOrReview) {
            setBatch(next);
          } else {
            setBatch(null);
          }
          setError(null);
        }
      } catch (e) {
        // A failed poll must not blank a batch that is on screen — showing
        // stale lanes beats flashing empty every time a request drops.
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the batch');
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [channelName, active]);

  if (!batch) return null;

  const run = batch.run;
  // A batch under review still owns the channel -- no new batch can start
  // until it is merged or discarded -- so the next-batch preview stays hidden.
  const runLive = Boolean(run && ['running', 'review', 'blocked', 'cancelled'].includes(run.batch.status));
  if (!active && !runLive) return null;
  const reload = async () => {
    try {
      setBatch(await workspaceApi.getParallelBatch(channelName));
    } catch {}
  };

  /*
    An empty board in parallel mode is the one state that must not render
    nothing. Switching to Parallel and seeing no change is what made the mode
    feel like it did not exist — so when there is nothing to run, this says what
    the mode is waiting for instead of disappearing.
  */
  if (batch.total === 0 && !run) {
    return (
      <div
        className={cn(
          'rounded-lg border border-dashed border-border bg-surface-raised/40 p-3',
          className
        )}
      >
        <p className="text-xs font-medium text-foreground">等待分配协作任务与材料</p>
        <p className="text-2xs text-muted-foreground mt-1 leading-snug">
          在消息中提及多个 Agent（如 <code className="text-2xs">@antigravity 分析视频 @pi 阅读规范 @codex 检查项目</code>）或点击下方分配任务，成员将立即并行处理。{' '}
          {batch.isolated
            ? '本项目已配置 Git 仓库，代码任务可在独立工作副本中并行修改，确认后合入项目。'
            : '普通任务将在当前工作区直接运行；涉及代码修改的任务可启用独立工作副本隔离。'}
        </p>
        {batch.isolated && (
          <ReviewSetting channelName={channelName} value={batch.review_agent} onSaved={reload} className="mt-2" />
        )}
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 shadow-xs"
          >
            <Plus className="size-3.5" />
            <span>分配协作任务并启动批次</span>
          </button>
        </div>
        {createOpen && (
          <CreateParallelBatchModal
            channelName={channelName}
            isIsolated={Boolean(batch.isolated)}
            onClose={() => setCreateOpen(false)}
            onCreated={reload}
          />
        )}
      </div>
    );
  }

  // A batch that is running, or the last one's result, shown lane by lane.
  // The board preview below is the NEXT batch, so it is hidden while one runs.
  const showBoard = batch.total > 0 && !runLive;

  return (
    <div className={cn('space-y-2', className)}>
    {run && (
      <RunView
        run={run}
        onRetried={reload}
        onNewBatch={() => setCreateOpen(true)}
        setting={
          batch.isolated ? <ReviewSetting channelName={channelName} value={batch.review_agent} onSaved={reload} /> : null
        }
      />
    )}
    {showBoard && (
    <div className="rounded-lg border border-border bg-surface-raised/60 p-3">
      <header className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground">Working in parallel</span>
          <StateBadge state={batch.state} />
        </div>
        <span className="text-2xs tabular-nums text-muted-foreground shrink-0">
          {batch.done}/{batch.total} done
        </span>
      </header>

      {batch.state === 'blocked' && (
        <div className="mb-2.5 rounded-md border border-status-warning/40 bg-status-warning/10 p-2">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="size-3.5 text-status-warning shrink-0" />
            <span className="text-2xs font-medium text-foreground">
              Not started — the work is not divided cleanly
            </span>
          </div>
          <ul className="space-y-0.5 pl-5">
            {batch.conflicts.map((conflict, index) => (
              <li key={index} className="text-2xs text-muted-foreground leading-snug">
                <span className="text-foreground">{conflict.assignee_a}</span>{' '}
                <code className="text-2xs">{conflict.scope_a}</code> ↔{' '}
                <span className="text-foreground">{conflict.assignee_b}</span>{' '}
                <code className="text-2xs">{conflict.scope_b}</code> — {conflict.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        {batch.workers.map((worker) => (
          <Lane key={worker.assignee} worker={worker} blocked={batch.state === 'blocked'} />
        ))}
      </div>

      {batch.isolated && (
        <ReviewSetting channelName={channelName} value={batch.review_agent} onSaved={reload} className="mt-2.5" />
      )}

      {error && <p className="mt-2 text-2xs text-muted-foreground">Last refresh failed: {error}</p>}
    </div>
    )}
      {createOpen && (
        <CreateParallelBatchModal
          channelName={channelName}
          isIsolated={Boolean(batch?.isolated)}
          onClose={() => setCreateOpen(false)}
          onCreated={reload}
        />
      )}
    </div>
  );
}

const LANE_STATUS: Record<ParallelLane['status'], { label: string; icon: React.ElementType; className: string }> = {
  running: { label: 'Working', icon: Loader2, className: 'text-status-info' },
  done: { label: '已交付', icon: CheckCircle2, className: 'text-status-success' },
  merged: { label: 'Merged', icon: GitMerge, className: 'text-status-success' },
  kept: { label: 'Branch kept', icon: PauseCircle, className: 'text-status-warning' },
  conflict: { label: 'Conflict', icon: AlertTriangle, className: 'text-status-warning' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-status-danger' },
  discarded: { label: 'Discarded', icon: Trash2, className: 'text-muted-foreground' },
};

/**
 * The batch that actually ran: one row per agent with what became of its work.
 * A failed lane can be run again on its own worktree without touching the rest.
 */
function RunView({ run, onRetried, onNewBatch, setting }: { run: ParallelRun; onRetried: () => void; onNewBatch?: () => void; setting?: React.ReactNode }) {
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const [deciding, setDeciding] = React.useState<'merge' | 'discard' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [cleaning, setCleaning] = React.useState(false);
  const [selectedDiffLane, setSelectedDiffLane] = React.useState<ParallelLane | null>(null);
  const [budgetConfirm,setBudgetConfirm]=React.useState(false);
  const [budgetBusy,setBudgetBusy]=React.useState(false);

  const cleanWorktrees = async () => {
    setCleaning(true);
    try {
      await workspaceApi.cleanupParallelBatch(run.batch.id);
      toast.success('已清理该批次临时托管工作区');
      onRetried();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清理工作区失败');
    } finally {
      setCleaning(false);
    }
  };
  const live = run.batch.status === 'running';
  const reviewing = run.batch.status === 'review';
  const finished = run.lanes.filter((l) => l.status !== 'running').length;
  const base = run.batch.base_branch || 'the base branch';
  const reviewsRunning = run.lanes.filter((l) => l.review_status === 'running').length;

  // Discard is a two-step click: it deletes every lane's worktree and branch,
  // and the second click has to be deliberate.
  React.useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => {
      setConfirmDiscard(false);
    }, 4000);
    return () => clearTimeout(t);
  }, [confirmDiscard]);

  const stopBatch = async () => {
    setStopping(true);
    try {
      await workspaceApi.stopParallelBatch(run.batch.id);
      toast.success('Parallel batch stopped');
      onRetried();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not stop batch');
    } finally {
      setStopping(false);
    }
  };

  const decide = async (action: 'merge' | 'discard') => {
    setDeciding(action);
    try {
      if (action === 'merge') {
        await workspaceApi.mergeParallelBatch(run.batch.id,run.lanes.map(lane=>({id:lane.id,commit:lane.commit_hash || '',version:lane.delivery_version || 0})));
        toast.success(`Merging into ${base}`);
      } else {
        await workspaceApi.discardParallelBatch(run.batch.id);
        toast.success('Batch discarded');
      }
      onRetried();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not ${action}`);
    } finally {
      setDeciding(null);
      setConfirmDiscard(false);
    }
  };

  const retry = async (agent: string) => {
    setRetrying(agent);
    try {
      await workspaceApi.retryParallelLane(run.batch.id, agent);
      toast.success(`Retrying @${agent}`);
      onRetried();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not retry');
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border bg-surface-raised/60 p-3">
      {run.batch.native_budget_policy && <div className="mb-3 rounded-md border border-border p-3 text-xs">
        <p className="font-medium">本批次原生配额管理 · {run.batch.native_budget_policy.valid?'已确认':'配置已变化，需要重新确认'}</p>
        <p className="mt-1 text-foreground-muted">{run.batch.native_budget_policy.notice}</p>
        {run.batch.accounting && <p className="mt-1 text-foreground-muted">{run.batch.accounting.tokensKnown?'返回的 Token 用量已记录':'存在未知 Token 用量，仅显示已知部分'} · {run.batch.accounting.costKnown?`累计费用 $${run.batch.accounting.estimatedCost?.toFixed(4)}`:'累计费用待核算'}</p>}
        {!run.batch.native_budget_policy.valid && <>
          <label className="mt-2 flex gap-2"><input type="checkbox" checked={budgetConfirm} onChange={e=>setBudgetConfirm(e.target.checked)} />我确认仅本批次继续使用原生配额，Token、步数与费用无法逐请求硬拦截。</label>
          <button type="button" disabled={!budgetConfirm || budgetBusy} className="mt-2 rounded border border-border px-2 py-1 disabled:opacity-40" onClick={async()=>{setBudgetBusy(true);try{await workspaceApi.authorizeBatchNativeBudget(run.batch.id);onRetried();setBudgetConfirm(false);}catch(e){toast.error(e instanceof Error?e.message:'确认失败');}finally{setBudgetBusy(false);}}}>重新确认本批次策略</button>
        </>}
      </div>}
      <header className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground">
            {live ? 'Working in parallel' : reviewing ? (run.lanes.some(l=>l.review_status==='changes_requested')?'等待修改与复审':run.lanes.every(l=>l.review_status==='approved')?'等待人工验收':'等待审阅') : 'Last parallel batch'}
          </span>
          {run.batch.delegated_by && (
            <span className="text-2xs text-foreground shrink-0" title="An agent delegated this work; it is told when the lanes finish.">
              delegated by @{run.batch.delegated_by}
            </span>
          )}
          <span className="text-2xs text-muted-foreground truncate">
            {reviewing
              ? `未合并入 ${base}`
              : run.batch.isolation === 'worktree'
              ? `独立工作副本${run.batch.base_branch ? ` · 确认后合入 ${run.batch.base_branch}` : ''}`
              : '常规工作区'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-2xs tabular-nums text-muted-foreground">
            {finished}/{run.lanes.length} 已交付
          </span>
          {live && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stopBatch()}
              className="inline-flex items-center gap-1 rounded-md border border-status-danger/40 bg-status-danger/10 px-2 py-0.5 text-2xs text-status-danger hover:bg-status-danger/20 transition-colors disabled:opacity-60"
            >
              {stopping ? <Loader2 className="size-3 animate-spin" /> : <XCircle className="size-3" />}
              Stop Batch
            </button>
          )}
        </div>
      </header>
      {setting && <div className="mb-2.5">{setting}</div>}
      <ul className="space-y-2">
        {run.lanes.map((lane) => {
          const st =
            reviewing && lane.status === 'done' && lane.diffstat && lane.review_status==='approved' && lane.reviewed_version===lane.delivery_version
              ? { label: '已审阅，待验收', icon: FileDiff, className: 'text-status-info' }
              : LANE_STATUS[lane.status] ?? LANE_STATUS.running;
          const Icon = st.icon;
          const firstLine = lane.task.replace(/^- /, '').split(/\r?\n/)[0];
          return (
            <li key={lane.id} className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', st.className, lane.status === 'running' && 'animate-spin')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-baseline gap-1.5 min-w-0">
                    <span className="text-2xs font-medium text-foreground truncate" title={lane.agent_id}>{lane.agent_name || lane.agent}</span>
                    {(lane.profile || lane.mode === 'plan') && (
                      <span
                        className="text-2xs text-muted-foreground shrink-0"
                        title={[
                          lane.profile && `Profile ${lane.profile}`,
                          lane.mode === 'plan' && 'Review: read-only',
                          lane.model && `Model ${lane.model}`,
                        ].filter(Boolean).join(' · ')}
                      >
                        {[lane.profile, lane.mode === 'plan' && 'Review'].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    {lane.port ? (
                      <code className="text-2xs text-muted-foreground shrink-0" title="Dev-server port for this lane">
                        :{lane.port}
                      </code>
                    ) : null}
                  </span>
                  <span className={cn('text-2xs shrink-0', st.className)}>
                    {st.label}
                    {lane.attempts > 1 ? ` · attempt ${lane.attempts}` : ''}
                  </span>
                </div>
                <p className="text-2xs text-muted-foreground truncate" title={lane.task}>
                  {firstLine}
                </p>
                {/* Capability & Phase Badge */}
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  {/video|视频|字幕|帧/.test(lane.task.toLowerCase()) ? (
                    <span className="inline-flex items-center gap-1 text-3xs font-mono px-1.5 py-0.5 rounded bg-surface2 text-primary border border-primary/20">
                      <Video className="size-2.5" />
                      <span>分析字幕与关键画面</span>
                    </span>
                  ) : /doc|spec|规范|文档|rfc/.test(lane.task.toLowerCase()) ? (
                    <span className="inline-flex items-center gap-1 text-3xs font-mono px-1.5 py-0.5 rounded bg-surface2 text-status-info border border-status-info/20">
                      <FileText className="size-2.5" />
                      <span>阅读规范与文档原文</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-3xs font-mono px-1.5 py-0.5 rounded bg-surface2 text-muted-foreground border border-border">
                      <FileCode className="size-2.5" />
                      <span>独立工作副本</span>
                    </span>
                  )}
                  {lane.delivery_version ? (
                    <span className="text-3xs font-mono text-muted-foreground">
                      成果 v{lane.delivery_version}
                    </span>
                  ) : null}
                </div>
                {/* Evidence & Citations */}
                {lane.delivery?.citations && lane.delivery.citations.length > 0 && (
                  <div className="mt-2 p-2 rounded-lg border border-border/70 bg-surface0/90 space-y-1.5">
                    <div className="flex items-center justify-between text-3xs font-medium text-foreground-muted">
                      <span>依据与引用片段 ({lane.delivery.citations.length})</span>
                      <span className="text-4xs text-foreground-extra-muted">可直接追问或交接</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {lane.delivery.citations.map((cite) => (
                        <CitationPill
                          key={cite.id}
                          citation={cite}
                          onFollowUp={(text) => {
                            const inputEl = document.querySelector('textarea[placeholder*="Ask"], textarea[placeholder*="输入"]') as HTMLTextAreaElement | null;
                            if (inputEl) {
                              inputEl.value = text;
                              inputEl.focus();
                            }
                            toast.success('已载入依据片段，可直接追问');
                          }}
                          onHandoff={() => {
                            const other = run.lanes.find((l) => l.id !== lane.id);
                            const target = other?.agent_name || other?.agent || 'codex';
                            void workspaceApi.handoffParallelLane(run.batch.id, lane.id || lane.agent, {
                              target_agent: target,
                              deliverable_version: lane.delivery_version || 1,
                              citations: [cite],
                              notes: `基于【${cite.label}】依据推进实现`,
                            }).then(() => {
                              toast.success(`已携带依据交接给 @${target}`);
                              onRetried();
                            }).catch((err) => toast.error(err instanceof Error ? err.message : '交接失败'));
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {/* Handoff Status & Quick Actions */}
                {lane.status === 'done' && (
                  <LaneHandoffBar
                    batchId={run.batch.id}
                    lane={lane}
                    allLanes={run.lanes}
                    onHandoffSuccess={onRetried}
                  />
                )}
                {lane.branch && lane.status !== 'merged' && (
                  <code className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground truncate">
                    <GitBranch className="size-3 shrink-0" />
                    {lane.branch}
                  </code>
                )}
                {lane.commit_hash && (
                  <div className="mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedDiffLane(lane)}
                      className="inline-flex items-center gap-1 text-2xs text-primary hover:underline font-mono"
                      title="查看此任务交付的代码改动 Diff"
                    >
                      <FileDiff className="size-3" />
                      <span>查看改动 {lane.commit_hash.slice(0, 7)}</span>
                    </button>
                  </div>
                )}
                {reviewing && lane.diffstat && (
                  <details className="mt-0.5 group">
                    <summary className="cursor-pointer list-none text-2xs text-muted-foreground hover:text-foreground">
                      {lane.diffstat}
                    </summary>
                    {lane.changed_files && (
                      <ul className="mt-0.5 space-y-px pl-3">
                        {lane.changed_files.split('\n').map((f) => (
                          <li key={f}>
                            <code className="text-2xs text-muted-foreground break-all">{f}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )}
                {lane.error && <p className="mt-0.5 text-2xs text-status-danger/90 leading-snug">{lane.error}</p>}
                {lane.status === 'failed' && (
                  <button
                    type="button"
                    disabled={retrying === (lane.id || lane.agent)}
                    onClick={() => void retry(lane.id || lane.agent)}
                    className="mt-1 inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-muted disabled:opacity-60"
                  >
                    <RotateCw className={cn('size-3', retrying === (lane.id || lane.agent) && 'animate-spin')} />
                    Retry this part
                  </button>
                )}
                {(lane.review_status || lane.status === 'done') && (
                  <LaneReview lane={lane} actionable={lane.status === 'done'} batchId={run.batch.id} onChanged={onRetried} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {(reviewing || run.batch.status === 'blocked' || run.batch.status === 'cancelled' || run.batch.status === 'done') && (
        <footer className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2.5">
          {onNewBatch && (run.batch.status === 'done' || run.batch.status === 'cancelled') && (
            <button
              type="button"
              onClick={onNewBatch}
              className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-2xs text-primary hover:bg-primary/20 font-medium"
            >
              <Plus className="size-3" />
              <span>新建协作批次</span>
            </button>
          )}
          {(run.batch.status === 'done' || run.batch.status === 'cancelled') && (
            <button
              type="button"
              disabled={cleaning}
              onClick={() => void cleanWorktrees()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-2xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-60"
              title="清理此批次的临时 Git 工作区，历史执行记录将完整保留"
            >
              {cleaning ? <Loader2 className="size-3 animate-spin" /> : <FolderMinus className="size-3" />}
              <span>清理工作区</span>
            </button>
          )}
          <button
            type="button"
            disabled={deciding !== null}
            onClick={() => (confirmDiscard ? void decide('discard') : setConfirmDiscard(true))}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs disabled:opacity-60',
              confirmDiscard
                ? 'border-status-danger/60 text-status-danger hover:bg-status-danger/10'
                : 'border-border text-foreground hover:bg-muted'
            )}
          >
            <Trash2 className="size-3" />
            {confirmDiscard ? 'Click again to discard all' : 'Discard'}
          </button>
          {reviewing && <button
            type="button"
            disabled={deciding !== null || reviewsRunning > 0 || run.lanes.some(lane => lane.review_status !== 'approved' || lane.reviewed_version !== lane.delivery_version)}
            onClick={() => void decide('merge')}
            className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-2xs font-medium text-background hover:opacity-90 disabled:opacity-60"
          >
            {deciding === 'merge' ? <Loader2 className="size-3 animate-spin" /> : <GitMerge className="size-3" />}
            {reviewsRunning > 0 ? 'Waiting for review' : `Merge into ${base}`}
          </button>}
        </footer>
      )}
          {selectedDiffLane && (
        <LaneDeliveryDiffModal
          batchId={run.batch.id}
          lane={selectedDiffLane}
          onClose={() => setSelectedDiffLane(null)}
        />
      )}
    </div>
  );
}

const REVIEW_STATUS: Record<Exclude<LaneReviewStatus, ''>, { label: (reviewer: string) => string; icon: React.ElementType; className: string }> = {
  running: { label: (r) => `Reviewing · @${r}`, icon: Loader2, className: 'text-status-info' },
  approved: { label: (r) => `Approved by @${r}`, icon: ShieldCheck, className: 'text-status-success' },
  changes_requested: { label: (r) => `Changes requested by @${r}`, icon: AlertTriangle, className: 'text-status-warning' },
  failed: { label: () => 'Review failed', icon: XCircle, className: 'text-status-danger' },
  timed_out: { label: () => 'Review timed out', icon: Clock, className: 'text-status-warning' },
  skipped: { label: () => 'Review skipped', icon: SkipForward, className: 'text-muted-foreground' },
  cancelled: { label: () => 'Review cancelled', icon: Ban, className: 'text-muted-foreground' },
};

/**
 * Another agent's verdict on one lane, read before the user merges.
 *
 * The verdict is a chip; the notes fold open, because they are the part the
 * user reads to decide and the part the author gets if it goes back. Send back
 * and Retry act on this lane only; Merge stays the batch's, and the user's.
 */
function LaneReview({
  lane,
  actionable,
  batchId,
  onChanged,
}: {
  lane: ParallelLane;
  actionable: boolean;
  batchId: string;
  onChanged: () => void;
}) {
  const { setCurrentSessionId } = useWorkspace();
  const [busy, setBusy] = React.useState<'send' | 'retry' | 'review' | null>(null);
  const [manualReviewOpen, setManualReviewOpen] = React.useState(false);
  const [manualTarget,setManualTarget]=React.useState<{expected_commit:string;expected_version:number}|null>(null);
  React.useEffect(()=>{setManualReviewOpen(false);setManualTarget(null);},[lane.commit_hash,lane.delivery_version]);
  const [manualNotes, setManualNotes] = React.useState('');
  const status = lane.review_status;

  const submitHumanReview = async (verdict: 'approved' | 'changes_requested') => {
    if(!manualTarget)return;
    setBusy('review');
    try {
      await workspaceApi.completeLaneReview(batchId, lane.id || lane.agent, {
        verdict,
        notes: manualNotes.trim() || undefined,
        ...manualTarget,
      });
      toast.success(verdict === 'approved' ? '已通过该交付' : '已要求修改该交付');
      setManualReviewOpen(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交审阅失败');
    } finally {
      setBusy(null);
    }
  };
  if (!status && lane.status !== 'done') return null;
  const st = (status && REVIEW_STATUS[status]) ? REVIEW_STATUS[status] : {
    label: () => '待审阅 (Awaiting Review)',
    icon: Clock,
    className: 'text-foreground-muted',
  };
  const Icon = st.icon;
  const notes = lane.review_notes.trim();
  const canSendBack = actionable && status === 'changes_requested' && notes !== '';
  const canRetry = actionable && (status === 'failed' || status === 'timed_out' || status === 'skipped' || status === 'cancelled');

  const act = async (action: 'send' | 'retry') => {
    setBusy(action);
    try {
      if (action === 'send') {
        await workspaceApi.sendBackParallelLane(batchId, lane.id || lane.agent, {expected_commit:lane.commit_hash || '',expected_version:lane.delivery_version || 0});
        toast.success(`Sent back to ${lane.agent_name || lane.agent} with the review`);
      } else {
        await workspaceApi.retryLaneReview(batchId, lane.id || lane.agent);
        toast.success(`Reviewing ${lane.agent_name || lane.agent}'s part again`);
      }
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not do that');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1 rounded-md border border-border/70 bg-background/40 px-2 py-1.5">
      <p className="mb-1 text-2xs text-foreground-muted">交付 v{lane.delivery_version || 0} · {lane.commit_hash?.slice(0,8)}</p>
      {!!lane.review_history?.length && <details className="mb-2 text-2xs text-foreground-muted"><summary className="cursor-pointer">审阅与验证记录 ({lane.review_history.length})</summary>
        {lane.review_history.map(review=><div key={review.id} className="mt-2 border-t border-border pt-2"><p>v{review.delivery_version} · {review.delivery_commit.slice(0,8)} · {review.reviewer_id} · {review.verdict}</p><p className="whitespace-pre-wrap">{review.notes}</p>
          {review.verification.worktree && <p className="break-all font-mono">检视工作区：{review.verification.worktree}</p>}
          {review.verification.commands?.map((command,index)=><p key={index} className="font-mono">{command.command} · {command.exitCode===undefined?'退出结果未知':`exit ${command.exitCode}`}</p>)}</div>)}
      </details>}
      <div className="flex items-center gap-1.5 min-w-0">
        <Icon className={cn('size-3 shrink-0', st.className, status === 'running' && 'animate-spin')} />
        <span className={cn('text-2xs font-medium shrink-0', st.className)}>{st.label(lane.reviewer)}</span>
        {lane.review_info && (
          <span className="text-2xs text-muted-foreground truncate" title={lane.review_info}>
            · {lane.review_info}
          </span>
        )}
      </div>
      {notes && (
        <details className="mt-1 group" open={status === 'changes_requested'}>
          <summary className="cursor-pointer list-none text-2xs text-muted-foreground hover:text-foreground">
            Review notes
          </summary>
          <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-2xs leading-snug text-foreground/90">
            {notes}
          </p>
        </details>
      )}
            {manualReviewOpen && (
        <div className="mt-2 p-2.5 rounded-lg border border-border/80 bg-surface0 space-y-2 text-2xs font-sans">
          <p className="font-semibold text-foreground">人工审阅交付结果</p>
          <textarea
            value={manualNotes}
            onChange={(e) => setManualNotes(e.target.value)}
            placeholder="通过时意见可选；要求修改时请填写具体反馈。"
            rows={2}
            className="w-full rounded-md border border-border bg-surface1 p-1.5 text-3xs text-foreground resize-y"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={busy !== null || !manualNotes.trim()}
              onClick={() => void submitHumanReview('changes_requested')}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-3xs border border-status-warning/40 text-status-warning hover:bg-status-warning/10 disabled:opacity-60"
            >
              <AlertTriangle className="size-2.5" />
              <span>要求修改</span>
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void submitHumanReview('approved')}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-3xs bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {busy === 'review' ? <Loader2 className="size-2.5 animate-spin" /> : <Check className="size-2.5" />}
              <span>通过 (Approve)</span>
            </button>
          </div>
        </div>
      )}
      {(actionable || canSendBack || canRetry || lane.review_channel) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {actionable && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {setManualTarget({expected_commit:lane.commit_hash || '',expected_version:lane.delivery_version || 0});setManualReviewOpen(!manualReviewOpen);}}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-muted disabled:opacity-60 font-medium"
            >
              <ShieldCheck className="size-3 text-primary" />
              <span>人工审阅</span>
            </button>
          )}
          {canSendBack && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act('send')}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-muted disabled:opacity-60"
            >
              {busy === 'send' ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
              Send back to {lane.agent_name || lane.agent}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act('retry')}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-muted disabled:opacity-60"
            >
              <RotateCw className={cn('size-3', busy === 'retry' && 'animate-spin')} />
              Retry review
            </button>
          )}
          {lane.review_channel && (
            <button
              type="button"
              onClick={() => setCurrentSessionId(lane.review_channel)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <MessagesSquare className="size-3" />
              Open review thread
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The thread's "review before merge" setting: who reads each lane's changes
 * before the user is asked to merge. Off, or an agent; the backend never lets
 * a lane's author review itself and falls back to another online agent.
 */

function CitationPill({
  citation,
  onFollowUp,
  onHandoff,
}: {
  citation: EvidenceCitation;
  onFollowUp: (text: string) => void;
  onHandoff: () => void;
}) {
  const [detailOpen, setDetailOpen] = React.useState(false);
  const icon = citation.type === 'video' ? '🎬' : citation.type === 'doc' ? '📄' : '💻';

  return (
    <div className="relative inline-flex items-center rounded-md border border-border bg-surface1 px-2 py-0.5 text-2xs hover:border-primary/40 transition-colors">
      <button
        type="button"
        onClick={() => setDetailOpen(!detailOpen)}
        className="flex items-center gap-1 font-mono text-foreground hover:text-primary mr-1 cursor-pointer"
        title={citation.quote || citation.label}
      >
        <span>{icon}</span>
        <span className="font-semibold underline decoration-dashed underline-offset-2">{citation.label}</span>
      </button>

      <div className="flex items-center gap-1 border-l border-border/80 pl-1.5 ml-0.5">
        <button
          type="button"
          onClick={() => onFollowUp(`关于【${citation.label}】（来源：成果 v${citation.version || 1}）：“${citation.quote || ''}”\n请基于此处深入分析：`)}
          className="text-3xs text-muted-foreground hover:text-foreground font-sans hover:underline cursor-pointer"
          title="以此片段追问当前 Agent"
        >
          以此追问
        </button>
        <span className="text-border">·</span>
        <button
          type="button"
          onClick={onHandoff}
          className="text-3xs text-primary hover:underline font-sans cursor-pointer font-medium"
          title="将此依据与成果交接给下游 Agent"
        >
          发给下游
        </button>
      </div>

      {detailOpen && citation.quote && (
        <div className="absolute bottom-full left-0 mb-1 z-30 w-72 p-2.5 rounded-lg border border-border bg-surface-raised shadow-xl text-3xs font-sans space-y-1">
          <div className="font-semibold text-foreground flex items-center justify-between">
            <span>{citation.label} 原文与证据</span>
            <button type="button" onClick={() => setDetailOpen(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">✕</button>
          </div>
          <p className="text-foreground-muted whitespace-pre-wrap max-h-36 overflow-y-auto font-mono bg-surface0 p-1.5 rounded">
            {citation.quote}
          </p>
        </div>
      )}
    </div>
  );
}

function LaneHandoffBar({
  batchId,
  lane,
  allLanes,
  onHandoffSuccess,
}: {
  batchId: string;
  lane: ParallelLane;
  allLanes: ParallelLane[];
  onHandoffSuccess: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [targetAgent, setTargetAgent] = React.useState('codex');
  const [openModal, setOpenModal] = React.useState(false);
  const [notes, setNotes] = React.useState('');

  const latestHandoff = lane.delivery?.latestHandoff;
  const currentVersion = lane.delivery_version || 1;
  const isStale = latestHandoff && currentVersion > latestHandoff.version;

  const otherLanes = allLanes.filter((l) => l.id !== lane.id);

  const doHandoff = async (agentName: string, customNotes?: string) => {
    setBusy(true);
    try {
      await workspaceApi.handoffParallelLane(batchId, lane.id || lane.agent, {
        target_agent: agentName,
        deliverable_version: currentVersion,
        notes: customNotes,
        citations: lane.delivery?.citations,
      });
      toast.success(`已交接成果 v${currentVersion} 给 @${agentName}`);
      setOpenModal(false);
      onHandoffSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '交接失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
      {/* Existing handoff status */}
      {latestHandoff && (
        <div className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-3xs font-sans',
          isStale
            ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
            : 'border-status-success/30 bg-status-success/10 text-status-success'
        )}>
          {isStale ? (
            <>
              <AlertTriangle className="size-2.5" />
              <span>上游有新版 v{currentVersion}，尚未交接（当前交接为 v{latestHandoff.version}）</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void doHandoff(latestHandoff.targetAgent)}
                className="underline font-semibold ml-1 hover:text-foreground cursor-pointer"
              >
                交接最新版
              </button>
            </>
          ) : (
            <>
              <Check className="size-2.5" />
              <span>已发送给 @{latestHandoff.targetAgent} · 成果 v{latestHandoff.version}</span>
            </>
          )}
        </div>
      )}

      {/* Trigger new handoff */}
      {(!latestHandoff || isStale) && (
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void doHandoff(targetAgent)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 font-medium cursor-pointer"
          >
            {busy ? <Loader2 className="size-2.5 animate-spin" /> : <GitMerge className="size-2.5" />}
            <span>交给 @{targetAgent} 继续实现</span>
          </button>

          {otherLanes.length > 1 && (
            <select
              value={targetAgent}
              onChange={(e) => setTargetAgent(e.target.value)}
              className="h-6 rounded border border-border bg-surface0 px-1 text-3xs text-foreground font-mono"
            >
              {otherLanes.map((ol) => (
                <option key={ol.id} value={ol.agent_name || ol.agent}>
                  @{ol.agent_name || ol.agent}
                </option>
              ))}
              <option value="codex">@codex</option>
            </select>
          )}

          <button
            type="button"
            onClick={() => setOpenModal(true)}
            className="text-3xs text-muted-foreground hover:text-foreground underline ml-1 cursor-pointer"
          >
            补充说明
          </button>
        </div>
      )}

      {openModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="flex flex-col w-full max-w-md rounded-xl border border-border bg-surface-raised p-4 space-y-3">
            <h4 className="text-xs font-semibold text-foreground">交接成果给下游 Agent</h4>
            <p className="text-3xs text-muted-foreground">
              将当前交付成果（版本 v{currentVersion}）与关联依据同步给下游成员作为输入上下文。
            </p>
            <div className="space-y-1">
              <label className="text-3xs text-foreground-muted">接收 Agent：</label>
              <input
                type="text"
                value={targetAgent}
                onChange={(e) => setTargetAgent(e.target.value)}
                className="w-full h-7 rounded border border-border bg-surface0 px-2 text-2xs text-foreground font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-3xs text-foreground-muted">交接指令与要求说明：</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="例如：结合视频采样与规范第2条，检查当前项目是否有遗漏..."
                rows={3}
                className="w-full rounded border border-border bg-surface0 p-2 text-2xs text-foreground resize-y"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => setOpenModal(false)}
                className="px-2.5 py-1 rounded text-2xs text-muted-foreground hover:bg-muted cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void doHandoff(targetAgent, notes)}
                className="px-3 py-1 rounded bg-primary text-primary-foreground text-2xs font-semibold hover:bg-primary/90 cursor-pointer"
              >
                确认交接
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Modal to inspect structured Git delivery diffs without touching source files. */
function LaneDeliveryDiffModal({
  batchId,
  lane,
  onClose,
}: {
  batchId: string;
  lane: ParallelLane;
  onClose: () => void;
}) {
  const [loading, setLoading] = React.useState(true);
  const [result, setResult] = React.useState<DeliveryDiffResult | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    workspaceApi
      .getLaneDeliveryDiff(batchId, lane.id || lane.agent)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            available: false,
            reason: err instanceof Error ? err.message : '加载 Diff 失败',
            baseCommit: '',
            deliveryCommit: lane.commit_hash || null,
            files: [],
            diff: '',
            truncated: false,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, lane.id, lane.agent, lane.commit_hash]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="flex flex-col w-full max-w-3xl max-h-[85vh] rounded-2xl border border-border bg-surface-raised shadow-2xl overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border/80 px-4 py-3 bg-surface0">
          <div className="flex items-center gap-2 min-w-0">
            <FileDiff className="size-4 text-primary shrink-0" />
            <h3 className="text-xs font-semibold text-foreground truncate">
              任务交付改动 · {lane.agent_name || lane.agent}
            </h3>
            {lane.commit_hash && (
              <code className="text-3xs font-mono bg-surface2 px-1.5 py-0.5 rounded text-muted-foreground">
                {lane.commit_hash.slice(0, 8)}
              </code>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xs p-1 rounded-md"
          >
            <X className="size-4" />
          </button>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-2xs">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>正在读取 Git 交付快照与比较基线...</span>
            </div>
          ) : !result?.available ? (
            <div className="p-4 rounded-xl border border-status-warning/40 bg-status-warning/10 text-status-warning space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="size-4" />
                <span>无法查看代码改动</span>
              </p>
              <p className="text-3xs font-sans opacity-90">{result?.reason || '无可用改动。'}</p>
            </div>
          ) : (
            <>
              {/* Diff summary stats */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-surface0 border border-border/60 text-3xs font-sans text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">基准 commit:</span>{' '}
                  <code className="font-mono">{result.baseCommit?.slice(0, 8)}</code>
                  <span className="mx-2">→</span>
                  <span className="font-medium text-foreground">交付 commit:</span>{' '}
                  <code className="font-mono">{result.deliveryCommit?.slice(0, 8)}</code>
                </div>
                {result.diffstat && <div className="text-foreground">{result.diffstat}</div>}
              </div>

              {/* Changed files */}
              {result.files.length > 0 && (
                <div className="space-y-1 font-sans">
                  <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                    变更文件 ({result.files.length})
                  </div>
                  <div className="max-h-32 overflow-y-auto divide-y divide-border/40 rounded-lg border border-border/60 bg-surface0">
                    {result.files.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 px-2.5 py-1 text-3xs">
                        <span
                          className={cn(
                            'font-mono font-bold text-4xs px-1 rounded',
                            f.status === 'A'
                              ? 'bg-status-success/20 text-status-success'
                              : f.status === 'D'
                              ? 'bg-status-danger/20 text-status-danger'
                              : 'bg-primary/20 text-primary'
                          )}
                        >
                          {f.status}
                        </span>
                        <span className="truncate font-mono text-foreground">{f.path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Raw Diff */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-3xs font-sans text-muted-foreground">
                  <span className="font-semibold uppercase tracking-wider">代码 Diff</span>
                  {result.truncated && (
                    <span className="text-status-warning">已截断至 64KB</span>
                  )}
                </div>
                <div className="rounded-lg border border-border bg-surface0 p-3 overflow-x-auto max-h-96">
                  <pre className="text-3xs leading-relaxed font-mono whitespace-pre text-foreground/90">
                    {result.diff.split('\n').map((line, idx) => {
                      const isAdd = line.startsWith('+') && !line.startsWith('+++');
                      const isDel = line.startsWith('-') && !line.startsWith('---');
                      const isHunk = line.startsWith('@@');
                      return (
                        <div
                          key={idx}
                          className={cn(
                            isAdd && 'bg-status-success/10 text-status-success',
                            isDel && 'bg-status-danger/10 text-status-danger',
                            isHunk && 'text-primary font-semibold'
                          )}
                        >
                          {line || ' '}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-end px-4 py-2.5 border-t border-border/80 bg-surface0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-md bg-foreground text-background text-2xs font-medium hover:opacity-90"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

function ReviewSetting({
  channelName,
  value,
  onSaved,
  className,
}: {
  channelName: string;
  value: string;
  onSaved: () => void;
  className?: string;
}) {
  const [agents, setAgents] = React.useState<AgentDefinition[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    workspaceApi.listAgentDefinitions().then(result => { if (!cancelled) setAgents(result.agents); }).catch(() => {});
    return () => { cancelled = true; };
  }, [channelName]);
  const [saving, setSaving] = React.useState(false);
  const options = React.useMemo(
    () => [...agents].filter(agent => agent.modelResource).sort((a, b) => a.name.localeCompare(b.name)),
    [agents]
  );
  const known = !value || options.some((agent) => agent.id === value);

  const save = async (next: string) => {
    setSaving(true);
    try {
      await workspaceApi.updateChannel(channelName, { reviewAgent: next || null });
      toast.success(next ? `${options.find(agent => agent.id === next)?.name || next} will review the next batch` : 'Review before merge is off');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the reviewer');
    } finally {
      setSaving(false);
    }
  };

  const id = `review-agent-${channelName}`;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
      <label htmlFor={id} className="text-2xs text-muted-foreground shrink-0">
        Next batch reviewer
      </label>
      <select
        id={id}
        value={value}
        disabled={saving}
        onChange={(e) => void save(e.target.value)}
        className="min-w-0 max-w-44 truncate rounded-md border border-border bg-background px-1.5 py-0.5 text-2xs text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
      >
        <option value="">Off</option>
        {!known && <option value={value}>@{value} (not in workspace)</option>}
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
    </div>
  );
}

function StateBadge({ state }: { state: ParallelBatch['state'] }) {
  const map: Record<ParallelBatch['state'], { label: string; className: string }> = {
    idle: { label: 'Idle', className: 'text-muted-foreground border-border' },
    running: { label: 'Running', className: 'text-status-info border-status-info/40' },
    blocked: { label: 'Blocked', className: 'text-status-warning border-status-warning/40' },
    done: { label: 'Complete', className: 'text-status-success border-status-success/40' },
    failed: { label: 'Failed', className: 'text-status-danger border-status-danger/40' },
    cancelled: { label: 'Stopped', className: 'text-muted-foreground border-border' },
  };
  const badge = map[state];
  return (
    <span className={cn('rounded-full border px-1.5 py-px text-2xs leading-none', badge.className)}>
      {badge.label}
    </span>
  );
}

function Lane({ worker, blocked }: { worker: ParallelWorker; blocked: boolean }) {
  const complete = worker.total > 0 && worker.done === worker.total;
  const hasCountableProgress = worker.total > 0;
  const percent = hasCountableProgress ? Math.round((worker.done / worker.total) * 100) : 0;

  const taskSummary = worker.tasks?.map((t) => t.content).join(' ') || worker.scope || '';
  const taskText = taskSummary.toLowerCase();
  const phaseLabel = complete
    ? '已完成交付'
    : worker.running && !blocked
    ? (/video|视频|字幕|帧/.test(taskText)
        ? '正在分析字幕与关键画面...'
        : /doc|spec|规范|文档|rfc/.test(taskText)
        ? '正在阅读与比对规范原文...'
        : '正在独立工作副本中执行...')
    : blocked
    ? '等待分工解除冲突'
    : '准备就绪';

  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 shrink-0">
        {complete ? (
          <CheckCircle2 className="size-3.5 text-status-success" />
        ) : worker.running && !blocked ? (
          <Loader2 className="size-3.5 text-status-info animate-spin" />
        ) : (
          <CircleDashed className="size-3.5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xs font-medium text-foreground truncate">{worker.assignee}</span>
          {hasCountableProgress ? (
            <span className="text-2xs tabular-nums text-muted-foreground shrink-0">
              {worker.done}/{worker.total} 项
            </span>
          ) : (
            <span className="text-3xs text-muted-foreground shrink-0 font-sans">
              {phaseLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 mt-0.5">
          <code className="text-2xs text-muted-foreground truncate">{worker.scope || '全工作区'}</code>
          <span className="text-3xs text-foreground-muted font-sans truncate">· {phaseLabel}</span>
        </div>

        {hasCountableProgress && (
          <div className="mt-1 h-1 rounded-full bg-border overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                complete ? 'bg-status-success' : blocked ? 'bg-status-warning' : 'bg-status-info'
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface CreateBatchProps {
  channelName: string;
  isIsolated: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CreateParallelBatchModal({ channelName, isIsolated, onClose, onCreated }: CreateBatchProps) {
  const [agents, setAgents] = React.useState<AgentDefinition[]>([]);
  const [loadingAgents, setLoadingAgents] = React.useState(true);
  const [isolationMode, setIsolationMode] = React.useState<'worktree' | 'directory'>(isIsolated ? 'worktree' : 'directory');
  const [workers, setWorkers] = React.useState<Array<{ agent_id: string; task: string; scope: string }>>([
    { agent_id: '', task: '', scope: '' },
    { agent_id: '', task: '', scope: '' },
  ]);
  const [reviewerId, setReviewerId] = React.useState<string>('');
  const [budgetTokens, setBudgetTokens] = React.useState<string>('128000');
  const [nativeBudgetAcknowledged,setNativeBudgetAcknowledged]=React.useState(false);
  const [verifyReview,setVerifyReview]=React.useState(false);
  const hasNative=agents.some(a=>(workers.some(w=>w.agent_id===a.id)||reviewerId===a.id) && (Boolean(a.connectionId)||a.runtimeKind!=='pi'));
  const selectedReviewer=agents.find(a=>a.id===reviewerId);
  const canVerify=Boolean(selectedReviewer?.permissions.executeCommands && selectedReviewer.maxMode==='agent' && !(selectedReviewer.runtimeKind==='pi'&&selectedReviewer.connectionId));
  const participantKey=[...workers.map(w=>w.agent_id),reviewerId].join('|');
  React.useEffect(()=>{setNativeBudgetAcknowledged(false);},[participantKey]);
  React.useEffect(()=>{setVerifyReview(false);},[reviewerId]);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    workspaceApi.listAgentDefinitions(false)
      .then((res) => {
        if (cancelled) return;
        const active = (res.agents || []).filter((a) => a.status !== 'disabled');
        setAgents(active);
        if (active.length > 0) {
          setWorkers([
            { agent_id: active[0].id, task: '', scope: '' },
            { agent_id: (active[1] || active[0]).id, task: '', scope: '' },
          ]);
        }
      })
      .catch(() => toast.error('无法加载 Agent 列表'))
      .finally(() => { if (!cancelled) setLoadingAgents(false); });
    return () => { cancelled = true; };
  }, []);

  const handleAddWorker = () => {
    if (agents.length === 0) return;
    setWorkers((prev) => [...prev, { agent_id: agents[0]?.id || '', task: '', scope: '' }]);
  };

  const handleRemoveWorker = (index: number) => {
    if (workers.length <= 1) return;
    setWorkers((prev) => prev.filter((_, i) => i !== index));
  };

  const handleWorkerChange = (index: number, patch: Partial<{ agent_id: string; task: string; scope: string }>) => {
    setWorkers((prev) => prev.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isolationMode === 'worktree' && !isIsolated) {
      toast.error('当前项目非 Git 仓库根目录，无法启用独立工作副本隔离');
      return;
    }
    const emptyTaskIndex = workers.findIndex((w) => !w.task.trim());
    if (emptyTaskIndex !== -1) {
      toast.error(`子任务 #${emptyTaskIndex + 1} 尚未填写任务内容`);
      return;
    }
    const emptyAgentIndex = workers.findIndex((w) => !w.agent_id);
    if (emptyAgentIndex !== -1) {
      toast.error(`子任务 #${emptyAgentIndex + 1} 尚未选择执行 Agent`);
      return;
    }

    setSubmitting(true);
    try {
      await workspaceApi.startParallelBatch({
        channel_name: channelName,
        workers: workers.map((w) => ({
          agent_id: w.agent_id,
          task: w.task.trim(),
          scope: w.scope.trim() || undefined,
        })),
        review_agent: reviewerId,
        total_budget_tokens: parseInt(budgetTokens, 10) || 128000,
        isolation: isolationMode,
        ...(hasNative && nativeBudgetAcknowledged?{native_budget_policy:{mode:'native-managed' as const,acknowledged:true as const}}:{}),
        review_verification:verifyReview,
      });
      toast.success('已启动多 Agent 协作批次');
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启动协作批次失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="flex flex-col w-full max-w-2xl max-h-[90vh] rounded-2xl border border-border bg-surface-raised shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-surface0">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-primary shrink-0" />
            <h3 className="text-sm font-semibold text-foreground">发起多 Agent 协作批次 (分配任务)</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-xs font-sans">
          {/* Isolation mode selection */}
          <div className="space-y-1.5 p-3 rounded-xl border border-border/70 bg-surface0/60">
            <label className="text-2xs font-semibold text-foreground flex items-center justify-between">
              <span>执行策略与环境隔离</span>
              <span className="text-3xs text-muted-foreground font-normal">通用任务与代码任务可选不同策略</span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <label className={cn(
                'flex items-start gap-2 p-2.5 rounded-lg border text-2xs cursor-pointer transition-colors',
                isolationMode === 'worktree' ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-surface1 text-muted-foreground',
                !isIsolated && 'opacity-50 cursor-not-allowed'
              )}>
                <input
                  type="radio"
                  name="isolationMode"
                  value="worktree"
                  disabled={!isIsolated}
                  checked={isolationMode === 'worktree'}
                  onChange={() => setIsolationMode('worktree')}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <span className="font-semibold block text-foreground">独立工作副本 (Git Worktree)</span>
                  <span className="text-3xs block leading-snug">代码修改先保存在独立副本中，确认后合入项目。</span>
                </div>
              </label>

              <label className={cn(
                'flex items-start gap-2 p-2.5 rounded-lg border text-2xs cursor-pointer transition-colors',
                isolationMode === 'directory' ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-surface1 text-muted-foreground'
              )}>
                <input
                  type="radio"
                  name="isolationMode"
                  value="directory"
                  checked={isolationMode === 'directory'}
                  onChange={() => setIsolationMode('directory')}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <span className="font-semibold block text-foreground">常规工作区目录</span>
                  <span className="text-3xs block leading-snug">适合视频字幕与画面分析、文档比对等通用研究任务。</span>
                </div>
              </label>
            </div>
          </div>
          {!isIsolated && (
            <div className="p-3 rounded-lg border border-status-warning/40 bg-status-warning/10 text-status-warning flex items-start gap-2">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                当前项目未设置 Git 仓库或非仓库根目录。并行协作需要独立的 Git Worktree 隔离工作区。请先在工作区设置中选择有效的 Git 项目根目录。
              </p>
            </div>
          )}

          {/* Workers list */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <span>并行子任务与执行 Agent 分配</span>
                <span className="text-3xs text-muted-foreground font-normal">（{isolationMode === 'worktree' ? '每个任务将运行于独立工作副本' : '各任务在当前工作区并发执行'}）</span>
              </label>
              <button
                type="button"
                onClick={handleAddWorker}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs bg-surface2 hover:bg-surface3 border border-border text-foreground transition-colors"
              >
                <Plus className="size-3" />
                <span>添加子任务</span>
              </button>
            </div>

            {loadingAgents ? (
              <div className="py-6 text-center text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin text-primary" />
                <span>加载 Agent 列表中...</span>
              </div>
            ) : (
              <div className="space-y-3">
                {workers.map((worker, index) => (
                  <div key={index} className="p-3 rounded-xl border border-border/80 bg-surface0/70 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="font-mono text-2xs font-bold text-muted-foreground w-6">#{index + 1}</span>
                        <div className="flex-1 min-w-0">
                          <select
                            value={worker.agent_id}
                            onChange={(e) => handleWorkerChange(index, { agent_id: e.target.value })}
                            className="w-full h-8 rounded-lg border border-border bg-surface1 px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {agents.map((ag) => (
                              <option key={ag.id} value={ag.id}>
                                {ag.name} ({ag.role})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      {workers.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveWorker(index)}
                          className="size-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title="移除此子任务"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>

                    <div>
                      <textarea
                        value={worker.task}
                        onChange={(e) => handleWorkerChange(index, { task: e.target.value })}
                        placeholder={`填写子任务 #${index + 1} 的具体实施目标与要求...`}
                        rows={2}
                        className="w-full rounded-lg border border-border bg-surface1 p-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                        required
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-3xs text-muted-foreground shrink-0">文件范围 (可选):</span>
                      <input
                        type="text"
                        value={worker.scope}
                        onChange={(e) => handleWorkerChange(index, { scope: e.target.value })}
                        placeholder="例如：src/components/**, api/v1/*"
                        className="flex-1 h-7 rounded-md border border-border bg-surface1 px-2 text-3xs text-foreground font-mono"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reviewer & Budget */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/60">
            <div className="space-y-1">
              <label className="text-2xs font-medium text-foreground">自动审阅 Agent (可选)</label>
              <select
                value={reviewerId}
                onChange={(e) => setReviewerId(e.target.value)}
                className="w-full h-8 rounded-lg border border-border bg-surface0 px-2 text-xs text-foreground"
              >
                <option value="">不指定（交付后由人工审阅）</option>
                {agents.map((ag) => (
                  <option key={ag.id} value={ag.id}>
                    {ag.name} ({ag.role})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-2xs font-medium text-foreground">{hasNative?'批次 Token 观测额度（非逐请求硬上限）':'批次 Token 预算上限'}</label>
              <input
                type="number"
                value={budgetTokens}
                onChange={(e) => setBudgetTokens(e.target.value)}
                min={1000}
                max={1000000}
                step={10000}
                className="w-full h-8 rounded-lg border border-border bg-surface0 px-2 text-xs font-mono text-foreground"
              />
            </div>
          </div>

          {/* Footer buttons */}
          {hasNative && <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs text-foreground-muted"><input type="checkbox" checked={nativeBudgetAcknowledged} onChange={e=>setNativeBudgetAcknowledged(e.target.checked)} className="mt-0.5" />
            我确认仅本批次原生 Agent 使用原生配额：不受工作台 Token、步数和费用硬上限约束，可能使累计费用超过全局阈值。全局配置保持不变，时间限制与操作审批继续生效。
          </label>}
          {reviewerId && <label className="flex items-start gap-2 text-xs text-foreground-muted"><input type="checkbox" checked={verifyReview} disabled={!canVerify} onChange={e=>setVerifyReview(e.target.checked)} />{canVerify?'允许审阅 Agent 在独立检视工作区请求运行验证命令，每条命令仍需审批。':'此审阅 Agent 不支持受控验证命令，将仅检视交付；原生 Pi 命令能力暂不开放。'}</label>}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/60">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting || (isolationMode === 'worktree' && !isIsolated) || loadingAgents || (hasNative && !nativeBudgetAcknowledged)}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 shadow-xs"
            >
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}
              <span>启动协作批次</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
