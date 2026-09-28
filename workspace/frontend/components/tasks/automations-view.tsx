'use client';

import { Hint } from '@/components/ui/hint';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  ChevronRight,
  ExternalLink,
  FileText,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { CreateRoutineDialog } from '@/components/routines/create-routine-dialog';
import { TRANSCRIPT_REVEAL_EVENT } from '@/components/chat/chat-messages';
import { useLayout } from '@/components/layout/layout-context';
import { useScrollRestore } from '@/hooks/use-scroll-restore';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { RoutineItem, RoutineRunItem } from '@/lib/types';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import { useWorkspace } from '@/lib/workspace-context';
import { formatAbsolute, formatDuration, formatSchedule, timeAgo, timeUntil } from '@/lib/schedule-format';
import { cn } from '@/lib/utils';

/*
  AUTOMATIONS: ONE ROW PER ROUTINE, NOT PER RUN.

  This replaced two screens. "Runs" listed every execution record flat -- 147
  of them, 141 failed, nearly all from one routine an agent had scheduled for
  itself -- so the one fact that mattered (a single routine failing every 30
  minutes, forever) was spread over a hundred identical rows. "Schedules" had
  the routines but not what they did. A row here is a routine: its schedule,
  its state, its last ten outcomes at a glance, and its run history -- with
  each run's actual result -- one click away.

  Colour follows the transcript's rule: only failure is coloured
  (`--destructive`); a run that worked is the default and stays neutral.
*/

const IDLE_REFRESH_MS = 20_000;
const ACTIVE_REFRESH_MS = 4_000;
const CLOCK_TICK_MS = 30_000;
const STRIP_SIZE = 10;
/** Enough history to fill every routine's strip even when one routine is noisy. */
const STRIP_FETCH_LIMIT = 500;

const STATUS_ORDER: Record<string, number> = { pending_approval: 0, active: 1, paused: 2 };

function statusLabel(r: RoutineItem): string {
  if (r.status === 'pending_approval') return 'Waiting for approval';
  if (r.status === 'paused') return 'Paused';
  return 'Active';
}

/**
 * A name that promises a cadence the schedule does not keep ("Daily Git Commit
 * Summary" firing every 30 minutes) -- exactly how the routine that failed 139
 * times went unnoticed.
 */
function scheduleMismatch(r: RoutineItem): string | null {
  const interval = r.scheduleIntervalMinutes;
  if (!interval || interval >= 1440) return null;
  const name = r.name.toLowerCase();
  let promised: string | null = null;
  if (/daily|每天|每日/.test(name)) promised = 'daily';
  else if (/weekly|每周/.test(name)) promised = 'weekly';
  if (!promised) return null;
  return `Name says ${promised}, runs ${formatSchedule(r).toLowerCase()}`;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.replace(/^API \d+:\s*/, '') : fallback;
}

/** Last N runs, oldest first, so the strip reads left to right in time. */
function RunStrip({ runs }: { runs: RoutineRunItem[] }) {
  if (runs.length === 0) {
    return <span className="text-foreground-extra-muted">No runs yet</span>;
  }
  const ordered = [...runs].reverse();
  const finished = runs.filter((r) => r.status !== 'running');
  const ok = finished.filter((r) => r.status === 'completed').length;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-[3px]" aria-hidden>
        {ordered.map((run) => (
          <span
            key={run.id}
            className={cn(
              'block h-2.5 w-1.5 rounded-[2px]',
              run.status === 'failed'
                ? 'bg-destructive'
                : run.status === 'running'
                  ? 'border border-foreground-extra-muted'
                  : 'bg-foreground-muted/45'
            )}
          />
        ))}
      </span>
      <Hint label={`${ok} of the last ${finished.length} finished runs succeeded`}>
        <span className="tabular-nums text-foreground-muted">
          {ok}/{finished.length}
        </span>
      </Hint>
    </span>
  );
}

function RunHistory({
  routine,
  onOpenMessage,
}: {
  routine: RoutineItem;
  onOpenMessage: (run: RoutineRunItem) => void;
}) {
  const [runs, setRuns] = useState<RoutineRunItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await workspaceApi.listRoutineRuns(routine.id, 50);
      setRuns(res.runs);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Run history could not be loaded'));
    }
  }, [routine.id]);

  const hasRunning = Boolean(runs?.some((r) => r.status === 'running'));
  useVisibilityPolling(load, hasRunning ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);

  useEffect(() => {
    if (!hasRunning) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [hasRunning]);

  if (error && !runs) return <p className="px-4 pb-3 text-xs text-destructive">{error}</p>;
  if (!runs) return <p className="px-4 pb-3 text-xs text-foreground-extra-muted">Loading run history…</p>;
  if (runs.length === 0) {
    return (
      <p className="px-4 pb-3 text-xs text-foreground-extra-muted">
        {routine.status === 'pending_approval' ? 'Nothing runs until this is approved.' : 'No runs yet.'}
      </p>
    );
  }

  return (
    <ol className="divide-y divide-border/60 border-t border-border/60">
      {runs.map((run) => {
        const isOpen = Boolean(expanded[run.id]);
        const running = run.status === 'running';
        return (
          <li key={run.id} className="px-4 py-2.5 pl-10 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={cn(
                  'font-medium',
                  run.status === 'failed' ? 'text-destructive' : 'text-foreground',
                  running && 'event-running'
                )}
              >
                {running ? 'Running' : run.status === 'failed' ? 'Failed' : 'Completed'}
              </span>
              <span className="font-mono text-foreground-extra-muted">#{run.runNumber}</span>
              <Hint label={formatAbsolute(run.startedAt)}>
                <span className="text-foreground-muted">{timeAgo(run.startedAt, now)}</span>
              </Hint>
              <span className="tabular-nums text-foreground-extra-muted">
                {formatDuration(run.startedAt, run.completedAt, now)}
              </span>
              <span className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenMessage(run)}
                  className="h-6 gap-1 px-2 text-xs text-foreground-muted hover:text-foreground"
                >
                  <ExternalLink className="size-3" />
                  {run.resultMessageId ? 'Open message' : 'Open thread'}
                </Button>
              </span>
            </div>

            {run.error && <p className="mt-1 text-destructive">{run.error}</p>}

            {run.result && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [run.id]: !isOpen }))}
                className={cn(
                  'mt-1.5 block w-full whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2.5 py-2 text-left text-foreground-muted',
                  !isOpen && 'line-clamp-4'
                )}
                aria-expanded={isOpen}
              >
                {run.result}
              </button>
            )}

            {run.filesChanged.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {run.filesChanged.map((file) => (
                  <li key={file} className="inline-flex items-center gap-1 font-mono text-foreground-muted">
                    <FileText className="size-3 text-foreground-extra-muted" />
                    {file}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function AutomationsView() {
  const {
    routines,
    refreshRoutines,
    createRoutine,
    updateRoutine,
    toggleRoutine,
    triggerRoutine,
    cancelRoutine,
    stopAllAgents,
    timers,
    refreshTimers,
    cancelTimer,
    agents,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode } = useLayout();
  const scrollRef = useScrollRestore<HTMLDivElement>('automations');

  const [runs, setRuns] = useState<RoutineRunItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<RoutineItem | null>(null);
  const [deletingRoutine, setDeletingRoutine] = useState<RoutineItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fetchRuns = useCallback(async () => {
    try {
      const res = await workspaceApi.listRoutineRuns(undefined, STRIP_FETCH_LIMIT);
      setRuns(res.runs);
    } catch {
      // The strip is a summary; the routine list above it still loads.
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshRoutines(), refreshTimers(), fetchRuns()]);
  }, [refreshRoutines, refreshTimers, fetchRuns]);

  const hasActiveRun = useMemo(() => runs.some((r) => r.status === 'running'), [runs]);
  useVisibilityPolling(refreshAll, hasActiveRun ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);

  useEffect(() => {
    const tick = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const runsByRoutine = useMemo(() => {
    const map = new Map<string, RoutineRunItem[]>();
    for (const run of runs) {
      const list = map.get(run.routineId) || [];
      if (list.length < STRIP_SIZE) list.push(run);
      map.set(run.routineId, list);
    }
    return map;
  }, [runs]);

  const visibleRoutines = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? routines.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.message.toLowerCase().includes(q) ||
            r.createdBy.toLowerCase().includes(q) ||
            (r.shortId || '').toLowerCase().includes(q)
        )
      : routines;
    // Waiting for a decision first: nothing else here needs the user to act.
    return [...filtered].sort((a, b) => {
      const byStatus = (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
      if (byStatus !== 0) return byStatus;
      return new Date(a.nextFiresAt).getTime() - new Date(b.nextFiresAt).getTime();
    });
  }, [routines, searchQuery]);

  const pendingTimers = useMemo(() => {
    const active = timers.filter((t) => t.status === 'active');
    const q = searchQuery.trim().toLowerCase();
    const list = q
      ? active.filter((t) => t.message.toLowerCase().includes(q) || t.createdBy.toLowerCase().includes(q))
      : active;
    return [...list].sort((a, b) => new Date(a.firesAt).getTime() - new Date(b.firesAt).getTime());
  }, [timers, searchQuery]);

  const run = async (id: string, action: () => Promise<unknown>, fallback: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(errorText(err, fallback));
    } finally {
      setBusyId(null);
    }
  };

  const decide = (routine: RoutineItem, approve: boolean) =>
    run(
      routine.id,
      async () => {
        if (approve) await workspaceApi.approveRoutine(routine.id);
        else await workspaceApi.rejectRoutine(routine.id);
        await refreshRoutines();
      },
      approve ? 'The routine could not be approved' : 'The routine could not be rejected'
    );

  const openThread = (channelName: string) => {
    setCurrentSessionId(channelName);
    setViewMode('threads');
  };

  /*
    The transcript listens for TRANSCRIPT_REVEAL_EVENT and scrolls the
    virtualised list to that message. The thread has to load first, so the
    request is repeated a few times as it does; each try is a no-op until the
    message is in the list.
  */
  const openMessage = (runItem: RoutineRunItem) => {
    openThread(runItem.channelName);
    const id = runItem.resultMessageId;
    if (!id) return;
    for (const delay of [300, 900, 2000]) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(TRANSCRIPT_REVEAL_EVENT, { detail: { messageId: id } }));
      }, delay);
    }
  };

  const stopRun = async (routine: RoutineItem) => {
    try {
      await stopAllAgents(routine.channelName);
      toast.success(`Stop signal sent to ${routine.createdBy}`);
      await refreshAll();
    } catch {
      toast.error('The run could not be stopped');
    }
  };

  const closeDialogs = (open: boolean) => {
    if (open) return;
    setShowCreateDialog(false);
    setEditingRoutine(null);
  };

  const empty = visibleRoutines.length === 0 && pendingTimers.length === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-surface1/30 px-6 py-3">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-extra-muted" />
          <input
            type="text"
            placeholder="Search automations by name, prompt, agent, ID..."
            data-view-search
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 w-full rounded-lg border border-border bg-surface2/60 pl-8 pr-7 text-xs text-foreground placeholder:text-foreground-extra-muted transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-extra-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Hint label="Refresh automations">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshAll()}
              aria-label="Refresh automations"
              className="h-8 w-8 bg-surface1/60 p-0 hover:bg-surface2"
            >
              <RefreshCw className="size-3.5 text-foreground-muted" />
            </Button>
          </Hint>
          <Button
            size="sm"
            onClick={() => {
              setEditingRoutine(null);
              setShowCreateDialog(true);
            }}
            className="h-8 gap-1.5 px-3 text-xs font-medium shadow-xs"
          >
            <Plus className="size-3.5" />
            <span>New automation</span>
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="mx-6 mt-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">
            <X className="size-3" />
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-5xl space-y-5">
          {pendingTimers.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Timer className="size-3.5 text-foreground-muted" />
                <h3 className="text-xs font-semibold tracking-tight text-foreground">One-off</h3>
                <span className="text-2xs tabular-nums text-foreground-extra-muted">{pendingTimers.length}</span>
              </div>
              <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-surface1/60">
                {pendingTimers.map((timer) => (
                  <div key={timer.id} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface2/60">
                    <Timer className="size-3.5 shrink-0 text-foreground-muted" />
                    <p className="min-w-0 flex-1 truncate text-sm text-foreground">{timer.message}</p>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-foreground-extra-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <AgentAvatar name={timer.createdBy} size={16} />
                        <span className="hidden text-foreground-muted sm:inline">{timer.createdBy}</span>
                      </span>
                      <Hint label={formatAbsolute(timer.firesAt)}>
                        <span className="font-medium text-foreground-muted">{timeUntil(timer.firesAt, now)}</span>
                      </Hint>
                      <Hint label="Cancel this reminder">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Cancel this reminder"
                          onClick={() => void run(timer.id, () => cancelTimer(timer.id), 'The reminder could not be cancelled')}
                          className="h-7 w-7 p-0 text-foreground-extra-muted opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </Hint>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {empty ? (
            <div className="flex h-64 flex-col items-center justify-center space-y-3 rounded-xl border border-dashed border-border p-8 text-center">
              <CalendarClock className="size-8 text-foreground-extra-muted opacity-60" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">No automations</p>
                <p className="max-w-sm text-xs text-foreground-extra-muted">
                  {searchQuery
                    ? 'Nothing matches your search.'
                    : 'Recurring routines you create, and ones agents propose for your approval, appear here.'}
                </p>
              </div>
            </div>
          ) : (
            visibleRoutines.length > 0 && (
              <section className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-surface1/60">
                {visibleRoutines.map((routine) => {
                  const recent = runsByRoutine.get(routine.id) || [];
                  const isOpen = Boolean(openIds[routine.id]);
                  const pending = routine.status === 'pending_approval';
                  const paused = routine.status === 'paused';
                  const running = recent[0]?.status === 'running';
                  const mismatch = scheduleMismatch(routine);
                  const busy = busyId === routine.id;

                  return (
                    <div key={routine.id}>
                      <div className="group flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                        <button
                          type="button"
                          onClick={() => setOpenIds((prev) => ({ ...prev, [routine.id]: !isOpen }))}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        >
                          <ChevronRight
                            className={cn(
                              'mt-0.5 size-4 shrink-0 text-foreground-extra-muted transition-transform',
                              isOpen && 'rotate-90'
                            )}
                          />
                          <span className="min-w-0 flex-1 space-y-1">
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="truncate text-sm font-medium text-foreground">{routine.name}</span>
                              {routine.shortId && (
                                <span className="font-mono text-2xs text-foreground-extra-muted">{routine.shortId}</span>
                              )}
                              <span
                                className={cn(
                                  'text-xs',
                                  pending ? 'font-medium text-foreground' : 'text-foreground-muted',
                                  running && !pending && 'event-running'
                                )}
                              >
                                {running && !pending ? 'Running' : statusLabel(routine)}
                              </span>
                            </span>
                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
                              <span>{formatSchedule(routine)}</span>
                              <span className="inline-flex items-center gap-1.5">
                                <AgentAvatar name={routine.createdBy} size={14} />
                                {routine.createdBy}
                              </span>
                              {routine.status === 'active' && (
                                <Hint label={formatAbsolute(routine.nextFiresAt)}>
                                  <span>Next {timeUntil(routine.nextFiresAt, now)}</span>
                                </Hint>
                              )}
                              {!pending && <RunStrip runs={recent} />}
                            </span>
                            {pending && (
                              <span className="block text-xs text-foreground-muted">
                                Proposed by {routine.createdBy}. It will not run until you approve it.
                              </span>
                            )}
                            {paused && routine.pausedReason && (
                              <span className="block text-xs text-destructive">
                                {routine.pausedReason}
                                {routine.lastRunError ? `. Last error: ${routine.lastRunError}` : ''}
                              </span>
                            )}
                            {mismatch && (
                              <span className="flex items-center gap-1 text-xs text-foreground-muted">
                                <TriangleAlert className="size-3 shrink-0" />
                                {mismatch}
                              </span>
                            )}
                          </span>
                        </button>

                        <div className="flex shrink-0 items-center gap-1.5 self-end pl-6 sm:self-auto sm:pl-0">
                          {pending ? (
                            <>
                              <Button size="sm" disabled={busy} onClick={() => void decide(routine, true)} className="h-7 px-3 text-xs">
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void decide(routine, false)}
                                className="h-7 px-3 text-xs"
                              >
                                Reject
                              </Button>
                            </>
                          ) : (
                            <>
                              {running ? (
                                <Hint label="Stop the current run">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void stopRun(routine)}
                                    className="h-7 gap-1 px-2 text-xs"
                                  >
                                    <Square className="size-2.5 fill-current" />
                                    Stop
                                  </Button>
                                </Hint>
                              ) : (
                                <Hint label="Trigger one run now">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      void run(
                                        routine.id,
                                        async () => {
                                          await triggerRoutine(routine.id);
                                          await fetchRuns();
                                        },
                                        'The routine could not be triggered'
                                      )
                                    }
                                    className="h-7 gap-1 px-2 text-xs"
                                  >
                                    <Play className="size-3" />
                                    Run now
                                  </Button>
                                </Hint>
                              )}
                              <Hint label={paused ? 'Resume schedule' : 'Pause schedule'}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void run(routine.id, () => toggleRoutine(routine.id), 'The routine could not be updated')}
                                  className="h-7 gap-1 px-2 text-xs"
                                >
                                  {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                                  {paused ? 'Resume' : 'Pause'}
                                </Button>
                              </Hint>
                            </>
                          )}
                          <Hint label="Edit schedule">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label="Edit schedule"
                              onClick={() => {
                                setEditingRoutine(routine);
                                setShowCreateDialog(false);
                              }}
                              className="h-7 w-7 p-0 text-foreground-muted"
                            >
                              <Pencil className="size-3" />
                            </Button>
                          </Hint>
                          <Hint label="Open the routine's thread">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label="Open the routine's thread"
                              onClick={() => openThread(routine.channelName)}
                              className="h-7 w-7 p-0 text-foreground-muted"
                            >
                              <ExternalLink className="size-3" />
                            </Button>
                          </Hint>
                          <Hint label="Delete">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label="Delete"
                              onClick={() => setDeletingRoutine(routine)}
                              className="h-7 w-7 p-0 text-foreground-extra-muted hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </Hint>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="pb-1">
                          <p className="px-4 pb-2 pl-10 font-mono text-xs text-foreground-muted">{routine.message}</p>
                          <RunHistory routine={routine} onOpenMessage={openMessage} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            )
          )}
        </div>
      </div>

      <CreateRoutineDialog
        open={showCreateDialog || Boolean(editingRoutine)}
        onOpenChange={closeDialogs}
        agents={agents}
        routine={editingRoutine}
        onCreateRoutine={createRoutine}
        onUpdateRoutine={updateRoutine}
      />

      <Dialog open={Boolean(deletingRoutine)} onOpenChange={(open) => !open && setDeletingRoutine(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete automation</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deletingRoutine?.name}&rdquo;? All future runs stop. Its run history stays in the thread. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setDeletingRoutine(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (deletingRoutine) {
                  const target = deletingRoutine;
                  setDeletingRoutine(null);
                  await run(target.id, () => cancelRoutine(target.id), 'The automation could not be deleted');
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
