'use client';

import { Hint } from '@/components/ui/hint';
import * as React from 'react';
import { Waypoints, Crown, Sparkles, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { WorkspaceSession, WorkspaceAgent } from '@/lib/types';
import { isComposing } from '@/lib/ime';

type Mode = 'dynamic' | 'master' | 'parallel';

const MODES: { value: Mode; label: string; icon: React.ElementType; description: string }[] = [
  {
    value: 'dynamic',
    label: 'Dynamic',
    icon: Sparkles,
    description: 'A router model picks the best next agent each turn.',
  },
  {
    value: 'master',
    label: 'Master / sub-agents',
    icon: Crown,
    description: 'Everything goes to the leader, who delegates and collects results.',
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
  hint. Its one real asset, the plan the user writes, is kept — it is now the
  assignment that parallel mode splits up.

  Threads still stored as 'workflow' fall back to dynamic below, which is the
  behaviour they already had.
*/

interface Props {
  session: WorkspaceSession;
  agents: WorkspaceAgent[];
  onChange: (updates: { mode?: Mode; instruction?: string | null; verificationCmd?: string | null }) => void;
  /** 'submenu' nests this under a parent DropdownMenu (the thread header's
   * overflow menu) instead of rendering its own standalone trigger button. */
  variant?: 'standalone' | 'submenu';
}

/**
 * Lets the user pick how a multi-agent thread coordinates: dynamic router
 * (default), master/sub-agent, or a custom natural-language workflow. The
 * custom workflow opens an editor with @agent autocomplete.
 */
export function OrchestrationControl({ session, agents, onChange, variant = 'standalone' }: Props) {
  const stored = (session.orchestrationMode || 'dynamic') as Mode | 'workflow';
  // A thread saved under the removed 'workflow' mode reads as dynamic, which is
  // what it effectively already was.
  const mode: Mode = stored === 'workflow' ? 'dynamic' : stored;
  const active = MODES.find((m) => m.value === mode) || MODES[0];

  /*
    Picking a mode just picks the mode.

    The first version of parallel opened the old workflow plan editor, which
    made it workflow with a new label — and worse, the text that editor saves
    (orchestration_instruction) is not what parallel reads. Parallel wakes the
    assignees on the TASK BOARD, so a paragraph typed into a dialog changed
    nothing at all while looking like the thing that configured the mode.

    The split is expressed by assigning tasks, which is where the user already
    does it. ParallelBatchPanel shows what the board currently implies, and what
    is missing, instead of asking for the same thing twice.
  */
  const selectMode = (next: Mode) => {
    onChange({ mode: next });
  };

  const ActiveIcon = active.icon;

  const items = (
    <>
      {MODES.map((m) => {
        const Icon = m.icon;
        const isActive = m.value === mode;
        return (
          <DropdownMenuItem
            key={m.value}
            onSelect={(e) => {
              // Keep the menu semantics simple; workflow opens a dialog.
              e.preventDefault();
              selectMode(m.value);
            }}
            className="flex items-start gap-2 py-2"
          >
            <Icon className="size-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">{m.label}</span>
                {isActive && <Check className="size-3 text-primary" />}
              </div>
              <p className="text-2xs text-muted-foreground leading-snug">{m.description}</p>
            </div>
          </DropdownMenuItem>
        );
      })}

    </>
  );

  return (
    <>
      {variant === 'submenu' ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 text-xs">
            <ActiveIcon className="size-3.5 text-foreground-muted" />
            Collaboration mode
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">{items}</DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Hint label="Collaboration mode">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 h-7 text-xs font-medium"
              >
                <ActiveIcon className="size-3.5" />
                <span className="hidden lg:inline">{active.label}</span>
              </Button>
            </Hint>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Collaboration mode</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

    </>
  );
}

// ---------------------------------------------------------------------------
// Plan editor with @agent autocomplete
export interface WorkflowPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: WorkspaceAgent[];
  initialValue: string;
  onSave: (instruction: string) => void;
}

export function WorkflowPlanDialog({ open, onOpenChange, agents, initialValue, onSave }: WorkflowPlanDialogProps) {
  const [value, setValue] = React.useState(initialValue);
  const [showMentions, setShowMentions] = React.useState(false);
  const [mentionFilter, setMentionFilter] = React.useState('');
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionListRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll selected mention into view
  React.useEffect(() => {
    if (!showMentions || !mentionListRef.current) return;
    const container = mentionListRef.current;
    const selectedEl = container.querySelector('[data-selected="true"]') as HTMLElement | null;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [mentionIndex, showMentions]);

  // Reset the draft whenever the dialog is (re)opened.
  React.useEffect(() => {
    if (open) {
      setValue(initialValue);
      setShowMentions(false);
    }
  }, [open, initialValue]);

  const filteredAgents = React.useMemo(
    () =>
      agents
        .filter((a) => a.agentName.toLowerCase().includes(mentionFilter.toLowerCase()))
        .sort((a, b) => {
          if (a.status !== b.status) {
            return a.status === 'online' ? -1 : 1;
          }
          if ((a.role === 'master') !== (b.role === 'master')) {
            return a.role === 'master' ? -1 : 1;
          }
          return a.agentName.localeCompare(b.agentName);
        }),
    [agents, mentionFilter],
  );

  const detectMention = (el: HTMLTextAreaElement, text: string) => {
    const cursor = el.selectionStart;
    const before = text.slice(0, cursor);
    const at = before.match(/@([\w-]*)$/);
    if (at && agents.length > 0) {
      setMentionFilter(at[1]);
      setMentionIndex(0);
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (name: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    const next = before.slice(0, at) + `@${name} ` + after;
    setValue(next);
    setShowMentions(false);
    // Restore caret just after the inserted mention.
    requestAnimationFrame(() => {
      const pos = at + name.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ↑/↓/Enter/Tab belong to the IME's candidate list while one is open — the
    // same guard the main composer carries, for the same mention popup.
    if (isComposing(e)) return;
    if (showMentions && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((p) => (p + 1) % filteredAgents.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((p) => (p - 1 + filteredAgents.length) % filteredAgents.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredAgents[mentionIndex].agentName);
      } else if (e.key === 'Escape') {
        setShowMentions(false);
      }
    }
  };

  const save = () => {
    onSave(value.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>How the work is split</DialogTitle>
          <DialogDescription>
            Say who does what, in plain language. Use <span className="font-mono">@</span> to
            reference an agent, and name the folder each one owns — parallel mode will not start a
            batch whose scopes overlap, because agents working on the same files overwrite each
            other silently.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              detectMention(e.target, e.target.value);
            }}
            onKeyDown={onKeyDown}
            rows={6}
            autoFocus
            placeholder={
              'e.g. @frontend takes workspace/frontend — rebuild the task board. ' +
              '@backend takes workspace/backend — add the batch endpoint. ' +
              '@docs takes docs/ — write up both.'
            }
            className="w-full resize-none rounded-md border bg-transparent p-3 text-sm outline-none focus:border-primary"
          />
          {showMentions && filteredAgents.length > 0 && (
            <div
              ref={mentionListRef}
              className="absolute left-3 right-3 z-50 mt-1 max-h-44 overflow-auto rounded-md border bg-popover shadow-md"
            >
              {filteredAgents.map((a, i) => (
                <button
                  key={a.agentName}
                  type="button"
                  data-selected={i === mentionIndex ? 'true' : undefined}
                  onClick={() => insertMention(a.agentName)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface2',
                    i === mentionIndex && 'bg-surface2',
                  )}
                >
                  <span className="font-medium">@{a.agentName}</span>
                  {a.role === 'master' && <Crown className="size-3 text-status-warning" />}
                  <span
                    className={cn(
                      'ml-auto size-1.5 rounded-full',
                      a.status === 'online' ? 'bg-status-success' : 'bg-foreground-extra-muted',
                    )}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}