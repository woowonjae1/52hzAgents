'use client';

import { Brain, Copy, Check, Sparkles } from 'lucide-react';
import { useState, useMemo } from 'react';
import { toast } from '@/lib/toast';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { EventLine, EventLineAction } from './event-line';
import { ThinkingShimmer } from '@/components/agents/loading-states/thinking-shimmer';
import { formatElapsed } from '@/lib/use-elapsed';
import { cn } from '@/lib/utils';

const LONG_THOUGHT_MS = 60_000;

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

  // Long enough that "why is this taking so long" is a real question.
  const notablyLong = (durationMs ?? 0) >= LONG_THOUGHT_MS;

  /*
    THE WORD COUNT IS GONE, AND THE DURATION ONLY SPEAKS WHEN IT HAS NEWS.

    Every thought carried "39.7s · ~1048 words". Nobody has ever made a decision
    because a thought was 1048 words rather than 900 — it is measurable, not
    useful, and it sat on every message in the transcript.

    Elapsed time does carry something, but only at the tail: 4s is the normal
    case and saying so on every row is the same noise. Above the threshold it
    is genuinely worth knowing, so that is when it appears.
  */

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
      label={
        isStreaming ? (
          <ThinkingShimmer duration={1.8} className="text-foreground font-medium tracking-tight">
            Thinking…
          </ThinkingShimmer>
        ) : (
          'Thought'
        )
      }
      meta={!isStreaming && notablyLong ? durationText ?? undefined : undefined}
      startTime={startTime}
      state={isStreaming ? 'running' : 'idle'}
      defaultOpen={defaultExpanded}
      actions={
        content ? (
          <EventLineAction onClick={handleCopy} title="Copy reasoning text">
            {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
          </EventLineAction>
        ) : undefined
      }
    >
      {content ? (
        <div className="relative my-1.5 border-l-2 border-border/80 pl-3.5 py-1">
          <div className="text-sm leading-[1.7] text-foreground/80 selection:bg-primary/20 space-y-2 [&_h1]:text-xs [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mt-2.5 [&_h1]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-medium [&_h3]:text-foreground/90 [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_strong]:font-semibold [&_strong]:text-foreground [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-0.5 [&_li]:my-0.5 [&_code]:text-3xs [&_code]:font-mono [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-surface2 [&_code]:border [&_code]:border-border/60 [&_code]:text-foreground [&_pre]:text-xs [&_pre]:my-2 [&_pre]:p-2.5 [&_pre]:rounded-lg [&_pre]:bg-surface2/90 [&_pre]:border [&_pre]:border-border/60 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic">
            <MarkdownContent content={content} />
            {isStreaming && (
              <span className="inline-block w-1.5 h-3.5 bg-primary/70 animate-pulse ml-1 translate-y-0.5" />
            )}
          </div>
        </div>
      ) : (
        <div className="py-1 text-xs text-foreground-extra-muted flex items-center gap-1.5 font-mono">
          <ThinkingShimmer duration={1.5} className="text-primary/90 text-xs">
            Generating reasoning stream…
          </ThinkingShimmer>
        </div>
      )}
    </EventLine>
  );
}
