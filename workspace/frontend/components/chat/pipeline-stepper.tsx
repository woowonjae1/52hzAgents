'use client';

import { Hint } from '@/components/ui/hint';
import { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle2,
  Loader2,
  Clock,
  AlertCircle,
  Square,
  GitFork,
  ChevronRight,
  Play,
  PauseCircle,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { workspaceApi } from '@/lib/api';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';

export interface PipelineDeliverable {
  summary: string;
  key_findings?: string[];
  artifacts?: string[];
  open_questions?: string[];
  raw_excerpt?: string;
}

export interface PipelineStepItem {
  agent: string;
  instruction: string;
  status: 'pending' | 'running' | 'retrying' | 'done' | 'failed';
  retry_count?: number;
  max_retries?: number;
  last_error?: string;
  deliverable?: PipelineDeliverable;
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
  verificationCmd,
  className,
}: {
  channelId: string | null;
  /**
   * The channel's verification command. The backend runs it after every
   * step's turn (evaluator.EvaluateTurnWithVerification) and sends a failing
   * step back for a retry, so it is a stage of every step -- shown here
   * because otherwise "Retry 1/3" appears with no visible cause.
   */
  verificationCmd?: string | null;
  className?: string;
}) {
  const [pipeline, setPipeline] = useState<PipelineData | null>(null);
  const [halting, setHalting] = useState(false);
  const [resuming, setResuming] = useState(false);

  const fetchPipeline = useCallback(async () => {
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
  }, [channelId]);

  useVisibilityPolling(fetchPipeline, 3000, { enabled: !!channelId });

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

  const handleResume = async () => {
    if (!channelId || resuming) return;
    setResuming(true);
    try {
      await workspaceApi.resumeChannelPipeline(channelId);
      toast.success('Pipeline execution resumed');
      await fetchPipeline();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to resume pipeline');
    } finally {
      setResuming(false);
    }
  };

  if (!pipeline || !pipeline.active || !pipeline.steps || pipeline.steps.length === 0) {
    return null;
  }

  const steps = pipeline.steps;
  const currentIdx = pipeline.current_index ?? 0;
  const isPaused = pipeline.status === 'paused';
  const doneCount = steps.filter((s, i) => s.status === 'done' || (i < currentIdx && s.status !== 'failed')).length;
  const verify = verificationCmd?.trim() || '';

  // What the pill's tooltip says: the instruction, then why it is retrying or failed.
  const stepHint = (step: PipelineStepItem) => {
    const parts = [step.instruction?.trim().split(/\r?\n/)[0]?.slice(0, 200)];
    if (step.last_error && (step.status === 'retrying' || step.status === 'failed')) {
      parts.push(`${verify ? 'Verification failed' : 'Failed'}: ${step.last_error.trim().split(/\r?\n/)[0].slice(0, 200)}`);
    }
    return parts.filter(Boolean).join(' — ') || `@${step.agent}`;
  };

  return (
    <div
      className={cn(
        'px-4 py-2 bg-surface2/70 flex items-center justify-between gap-3 text-xs shrink-0 select-none animate-in fade-in slide-in-from-top-1 duration-200',
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0 overflow-x-auto py-0.5">
        <div className="flex items-center gap-1.5 text-foreground-extra-muted shrink-0">
          <GitFork className={cn('size-3.5', isPaused ? 'text-status-warning' : 'text-primary')} />
          <span className={cn('font-semibold text-3xs uppercase tracking-wider', isPaused ? 'text-status-warning' : 'text-primary')}>
            {isPaused ? 'Pipeline Paused' : 'Pipeline'}
          </span>
          <span className="tabular-nums text-3xs">
            {doneCount}/{steps.length}
          </span>
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          {steps.map((step, idx) => {
            const isCurrent = idx === currentIdx;
            const isFailed = step.status === 'failed';
            const isDone = !isFailed && (step.status === 'done' || idx < currentIdx);
            const isRetrying = step.status === 'retrying';
            const isRunning = isCurrent && !isPaused && (step.status === 'running' || !step.status);
            const isStepPaused = isCurrent && isPaused;

            return (
              <div key={idx} className="flex items-center gap-1.5 shrink-0">
                <Hint label={stepHint(step)}>
                <div
                  tabIndex={0}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-medium border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    isFailed
                      ? 'bg-status-danger/10 text-status-danger border-status-danger/30'
                      : isDone
                      ? 'bg-surface3/80 text-foreground-muted border-border/60'
                      : isStepPaused
                        ? 'bg-status-warning/10 text-status-warning border-status-warning/30 font-semibold shadow-xs'
                        : isRunning
                          ? 'bg-primary/10 text-primary border-primary/30 font-semibold shadow-xs'
                          : isRetrying
                            ? 'bg-status-warning/10 text-status-warning border-status-warning/30'
                            : 'bg-surface2 text-foreground-extra-muted border-border/60'
                  )}
                >
                  {isFailed ? (
                    <XCircle className="size-3 text-status-danger shrink-0" />
                  ) : isDone ? (
                    <CheckCircle2 className="size-3 text-status-success shrink-0" />
                  ) : isStepPaused ? (
                    <PauseCircle className="size-3 text-status-warning shrink-0" />
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
                </Hint>

                {idx < steps.length - 1 && (
                  <ChevronRight className="size-3 text-foreground-extra-muted/60 shrink-0" />
                )}
              </div>
            );
          })}
        </div>

        {verify && (
          <Hint label={`Every step is checked with \`${verify}\` when its turn ends; a failure sends that step back for a retry.`}>
            <span
              tabIndex={0}
              className="inline-flex max-w-[220px] items-center gap-1 rounded-lg border border-border/60 bg-surface2 px-2 py-1 text-2xs text-foreground-muted shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ShieldCheck className="size-3 shrink-0" />
              <span className="shrink-0">Verify</span>
              <code className="truncate font-mono text-3xs">{verify}</code>
            </span>
          </Hint>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {isPaused && (
          <Hint label="Resume pipeline execution">
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-3xs font-medium bg-primary/10 hover:bg-primary/20 text-primary transition-colors border border-primary/30"
            >
              {resuming ? <Loader2 className="size-2.5 animate-spin" /> : <Play className="size-2.5 fill-current" />}
              Resume
            </button>
          </Hint>
        )}
        <Hint label="Stop running pipeline">
          <button
            type="button"
            onClick={handleHalt}
            disabled={halting}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-3xs font-medium bg-surface3 hover:bg-status-danger/10 text-foreground-muted hover:text-status-danger transition-colors border border-border/60"
          >
            {halting ? <Loader2 className="size-2.5 animate-spin" /> : <Square className="size-2.5" />}
            Stop
          </button>
        </Hint>
      </div>
    </div>
  );
}
