'use client';

import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Hint } from '@/components/ui/hint';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { ContextRing } from '@/components/chat/context-ring';
import { timeAgo } from '@/lib/helpers';
import { cn } from '@/lib/utils';
import {
  useAgentContexts,
  contextPercent,
  contextLevel,
  fmtTokens,
} from '@/lib/use-agent-contexts';
import type { AgentContext } from '@/lib/types';

interface ContextHealthIndicatorProps {
  channelName?: string;
  className?: string;
}

/*
  CONTEXT IS PER AGENT. THIS USED TO PRETEND OTHERWISE.

  The old indicator showed one number for the channel: the largest prompt any
  participant had sent, divided by the SMALLEST participant's window -- "this
  channel is capped at 64k by @x". None of that was true. Every adapter resumes
  its own per-channel CLI session, so a 1M-window agent in a room with a 64k one
  still has 1M; the two never share a context. And no adapter reported a prompt
  size, so the number was a character count of the channel's text against a
  window looked up by model name. Its "Compact Context Now" button rolled a
  channel summary that no agent reads.

  Now each agent that has worked here reports what its own CLI measured on its
  last turn, and this shows exactly that: one row per agent, its tokens over
  its window. The ring beside send shows the fullest of them -- the one that
  would overflow first -- and turns colour only when that one is actually tight.
*/
export function ContextHealthIndicator({ channelName, className }: ContextHealthIndicatorProps) {
  const rawChannel = (channelName || 'general').replace(/^channel\//, '');
  const { rows, refresh } = useAgentContexts();
  const [open, setOpen] = React.useState(false);

  const here = React.useMemo(
    () =>
      rows
        .filter((r) => r.channelName === rawChannel)
        .sort((a, b) => (contextPercent(b) ?? -1) - (contextPercent(a) ?? -1)),
    [rows, rawChannel]
  );
  const fullest: AgentContext | undefined = here[0];
  const pct = fullest ? contextPercent(fullest) : null;

  const hint = !fullest
    ? 'No agent has reported its context here yet'
    : pct === null
      ? `${fullest.agentName}: ${fmtTokens(fullest.promptTokens)} tokens, window unknown`
      : `${fullest.agentName}: ${fmtTokens(fullest.promptTokens)} of ${fmtTokens(fullest.contextWindow)} (${pct}%)` +
        (here.length > 1 ? ` · fullest of ${here.length}` : '');

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refresh();
      }}
    >
      <PopoverTrigger asChild>
        <Hint label={hint}>
          <button
            type="button"
            aria-label="Agent context usage"
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center rounded-full',
              'text-foreground-extra-muted hover:text-foreground transition-colors',
              className
            )}
          >
            <ContextRing pct={pct} />
          </button>
        </Hint>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-3 space-y-2.5 rounded-xl">
        <div>
          <div className="text-xs font-semibold text-foreground">Context by agent</div>
          <p className="text-3xs text-foreground-muted leading-snug mt-0.5">
            Each agent keeps its own context in this thread and compacts it itself. Figures are
            what each agent measured on its last turn here.
          </p>
        </div>

        {here.length === 0 ? (
          <p className="text-2xs text-foreground-muted py-2">
            No agent has reported yet. Each one reports after its next turn in this channel.
          </p>
        ) : (
          <ul className="space-y-1">
            {here.map((c) => (
              <AgentContextRow key={c.agentName} ctx={c} />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AgentContextRow({ ctx }: { ctx: AgentContext }) {
  const pct = contextPercent(ctx);
  const level = contextLevel(pct);
  return (
    <li className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-surface2/60">
      <AgentAvatar name={ctx.agentName} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="max-w-[65%] shrink-0 truncate text-xs font-medium text-foreground">{ctx.agentName}</span>
          {ctx.model && (
            <span className="min-w-0 truncate text-3xs font-mono text-foreground-extra-muted">{ctx.model}</span>
          )}
        </div>
        <div className="text-3xs text-foreground-muted truncate">
          {ctx.compactedAt ? `Compacted ${timeAgo(ctx.compactedAt)}` : `Updated ${timeAgo(ctx.updatedAt)}`}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div
          className={cn(
            'font-mono tabular-nums text-2xs',
            level === 'critical'
              ? 'text-status-danger'
              : level === 'warning'
                ? 'text-status-warning'
                : 'text-foreground'
          )}
        >
          {fmtTokens(ctx.promptTokens)}
          <span className="text-foreground-extra-muted"> / </span>
          {ctx.contextWindow ? (
            <Hint
              label={
                ctx.windowSource === 'reported'
                  ? 'Window reported by the agent'
                  : 'Window looked up from the model name'
              }
            >
              <span className={cn(ctx.windowSource !== 'reported' && 'underline decoration-dotted underline-offset-2')}>
                {fmtTokens(ctx.contextWindow)}
              </span>
            </Hint>
          ) : (
            <span className="text-foreground-extra-muted">?</span>
          )}
        </div>
        {pct !== null && <div className="text-3xs text-foreground-extra-muted tabular-nums">{pct}%</div>}
      </div>
      <ContextRing pct={pct} size={18} />
    </li>
  );
}
