'use client';

import * as React from 'react';
import {
  Clock,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  FileCode,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TimelineStep {
  verb: string;
  chip: string;
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
}

export interface TimelineStat {
  file: string;
  added?: number;
  removed?: number;
}

export interface ToolTimelineProps {
  steps: TimelineStep[];
  visibleSteps?: number;
  streaming?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  restingLabel?: string;
  activeLabel?: string;
  stats?: TimelineStat[];
  className?: string;
}

export function ToolTimeline({
  steps = [],
  visibleSteps,
  streaming = false,
  open: controlledOpen,
  onOpenChange,
  restingLabel = 'Tool steps',
  activeLabel = 'Executing steps...',
  stats = [],
  className,
}: ToolTimelineProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange]
  );

  const displayedSteps = visibleSteps !== undefined ? steps.slice(0, visibleSteps) : steps;
  const label = streaming ? activeLabel : restingLabel;

  const renderStepIcon = (icon?: React.ComponentType<{ className?: string }> | React.ReactNode) => {
    if (React.isValidElement(icon)) return icon;
    if (typeof icon === 'function') {
      const Comp = icon as React.ComponentType<{ className?: string }>;
      return <Comp className="size-3.5" />;
    }
    return <FileCode className="size-3.5" />;
  };

  return (
    <div
      className={cn(
        'my-2 rounded-2xl border border-border/80 bg-surface1/75 backdrop-blur-md p-3 shadow-xs space-y-2.5 transition-all',
        className
      )}
    >
      {/* Trigger Header */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 text-left cursor-pointer group select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-lg',
              streaming ? 'bg-primary/15 text-primary' : 'bg-surface3 text-foreground-muted'
            )}
          >
            {streaming ? <Loader2 className="size-3.5 animate-spin" /> : <Clock className="size-3.5" />}
          </span>
          <span
            className={cn(
              'text-xs font-semibold tracking-tight truncate',
              streaming ? 'text-primary' : 'text-foreground'
            )}
          >
            {label}
          </span>
          <span className="text-3xs font-mono px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted border border-border/60 shrink-0">
            {steps.length} {steps.length === 1 ? 'action' : 'actions'}
          </span>
        </div>

        <div className="flex items-center gap-2 text-foreground-extra-muted shrink-0">
          {streaming && (
            <span className="flex items-center gap-1 text-3xs font-medium text-primary">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              <span>Active</span>
            </span>
          )}
          <span>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        </div>
      </button>

      {/* Expanded Timeline Steps */}
      {open && (
        <div className="space-y-3 pt-1 border-t border-border/60">
          {/* Step list with tree rail */}
          <div className="space-y-1.5 border-l-2 border-primary/25 pl-3 ml-2.5">
            {displayedSteps.map((step, idx) => (
              <div key={idx} className="flex items-center justify-between gap-2 py-1 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded bg-surface3 text-foreground-muted">
                    {renderStepIcon(step.icon)}
                  </span>
                  <span className="font-semibold text-foreground">{step.verb}</span>
                  <span className="font-mono text-2xs px-2 py-0.5 rounded-md bg-surface2 text-foreground-muted border border-border/50 truncate">
                    {step.chip}
                  </span>
                </div>

                <span className="text-3xs text-foreground-extra-muted font-mono">
                  #{idx + 1}
                </span>
              </div>
            ))}
          </div>

          {/* Stats section (Added / Removed Lines) */}
          {stats.length > 0 && (
            <div className="mt-2 rounded-xl bg-surface2/60 border border-border/60 p-2.5 space-y-1.5">
              <div className="text-3xs font-mono uppercase tracking-wider text-foreground-extra-muted">
                File Changes Summary
              </div>
              <div className="space-y-1">
                {stats.map((stat, sIdx) => (
                  <div key={sIdx} className="flex items-center justify-between text-2xs font-mono py-0.5">
                    <span className="text-foreground-muted truncate mr-2" title={stat.file}>
                      {stat.file}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0 font-medium tabular-nums">
                      {stat.added !== undefined && stat.added > 0 && (
                        <span className="text-status-success inline-flex items-center gap-0.5">
                          <Plus className="size-2.5" />
                          {stat.added}
                        </span>
                      )}
                      {stat.removed !== undefined && stat.removed > 0 && (
                        <span className="text-status-danger inline-flex items-center gap-0.5">
                          <Minus className="size-2.5" />
                          {stat.removed}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
