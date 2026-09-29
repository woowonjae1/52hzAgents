'use client';

import { Hint } from '@/components/ui/hint';
import * as React from 'react';
import { Waypoints, Crown, Sparkles } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { cn } from '@/lib/utils';
import type { WorkspaceSession, WorkspaceAgent } from '@/lib/types';

export type OrchestrationMode = 'dynamic' | 'master' | 'parallel';
type Mode = OrchestrationMode;

/** Shared with the Home dashboard's Collaboration card, so the words match. */
export const ORCHESTRATION_MODES: { value: Mode; label: string; icon: React.ElementType; description: string }[] = [
  {
    value: 'dynamic',
    label: 'Dynamic',
    icon: Sparkles,
    description: 'A router picks the best next agent each turn.',
  },
  {
    value: 'master',
    label: 'Master',
    icon: Crown,
    description: 'The master agent receives everything, delegates, and collects results.',
  },
  {
    value: 'parallel',
    label: 'Parallel',
    icon: Waypoints,
    description: 'Everyone assigned starts at once. For work already split cleanly.',
  },
];

/*
  'workflow' was removed rather than renamed. It never had its own branch in the
  router: it was dynamic mode with the plan text appended to the same
  single-next-speaker prompt, so it promised a workflow engine and delivered a
  hint. Threads still stored as 'workflow' fall back to dynamic below, which is
  the behaviour they already had.

  Its plan editor (with its own @agent autocomplete) went with it: nothing
  rendered it, and parallel reads the task board, not a paragraph.
*/

interface Props {
  session: WorkspaceSession;
  agents: WorkspaceAgent[];
  onChange: (updates: { mode?: Mode; instruction?: string | null; verificationCmd?: string | null }) => void;
  /**
   * Sets the thread's master agent. Master mode is only entered once one is
   * set: without a master, the router has nobody to give an un-addressed
   * message to and silently behaves like Dynamic.
   */
  onMasterChange?: (agentName: string) => void;
}

/**
 * How a multi-agent thread coordinates, as a three-way segmented switch in the
 * composer's bottom row.
 *
 * A SWITCH, NOT A MENU. There are exactly three options and switching between
 * them is the whole job, so a dropdown cost two clicks and a paragraph of
 * reading for what is a one-click choice — and hid the alternatives until it
 * was opened. Now every option is visible, the active one carries its name,
 * and the explanation moved to the hover, where it is read once and then
 * never again.
 */
export function OrchestrationControl({ session, agents, onChange, onMasterChange }: Props) {
  const [pickingMaster, setPickingMaster] = React.useState(false);
  const stored = (session.orchestrationMode || 'dynamic') as Mode | 'workflow';
  // A thread saved under the removed 'workflow' mode reads as dynamic, which is
  // what it effectively already was.
  const mode: Mode = stored === 'workflow' ? 'dynamic' : stored;

  /*
    Picking a mode just picks the mode. Parallel wakes the assignees on the
    TASK BOARD; ParallelBatchPanel shows what the board currently implies
    instead of asking for the split a second time here.
  */
  const select = (next: Mode) => {
    if (next === mode) return;
    // Master needs a master. Ask for one first, and switch only once it is
    // picked -- a Master thread with no master routes like Dynamic.
    if (next === 'master' && !session.master && onMasterChange) {
      setPickingMaster(true);
      return;
    }
    onChange({ mode: next });
  };

  const pickMaster = (agentName: string) => {
    onMasterChange?.(agentName);
    onChange({ mode: 'master' });
    setPickingMaster(false);
  };

  // Candidates: the thread's agents, online ones first. `participants` is the
  // workspace roster (see channel-participants-are-roster), so it is the right
  // list to choose a lead from.
  const candidates = React.useMemo(() => {
    const names = new Set((session.participants || []).map((n) => n.toLowerCase()));
    const pool = agents.filter((a) => names.size === 0 || names.has(a.agentName.toLowerCase()));
    return [...pool].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'));
  }, [agents, session.participants]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = ORCHESTRATION_MODES.findIndex((m) => m.value === mode);
    const next = ORCHESTRATION_MODES[(i + (e.key === 'ArrowRight' ? 1 : ORCHESTRATION_MODES.length - 1)) % ORCHESTRATION_MODES.length];
    select(next.value);
    // All three segments are always rendered, so focus can move now.
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next.value}"]`)?.focus();
  };

  return (
    <Popover open={pickingMaster} onOpenChange={(open) => { if (!open) setPickingMaster(false); }}>
    <PopoverPrimitive.Anchor asChild>
    <div
      role="radiogroup"
      aria-label="Collaboration mode"
      onKeyDown={onKeyDown}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-surface1 p-0.5"
    >
      {ORCHESTRATION_MODES.map((m) => {
        const Icon = m.icon;
        const isActive = m.value === mode;
        return (
          <Hint
            key={m.value}
            side="top"
            label={
              <span className="block max-w-56">
                <span className="font-medium">{m.label}</span>
                <span className="block text-foreground-muted">{m.description}</span>
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-label={m.label}
              data-mode={m.value}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(m.value)}
              className={cn(
                'inline-flex h-5 items-center gap-1 rounded-[5px] px-1.5',
                'text-3xs font-mono select-none transition-colors',
                'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
                isActive
                  ? 'bg-surface3 text-foreground shadow-xs'
                  : 'text-foreground-extra-muted hover:text-foreground'
              )}
            >
              <Icon className="size-3 shrink-0" />
              {/* Only the active segment spells its name: the row stays
                  narrow, and you can still tell which mode you are in
                  without hovering anything. */}
              {isActive && <span>{m.label}</span>}
            </button>
          </Hint>
        );
      })}
    </div>
    </PopoverPrimitive.Anchor>
    <PopoverContent side="top" align="start" className="w-64 p-2">
      <p className="px-1.5 pb-1.5 text-xs font-medium text-foreground">Pick the master agent</p>
      <p className="px-1.5 pb-2 text-2xs text-foreground-muted leading-snug">
        It gets every message you do not address with @, and hands work out.
      </p>
      {candidates.length === 0 ? (
        <p className="px-1.5 py-1 text-2xs text-foreground-muted">No agents in this thread yet.</p>
      ) : (
        <ul className="max-h-60 overflow-y-auto">
          {candidates.map((a) => (
            <li key={a.agentName}>
              <button
                type="button"
                onClick={() => pickMaster(a.agentName)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              >
                <AgentAvatar name={a.agentName} agentType={a.agentType} size={18} status={a.status} showStatus />
                <span className="truncate">{a.agentName}</span>
                {a.status !== 'online' && <span className="ml-auto text-2xs text-foreground-muted">offline</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </PopoverContent>
    </Popover>
  );
}
