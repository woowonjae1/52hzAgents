'use client';

import { memo } from 'react';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';

interface ThinkingMessageProps {
  sender: string;
  messages: WorkspaceMessage[];
  agents?: WorkspaceAgent[];
  /**
   * The agent has since posted its reply, so this trace is history. Drops the
   * live-streaming affordance; the block keeps its slot and its header, and the
   * reply renders directly beneath it.
   */
  settled?: boolean;
}

function isPlaceholder(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '' || t === 'thinking...' || t === 'thinking';
}

export const ThinkingMessage = memo(function ThinkingMessage({ sender, messages, agents, settled = false }: ThinkingMessageProps) {
  const texts = messages.map((m) => m.content).filter((t) => t && !isPlaceholder(t));
  if (texts.length === 0) return null;

  const combinedContent = texts.join('\n\n');
  const startTime = messages[0]?.createdAt ? new Date(messages[0].createdAt).getTime() : undefined;
  // Both ends of the run, so the settled block can report how long the thought
  // took rather than how long ago it happened. `Reasoning` cannot work this out
  // for itself -- it only ever sees `startTime` -- and reading `Date.now()`
  // against that is what made an old reply claim `Thought 1367.1s`.
  const lastAt = messages[messages.length - 1]?.createdAt;
  const durationMs =
    startTime && lastAt && messages.length > 1
      ? Math.max(0, new Date(lastAt).getTime() - startTime) || undefined
      : undefined;
  const agent = agents?.find((a) => a.agentName === sender);

  return (
    <div className="py-3.5 group/agentmsg">
      <div className="flex items-start gap-3">
        <AgentAvatar
          name={sender}
          agentType={agent?.agentType}
          size={28}
          className="mt-0.5 shrink-0"
        />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-baseline gap-2 select-none">
            <span className="text-sm font-semibold text-foreground tracking-tight">
              {sender}
            </span>
            {agent?.agentType && (
              <span className="text-3xs px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted font-mono border border-border">
                {agent.agentType}
              </span>
            )}
          </div>
          <Reasoning
            content={combinedContent}
            startTime={startTime}
            durationMs={durationMs}
            isStreaming={!settled}
            defaultExpanded={false}
          />
        </div>
      </div>
    </div>
  );
});

