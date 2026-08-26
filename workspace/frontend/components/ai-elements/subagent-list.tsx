'use client';

import * as React from 'react';
import { Bot, Check, Sparkles, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SubagentItem {
  name: string;
  role?: string;
  model?: string;
  workspace?: string;
  prompt?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  steps?: { tool: string; summary: string }[];
}

export interface SubagentListProps {
  agents: SubagentItem[];
  completedCount?: number;
  progress?: number[]; // 0-100 per agent
  showSummary?: boolean;
  summaryAgent?: SubagentItem;
  className?: string;
  onAgentClick?: (agent: SubagentItem, index: number) => void;
}

export function SubagentList({
  agents = [],
  completedCount = 0,
  progress = [],
  showSummary = false,
  summaryAgent,
  className,
  onAgentClick,
}: SubagentListProps) {
  if (!agents || agents.length === 0) return null;

  const total = agents.length;
  const isAllComplete = completedCount >= total;

  return (
    <div
      className={cn(
        'my-2 rounded-2xl border border-border/80 bg-surface1/75 backdrop-blur-md p-3.5 shadow-xs space-y-3 transition-all',
        className
      )}
    >
      {/* Header with counter */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Layers className="size-3.5" />
          </span>
          <span className="text-xs font-semibold text-foreground tracking-tight">
            Parallel Subagents
          </span>
          <span className="text-3xs font-mono px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted border border-border/60">
            {completedCount} / {total} completed
          </span>
        </div>

        {isAllComplete && (
          <span className="inline-flex items-center gap-1 text-3xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
            <Check className="size-2.5" />
            <span>All done</span>
          </span>
        )}
      </div>

      {/* Agents Card Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {agents.map((agent, index) => {
          const isDone = agent.status === 'completed' || index < completedCount;
          const isRunning = !isDone && (agent.status === 'running' || index === completedCount);
          const currentProgress = progress[index] ?? (isDone ? 100 : isRunning ? 60 : 0);

          return (
            <div
              key={index}
              onClick={() => onAgentClick?.(agent, index)}
              className={cn(
                'group flex flex-col justify-between rounded-xl border border-border/70 bg-surface2/70 p-3 transition-all duration-200',
                isRunning && 'border-primary/40 shadow-xs shadow-primary/5',
                onAgentClick && 'cursor-pointer hover:border-border hover:bg-surface2'
              )}
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={cn(
                        'flex size-5 items-center justify-center rounded-md text-3xs',
                        isDone
                          ? 'bg-status-muted-success text-status-success'
                          : isRunning
                          ? 'bg-primary/15 text-primary'
                          : 'bg-surface3 text-foreground-muted'
                      )}
                    >
                      <Bot className="size-3" />
                    </span>
                    <span className="text-xs font-semibold text-foreground truncate">
                      {agent.role || agent.name}
                    </span>
                  </div>

                  {agent.model && (
                    <span className="text-3xs font-mono px-1.5 py-0.2 rounded bg-surface3/80 text-foreground-muted shrink-0">
                      {agent.model}
                    </span>
                  )}
                </div>

                {agent.prompt && (
                  <p className="text-2xs text-foreground-muted line-clamp-2 leading-relaxed">
                    {agent.prompt}
                  </p>
                )}
              </div>

              {/* Progress bar */}
              <div className="mt-2.5 space-y-1">
                <div className="flex items-center justify-between text-3xs text-foreground-extra-muted">
                  <span className="flex items-center gap-1">
                    {isRunning ? (
                      <span className="flex items-center gap-1 text-primary font-medium">
                        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                        <span>Running</span>
                      </span>
                    ) : isDone ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        Complete
                      </span>
                    ) : (
                      <span>Pending</span>
                    )}
                  </span>
                  <span className="font-mono tabular-nums">{currentProgress}%</span>
                </div>
                <div className="h-1 w-full bg-surface3 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-300',
                      isDone
                        ? 'bg-status-success'
                        : isRunning
                        ? 'bg-primary animate-pulse'
                        : 'bg-foreground-extra-muted/30'
                    )}
                    style={{ width: `${currentProgress}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary Agent Card (Optional) */}
      {(showSummary || summaryAgent) && (
        <div className="rounded-xl border border-border/80 bg-primary/5 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
              <Sparkles className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <span>{summaryAgent?.name || 'Synthesis Lead'}</span>
                {summaryAgent?.model && (
                  <span className="text-3xs font-mono px-1.5 py-0.2 rounded bg-surface2 text-foreground-muted">
                    {summaryAgent.model}
                  </span>
                )}
              </div>
              <p className="text-3xs text-foreground-muted truncate">
                Synthesizing findings from all {total} parallel subagents
              </p>
            </div>
          </div>

          <span className="text-3xs font-medium px-2 py-0.5 rounded-md bg-surface1 text-foreground-muted border border-border/60 shrink-0">
            {isAllComplete ? 'Ready' : 'Waiting on workers'}
          </span>
        </div>
      )}
    </div>
  );
}
