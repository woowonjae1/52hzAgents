'use client';

import * as React from 'react';
import {
  Wrench,
  Search,
  FileCode,
  Terminal,
  Globe,
  Check,
  Copy,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolCallProps {
  label: string;
  activeLabel?: string;
  query?: string;
  request?: string | Record<string, unknown>;
  result?: string | Record<string, unknown>;
  running?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
  className?: string;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running = false,
  open: controlledOpen,
  onOpenChange,
  icon: CustomIcon,
  className,
}: ToolCallProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange]
  );

  const displayLabel = running ? activeLabel || `${label}...` : label;
  const requestStr = typeof request === 'object' ? JSON.stringify(request, null, 2) : request;
  const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : result;
  const hasContent = Boolean(requestStr || resultStr || query);

  const renderIcon = () => {
    if (React.isValidElement(CustomIcon)) return CustomIcon;
    if (typeof CustomIcon === 'function') {
      const Comp = CustomIcon as React.ComponentType<{ className?: string }>;
      return <Comp className="size-3.5" />;
    }
    const lower = label.toLowerCase();
    if (lower.includes('search') || lower.includes('grep')) return <Search className="size-3.5" />;
    if (lower.includes('read') || lower.includes('write') || lower.includes('edit')) return <FileCode className="size-3.5" />;
    if (lower.includes('bash') || lower.includes('cmd') || lower.includes('term')) return <Terminal className="size-3.5" />;
    if (lower.includes('web') || lower.includes('fetch')) return <Globe className="size-3.5" />;
    return <Wrench className="size-3.5" />;
  };

  return (
    <div
      className={cn(
        'my-1.5 rounded-xl border border-border/70 bg-surface1/60 overflow-hidden shadow-2xs transition-all',
        className
      )}
    >
      <button
        type="button"
        onClick={() => hasContent && setOpen(!open)}
        disabled={!hasContent}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2 text-left select-none transition-colors',
          hasContent ? 'cursor-pointer hover:bg-surface2/60' : 'cursor-default'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-md',
              running ? 'bg-primary/15 text-primary' : 'bg-surface3 text-foreground-muted'
            )}
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : renderIcon()}
          </span>

          <span
            className={cn(
              'text-xs font-semibold tracking-tight truncate',
              running ? 'text-primary' : 'text-foreground'
            )}
          >
            {displayLabel}
          </span>

          {query && (
            <span className="font-mono text-2xs px-2 py-0.5 rounded-md bg-surface2 text-foreground-muted truncate max-w-xs border border-border/50">
              {query}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 text-foreground-extra-muted">
          {running && (
            <span className="flex items-center gap-1 text-3xs font-medium text-primary">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              <span>Running</span>
            </span>
          )}
          {hasContent && (
            <span>
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </span>
          )}
        </div>
      </button>

      {open && hasContent && (
        <div className="border-t border-border/60 bg-surface2/40 p-3 space-y-2.5">
          {requestStr && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-3xs font-mono uppercase tracking-wider text-foreground-extra-muted">
                <span>Request Parameters</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(requestStr);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="hover:text-foreground transition-colors p-0.5 rounded cursor-pointer"
                  title="Copy request"
                >
                  {copied ? <Check className="size-2.5 text-status-success" /> : <Copy className="size-2.5" />}
                </button>
              </div>
              <pre className="text-2xs font-mono p-2.5 rounded-lg bg-surface1 border border-border/60 text-foreground-muted overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-48">
                {requestStr}
              </pre>
            </div>
          )}

          {resultStr && (
            <div className="space-y-1">
              <span className="text-3xs font-mono uppercase tracking-wider text-foreground-extra-muted">
                Result Output
              </span>
              <pre className="text-2xs font-mono p-2.5 rounded-lg bg-surface1 border border-border/60 text-foreground-muted overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-56">
                {resultStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
