'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, GitMerge, GitBranch, XCircle, RotateCw, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import type { ParallelBatch, ParallelWorker, ParallelRun, ParallelLane } from '@/lib/api/orchestration';
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
}

const POLL_MS = 4000;

export function ParallelBatchPanel({ channelName, active, className }: Props) {
  const [batch, setBatch] = React.useState<ParallelBatch | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!active || !channelName) {
      setBatch(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const next = await workspaceApi.getParallelBatch(channelName);
        if (!cancelled) {
          setBatch(next);
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

  if (!active || !batch) return null;

  const run = batch.run;
  const runLive = run?.batch.status === 'running';
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
      </div>
    );
  }

  // A batch that is running, or the last one's result, shown lane by lane.
  // The board preview below is the NEXT batch, so it is hidden while one runs.
  const showBoard = batch.total > 0 && !runLive;

  return (
    <div className={cn('space-y-2', className)}>
    {run && <RunView run={run} onRetried={reload} />}
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
};

/**
 * The batch that actually ran: one row per agent with what became of its work.
 * A failed lane can be run again on its own worktree without touching the rest.
 */
function RunView({ run, onRetried }: { run: ParallelRun; onRetried: () => void }) {
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const live = run.batch.status === 'running';
  const finished = run.lanes.filter((l) => l.status !== 'running').length;

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
            {live ? 'Working in parallel' : 'Last parallel batch'}
          </span>
          <span className="text-2xs text-muted-foreground truncate">
            {run.batch.isolation === 'worktree'
              ? `own worktrees${run.batch.base_branch ? ` · merges into ${run.batch.base_branch}` : ''}`
              : 'shared folder'}
          </span>
        </div>
        <span className="text-2xs tabular-nums text-muted-foreground shrink-0">
          {finished}/{run.lanes.length} finished
        </span>
      </header>
      <ul className="space-y-2">
        {run.lanes.map((lane) => {
          const st = LANE_STATUS[lane.status] ?? LANE_STATUS.running;
          const Icon = st.icon;
          const firstLine = lane.task.replace(/^- /, '').split(/\r?\n/)[0];
          return (
            <li key={lane.id} className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', st.className, lane.status === 'running' && 'animate-spin')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-2xs font-medium text-foreground truncate">{lane.agent}</span>
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
              </div>
            </li>
          );
        })}
      </ul>
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
