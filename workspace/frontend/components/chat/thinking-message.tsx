'use client';

import { memo } from 'react';
import { Reasoning } from '@/components/ai-elements/reasoning';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';

interface ThinkingMessageProps {
  sender: string;
  messages: WorkspaceMessage[];
  agents?: WorkspaceAgent[];
}

function isPlaceholder(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '' || t === 'thinking...' || t === 'thinking';
}

export const ThinkingMessage = memo(function ThinkingMessage({ messages }: ThinkingMessageProps) {
  const texts = messages.map((m) => m.content).filter((t) => t && !isPlaceholder(t));
  if (texts.length === 0) return null;

  const combinedContent = texts.join('\n\n');
  const startTime = messages[0]?.createdAt ? new Date(messages[0].createdAt).getTime() : undefined;

  return (
    <div className="py-1">
      <Reasoning
        content={combinedContent}
        startTime={startTime}
        defaultExpanded={false}
      />
    </div>
  );
});
