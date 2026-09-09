'use client';

import { Brain, Copy, Check, Sparkles } from 'lucide-react';
import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { EventLine, EventLineAction } from './event-line';
import { formatElapsed } from '@/lib/use-elapsed';
import { cn } from '@/lib/utils';

export interface ReasoningProps {
  content: string;
  isStreaming?: boolean;
  durationMs?: number;
  startTime?: number;
  defaultExpanded?: boolean;
  className?: string;
}

export function Reasoning({
  content,
  isStreaming = false,
  durationMs,
  startTime,
  defaultExpanded = false,
  className,
}: ReasoningProps) {
  const [copied, setCopied] = useState(false);

  const durationText = useMemo(
    () => (durationMs && durationMs > 0 ? formatElapsed(durationMs) : null),
    [durationMs]
  );

  const wordCount = useMemo(() => {
    if (!content) return 0;
    return content.trim().split(/\s+/).length;
  }, [content]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('Reasoning process copied');
    setTimeout(() => setCopied(false), 2000);
  };

  if (!content && !isStreaming) return null;

  return (
    <EventLine
      className={className}
      icon={<Brain className={cn(isStreaming && 'text-primary animate-pulse')} />}
      label={isStreaming ? 'Thinking' : 'Thought'}
      meta={!isStreaming && durationText ? durationText : undefined}
      startTime={startTime}
      state={isStreaming ? 'running' : 'idle'}
      defaultOpen={defaultExpanded || isStreaming}
      actions={
        content ? (
          <EventLineAction onClick={handleCopy} title="Copy reasoning text">
            {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
          </EventLineAction>
        ) : undefined
      }
    >
      {content ? (
        <div className="relative my-1 rounded-lg border border-border/50 bg-surface1/50 dark:bg-surface1/70 px-3.5 py-2.5 space-y-1.5 shadow-2xs">
          <div className="flex items-center justify-between text-3xs font-mono text-foreground-extra-muted pb-2 select-none">
            <span className="flex items-center gap-1 font-medium">
              <Sparkles className="size-2.5 text-primary/70" />
              <span>Chain of Thought</span>
            </span>
            {wordCount > 0 && <span>~{wordCount} words</span>}
          </div>
          <div className="py-0.5 text-xs leading-[1.75] text-foreground-muted [&_*]:text-xs [&_p]:my-1.5 [&_pre]:text-2xs selection:bg-primary/20">
            <MarkdownContent content={content} />
            {isStreaming && (
              <span className="inline-block w-1.5 h-3 bg-primary/70 animate-pulse ml-1 translate-y-0.5" />
            )}
          </div>
        </div>
      ) : (
        <div className="py-1 text-xs text-foreground-extra-muted flex items-center gap-1.5 font-mono">
          <span className="inline-block size-1.5 rounded-full bg-primary/60 animate-ping" />
          <span>Generating reasoning stream…</span>
        </div>
      )}
    </EventLine>
  );
}
