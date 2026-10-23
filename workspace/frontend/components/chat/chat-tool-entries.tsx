'use client';

import * as React from 'react';
import { useState, useMemo } from 'react';
import {
  Terminal,
  FileText,
  Search,
  Globe,
  ChevronRight,
  ChevronDown,
  Wrench,
  Loader2,
  Check,
  X,
  Code2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';

/* -------------------------------------------------------------------------- */
/* ToolStatusDot (ported from cdesktop ToolStatusDot.tsx)                    */
/* -------------------------------------------------------------------------- */

export type ToolStatusType =
  | 'success'
  | 'completed'
  | 'ok'
  | 'failed'
  | 'error'
  | 'denied'
  | 'timed_out'
  | 'running'
  | 'in_progress'
  | 'pending'
  | 'created'
  | 'pending_approval'
  | 'blocked';

export interface ToolStatusLike {
  status: string;
}

interface ToolStatusDotProps {
  status: ToolStatusLike | string;
  className?: string;
}

export function ToolStatusDot({ status, className }: ToolStatusDotProps) {
  const s = (typeof status === 'string' ? status : status.status || '').toLowerCase();

  const isSuccess = s === 'success' || s === 'completed' || s === 'ok';
  const isError = s === 'failed' || s === 'error' || s === 'denied' || s === 'timed_out';
  const isRunning = s === 'running' || s === 'in_progress';
  const isPending = s === 'created' || s === 'pending_approval' || s === 'pending';

  return (
    <span className={cn('relative inline-flex items-center justify-center size-2 shrink-0', className)}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          isSuccess && 'bg-status-success',
          isError && 'bg-status-danger',
          isRunning && 'bg-brand',
          isPending && 'bg-status-warning',
          !isSuccess && !isError && !isRunning && !isPending && 'bg-foreground-extra-muted'
        )}
      />
      {(isRunning || isPending) && (
        <span
          className={cn(
            'absolute inset-0 size-2 rounded-full animate-ping opacity-75',
            isRunning ? 'bg-brand' : 'bg-status-warning'
          )}
        />
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* ChatToolSummary (ported from cdesktop ChatToolSummary.tsx)                */
/* -------------------------------------------------------------------------- */

export interface ChatToolSummaryProps {
  summary: string;
  className?: string;
  expanded?: boolean;
  onToggle?: () => void;
  status?: ToolStatusLike | string;
  onViewContent?: () => void;
  toolName?: string;
  actionType?: string;
  detail?: React.ReactNode;
}

export function ChatToolSummary({
  summary,
  className,
  expanded = false,
  onToggle,
  status,
  onViewContent,
  toolName,
  actionType,
  detail,
}: ChatToolSummaryProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = onToggle ? expanded : internalExpanded;
  const handleToggle = onToggle || (() => setInternalExpanded((prev) => !prev));
  const isClickable = Boolean(onViewContent || detail);

  const getIcon = () => {
    const t = (toolName || '').toLowerCase();
    const a = (actionType || '').toLowerCase();
    if (t.includes('bash') || t.includes('terminal') || t.includes('shell') || t.includes('command')) {
      return Terminal;
    }
    if (a === 'file_read' || a.includes('read') || a.includes('file') || t.includes('read') || t.includes('file')) {
      return FileText;
    }
    if (a.includes('search') || a.includes('find') || a.includes('grep') || t.includes('search')) {
      return Search;
    }
    if (a.includes('web') || a.includes('fetch') || a.includes('http') || a.includes('url')) {
      return Globe;
    }
    return Wrench;
  };

  const Icon = getIcon();

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div
        className={cn(
          'flex items-center gap-2 text-xs text-foreground-muted py-0.5 select-none',
          isClickable && 'cursor-pointer hover:text-foreground'
        )}
        onClick={isClickable ? handleToggle : undefined}
        role={isClickable ? 'button' : undefined}
      >
        <span className="relative shrink-0 flex items-center justify-center size-4">
          <Icon className="size-3 text-foreground-extra-muted" />
          {status && (
            <span className="absolute -bottom-0.5 -right-0.5">
              <ToolStatusDot status={status} />
            </span>
          )}
        </span>
        <span className="truncate flex-1 font-mono text-2xs text-foreground/85">
          {summary}
        </span>
        {detail && (
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-foreground-extra-muted transition-transform',
              !isExpanded && '-rotate-90'
            )}
          />
        )}
      </div>

      {isExpanded && detail && (
        <div className="ml-5 p-2 rounded bg-surface2/60 border border-border/50 text-3xs font-mono text-foreground overflow-x-auto">
          {detail}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ChatAggregatedToolEntries (ported from cdesktop ChatAggregatedToolEntries)*/
/* -------------------------------------------------------------------------- */

export interface AggregatedToolEntry {
  summary: string;
  status?: ToolStatusLike | string;
  expansionKey: string;
  content?: string;
  command?: string;
  toolName?: string;
  actionType?: string;
  detail?: React.ReactNode;
}

export interface ChatAggregatedToolEntriesProps {
  entries: AggregatedToolEntry[];
  expanded?: boolean;
  onToggle?: () => void;
  label: string;
  unitLabel: string;
  className?: string;
}

export function ChatAggregatedToolEntries({
  entries,
  expanded: controlledExpanded,
  onToggle,
  label,
  unitLabel,
  className,
}: ChatAggregatedToolEntriesProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const handleToggle = onToggle || (() => setInternalExpanded((prev) => !prev));

  if (entries.length === 0) return null;

  // Single entry fallback
  if (entries.length === 1) {
    const entry = entries[0];
    return (
      <ChatToolSummary
        summary={entry.summary}
        status={entry.status}
        toolName={entry.toolName}
        actionType={entry.actionType}
        detail={entry.detail}
        className={className}
      />
    );
  }

  // Find worst status among all entries
  const worstStatus = (() => {
    const statusPriority: Record<string, number> = {
      failed: 6,
      error: 6,
      denied: 5,
      timed_out: 4,
      pending_approval: 3,
      created: 2,
      running: 2,
      in_progress: 2,
      success: 1,
      completed: 1,
      ok: 1,
    };
    let worst = 'ok';
    let maxPrio = 0;
    for (const e of entries) {
      const s = (typeof e.status === 'string' ? e.status : e.status?.status || '').toLowerCase();
      const prio = statusPriority[s] || 0;
      if (prio > maxPrio) {
        maxPrio = prio;
        worst = s;
      }
    }
    return worst;
  })();

  const isBash = entries.some((e) => (e.toolName || '').toLowerCase().includes('bash'));
  const RootIcon = isBash ? Terminal : Wrench;

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Header row - clickable to toggle */}
      <div
        className="flex items-center gap-2 text-xs text-foreground-muted hover:text-foreground cursor-pointer select-none py-1 group"
        onClick={handleToggle}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        role="button"
        aria-expanded={isExpanded}
      >
        <span className="relative shrink-0 flex items-center justify-center size-4">
          {isHovered ? (
            <ChevronRight
              className={cn(
                'size-3 text-foreground transition-transform duration-150',
                isExpanded && 'rotate-90'
              )}
            />
          ) : (
            <RootIcon className="size-3 text-foreground-extra-muted" />
          )}
          <span className="absolute -bottom-0.5 -right-0.5">
            <ToolStatusDot status={worstStatus} />
          </span>
        </span>
        <span className="truncate font-mono text-2xs text-foreground/80">
          {label} · {unitLabel}
        </span>
      </div>

      {/* Expanded sub-entries */}
      {isExpanded && (
        <div className="ml-5 pt-0.5 pb-1 flex flex-col gap-1 border-l border-border/50 pl-2">
          {entries.map((entry) => (
            <ChatToolSummary
              key={entry.expansionKey}
              summary={entry.summary}
              status={entry.status}
              toolName={entry.toolName}
              actionType={entry.actionType}
              detail={entry.detail}
            />
          ))}
        </div>
      )}
    </div>
  );
}
