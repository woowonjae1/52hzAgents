'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentAvatar } from './agent-avatar';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';

type AgentState = 'working' | 'online' | 'offline';

/** Ring colour per state. Working is the only one that moves. */
const RING: Record<AgentState, string> = {
  working: 'ring-status-warning',
  online: 'ring-status-success',
  offline: 'ring-border',
};

/**
 * One-line replacement for the old AGENTS roster block, which spent a header,
 * a counter and one full row per agent — pushing the channel list, the thing
 * people actually click all day, below the fold. Overlapping avatars carry
 * identity; the ring carries state. Crucially it distinguishes *working* from
 * merely *online*, which the old `offline` text label never did.
 */
export function AgentStatusStrip() {
  const { agents, workingAgentNames } = useWorkspace();
  const { setViewMode } = useLayout();

  const { ordered, onlineCount, workingCount } = useMemo(() => {
    const stateOf = (name: string, status?: string): AgentState => {
      if (workingAgentNames.has(name)) return 'working';
      return status === 'online' ? 'online' : 'offline';
    };
    // Working first, then online, then offline — the avatars that matter stay
    // at the front of the stack even when the roster grows.
    const rank: Record<AgentState, number> = { working: 0, online: 1, offline: 2 };
    const withState = agents.map((a) => ({ agent: a, state: stateOf(a.agentName, a.status) }));
    withState.sort((a, b) => rank[a.state] - rank[b.state]);
    return {
      ordered: withState,
      onlineCount: withState.filter((x) => x.state !== 'offline').length,
      workingCount: withState.filter((x) => x.state === 'working').length,
    };
  }, [agents, workingAgentNames]);

  if (agents.length === 0) {
    return (
      <button
        type="button"
        onClick={() => setViewMode('mission')}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
      >
        <Plus className="size-3.5 shrink-0 text-foreground-extra-muted" />
        <span>Connect agent</span>
      </button>
    );
  }

  const MAX_SHOWN = 6;
  const shown = ordered.slice(0, MAX_SHOWN);
  const overflow = ordered.length - shown.length;

  const summary = workingCount > 0
    ? `${workingCount} working`
    : `${onlineCount} of ${agents.length} online`;

  return (
    <button
      type="button"
      onClick={() => setViewMode('mission')}
      title="Open agent station"
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-surface2 transition-colors cursor-pointer text-left"
    >
      <div className="flex items-center -space-x-1.5 shrink-0">
        {shown.map(({ agent, state }) => (
          <Tooltip key={agent.agentName}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'rounded-full ring-2 bg-surface0 transition-colors',
                  RING[state],
                  state === 'offline' && 'opacity-50',
                )}
              >
                <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={20} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {agent.agentName} · {state}
            </TooltipContent>
          </Tooltip>
        ))}
        {overflow > 0 && (
          <span className="h-5 min-w-5 px-1 rounded-full ring-2 ring-border bg-surface2 text-[9px] font-mono font-medium tracking-tighter text-foreground-muted flex items-center justify-center leading-none select-none">
            +{overflow}
          </span>
        )}
      </div>

      <span
        className={cn(
          'text-2xs truncate flex-1 min-w-0',
          workingCount > 0 ? 'text-foreground' : 'text-foreground-extra-muted',
        )}
      >
        {summary}
      </span>

      <Plus className="size-3.5 shrink-0 text-foreground-extra-muted" />
    </button>
  );
}
