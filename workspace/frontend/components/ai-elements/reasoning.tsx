'use client';

import { Brain, Copy, Check } from 'lucide-react';
import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { EventLine, EventLineAction } from './event-line';
import { formatElapsed } from '@/lib/use-elapsed';

export interface ReasoningProps {
  content: string;
  isStreaming?: boolean;
  durationMs?: number;
  startTime?: number;
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * The agent's thought process.
 *
 * This was a rounded-full capsule with its own indigo accent — an indigo ring,
 * an indigo glow behind a pulsing brain icon, an indigo-tinted rail, and a
 * bespoke indigo-to-foreground gradient shimmer driven by a `motion` animation
 * loop. None of that indigo existed as a token, so it was a fifth accent colour
 * that nothing in the theme could reach or change.
 *
 * It now draws through `EventLine` like every other event. Streaming is signalled
 * by the shared shimmer, which is the same shimmer a running tool call uses, so
 * "the agent is working on something with nothing to show yet" looks the same
 * wherever it happens.
 */
export function Reasoning({
  content,
  isStreaming = false,
  durationMs,
  startTime,
  defaultExpanded = false,
  className,
}: ReasoningProps) {
  const [copied, setCopied] = useState(false);

  /**
   * How long the thought took — ONLY from `durationMs`.
   *
   * This used to fall back to `Date.now() - startTime` when no duration was
   * passed, which is not the thought's duration, it is the thought's AGE. On a
   * settled block that is wrong by however long ago the message was sent: a
   * reply from twenty minutes ago read "Thought 1367.1s". It stayed hidden while
   * traces rendered as loose per-message rows and never reached this label at
   * all. `startTime` is still accepted, but it now feeds only the LIVE clock in
   * `EventLine` — where "now minus then" is exactly the right sum.
   */
  const durationText = useMemo(
    () => (durationMs && durationMs > 0 ? formatElapsed(durationMs) : null),
    [durationMs]
  );

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
      icon={<Brain />}
      label={isStreaming ? 'Thinking' : 'Thought'}
      // Once settled the duration carries the information the old label spelled
      // out ("Thought for 4.2s"), so the label stops repeating it. While
      // streaming `meta` is left undefined on purpose: EventLine then fills the
      // same slot with a live clock off `startTime`, so the number does not
      // appear out of nowhere the instant the thought lands.
      meta={!isStreaming && durationText ? durationText : undefined}
      startTime={startTime}
      state={isStreaming ? 'running' : 'idle'}
      defaultOpen={defaultExpanded || isStreaming}
      actions={
        content ? (
          <EventLineAction onClick={handleCopy} title="Copy reasoning text">
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </EventLineAction>
        ) : undefined
      }
    >
      {content ? (
        <div className="py-0.5 text-xs leading-[1.75] text-foreground-muted [&_*]:text-xs [&_p]:my-1.5 [&_pre]:text-2xs">
          <MarkdownContent content={content} />
        </div>
      ) : (
        // Streaming with nothing buffered yet. The shimmer on the row above is
        // already saying this, so the placeholder stays flat and quiet rather
        // than adding a second animation.
        <div className="py-1 text-xs text-foreground-extra-muted">Nothing yet.</div>
      )}
    </EventLine>
  );
}
