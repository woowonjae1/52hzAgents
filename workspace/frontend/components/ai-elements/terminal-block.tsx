'use client';

import * as React from 'react';
import { Terminal, Check, Copy, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TerminalBlockProps {
  command: string;
  lines?: string[];
  visibleCount?: number;
  done?: boolean;
  exitCode?: number;
  variant?: 'paper' | 'ink';
  className?: string;
  onCopy?: () => void;
}

export function TerminalBlock({
  command,
  lines = [],
  visibleCount,
  done = false,
  exitCode = 0,
  variant = 'paper',
  className,
  onCopy,
}: TerminalBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const displayedLines = visibleCount !== undefined ? lines.slice(0, visibleCount) : lines;
  const isSuccess = done && exitCode === 0;

  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayedLines.length]);

  const isInk = variant === 'ink';

  return (
    <div
      className={cn(
        'my-2 rounded-2xl overflow-hidden border shadow-xs transition-all font-mono',
        isInk
          ? 'bg-neutral-950 text-neutral-200 border-neutral-800'
          : 'bg-surface1/90 text-foreground border-border/80 backdrop-blur-md',
        className
      )}
    >
      {/* Terminal Title Bar */}
      <div
        className={cn(
          'flex items-center justify-between gap-3 px-3.5 py-2.5 border-b text-xs select-none',
          isInk ? 'bg-neutral-900/90 border-neutral-800' : 'bg-surface2/70 border-border/60'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="size-2.5 rounded-full bg-red-500/80 inline-block" />
            <span className="size-2.5 rounded-full bg-amber-500/80 inline-block" />
            <span className="size-2.5 rounded-full bg-emerald-500/80 inline-block" />
          </div>

          <div className="flex items-center gap-1.5 min-w-0 ml-1">
            <Terminal className="size-3.5 text-foreground-muted shrink-0" />
            <span className="font-semibold text-2xs truncate opacity-90">{command}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!done ? (
            <span className="inline-flex items-center gap-1 text-3xs text-primary font-medium">
              <Loader2 className="size-3 animate-spin" />
              <span>Running</span>
            </span>
          ) : isSuccess ? (
            <span className="inline-flex items-center gap-1 text-3xs text-status-success font-medium bg-status-muted-success px-1.5 py-0.5 rounded">
              <Check className="size-2.5" />
              <span>exit 0</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-3xs text-status-danger font-medium bg-status-muted-danger px-1.5 py-0.5 rounded">
              <AlertCircle className="size-2.5" />
              <span>exit {exitCode}</span>
            </span>
          )}

          <button
            type="button"
            onClick={() => {
              const fullText = `$ ${command}\n${lines.join('\n')}`;
              navigator.clipboard.writeText(fullText);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
              onCopy?.();
            }}
            className={cn(
              'p-1 rounded transition-colors cursor-pointer',
              isInk ? 'hover:bg-neutral-800 text-neutral-400' : 'hover:bg-surface3 text-foreground-muted'
            )}
            title="Copy command and output"
          >
            {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
          </button>
        </div>
      </div>

      {/* Terminal Output Lines */}
      <div
        ref={containerRef}
        className={cn(
          'p-3 text-2xs leading-relaxed overflow-x-auto max-h-64 space-y-0.5 select-text',
          isInk ? 'text-neutral-300' : 'text-foreground-muted'
        )}
      >
        <div className="text-foreground-extra-muted flex items-center gap-1 mb-1">
          <span className="text-primary font-bold">$</span>
          <span>{command}</span>
        </div>

        {displayedLines.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap font-mono break-all">
            {line}
          </div>
        ))}

        {!done && (
          <div className="flex items-center gap-1 text-primary">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
          </div>
        )}
      </div>
    </div>
  );
}
