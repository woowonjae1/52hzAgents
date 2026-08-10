'use client';

import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/lib/types';

interface AgentStatusIndicatorProps {
  agents: WorkspaceAgent[];
}

export function AgentStatusIndicator({ agents }: AgentStatusIndicatorProps) {
  const onlineCount = agents.filter((a) => a.status === 'online').length;

  if (agents.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span
        className={cn(
          'size-2 rounded-full',
          onlineCount > 0 ? 'bg-status-success' : 'bg-foreground-extra-muted'
        )}
      />
      <span>
        {onlineCount}/{agents.length} agent{agents.length !== 1 ? 's' : ''} online
      </span>
    </div>
  );
}