'use client';

import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Clock,
  AlertCircle,
  Square,
  GitFork,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';

export interface PipelineStepItem {
  agent: string;
  instruction: string;
  status: 'pending' | 'running' | 'retrying' | 'done' | 'failed';
  retry_count?: number;
  max_retries?: number;
  last_error?: string;
}

export interface PipelineData {
  active: boolean;
  id?: string;
  status?: string;
  current_index?: number;
  total_retries?: number;
  max_total_retries?: number;
  started_by?: string;
  steps?: PipelineStepItem[];
}

export function PipelineStepper({
  channelId,
  className,
}: {
  channelId: string | null;
  className?: string;
}) {
  const [pipeline, setPipeline] = useState<PipelineData | null>(null);
  const [halting, setHalting] = useState(false);

  const fetchPipeline = async () => {
    if (!channelId) return;
    try {
      const data = (await workspaceApi.getChannelPipeline(channelId)) as unknown as PipelineData;
      if (data && data.steps && data.steps.length > 0 && data.active) {
        setPipeline(data);
      } else {
        setPipeline(null);
      }
    } catch {
      setPipeline(null);
    }
  };

  useEffect(() => {
    if (!channelId) return;
    fetchPipeline();
    const interval = setInterval(fetchPipeline, 3000);
    return () => clearInterval(interval);
  }, [channelId]);

  const handleHalt = async () => {
    if (!channelId || halting) return;
    setHalting(true);
    try {
      await workspaceApi.haltChannelPipeline(channelId);
      toast.success('Pipeline execution halted');
      await fetchPipeline();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to halt pipeline');
    } finally {
      setHalting(false);
    }
  };

  if (!pipeline || !pipeline.active || !pipeline.steps || pipeline.steps.length === 0) {
    return null;
  }

  const steps = pipeline.steps;
  const currentIdx = pipeline.current_index ?? 0;

  return (
    <div
      className={cn(
        'px-4 py-2 bg-surface2/70 border-b border-border/80 flex items-center justify-between gap-3 text-xs shrink-0 select-none animate-in fade-in slide-in-from-top-1 duration-200',
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0 overflow-x-auto py-0.5">
        <div className="flex items-center gap-1.5 text-foreground-extra-muted shrink-0">
          <GitFork className="size-3.5 text-primary" />
          <span className="font-semibold text-3xs uppercase tracking-wider text-primary">Pipeline</span>
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          {steps.map((step, idx) => {
            const isCurrent = idx === currentIdx;
            const isDone = step.status === 'done' || idx < currentIdx;
            const isRetrying = step.status === 'retrying';
            const isRunning = isCurrent && (step.status === 'running' || !step.status);

            return (
              <div key={idx} className="flex items-center gap-1.5 shrink-0">
                <div
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-medium border transition-colors',
                    isDone
                      ? 'bg-surface3/80 text-foreground-muted border-border/60'
                      : isRunning
                        ? 'bg-primary/10 text-primary border-primary/30 font-semibold shadow-2xs'
                        : isRetrying
                          ? 'bg-status-warning/10 text-status-warning border-status-warning/30'
                          : 'bg-surface2 text-foreground-extra-muted border-border/40'
                  )}
                  title={step.instruction || `@${step.agent}`}
                >
                  {isDone ? (
                    <CheckCircle2 className="size-3 text-status-success shrink-0" />
                  ) : isRetrying ? (
                    <AlertCircle className="size-3 text-status-warning shrink-0" />
                  ) : isRunning ? (
                    <Loader2 className="size-3 text-primary animate-spin shrink-0" />
                  ) : (
                    <Clock className="size-3 text-foreground-extra-muted shrink-0" />
                  )}

                  <span className="truncate max-w-[110px]">@{step.agent}</span>

                  {isRetrying && (
                    <span className="font-mono text-3xs px-1 rounded bg-status-warning/20 text-status-warning shrink-0">
                      Retry {step.retry_count || 1}/{step.max_retries || 3}
                    </span>
                  )}
                </div>

                {idx < steps.length - 1 && (
                  <ChevronRight className="size-3 text-foreground-extra-muted/60 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleHalt}
          disabled={halting}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-3xs font-medium bg-surface3 hover:bg-status-danger/10 text-foreground-muted hover:text-status-danger transition-colors cursor-pointer border border-border/60"
          title="Stop running pipeline"
        >
          {halting ? <Loader2 className="size-2.5 animate-spin" /> : <Square className="size-2.5" />}
          Stop
        </button>
      </div>
    </div>
  );
}
