'use client';

import * as React from 'react';
import {
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import {
  ArrowUp,
  ListChecks,
  Plus,
  Check,
  Circle,
  CircleDot,
  Loader2,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Hint } from '@/components/ui/hint';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import type { WorkspaceAgent, TodoItem } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* 1. TurnNavigationPopup (ported from cdesktop TurnNavigationPopup.tsx)      */
/* -------------------------------------------------------------------------- */

export interface TurnNavigationItem {
  /** Unique message ID for this user turn */
  patchKey: string;
  /** The user message content text */
  content: string;
  /** 1-indexed turn number */
  turnNumber: number;
}

interface TurnNavigationPopupProps {
  turns: TurnNavigationItem[];
  onNavigateToTurn: (patchKey: string) => void;
  getActiveTurnPatchKey?: () => string | null;
  children: ReactNode;
}

export function TurnNavigationPopup({
  turns,
  onNavigateToTurn,
  getActiveTurnPatchKey,
  children,
}: TurnNavigationPopupProps) {
  const [open, setOpen] = useState(false);
  const [activePatchKey, setActivePatchKey] = useState<string | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastNavigatedRef = useRef<string | null>(null);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimeout();
    closeTimeoutRef.current = setTimeout(() => {
      setOpen(false);
    }, 200);
  }, [clearCloseTimeout]);

  const handleTriggerEnter = useCallback(() => {
    if (turns.length === 0) return;
    clearCloseTimeout();
    const active =
      lastNavigatedRef.current ?? getActiveTurnPatchKey?.() ?? null;
    lastNavigatedRef.current = null;
    setActivePatchKey(active);
    setOpen(true);
  }, [turns.length, clearCloseTimeout, getActiveTurnPatchKey]);

  const handleTriggerLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  const handleContentEnter = useCallback(() => {
    clearCloseTimeout();
  }, [clearCloseTimeout]);

  const handleContentLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  const handleNavigate = useCallback(
    (patchKey: string) => {
      lastNavigatedRef.current = patchKey;
      setOpen(false);
      onNavigateToTurn(patchKey);
    },
    [onNavigateToTurn]
  );

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    if (activePatchKey) {
      const activeEl = list.querySelector<HTMLElement>(
        `[data-patch-key="${activePatchKey}"]`
      );
      if (activeEl) {
        const top = activeEl.offsetTop - list.offsetTop;
        list.scrollTop =
          top - list.clientHeight / 2 + activeEl.offsetHeight / 2;
        return;
      }
    }
    list.scrollTop = list.scrollHeight;
  }, [open, activePatchKey]);

  if (turns.length === 0) {
    return <>{children}</>;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <span
          className="inline-flex"
          onMouseEnter={handleTriggerEnter}
          onMouseLeave={handleTriggerLeave}
        >
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 max-h-[min(60vh,340px)] flex flex-col p-3"
        onMouseEnter={handleContentEnter}
        onMouseLeave={handleContentLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2 min-h-0">
          <div className="flex items-center justify-between shrink-0">
            <h4 className="text-xs font-semibold text-foreground">
              Your Messages
            </h4>
            <span className="text-2xs text-foreground-muted font-mono">
              {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
            </span>
          </div>

          <ul ref={listRef} className="space-y-0.5 overflow-y-auto min-h-0">
            {turns.map((turn) => {
              const isActive = turn.patchKey === activePatchKey;
              return (
                <li key={turn.patchKey} data-patch-key={turn.patchKey}>
                  <button
                    type="button"
                    className={cn(
                      'w-full text-left px-2 py-1.5 rounded-md transition-colors group cursor-pointer',
                      isActive
                        ? 'bg-brand/10 border-l-2 border-brand'
                        : 'hover:bg-surface2'
                    )}
                    onClick={() => handleNavigate(turn.patchKey)}
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          'text-2xs shrink-0 tabular-nums font-mono',
                          isActive ? 'text-brand' : 'text-foreground-extra-muted'
                        )}
                      >
                        #{turn.turnNumber}
                      </span>
                      <span
                        className={cn(
                          'text-xs truncate',
                          isActive
                            ? 'text-brand font-medium'
                            : 'text-foreground/90 group-hover:text-foreground'
                        )}
                      >
                        {turn.content}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. TodoProgressPopup (ported from cdesktop TodoProgressPopup.tsx)          */
/* -------------------------------------------------------------------------- */

export interface TodoProgressItem {
  content: string;
  status?: string | null;
}

interface TodoProgressPopupProps {
  todos: TodoProgressItem[];
  className?: string;
}

function getStatusIcon(status?: string | null) {
  const s = (status || '').toLowerCase();
  if (s === 'completed')
    return <Check aria-hidden className="size-3.5 text-status-success" />;
  if (s === 'in_progress' || s === 'in-progress')
    return <CircleDot aria-hidden className="size-3.5 text-blue-500" />;
  if (s === 'cancelled')
    return <Circle aria-hidden className="size-3.5 text-foreground-extra-muted" />;
  return <Circle aria-hidden className="size-3.5 text-muted-foreground" />;
}

export function TodoProgressPopup({
  todos,
  className,
}: TodoProgressPopupProps) {
  const isEmpty = todos.length === 0;

  const { completed, total, percentage } = useMemo(() => {
    const total = todos.length;
    const completed = todos.filter(
      (todo) => todo.status?.toLowerCase() === 'completed'
    ).length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percentage };
  }, [todos]);

  const tooltipText = isEmpty
    ? 'No tasks in this session'
    : `Tasks: ${completed}/${total} completed`;

  if (isEmpty) {
    return (
      <Hint label={tooltipText} side="top">
        <span className="inline-flex">
          <button
            type="button"
            disabled
            className={cn(
              'flex items-center justify-center p-1 rounded-md text-foreground-extra-muted opacity-40 cursor-not-allowed',
              className
            )}
            aria-label="Session tasks"
          >
            <ListChecks className="size-3.5" />
          </button>
        </span>
      </Hint>
    );
  }

  return (
    <Popover>
      <Hint label={tooltipText} side="top">
        <span className="inline-flex">
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex items-center justify-center p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
                className
              )}
              aria-label="Session tasks"
            >
              <div className="relative">
                <ListChecks className="size-3.5" />
                {percentage < 100 && (
                  <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
                )}
                {percentage === 100 && (
                  <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-status-success" />
                )}
              </div>
            </button>
          </PopoverTrigger>
        </span>
      </Hint>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 max-h-[min(65vh,360px)] flex flex-col p-3"
      >
        <div className="flex flex-col gap-2.5 min-h-0">
          <div className="flex items-center justify-between shrink-0">
            <h4 className="text-xs font-semibold text-foreground">
              Tasks
            </h4>
            <span className="text-2xs text-foreground-muted font-mono">
              {completed}/{total} completed
            </span>
          </div>

          <div className="h-1.5 w-full bg-surface3 rounded-full overflow-hidden shrink-0">
            <div
              className={cn(
                'h-full transition-all duration-300 rounded-full',
                percentage === 100 ? 'bg-status-success' : 'bg-blue-500'
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>

          <ul className="space-y-1 overflow-y-auto min-h-0">
            {todos.map((todo, index) => (
              <li
                key={`${todo.content}-${index}`}
                className="flex items-start gap-2 py-1"
              >
                <span className="mt-0.5 size-3.5 flex items-center justify-center shrink-0">
                  {getStatusIcon(todo.status)}
                </span>
                <span className="text-xs leading-5 break-words text-foreground">
                  {todo.status?.toLowerCase() === 'cancelled' ? (
                    <s className="text-foreground-extra-muted">{todo.content}</s>
                  ) : (
                    todo.content
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. TeamPillRow (ported from cdesktop TeamPillRow.tsx)                      */
/* -------------------------------------------------------------------------- */

export interface TeamPillMember {
  agentName: string;
  agentType?: string | null;
  isLead: boolean;
  status: 'running' | 'idle' | 'errored' | 'awaiting_approval';
}

const MAX_LABEL_CHARS = 16;

function truncateLabel(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function StatusDot({ status }: { status: TeamPillMember['status'] }) {
  const color =
    status === 'running'
      ? 'bg-brand animate-pulse'
      : status === 'errored'
        ? 'bg-status-danger'
        : status === 'awaiting_approval'
          ? 'bg-status-warning'
          : 'bg-foreground-muted/50';
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 shrink-0 rounded-full', color)}
    />
  );
}

interface TeamPillRowProps {
  members: TeamPillMember[];
  availableAgents: WorkspaceAgent[];
  activeAgentName?: string | null;
  onSelectAgent?: (agentName: string) => void;
  onAddTeammate?: (agentName: string) => void;
  onOpenAgentsHub?: () => void;
}

export function TeamPillRow({
  members,
  availableAgents,
  activeAgentName,
  onSelectAgent,
  onAddTeammate,
  onOpenAgentsHub,
}: TeamPillRowProps) {
  const memberSet = useMemo(
    () => new Set(members.map((m) => m.agentName.toLowerCase())),
    [members]
  );
  const candidateAgents = useMemo(
    () =>
      availableAgents.filter(
        (a) => !memberSet.has(a.agentName.toLowerCase())
      ),
    [availableAgents, memberSet]
  );

  const renderAddDropdown = (trigger: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-56 p-1">
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Add Teammate to Session
        </DropdownMenuLabel>
        {candidateAgents.length > 0 ? (
          candidateAgents.map((agent) => (
            <DropdownMenuItem
              key={agent.agentName}
              onClick={() => onAddTeammate?.(agent.agentName)}
              className="cursor-pointer gap-2 py-1.5 text-xs"
            >
              <AgentAvatar
                name={agent.agentName}
                agentType={agent.agentType ?? undefined}
                size={18}
                status={agent.status === 'online' ? 'online' : 'offline'}
                showStatus
              />
              <span className="truncate font-medium">@{agent.agentName}</span>
              {agent.role && (
                <span className="ms-auto text-2xs text-muted-foreground truncate max-w-[80px]">
                  {agent.role}
                </span>
              )}
            </DropdownMenuItem>
          ))
        ) : (
          <div className="px-2 py-1.5 text-2xs text-muted-foreground">
            All connected agents are in this session
          </div>
        )}
        {onOpenAgentsHub && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onOpenAgentsHub}
              className="cursor-pointer gap-2 py-1.5 text-xs text-primary font-medium"
            >
              <Users className="size-3.5 shrink-0" />
              <span>Open Agent Team Hub…</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Single-agent or empty session: render compact "+ teammate" button (like cdesktop)
  if (members.length <= 1) {
    return renderAddDropdown(
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium cursor-pointer',
          'bg-surface2/80 text-foreground-muted hover:bg-surface3 hover:text-foreground transition-colors'
        )}
      >
        <Plus className="size-3 stroke-[2.5]" />
        <span>teammate</span>
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide">
      {members.map((m) => {
        const isActive =
          activeAgentName?.toLowerCase() === m.agentName.toLowerCase();
        const label = m.isLead
          ? `main (${truncateLabel(m.agentName, 10)})`
          : truncateLabel(m.agentName, MAX_LABEL_CHARS);
        return (
          <button
            key={m.agentName}
            type="button"
            onClick={() => onSelectAgent?.(m.agentName)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors shrink-0 cursor-pointer',
              isActive
                ? 'bg-surface3 font-semibold text-foreground'
                : 'bg-surface2/80 text-foreground-muted hover:bg-surface3 hover:text-foreground'
            )}
            title={`@${m.agentName}${m.isLead ? ' (lead)' : ''}`}
          >
            <StatusDot status={m.status} />
            <span className="max-w-[140px] truncate">{label}</span>
          </button>
        );
      })}
      {renderAddDropdown(
        <button
          type="button"
          aria-label="Add teammate"
          title="Add teammate"
          className={cn(
            'inline-flex items-center justify-center rounded-md px-1.5 py-1 cursor-pointer shrink-0',
            'bg-surface2/80 text-foreground-muted hover:bg-surface3 hover:text-foreground transition-colors'
          )}
        >
          <Plus className="size-3 stroke-[2.5]" />
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. ComposerHeaderBar (ported from cdesktop SessionChatBox headerLeft/Right)*/
/* -------------------------------------------------------------------------- */

export interface ComposerHeaderBarProps {
  /** Number of modified files in git or transcript */
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Opens the Review & Diff Studio panel */
  onViewCode?: () => void;
  /** Currently running todo item, shown when agent is actively running */
  inProgressTodo?: TodoProgressItem | null;
  isRunning?: boolean;
  /** All todos for this session */
  todos?: TodoProgressItem[];
  /** User message turns for turn navigation popup */
  userMessageTurns?: TurnNavigationItem[];
  onScrollToUserMessage?: (patchKey: string) => void;
  onScrollToPreviousMessage?: () => void;
  /** Team roster pills */
  teamMembers?: TeamPillMember[];
  availableAgents?: WorkspaceAgent[];
  activeAgentName?: string | null;
  onSelectTeamAgent?: (agentName: string) => void;
  onAddTeammate?: (agentName: string) => void;
  onOpenAgentsHub?: () => void;
  className?: string;
}

export function ComposerHeaderBar({
  filesChanged,
  linesAdded,
  linesRemoved,
  onViewCode,
  inProgressTodo,
  isRunning,
  todos = [],
  userMessageTurns = [],
  onScrollToUserMessage,
  onScrollToPreviousMessage,
  teamMembers = [],
  availableAgents = [],
  activeAgentName,
  onSelectTeamAgent,
  onAddTeammate,
  onOpenAgentsHub,
  className,
}: ComposerHeaderBarProps) {
  const showStats = filesChanged !== undefined && filesChanged > 0;

  return (
    <div
      data-composer-header="true"
      className={cn(
        'flex items-center justify-between gap-2 py-1 px-0.5 text-xs select-none',
        className
      )}
    >
      {/* Left side: running todo OR files changed stats pill + TeamPillRow */}
      <div className="flex flex-1 items-center gap-2 min-w-0 overflow-hidden">
        {isRunning && inProgressTodo ? (
          <span className="text-xs flex items-center gap-1.5 min-w-0 text-foreground-muted">
            <Loader2 className="size-3.5 animate-spin shrink-0 text-brand" />
            <span className="truncate">{inProgressTodo.content}</span>
          </span>
        ) : showStats ? (
          <button
            type="button"
            onClick={onViewCode}
            data-diff-stats-pill="true"
            className="rounded-md px-2 py-0.5 flex gap-1.5 items-center bg-surface2/90 hover:bg-surface3 text-foreground transition-colors min-w-0 cursor-pointer shrink-0 border border-border/50"
            title="Open Review & Diff Inspector"
          >
            <span className="text-xs space-x-1.5 whitespace-nowrap truncate">
              <span className="font-medium">
                {filesChanged} {filesChanged === 1 ? 'file changed' : 'files changed'}
              </span>
              {(linesAdded !== undefined || linesRemoved !== undefined) && (
                <span className="space-x-1 font-mono text-2xs">
                  {linesAdded !== undefined && (
                    <span className="text-status-success font-semibold">
                      +{linesAdded}
                    </span>
                  )}
                  {linesRemoved !== undefined && (
                    <span className="text-status-danger font-semibold">
                      -{linesRemoved}
                    </span>
                  )}
                </span>
              )}
            </span>
          </button>
        ) : null}

        <span data-team-controls><TeamPillRow
          members={teamMembers}
          availableAgents={availableAgents}
          activeAgentName={activeAgentName}
          onSelectAgent={onSelectTeamAgent}
          onAddTeammate={onAddTeammate}
          onOpenAgentsHub={onOpenAgentsHub}
        /></span>
      </div>

      {/* Right side: TurnNavigationPopup + TodoProgressPopup */}
      <div className="flex items-center gap-1.5 shrink-0">
        {userMessageTurns.length > 0 && (
          <TurnNavigationPopup
            turns={userMessageTurns}
            onNavigateToTurn={onScrollToUserMessage ?? (() => {})}
          >
            <button
              type="button"
              onClick={
                onScrollToPreviousMessage ??
                (() => {
                  const last = userMessageTurns[userMessageTurns.length - 1];
                  if (last && onScrollToUserMessage) {
                    onScrollToUserMessage(last.patchKey);
                  }
                })
              }
              aria-label="Scroll to previous user message"
              title="Your Messages (Turn Navigation)"
              className="flex items-center justify-center p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
            >
              <ArrowUp className="size-3.5" />
            </button>
          </TurnNavigationPopup>
        )}

        <TodoProgressPopup todos={todos} />
      </div>
    </div>
  );
}
