'use client';

import { Hint } from '@/components/ui/hint';
import React, { useState, useEffect, useCallback } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from '@/components/ui/sheet';
import {
  History,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Clock,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import { workspaceApi } from '@/lib/api';
import type { RoutineItem, RoutineRunItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/schedule-format';

interface RoutineHistoryDrawerProps {
  routine: RoutineItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenThread?: (channelName: string) => void;
}

export function RoutineHistoryDrawer({
  routine,
  open,
  onOpenChange,
  onOpenThread,
}: RoutineHistoryDrawerProps) {
  const [runs, setRuns] = useState<RoutineRunItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRuns = useCallback(async () => {
    if (!routine) return;
    setLoading(true);
    try {
      const data = await workspaceApi.listRoutineRuns(routine.id);
      setRuns(data?.runs || []);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [routine]);

  useEffect(() => {
    if (open && routine) {
      fetchRuns();
    }
  }, [open, routine, fetchRuns]);

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return 'Running';
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    const diff = Math.max(0, e - s);
    if (diff < 1000) return `${diff}ms`;
    if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`;
    const m = Math.floor(diff / 60000);
    const sec = Math.floor((diff % 60000) / 1000);
    return `${m}m ${sec}s`;
  };

  const formatTimestamp = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      return ts;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl w-full flex flex-col p-0">
        <SheetHeader className="px-6 py-5 border-b border-border/80 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="size-8 rounded-lg bg-status-merged/10 text-status-merged flex items-center justify-center shrink-0">
                <History className="size-4" />
              </div>
              <div className="min-w-0">
                <SheetTitle className="truncate">
                  {routine ? routine.name : 'Run history'}
                </SheetTitle>
                <SheetDescription className="truncate">
                  Task {routine?.shortId || routine?.id?.slice(0, 8)} · past runs and execution traces
                </SheetDescription>
              </div>
            </div>
            <Hint label="Refresh">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchRuns}
                disabled={loading}
                className="h-8 px-2.5 gap-1.5 shrink-0 rounded-lg"
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                <span className="text-xs">Refresh</span>
              </Button>
            </Hint>
          </div>
        </SheetHeader>

        <SheetBody className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading && runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
              <Loader2 className="size-6 animate-spin text-primary" />
              <span className="text-sm">Loading run history…</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-56 gap-2 text-muted-foreground">
              <Clock className="size-8 opacity-40" />
              <p className="text-sm font-medium">No runs yet</p>
              <p className="text-xs text-muted-foreground/70">
                Trigger it with Run Now on the task card, or wait for the next scheduled fire — logs land here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {runs.map((run) => {
                const isSuccess = run.status === 'completed';
                const isFailed = run.status === 'failed';
                const isRunning = run.status === 'running';

                return (
                  <div
                    key={run.id}
                    className="p-4 rounded-xl border border-border/80 bg-surface2/50 hover:bg-surface2/80 transition-colors space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-semibold text-foreground/80 px-1.5 py-0.5 rounded bg-surface3/60">
                          #{run.runNumber}
                        </span>

                        {isRunning && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface2 text-foreground-muted border border-border">
                            <Loader2 className="size-3 animate-spin" />
                            Running
                          </span>
                        )}
                        {isSuccess && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-muted-success text-status-success border border-status-success/30">
                            <CheckCircle2 className="size-3" />
                            Completed
                          </span>
                        )}
                        {isFailed && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-muted-danger text-status-danger border border-status-danger/30">
                            <AlertCircle className="size-3" />
                            Failed
                          </span>
                        )}
                      </div>

                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDuration(run.startedAt, run.completedAt)}
                      </span>
                    </div>

                    {/* Trigger prompt text */}
                    {run.triggerMessage && (
                      <div className="text-xs font-mono bg-surface1/80 border border-border/40 rounded-lg p-2.5 text-foreground-muted leading-relaxed line-clamp-3">
                        {run.triggerMessage}
                      </div>
                    )}

                    {/* Failure details callout */}
                    {isFailed && run.error && (
                      <div className="p-2.5 rounded-lg bg-status-muted-danger border border-status-danger/30 text-status-danger text-xs leading-relaxed">
                        <span className="font-semibold">Error: </span>
                        {run.error}
                      </div>
                    )}

                    {/* Run footer meta */}
                    <div className="flex items-center justify-between text-xs text-muted-foreground/80 pt-1">
                      <div className="flex items-center gap-2">
                        <Clock className="size-3 text-muted-foreground/60" />
                        <span>{formatTimestamp(run.startedAt)}</span>
                        <span className="text-muted-foreground/40">({timeAgo(run.startedAt)})</span>
                      </div>

                      {onOpenThread && run.channelName && (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenThread(run.channelName);
                            onOpenChange(false);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium cursor-pointer"
                        >
                          <span>Open thread</span>
                          <ArrowUpRight className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
