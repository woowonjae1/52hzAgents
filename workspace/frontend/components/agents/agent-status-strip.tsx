'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentAvatar } from './agent-avatar';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';

type AgentState = 'working' | 'online' | 'offline';

/*
  THE RING IS SEPARATION FIRST AND STATE SECOND.

  Every live avatar used to carry `ring-status-success`, and with 2px rings on
  20px discs overlapped by only 4px the rings of three online agents met and
  read as ONE CONTINUOUS GREEN BAND — three copies of a fact the sentence
  immediately beside them already states, drawn over the logos at exactly the
  size where they stop being identifiable. Identifying who is live is the only
  reason to show faces at all, so the ring's job here is the one an overlapping
  stack actually needs: cut each avatar out of the one behind it. That is the
  sidebar's own ground, not a colour.

  Colour is then spent only where it says something the sentence cannot —
  which agent is WORKING right now. One amber ring in a row of quiet ones is
  legible; eight green ones are wallpaper.
*/
const RING: Record<AgentState, string> = {
  working: 'ring-status-warning',
  online: 'ring-surface-sidebar',
  offline: 'ring-surface-sidebar',
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

  /*
    Only agents that are actually up get a mark. Showing the whole roster meant
    the same six logos sat here permanently — identical every render, saying
    nothing the "N of M online" text does not already say, while the one fact
    worth seeing (which agents are live right now) was buried among the offline
    ones at 50% opacity. With nothing online the strip is just the sentence.
  */
  const MAX_SHOWN = 6;
  const live = ordered.filter((x) => x.state !== 'offline');
  const shown = live.slice(0, MAX_SHOWN);
  const overflow = live.length - shown.length;

  const summary = workingCount > 0
    ? `${workingCount} working`
    : `${onlineCount} of ${agents.length} online`;

  /*
    The trailing `+` is gone. It was a `<Plus>` drawn INSIDE this button rather
    than a control of its own, so it looked like "add an agent" and did what
    every other pixel of the row does — open the station. A plus that cannot be
    clicked separately is a promise the row does not keep, and the two real
    ways in (the Projects header below, the Agents button at the foot of the
    sidebar) are both one row away.
  */
  return (
    <button
      type="button"
      onClick={() => setViewMode('mission')}
      title="Open agent station"
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-surface2 transition-colors cursor-pointer text-left"
    >
      {/* -space-x-1.5, not -1: at 4px the discs merely touched, which reads as
          a crowded row rather than a stack. */}
      <div className="flex items-center -space-x-1.5 shrink-0 empty:hidden">
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
    </button>
  );
}
