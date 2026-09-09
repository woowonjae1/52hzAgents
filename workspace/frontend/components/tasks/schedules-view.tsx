import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  CalendarClock,
  Clock,
  Timer,
  Play,
  Pause,
  Pencil,
  Trash2,
  ExternalLink,
  Plus,
  Search,
  X,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Square,
  History,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { RoutineHistoryDrawer } from '@/components/routines/routine-history-drawer';
import { toast } from 'sonner';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { CreateRoutineDialog } from '@/components/routines/create-routine-dialog';
import type { RoutineItem } from '@/lib/types';
import { formatAbsolute, formatSchedule, timeAgo, timeUntil } from '@/lib/schedule-format';
import { cn } from '@/lib/utils';

// Re-exported for the other views that grew their own copies of these.
export { formatSchedule, timeUntil };

/**
 * How often to re-read routines from the server.
 *
 * The countdowns on this screen change every minute, but the *data* behind them
 * only changes when a routine fires. This view used to refetch every 4 seconds
 * to keep "in 3h 12m" moving — 15 requests a minute to re-render a string the
 * client can compute itself. The countdown now runs off a local clock tick and
 * the network poll only has to notice a fired run, so it slows down to a rate
 * the workspace context already uses. While something is actually running the
 * poll speeds up, because then the data really is changing.
 */
const IDLE_REFRESH_MS = 20_000;
const ACTIVE_REFRESH_MS = 4_000;
const CLOCK_TICK_MS = 1_000;

export function SchedulesView() {
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

  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<RoutineItem | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [historyRoutine, setHistoryRoutine] = useState<RoutineItem | null>(null);
  const [deletingRoutine, setDeletingRoutine] = useState<RoutineItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const hasActiveRun = useMemo(
    () => routines.some((r) => r.lastRunStatus === 'running' && r.status !== 'paused'),
    [routines]
  );

  const refreshSchedules = useCallback(async () => {
    await Promise.all([refreshRoutines(), refreshTimers()]);
  }, [refreshRoutines, refreshTimers]);

  useVisibilityPolling(refreshSchedules, hasActiveRun ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);

  // One clock for every countdown on the page.
  useEffect(() => {
    const tick = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const filteredRoutines = useMemo(() => {
    if (!searchQuery.trim()) return routines;
    const q = searchQuery.toLowerCase();
    return routines.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.message.toLowerCase().includes(q) ||
        r.createdBy.toLowerCase().includes(q) ||
        (r.shortId && r.shortId.toLowerCase().includes(q))
    );
  }, [routines, searchQuery]);

  // One-off timers belong on this page too. A "remind me at 16:11" was only
  // ever visible in the thread status bar, so the Schedules tab looked empty
  // even though something was genuinely scheduled.
  const pendingTimers = useMemo(() => {
    const active = timers.filter((t) => t.status === 'active');
    if (!searchQuery.trim()) return active;
    const q = searchQuery.toLowerCase();
    return active.filter(
      (t) => t.message.toLowerCase().includes(q) || t.createdBy.toLowerCase().includes(q)
    );
  }, [timers, searchQuery]);

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The action could not be completed');
    }
  };

  const handleRunNow = async (routine: RoutineItem) => {
    setRunningRoutineId(routine.id);
    try {
      await triggerRoutine(routine.id);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The routine could not be triggered');
    } finally {
      setRunningRoutineId(null);
    }
  };

  const handleStopRun = async (routine: RoutineItem) => {
    try {
      await stopAllAgents(routine.channelName);
      toast.success(`已向 @${routine.createdBy} 发送终止指令`);
      await refreshRoutines();
    } catch {
      toast.error('未能中止当前执行');
    }
  };

  const handleOpenThread = (channelName: string) => {
    setCurrentSessionId(channelName);
    setViewMode('threads');
  };

  const closeDialogs = (open: boolean) => {
    if (open) return;
    setShowCreateDialog(false);
    setEditingRoutine(null);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search & Actions Bar */}
      <div className="px-6 py-3 border-b border-border/60 bg-surface1/30 flex items-center justify-between gap-3 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-extra-muted" />
          <input
            type="text"
            placeholder="Search scheduled routines by name, prompt, ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-7 text-xs rounded-lg border border-border/70 bg-surface2/60 text-foreground placeholder:text-foreground-extra-muted focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-extra-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshSchedules()}
            className="h-8 w-8 p-0 bg-surface1/60 hover:bg-surface2"
            title="Refresh schedules"
          >
            <RefreshCw className="size-3.5 text-foreground-muted" />
          </Button>
          <Button
            size="sm"
            onClick={() => { setEditingRoutine(null); setShowCreateDialog(true); }}
            className="h-8 gap-1.5 px-3 text-xs font-medium shadow-xs"
          >
            <Plus className="size-3.5" />
            <span>New Schedule</span>
          </Button>
        </div>
      </div>

      {/* An action that failed used to fail silently — pause, run and delete all
          swallowed their errors, so a rejected request looked like a no-op. */}
      {actionError && (
        <div className="mx-6 mt-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* Main Routine List */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-5xl mx-auto space-y-4">
          {/* One-off timers, soonest first. Rendered above the recurring list
              because they are the things about to happen. */}
          {pendingTimers.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Timer className="size-3.5 text-foreground-muted" />
                <h3 className="text-xs font-semibold text-foreground tracking-tight">One-off</h3>
                <span className="text-2xs font-mono font-medium text-foreground-extra-muted bg-surface2 px-1.5 py-0.2 rounded-full border border-border/40">
                  {pendingTimers.length}
                </span>
              </div>
              <div className="overflow-hidden rounded-xl border border-border/80 bg-surface1/60 divide-y divide-border/60 shadow-xs">
                {[...pendingTimers]
                  .sort((a, b) => new Date(a.firesAt).getTime() - new Date(b.firesAt).getTime())
                  .map((timer) => (
                    <div
                      key={timer.id}
                      className="group flex items-center gap-3 px-4 py-2.5 hover:bg-surface2/60 transition-colors"
                    >
                      <Timer className="size-3.5 shrink-0 text-amber-400" />
                      <p className="min-w-0 flex-1 text-sm text-foreground truncate">{timer.message}</p>
                      <div className="flex shrink-0 items-center gap-3 text-xs text-foreground-extra-muted">
                        <span className="inline-flex items-center gap-1.5">
                          <AgentAvatar name={timer.createdBy} size={16} />
                          <span className="hidden sm:inline text-foreground-muted">{timer.createdBy}</span>
                        </span>
                        <span
                          className="font-medium text-amber-400"
                          title={formatAbsolute(timer.firesAt)}
                        >
                          {timeUntil(timer.firesAt, now)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void runAction(() => cancelTimer(timer.id))}
                          className="h-7 w-7 p-0 text-foreground-extra-muted hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Cancel this reminder"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {filteredRoutines.length === 0 && pendingTimers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-border/70 p-8 space-y-3">
              <CalendarClock className="size-8 text-foreground-extra-muted opacity-60" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">No scheduled routines</p>
                <p className="text-xs text-foreground-extra-muted max-w-sm">
                  {searchQuery
                    ? 'No routines match your search filter.'
                    : 'Set up automated schedules for agents to run recurring tasks, code checks, or daily summaries.'}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => { setEditingRoutine(null); setShowCreateDialog(true); }}
                className="mt-2 gap-1.5 text-xs"
              >
                <Plus className="size-3.5" />
                Create Schedule
              </Button>
            </div>
          ) : (
            filteredRoutines.map((routine) => {
              const isPaused = routine.status === 'paused';
              const isRunning = routine.lastRunStatus === 'running' || runningRoutineId === routine.id;
              const hasFailed = routine.lastRunStatus === 'failed';

              return (
                <div
                  key={routine.id}
                  className={cn(
                    'group relative rounded-xl border bg-surface1/60 p-4 transition-all shadow-xs hover:border-border hover:bg-surface1/80',
                    isPaused ? 'border-border/40 opacity-75' : 'border-border/80'
                  )}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/50">
                    {/* Top Meta info */}
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        {routine.shortId || 'RTN'}
                      </span>
                      <h3 className="text-sm font-semibold text-foreground tracking-tight">
                        {routine.name}
                      </h3>
                      {isPaused ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium bg-surface3 text-foreground-muted border border-border/60">
                          Paused
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Active
                        </span>
                      )}
                      {isRunning && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          <Loader2 className="size-2.5 animate-spin" />
                          Running
                        </span>
                      )}
                    </div>

                    {/* Quick Action Buttons */}
                    <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                      {isRunning ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleStopRun(routine)}
                          className="h-7 px-2 text-xs gap-1 border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/60 bg-rose-500/5"
                          title="停止当前运行"
                        >
                          <Square className="size-2.5 fill-current" />
                          <span>Stop</span>
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRunNow(routine)}
                          disabled={runningRoutineId === routine.id}
                          className="h-7 px-2 text-xs gap-1 bg-surface2/60 hover:bg-surface2"
                          title="立即触发一次"
                        >
                          {runningRoutineId === routine.id ? (
                            <Loader2 className="size-3 animate-spin text-foreground-muted" />
                          ) : (
                            <Play className="size-3 text-emerald-400" />
                          )}
                          <span>Run Now</span>
                        </Button>
                      )}

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setHistoryRoutine(routine)}
                        className="h-7 px-2 text-xs gap-1 bg-surface2/60 hover:bg-surface2 text-status-merged hover:text-status-merged"
                        title="查看历史执行记录与日志"
                      >
                        <History className="size-3" />
                        <span>History</span>
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runAction(() => toggleRoutine(routine.id))}
                        className="h-7 px-2 text-xs gap-1 bg-surface2/60 hover:bg-surface2"
                        title={isPaused ? 'Resume schedule' : 'Pause schedule'}
                      >
                        {isPaused ? (
                          <>
                            <Play className="size-3 text-blue-400" />
                            <span>Resume</span>
                          </>
                        ) : (
                          <>
                            <Pause className="size-3 text-amber-400" />
                            <span>Pause</span>
                          </>
                        )}
                      </Button>

                      {/* Editing a schedule used to mean deleting it and
                          starting over, which threw away its id, run count and
                          entire run history. */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setEditingRoutine(routine); setShowCreateDialog(false); }}
                        className="h-7 px-2 text-xs gap-1 bg-surface2/60 hover:bg-surface2"
                        title="Edit schedule"
                      >
                        <Pencil className="size-3" />
                        <span>Edit</span>
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleOpenThread(routine.channelName)}
                        className="h-7 px-2 text-xs gap-1 bg-surface2/60 hover:bg-surface2 text-foreground-muted hover:text-foreground"
                        title="View Routine Thread"
                      >
                        <ExternalLink className="size-3" />
                        <span>Thread</span>
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeletingRoutine(routine)}
                        className="h-7 w-7 p-0 text-foreground-extra-muted hover:text-destructive hover:bg-destructive/10"
                        title="Delete schedule"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>

                  {/* Body Content */}
                  <div className="pt-3 space-y-2.5">
                    <p className="text-xs text-foreground-muted leading-relaxed font-mono bg-surface2/40 rounded-lg p-2.5 border border-border/40">
                      {routine.message}
                    </p>

                    {hasFailed && routine.lastRunError && (
                      <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-2">
                        Last run failed: {routine.lastRunError}
                      </p>
                    )}

                    {/* Metadata Footer */}
                    <div className="flex flex-wrap items-center gap-4 text-xs text-foreground-extra-muted pt-1">
                      {/* Assigned Agent */}
                      <div className="flex items-center gap-1.5">
                        <AgentAvatar name={routine.createdBy} size={16} />
                        <span className="font-medium text-foreground-muted">{routine.createdBy}</span>
                      </div>

                      {/* Schedule Rule */}
                      <div className="flex items-center gap-1">
                        <Clock className="size-3" />
                        <span>{formatSchedule(routine)}</span>
                      </div>

                      {/* Next Fire */}
                      <div className="flex items-center gap-1">
                        <CalendarClock className="size-3" />
                        {isPaused ? (
                          <span className="text-foreground-extra-muted">Paused</span>
                        ) : (
                          <span
                            className="font-medium text-blue-400"
                            title={formatAbsolute(routine.nextFiresAt)}
                          >
                            Next run: {timeUntil(routine.nextFiresAt, now)}
                          </span>
                        )}
                      </div>

                      {/* Run Count & Last Status */}
                      {routine.runCount !== undefined && routine.runCount > 0 && (
                        <div className="flex items-center gap-1" title={formatAbsolute(routine.lastFiredAt)}>
                          {routine.lastRunStatus === 'completed' ? (
                            <CheckCircle2 className="size-3 text-emerald-400" />
                          ) : hasFailed ? (
                            <AlertCircle className="size-3 text-red-400" />
                          ) : (
                            <Loader2 className="size-3 text-blue-400 animate-spin" />
                          )}
                          <span>
                            Run #{routine.runCount} ({routine.lastRunStatus || 'completed'})
                            {routine.lastFiredAt ? ` · ${timeAgo(routine.lastFiredAt, now)}` : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
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

      <RoutineHistoryDrawer
        routine={historyRoutine}
        open={Boolean(historyRoutine)}
        onOpenChange={(open) => !open && setHistoryRoutine(null)}
        onOpenThread={handleOpenThread}
      />

      <Dialog open={Boolean(deletingRoutine)} onOpenChange={(open) => !open && setDeletingRoutine(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除定时任务</DialogTitle>
            <DialogDescription>
              确定要删除定时任务「{deletingRoutine?.name}」吗？删除后将停止所有后续调度并清理相关配置，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setDeletingRoutine(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (deletingRoutine) {
                  await runAction(() => cancelRoutine(deletingRoutine.id));
                  setDeletingRoutine(null);
                }
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
