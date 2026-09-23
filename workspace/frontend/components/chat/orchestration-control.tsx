'use client';

import { Hint } from '@/components/ui/hint';
import * as React from 'react';
import { Waypoints, Crown, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceSession, WorkspaceAgent } from '@/lib/types';

type Mode = 'dynamic' | 'master' | 'parallel';

const MODES: { value: Mode; label: string; icon: React.ElementType; description: string }[] = [
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
export function OrchestrationControl({ session, onChange }: Props) {
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
    if (next !== mode) onChange({ mode: next });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = MODES.findIndex((m) => m.value === mode);
    const next = MODES[(i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length];
    select(next.value);
    // All three segments are always rendered, so focus can move now.
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next.value}"]`)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Collaboration mode"
      onKeyDown={onKeyDown}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-surface1 p-0.5"
    >
      {MODES.map((m) => {
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
  );
}
