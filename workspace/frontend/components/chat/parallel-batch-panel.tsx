'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, GitMerge, GitBranch, XCircle, RotateCw, PauseCircle, Trash2, FileDiff, ShieldCheck, Clock, SkipForward, Undo2, MessagesSquare, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import type { ParallelBatch, ParallelWorker, ParallelRun, ParallelLane, LaneReviewStatus } from '@/lib/api/orchestration';
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
          const isLiveOrReview = next?.run?.batch.status === 'running' || next?.run?.batch.status === 'review';
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
  const runLive = run?.batch.status === 'running' || run?.batch.status === 'review';
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
        <p className="text-xs font-medium text-foreground">Waiting for the work to be split</p>
        <p className="text-2xs text-muted-foreground mt-1 leading-snug">
          Name two or more agents in one message (<code className="text-2xs">@a do X @b do Y</code>) or
          assign tasks on the board. Everyone starts at once.{' '}
          {batch.isolated
            ? 'This project is a git repository, so each agent works in its own worktree and the results are merged back when all of them finish.'
            : 'This folder is not a git repository, so the agents share it: give each task the folder it owns (or name it in the task) so no two overlap.'}
        </p>
        {batch.isolated && (
          <ReviewSetting channelName={channelName} value={batch.review_agent} onSaved={reload} className="mt-2" />
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
    </div>
  );
}

const LANE_STATUS: Record<ParallelLane['status'], { label: string; icon: React.ElementType; className: string }> = {
  running: { label: 'Working', icon: Loader2, className: 'text-status-info' },
  done: { label: 'Finished', icon: CheckCircle2, className: 'text-status-success' },
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
function RunView({ run, onRetried, setting }: { run: ParallelRun; onRetried: () => void; setting?: React.ReactNode }) {
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const [deciding, setDeciding] = React.useState<'merge' | 'discard' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [confirmMerge, setConfirmMerge] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const live = run.batch.status === 'running';
  const reviewing = run.batch.status === 'review';
  const finished = run.lanes.filter((l) => l.status !== 'running').length;
  const base = run.batch.base_branch || 'the base branch';
  // Merging while a reviewer is still reading cancels that review, so it takes
  // a second, deliberate click -- like Discard.
  const reviewsRunning = run.lanes.filter((l) => l.review_status === 'running').length;

  // Discard is a two-step click: it deletes every lane's worktree and branch,
  // and the second click has to be deliberate.
  React.useEffect(() => {
    if (!confirmDiscard && !confirmMerge) return;
    const t = setTimeout(() => {
      setConfirmDiscard(false);
      setConfirmMerge(false);
    }, 4000);
    return () => clearTimeout(t);
  }, [confirmDiscard, confirmMerge]);

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
        await workspaceApi.mergeParallelBatch(run.batch.id);
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
      setConfirmMerge(false);
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
    <div className="rounded-lg border border-border bg-surface-raised/60 p-3">
      <header className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground">
            {live ? 'Working in parallel' : reviewing ? 'Ready for review' : 'Last parallel batch'}
          </span>
          <span className="text-2xs text-muted-foreground truncate">
            {reviewing
              ? `nothing merged into ${base} yet`
              : run.batch.isolation === 'worktree'
              ? `own worktrees${run.batch.base_branch ? ` · merges into ${run.batch.base_branch} after your review` : ''}`
              : 'shared folder'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-2xs tabular-nums text-muted-foreground">
            {finished}/{run.lanes.length} finished
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
            reviewing && lane.status === 'done' && lane.diffstat
              ? { label: 'Ready to merge', icon: FileDiff, className: 'text-status-info' }
              : LANE_STATUS[lane.status] ?? LANE_STATUS.running;
          const Icon = st.icon;
          const firstLine = lane.task.replace(/^- /, '').split(/\r?\n/)[0];
          return (
            <li key={lane.id} className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', st.className, lane.status === 'running' && 'animate-spin')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-baseline gap-1.5 min-w-0">
                    <span className="text-2xs font-medium text-foreground truncate">{lane.agent}</span>
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
                {lane.branch && lane.status !== 'merged' && (
                  <code className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground truncate">
                    <GitBranch className="size-3 shrink-0" />
                    {lane.branch}
                  </code>
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
                    disabled={retrying === lane.agent}
                    onClick={() => void retry(lane.agent)}
                    className="mt-1 inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-muted disabled:opacity-60"
                  >
                    <RotateCw className={cn('size-3', retrying === lane.agent && 'animate-spin')} />
                    Retry this part
                  </button>
                )}
                {lane.review_status && (
                  <LaneReview lane={lane} actionable={reviewing && lane.status === 'done'} batchId={run.batch.id} onChanged={onRetried} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {reviewing && (
        <footer className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2.5">
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
          <button
            type="button"
            disabled={deciding !== null}
            onClick={() => (reviewsRunning > 0 && !confirmMerge ? setConfirmMerge(true) : void decide('merge'))}
            className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-2xs font-medium text-background hover:opacity-90 disabled:opacity-60"
          >
            {deciding === 'merge' ? <Loader2 className="size-3 animate-spin" /> : <GitMerge className="size-3" />}
            {reviewsRunning === 0
              ? `Merge into ${base}`
              : confirmMerge
              ? `Click again — cancels ${reviewsRunning === 1 ? 'the review' : `${reviewsRunning} reviews`}`
              : 'Merge without waiting'}
          </button>
        </footer>
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
  const [busy, setBusy] = React.useState<'send' | 'retry' | null>(null);
  const status = lane.review_status;
  if (!status) return null;
  const st = REVIEW_STATUS[status];
  const Icon = st.icon;
  const notes = lane.review_notes.trim();
  const canSendBack = actionable && status !== 'running' && notes !== '';
  const canRetry = actionable && (status === 'failed' || status === 'timed_out' || status === 'skipped' || status === 'cancelled');

  const act = async (action: 'send' | 'retry') => {
    setBusy(action);
    try {
      if (action === 'send') {
        await workspaceApi.sendBackParallelLane(batchId, lane.agent);
        toast.success(`Sent back to @${lane.agent} with the review`);
      } else {
        await workspaceApi.retryLaneReview(batchId, lane.agent);
        toast.success(`Reviewing @${lane.agent}'s part again`);
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
      {(canSendBack || canRetry || lane.review_channel) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {canSendBack && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act('send')}
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-muted disabled:opacity-60"
            >
              {busy === 'send' ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
              Send back to @{lane.agent}
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
  const { agents } = useWorkspace();
  const [saving, setSaving] = React.useState(false);
  const options = React.useMemo(
    () => [...agents].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online') || a.agentName.localeCompare(b.agentName)),
    [agents]
  );
  const known = !value || options.some((a) => a.agentName.toLowerCase() === value.toLowerCase());

  const save = async (next: string) => {
    setSaving(true);
    try {
      await workspaceApi.updateChannel(channelName, { reviewAgent: next || null });
      toast.success(next ? `@${next} reviews each part before you merge` : 'Review before merge is off');
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
        Review before merge
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
          <option key={a.agentName} value={a.agentName}>
            @{a.agentName}
            {a.status !== 'online' ? ' (offline)' : ''}
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
  const percent = worker.total === 0 ? 0 : Math.round((worker.done / worker.total) * 100);

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
          <span className="text-2xs tabular-nums text-muted-foreground shrink-0">
            {worker.done}/{worker.total}
          </span>
        </div>

        {/* The scope is the contract that lets this lane run beside the others,
            so it is shown rather than hidden behind a tooltip. */}
        <code className="block text-2xs text-muted-foreground truncate">{worker.scope}</code>

        <div className="mt-1 h-1 rounded-full bg-border overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              complete ? 'bg-status-success' : blocked ? 'bg-status-warning' : 'bg-status-info'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
}
