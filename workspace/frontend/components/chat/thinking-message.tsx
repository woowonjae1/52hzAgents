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
  const agent = agents?.find((a) => a.agentName === sender);

  return (
    <div className="py-3.5 group/agentmsg">
      <div className="flex items-start gap-3">
        <AgentAvatar
          name={sender}
          agentType={agent?.agentType}
          size={24}
          className="mt-0.5 shrink-0 rounded-full ring-1 ring-border/40"
        />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 select-none">
            <span className="text-sm font-semibold text-foreground tracking-tight">
              {sender}
            </span>
            {agent?.agentType && (
              <span className="text-2xs text-muted-foreground font-normal">
                {agent.agentType}
              </span>
            )}
          </div>
          <Reasoning
            content={combinedContent}
            startTime={startTime}
            isStreaming={!settled}
            defaultExpanded={false}
          />
        </div>
      </div>
    </div>
  );
});
