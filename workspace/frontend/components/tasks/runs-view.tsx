import { Hint } from '@/components/ui/hint';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  History,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Search,
  X,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/lib/api';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import type { RoutineRunItem } from '@/lib/types';
import { formatAbsolute, formatDuration, timeAgo } from '@/lib/schedule-format';
import { cn } from '@/lib/utils';

/**
 * Run history is append-only: once every run has finished, nothing on this
 * screen changes until a routine fires again. Polling it every 4 seconds
 * regardless was pure overhead, so the interval follows whether anything is
 * actually in flight.
 */
const IDLE_REFRESH_MS = 20_000;
const ACTIVE_REFRESH_MS = 3_000;

export function RunsView() {
  const [runs, setRuns] = useState<RoutineRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const { setCurrentSessionId } = useWorkspace();
  const { setViewMode } = useLayout();

  const fetchRuns = useCallback(async () => {
    try {
      const res = await workspaceApi.listRoutineRuns();
      setRuns(res.runs);
      setError(null);
    } catch (err) {
      // A failed fetch used to be swallowed, leaving a stale list that looked
      // current. Say so instead, and keep whatever was already loaded.
      setError(err instanceof Error ? err.message : 'Execution history could not be loaded');
    } finally {
      setLoading(false);
    }
  }, []);

  const hasRunning = useMemo(() => runs.some((r) => r.status === 'running'), [runs]);

  useVisibilityPolling(fetchRuns, hasRunning ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);

  // Durations of open runs tick locally rather than on each refetch.
  useEffect(() => {
    if (!hasRunning) return;
    const tick = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(tick);
  }, [hasRunning]);

  const filteredRuns = useMemo(() => {
    if (!searchQuery.trim()) return runs;
    const q = searchQuery.toLowerCase();
    return runs.filter(
      (r) =>
        r.routineShortId.toLowerCase().includes(q) ||
        r.agentName.toLowerCase().includes(q) ||
        r.triggerMessage.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q) ||
        `task-${r.routineShortId.toLowerCase()}.#${r.runNumber}`.includes(q)
    );
  }, [runs, searchQuery]);

  const handleOpenThread = (channelName: string) => {
    setCurrentSessionId(channelName);
    setViewMode('threads');
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search & Actions Bar */}
      <div className="px-6 py-3 border-b border-border/60 bg-surface1/30 flex items-center justify-between gap-3 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-extra-muted" />
          <input
            type="text"
            placeholder="Search execution runs by ID, agent, trigger..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-7 text-xs rounded-lg border border-border bg-surface2/60 text-foreground placeholder:text-foreground-extra-muted focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
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
          <Hint label="Refresh runs">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchRuns()}
              className="h-8 w-8 p-0 bg-surface1/60 hover:bg-surface2"
            >
              <RefreshCw className={cn('size-3.5 text-foreground-muted', loading && 'animate-spin')} />
            </Button>
          </Hint>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* Main Runs List */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-5xl mx-auto space-y-3">
          {filteredRuns.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-border p-8 space-y-2">
              <History className="size-8 text-foreground-extra-muted opacity-60" />
              <p className="text-sm font-medium text-foreground">
                {loading ? 'Loading execution records…' : 'No execution records found'}
              </p>
              <p className="text-xs text-foreground-extra-muted max-w-sm">
                {searchQuery
                  ? 'No runs match your search filter.'
                  : 'Execution instances appear here automatically whenever a scheduled routine fires.'}
              </p>
            </div>
          ) : (
            filteredRuns.map((run) => {
              const isRunning = run.status === 'running';
              const isFailed = run.status === 'failed';
              const isCompleted = run.status === 'completed';

              return (
                <div
                  key={run.id}
                  className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-border bg-surface1/60 hover:bg-surface1 hover:border-border transition-all"
                >
                  <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                    {/* Status Icon */}
                    <div className="shrink-0 pt-0.5 sm:pt-0">
                      {isRunning ? (
                        <Loader2 className="size-4 text-foreground-muted animate-spin" />
                      ) : isFailed ? (
                        <AlertCircle className="size-4 text-status-danger" />
                      ) : (
                        <CheckCircle2 className="size-4 text-status-success" />
                      )}
                    </div>

                    {/* Run ID & Details */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-md bg-surface2 border border-border text-foreground">
                          TASK-{run.routineShortId}.#{run.runNumber}
                        </span>

                        <div className="flex items-center gap-1.5">
                          <AgentAvatar name={run.agentName} size={16} />
                          <span className="text-xs font-medium text-foreground-muted">
                            {run.agentName}
                          </span>
                        </div>

                        {isRunning && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.2 rounded-full text-3xs font-medium bg-surface2 text-foreground-muted border border-border">
                            Running
                          </span>
                        )}
                        {isCompleted && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.2 rounded-full text-3xs font-medium bg-status-muted-success text-status-success border border-status-success/30">
                            Completed
                          </span>
                        )}
                        {isFailed && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.2 rounded-full text-3xs font-medium bg-status-muted-danger text-status-danger border border-status-danger/30">
                            Failed
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-foreground-muted truncate font-mono">
                        {run.triggerMessage}
                      </p>

                      {/* A failed run without its reason is not actionable. */}
                      {isFailed && run.error && (
                        <p className="text-3xs text-destructive truncate" title={run.error}>
                          {run.error}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Right Side: Timestamps & Action */}
                  <div className="flex items-center gap-4 shrink-0 self-end sm:self-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-border/60">
                    <div className="text-right text-3xs text-foreground-extra-muted space-y-0.5">
                      <div
                        className="flex items-center justify-end gap-1"
                        title={formatAbsolute(run.startedAt)}
                      >
                        <Clock className="size-3" />
                        <span>{timeAgo(run.startedAt, now)}</span>
                      </div>
                      <div className="font-mono">
                        {isRunning ? 'Elapsed' : 'Duration'}:{' '}
                        {formatDuration(run.startedAt, run.completedAt, now)}
                      </div>
                    </div>

                    <Hint label="Open conversation thread">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleOpenThread(run.channelName)}
                        className="h-7 px-2.5 text-xs gap-1 bg-surface2/60 hover:bg-surface2 text-foreground-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-3" />
                        <span>Thread</span>
                      </Button>
                    </Hint>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
