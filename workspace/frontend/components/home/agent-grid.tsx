'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Plus } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/lib/types';
import { StatusDot } from './home-panel';
import type { AgentState } from './agent-detail-panel';

/*
  TILES, AND THE DETAIL ROW UNDER THE ONE YOU CLICKED.

  An image-grid detail row: clicking a tile opens a full-width panel directly
  under that tile's row, with a notch pointing back at it. Another tile in the
  same row moves the notch; a tile in another row moves the panel; the same
  tile or Esc closes it.

  Opening a tile never changes who joins the session. Joining is its own
  control -- the checkbox in the tile's corner, or the switch in the panel --
  so looking at an agent is never a silent edit of the session.

  The column count is measured rather than left to `auto-fill`, because the
  panel has to be inserted after the LAST tile of the clicked row, and only a
  known column count says where that is.
*/

const TILE_MIN = 124;
const GAP = 8;

export function AgentGrid({
  agents,
  stateOf,
  selected,
  openName,
  leadName,
  onOpen,
  onToggleSelected,
  onAddAgent,
  renderPanel,
}: {
  agents: WorkspaceAgent[];
  stateOf: (a: WorkspaceAgent) => AgentState;
  selected: string[];
  openName: string | null;
  leadName: string | null;
  onOpen: (name: string | null) => void;
  onToggleSelected: (name: string) => void;
  onAddAgent: () => void;
  renderPanel: (agent: WorkspaceAgent) => React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [cols, setCols] = React.useState(4);
  const reduceMotion = useReducedMotion();

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number) => setCols(Math.max(2, Math.floor((w + GAP) / (TILE_MIN + GAP))));
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc closes the panel -- unless a menu or dialog inside it is open, in
  // which case that layer takes the Esc (Radix handles it) and the panel stays.
  React.useEffect(() => {
    if (!openName) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="listbox"], [role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      onOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openName, onOpen]);

  type Cell = { kind: 'agent'; agent: WorkspaceAgent } | { kind: 'add' };
  const cells: Cell[] = [...agents.map((agent) => ({ kind: 'agent' as const, agent })), { kind: 'add' }];
  const rows: Cell[][] = [];
  for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));

  const openAgent = openName ? agents.find((a) => a.agentName === openName) ?? null : null;
  const openIndex = openAgent ? agents.indexOf(openAgent) : -1;
  const openRow = openIndex >= 0 ? Math.floor(openIndex / cols) : -1;
  const openCol = openIndex >= 0 ? openIndex % cols : 0;

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Agents"
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {rows.map((row, r) => (
        <React.Fragment key={r}>
          {row.map((cell) =>
            cell.kind === 'add' ? (
              <button
                key="__add"
                type="button"
                onClick={onAddAgent}
                className="flex min-h-[104px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-2 text-xs text-muted-foreground outline-none transition-colors hover:border-border-accent hover:bg-surface2/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="size-4" />
                Add agent
              </button>
            ) : (
              <AgentTile
                key={cell.agent.agentName}
                agent={cell.agent}
                state={stateOf(cell.agent)}
                selected={selected.includes(cell.agent.agentName)}
                open={openName === cell.agent.agentName}
                isLead={leadName === cell.agent.agentName}
                onOpen={() => onOpen(openName === cell.agent.agentName ? null : cell.agent.agentName)}
                onToggleSelected={() => onToggleSelected(cell.agent.agentName)}
              />
            ),
          )}
          <AnimatePresence initial={false}>
            {openAgent && openRow === r && (
              <motion.div
                key={`panel-row-${r}`}
                id="home-agent-panel"
                role="region"
                aria-label={`${openAgent.agentName} configuration`}
                style={{ gridColumn: '1 / -1' }}
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="relative pt-2">
                  {/* The notch: points at the tile this panel belongs to. */}
                  <span
                    aria-hidden
                    className="absolute top-[3px] size-3 -translate-x-1/2 rotate-45 border-l border-t border-border bg-surface1 transition-[left] duration-200 ease-out"
                    style={{ left: `calc(${((openCol + 0.5) / cols) * 100}%)` }}
                  />
                  <div className="rounded-xl border border-border bg-surface1 p-3.5">{renderPanel(openAgent)}</div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </React.Fragment>
      ))}
    </div>
  );
}

function AgentTile({
  agent,
  state,
  selected,
  open,
  isLead,
  onOpen,
  onToggleSelected,
}: {
  agent: WorkspaceAgent;
  state: AgentState;
  selected: boolean;
  open: boolean;
  isLead: boolean;
  onOpen: () => void;
  onToggleSelected: () => void;
}) {
  const offline = state === 'offline';
  const stateWord = isLead ? 'Lead' : state === 'working' ? 'Working' : state === 'online' ? 'Online' : 'Offline';
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        aria-controls={open ? 'home-agent-panel' : undefined}
        className={cn(
          'flex min-h-[104px] w-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border px-2 pb-2 pt-3 text-center outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring',
          open
            ? 'border-foreground/70 bg-surface1 ring-1 ring-foreground/70'
            : selected
              ? 'border-border-accent bg-surface2'
              : 'border-border bg-background hover:border-border-accent hover:bg-surface2/60',
        )}
      >
        <span className={cn('flex flex-col items-center gap-1.5', offline && 'opacity-55')}>
          <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={28} status={agent.status} />
          <span className="w-full max-w-[9rem] truncate text-xs font-medium text-foreground">{agent.agentName}</span>
        </span>
        <span className="inline-flex items-center gap-1 text-3xs text-muted-foreground">
          <StatusDot state={state} />
          {stateWord}
        </span>
      </button>
      {/*
        A sibling of the tile button, not a child: a button inside a button is
        invalid and the inner click would also open the panel.
        aria-disabled rather than disabled, so the Hint explaining why can open.
      */}
      <Hint
        label={offline ? `@${agent.agentName} is offline. Connect it to add it.` : selected ? 'Remove from session' : 'Add to session'}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-disabled={offline || undefined}
          aria-label={`Add @${agent.agentName} to the session`}
          onClick={offline ? undefined : onToggleSelected}
          className={cn(
            'absolute left-1.5 top-1.5 grid size-4 place-items-center rounded border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
            selected
              ? 'border-foreground bg-foreground text-background'
              : 'border-border-accent bg-background hover:border-foreground/60',
            offline && 'cursor-not-allowed opacity-40 hover:border-border-accent',
          )}
        >
          {selected && <Check className="size-2.5" strokeWidth={3} />}
        </button>
      </Hint>
    </div>
  );
}
