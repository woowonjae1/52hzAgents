'use client';

import { Hint } from '@/components/ui/hint';
import { SkeletonRows } from '@/components/ui/skeleton';
import { runUndoable } from '@/lib/undoable';
import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from '@/lib/toast';
import { PanelLeft, Pencil, RefreshCw, Search, Star, Archive, Trash2, MoreVertical, ArchiveRestore, Wrench, Loader2, CheckCircle2, MessageCircle, MessageSquare, Plus, Folder, FolderPlus, FolderOpen, FolderMinus, MessageSquarePlus, Command, History as HistoryIcon, CalendarClock, BookOpen, Sparkles, X, ListFilter } from 'lucide-react';
import { browseForFolder, basename } from '@/components/chat/project-folder-picker';
import { cn } from '@/lib/utils';
import { useWorkspace, type LastMessageInfo } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { timeAgo, formatRowTime, formatCompactRelativeTime } from '@/lib/helpers';
import { AgentAvatar, AgentAvatarStack, type AgentStackItem } from '@/components/agents/agent-avatar';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { workspaceApi } from '@/lib/api';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { stripAddressPrefix } from '@/lib/types';
import { isComposing } from '@/lib/ime';
import { useThreadSeen } from '@/lib/thread-seen';
import {
  getDerivedTitle,
  subscribeToTitles,
  cleanTitleText,
  truncateTitle,
  isUnusableTitleSource,
} from '@/lib/thread-title';
import { FIND_EVENT } from '@/components/layout/global-shortcuts';

/*
  Who is in this channel, as marks rather than names. One agent renders as a
  single logo; several overlap into a stack that collapses to `+N` past `max`.

  The separating ring is what keeps overlapping logos readable, so it stays
  even though logos are otherwise unframed now — but it is `ring-surface-sidebar`
/**
 * Extract participating agents from session metadata, mentions in title,
 * master agent, and recent messages.
 */
export function extractSessionAgents(
  session: WorkspaceSession,
  allWorkspaceAgents: WorkspaceAgent[],
  lastMsg?: LastMessageInfo | null,
  smartTitle?: string,
): AgentStackItem[] {
  const agentMap = new Map<string, AgentStackItem>();

  const addAgent = (rawName: string) => {
    const clean = stripAddressPrefix(rawName).trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (['user', 'human', 'system', 'you', 'assistant', 'unknown'].includes(lower)) return;
    if (agentMap.has(lower)) return;

    const matched = allWorkspaceAgents.find(
      (a) => a.agentName.toLowerCase() === lower
    );
    if (matched) {
      agentMap.set(lower, {
        name: matched.agentName,
        agentType: matched.agentType,
        status: matched.status,
      });
    } else {
      agentMap.set(lower, {
        name: clean,
        agentType: clean,
      });
    }
  };

  // 1. Explicit @mentions in title, smartTitle, or message content (strongest intent)
  const stringsToCheck = [session.title, smartTitle, lastMsg?.content].filter(Boolean) as string[];
  for (const str of stringsToCheck) {
    for (const m of str.match(/@([a-zA-Z0-9_.-]+)/g) ?? []) addAgent(m.slice(1));
  }

  // 2. Direct match of title to an agent name (e.g. "pi", "antigravity", "pi: ...")
  for (const str of [session.title, smartTitle].filter(Boolean) as string[]) {
    const clean = str.trim().toLowerCase();
    for (const a of allWorkspaceAgents) {
      const aLower = a.agentName.toLowerCase();
      if (
        clean === aLower ||
        clean.startsWith(`${aLower} `) ||
        clean.startsWith(`${aLower}:`) ||
        clean.startsWith(`${aLower}：`)
      ) {
        addAgent(a.agentName);
      }
    }
  }

  // 3. Last message speaker if it was an agent (strongest activity)
  if (lastMsg?.senderName) {
    addAgent(lastMsg.senderName);
  }

  // 4. Session master agent (strongest leadership)
  if (session.master) {
    addAgent(session.master);
  }

  // 5. Specific assigned participants (only if not the entire default workspace roster)
  if (agentMap.size === 0 && session.participants && session.participants.length > 0 && allWorkspaceAgents.length > 1) {
    if (session.participants.length < allWorkspaceAgents.length) {
      for (const p of session.participants) {
        addAgent(p);
      }
    }
  }

  // 6. If no agent identified yet and exactly one agent is online in the workspace
  if (agentMap.size === 0 && allWorkspaceAgents.length > 0) {
    const onlineAgents = allWorkspaceAgents.filter((a) => a.status === 'online');
    if (onlineAgents.length === 1) {
      addAgent(onlineAgents[0].agentName);
    }
  }

  return Array.from(agentMap.values());
}

function AvatarStack({
  agents,
  max = 3,
  size = 18,
}: { agents: WorkspaceAgent[]; max?: number; size?: number }) {
  const items: AgentStackItem[] = agents.map((a) => ({
    name: a.agentName,
    agentType: a.agentType,
    status: a.status,
  }));
  return <AgentAvatarStack agents={items} max={max} size={size} />;
}

interface SearchHit {
  channelName: string;
  snippet: string;
  messageId: string;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-primary/20 text-foreground font-semibold rounded-xs px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function DMSection({
  conversations,
  currentSessionId,
  onSelect,
}: {
  conversations: import('@/lib/types').DMConversation[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
      >
        <MessageCircle className="size-3" />
        <span>Agent DMs ({conversations.length})</span>
        <svg
          className={cn('size-3 ml-auto transition-transform', expanded && 'rotate-180')}
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-1 space-y-1">
          {conversations.map((convo) => {
            const agent0 = convo.agents?.[0] || 'agent';
            const agent1 = convo.agents?.[1] || 'agent';
            const dmId = `dm:${agent0},${agent1}`;
            const isSelected = currentSessionId === dmId;
            const agentA = stripAddressPrefix(agent0);
            const agentB = stripAddressPrefix(agent1);
            const sender = stripAddressPrefix(convo.lastMessage?.sender);
            const preview = `${sender}: ${convo.lastMessage?.content || ''}`;
            const displayTime = convo.lastMessage?.timestamp
              ? timeAgo(new Date(convo.lastMessage.timestamp).toISOString())
              : '';

            return (
              <div
                key={dmId}
                onClick={() => onSelect(dmId)}
                className={cn(
                  'w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors relative',
                  // Matches the session rows above: brand tint + brand rail.
                  // The rail was `--primary`, i.e. near-black, which on the
                  // sidebar ground read as a crop mark rather than a marker.
                  isSelected
                    ? 'bg-brand-subtle text-foreground font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-r-full before:bg-brand'
                    : 'border border-transparent hover:bg-surface2/60 text-foreground-muted hover:text-foreground'
                )}
              >
                <div className="shrink-0 flex items-center justify-center">
                  <AgentAvatarStack agents={[{ name: agentA, agentType: agentA }, { name: agentB, agentType: agentB }]} size={20} />
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs flex-1 min-w-0 truncate font-medium text-foreground">
                      {agentA} ↔ {agentB}
                    </span>
                    <span className="text-2xs text-muted-foreground shrink-0 tabular-nums">{displayTime}</span>
                  </div>
                  <p className="text-2xs text-muted-foreground truncate">{preview}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The name of a thread, in priority order. See lib/thread-title.ts for why the
 * old rule — "strip the last message and cut at 24" — produced a sidebar of
 * crash text that renamed itself every turn.
 *
 *   1. what the user explicitly called it
 *   2. what they asked for first, recorded the last time the thread was open
 *   3. the newest message, but only if it is not a failure, a tool trace or an
 *      agent narrating its own next step
 *   4. the project folder — disambiguated, because otherwise every unnamed
 *      thread in one folder shares a name
 */
export function getSmartSessionTitle(
  session: WorkspaceSession,
  lastMsg?: LastMessageInfo | null,
  folderOrdinal?: number,
): string {
  const rawTitle = (session.title || '').trim();
  const isGeneric =
    !rawTitle ||
    rawTitle === '新频道' ||
    rawTitle === 'New Channel' ||
    rawTitle === 'Untitled Channel' ||
    rawTitle === 'Untitled' ||
    rawTitle === 'New Chat';

  if (!isGeneric) return rawTitle;

  // Recorded from the transcript's first user message. Stable by construction:
  // written once, never overwritten.
  const derived = getDerivedTitle(session.sessionId);
  if (derived) return derived;

  // Never opened, so the newest message is all there is. Filtered hard.
  if (lastMsg && lastMsg.content && !lastMsg.isStatus) {
    const clean = cleanTitleText(lastMsg.content);
    if (clean && !isUnusableTitleSource(clean)) {
      return truncateTitle(clean);
    }
  }

  if (session.workingDir) {
    const parts = session.workingDir.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length > 0) {
      const folder = parts[parts.length - 1];
      /*
        `java-to-go`, eight times, is not a list. The ordinal is assigned by the
        caller from the thread's position among the other unnamed threads in
        the same folder, so the numbers are stable for as long as the ordering
        is and do not renumber themselves as unrelated threads arrive.
      */
      return folderOrdinal && folderOrdinal > 1 ? `${folder} ${folderOrdinal}` : folder;
    }
  }

  return 'New chat';
}

/*
  A private MIME type, not `text/plain`: the sidebar must not treat a dragged
  file, a URL or a selection from the transcript as a thread being refiled.
*/
const THREAD_DRAG_TYPE = 'application/x-52hz-thread';

interface ThreadRowProps {
  session: WorkspaceSession;
  isSelected: boolean;
  lastMsg?: LastMessageInfo;
  isActive: boolean;
  isCompleted: boolean;
  contentHit?: SearchHit;
  isSearching: boolean;
  searchQuery: string;
  isEditing: boolean;
  /** Activity newer than the last time this thread was on screen. */
  isUnread: boolean;
  /**
   * This thread's position among the OTHER unnamed threads sharing its project
   * folder, 1-based. Only used when the title falls all the way back to the
   * folder name, to stop eight rows all reading `java-to-go`.
   */
  folderOrdinal?: number;
  editTitleValue: string;
  agents: WorkspaceAgent[];
  onSelect: (sessionId: string) => void;
  onStartEdit: (sessionId: string, title: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (sessionId: string, title: string) => void;
  onUpdateStarred: (sessionId: string, starred: boolean) => void;
  onUpdateStatus: (sessionId: string, status: 'active' | 'archived' | 'deleted') => void;
  /*
    Re-point an EXISTING thread at a folder, or detach it with null.

    `workingDir` was write-once from the UI's side: the two places that set it
    (the launch screen and the New chat dialog) both run at creation, and
    every other site only reads it to group and display. Drag-and-drop could
    move a thread BETWEEN groups, but a group only exists if some thread is
    already in that folder — so a directory you had not used before was
    unreachable without starting a new thread. The row already shows the
    folder; now it can change it.
  */
  onChangeFolder: (sessionId: string, current: string | null) => void;
  /** Detach without opening a picker. Separate from `onChangeFolder`,
      whose second argument seeds the browse dialog rather than setting a
      value — one callback doing both reads as the same action twice. */
  onClearFolder: (sessionId: string) => void;
  setEditTitleValue: (v: string) => void;
  /** Alt+Shift+Up/Down: move this thread to the previous/next project group. */
  onMoveToAdjacentFolder?: (sessionId: string, direction: -1 | 1) => void;
}

const ThreadRow = memo(function ThreadRow({
  session,
  isSelected,
  lastMsg,
  isActive,
  isCompleted,
  contentHit,
  isSearching,
  searchQuery,
  isEditing,
  isUnread,
  folderOrdinal,
  editTitleValue,
  agents,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onUpdateStarred,
  onUpdateStatus,
  onChangeFolder,
  onClearFolder,
  setEditTitleValue,
  onMoveToAdjacentFolder,
}: ThreadRowProps) {
  const activityMs = session.lastEventAt;
  const displayTime = formatCompactRelativeTime(
    activityMs || (session.createdAt ? new Date(session.createdAt).getTime() : 0),
  );

  /*
    A `displayAgent` chain used to sit here: last speaker, else `master`, else
    `session.participants[0]`. Nothing read it -- it terminated in a const the
    row never rendered -- so it was six bindings of dead code whose last step
    was literally "the alphabetically first name in the roster". That is the
    amp selector, spelled out. extractSessionAgents above is the one place
    that answers this question now.
  */

  const smartTitle = getSmartSessionTitle(session, lastMsg, folderOrdinal);

  /*
    A thread nothing has been said in shows no avatars.

    Three rows titled "New chat" each carrying the same five-agent stack is
    what the sidebar looked like after clicking New chat three times: brand-new
    empty threads presented as established, busy ones, and indistinguishable
    from each other. The stack answers "who has been working here", and in an
    empty thread the honest answer is nobody — the assignment roster is not an
    activity.

    Capped at TWO rather than the component's default three. With the ordering
    above, two is enough to tell one row from another, and the third slot was
    where the rows started looking alike again.
  */
  const sessionAgents = useMemo(
    () => extractSessionAgents(session, agents, lastMsg, smartTitle).slice(0, 2),
    [session, agents, lastMsg, smartTitle]
  );

  let preview: React.ReactNode;
  let previewIsStatus = false;
  if (isSearching && contentHit) {
    const snippet = contentHit.snippet.length > 80
      ? contentHit.snippet.slice(0, 80) + '...'
      : contentHit.snippet;
    preview = highlightMatch(snippet, searchQuery);
  } else if (lastMsg && lastMsg.content) {
    const trimmed = lastMsg.content.trim();
    const isThinkingText = /^thinking(\.{0,3})?$/i.test(trimmed) || /^<think/i.test(trimmed);

    if (lastMsg.isStatus && isActive) {
      previewIsStatus = true;
      const toolMatch = lastMsg.content.match(/Using tool:?\**\s*`?([^`\n]+)`?/i);
      if (toolMatch) {
        const rawTool = toolMatch[1].trim();
        const cleanTool = rawTool.replace(/^mcp__[^_]+__/, '');
        preview = (
          <span className="flex items-center gap-1">
            <Wrench className="size-3 shrink-0" /> {cleanTool}
          </span>
        );
      } else if (isThinkingText || lastMsg.content.includes('thinking')) {
        preview = (
          <span className="flex items-center gap-1">
            <span className="event-running">thinking</span>
          </span>
        );
      } else {
        const cleaned = lastMsg.content
          .replace(/\*\*/g, '')
          .replace(/`/g, '')
          .replace(/```[\s\S]*/g, '')
          .trim();
        preview = cleaned || 'No messages yet';
      }
    } else if (isThinkingText || trimmed === 'sse-probe') {
      preview = 'No messages yet';
    } else {
      preview = lastMsg.content;
    }
  } else {
    preview = 'No messages yet';
  }

  const normalizeForCompare = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_#~>]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .replace(/(\.{3}|…)$/, '')
      .trim()
      .toLowerCase();

  const normalizedPreview = typeof preview === 'string' ? normalizeForCompare(preview) : '';
  const normalizedTitle = normalizeForCompare(smartTitle);
  const previewRestatesTitle =
    normalizedPreview.length > 0 &&
    normalizedTitle.length > 0 &&
    (normalizedPreview === normalizedTitle ||
      normalizedPreview.startsWith(normalizedTitle) ||
      normalizedTitle.startsWith(normalizedPreview));

  const previewText = typeof preview === 'string' ? preview.trim() : '';
  const hoverPreview =
    previewText && !previewRestatesTitle && previewText !== 'No messages yet'
      ? previewText
      : null;

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      /*
        DRAG TO REFILE, AND A KEYBOARD PATH TO THE SAME THING.

        A project group is just the set of threads sharing a `workingDir`, so
        dropping a row on another group's header rebinds that one field. The
        keyboard equivalent is Alt+Shift+Up/Down, because a move that only
        exists as a drag is a move half the people using this cannot make.
      */
      draggable={!isEditing}
      onDragStart={(e) => {
        if (isEditing) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(THREAD_DRAG_TYPE, session.sessionId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onKeyDown={(e) => {
        if (isEditing) return;
        if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onMoveToAdjacentFolder?.(session.sessionId, e.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(session.sessionId);
        }
      }}
      onClick={() => {
        if (isEditing) return;
        onSelect(session.sessionId);
      }}
      className={cn(
        /*
          beUI's `ai-sidebar` resource row, value for value: `min-h-9`,
          `gap-2.5`, `rounded-xl`, `pr-3`, `text-sm`, muted by default and
          lifting to `bg-muted text-foreground` when selected or hovered.

          The brand-tinted fill and the 3px left rule are gone with it — the
          reference marks the active row with the same `bg-muted` plate it
          uses for hover and nothing else.
        */
        'group relative flex min-h-9 w-full min-w-0 cursor-pointer select-none items-center justify-between gap-2.5 rounded-xl ps-4 pr-3 text-left text-sm transition-colors',
        'focus-visible:outline-hidden focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        isSelected
          ? 'bg-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        'has-data-[state=open]:bg-muted has-data-[state=open]:text-foreground',
        isActive && 'thread-wip',
        isCompleted && !isSelected && 'bg-surface2/40'
      )}
    >
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        {isUnread && (
          <span
            aria-label="Unread"
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        )}
        {session.starred && (
          <Star className="size-3 shrink-0 fill-amber-500 text-status-warning" />
        )}
        {sessionAgents.length > 0 ? (
          <AgentAvatarStack agents={sessionAgents} max={2} size={18} />
        ) : session.workingDir ? (
          <span className="size-4 shrink-0 flex items-center justify-center text-foreground-extra-muted text-xs font-mono font-semibold">
            #
          </span>
        ) : (
          <MessageSquare className="size-3.5 text-foreground-extra-muted shrink-0" />
        )}
        {isEditing ? (
          <input
            type="text"
            autoFocus
            value={editTitleValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditTitleValue(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                const trimmed = editTitleValue.trim();
                if (trimmed) onSaveEdit(session.sessionId, trimmed);
                onCancelEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancelEdit();
              }
            }}
            onBlur={() => {
              const trimmed = editTitleValue.trim();
              if (trimmed) onSaveEdit(session.sessionId, trimmed);
              onCancelEdit();
            }}
            className="text-xs font-semibold flex-1 min-w-0 px-1.5 py-0.5 rounded bg-surface1 text-foreground border border-primary outline-hidden"
          />
        ) : (
          <span
            title={hoverPreview ? `${smartTitle} — ${hoverPreview}` : smartTitle}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onStartEdit(session.sessionId, smartTitle);
            }}
            className={cn(
              'text-xs flex-1 min-w-0 truncate tracking-tight transition-colors',
              isSelected ? 'font-medium text-foreground' : 'font-normal text-foreground/85 group-hover:text-foreground'
            )}
          >
            {isSearching ? highlightMatch(smartTitle, searchQuery) : smartTitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <span className={cn(
          'text-3xs tabular-nums transition-colors',
          isSelected ? 'text-foreground/70' : 'text-foreground-extra-muted'
        )}>
          {displayTime}
        </span>

        {/* Hover actions */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity p-0.5 rounded hover:bg-surface3 text-foreground-extra-muted hover:text-foreground shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit(session.sessionId, smartTitle);
              }}
            >
              <Pencil className="size-4" />
              <span>Rename</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onUpdateStarred(session.sessionId, !session.starred);
              }}
            >
              <Star className={cn('size-4', session.starred && 'fill-status-warning text-status-warning')} />
              <span>{session.starred ? 'Unstar' : 'Star'}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onUpdateStatus(session.sessionId, session.status === 'archived' ? 'active' : 'archived');
              }}
            >
              {session.status === 'archived'
                ? <><ArchiveRestore className="size-4" /><span>Unarchive</span></>
                : <><Archive className="size-4" /><span>Archive</span></>
              }
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onChangeFolder(session.sessionId, session.workingDir ?? null);
              }}
            >
              <FolderOpen className="size-4" />
              <span>{session.workingDir ? 'Change project folder…' : 'Set project folder…'}</span>
            </DropdownMenuItem>
            {session.workingDir && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onClearFolder(session.sessionId);
                }}
              >
                <FolderMinus className="size-4" />
                <span>Remove from project</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateStatus(session.sessionId, 'deleted');
              }}
            >
              <Trash2 className="size-4" />
              <span>Delete</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}, (prev, next) => {
  return (
    prev.session === next.session &&
    prev.isSelected === next.isSelected &&
    prev.isActive === next.isActive &&
    prev.isCompleted === next.isCompleted &&
    prev.lastMsg === next.lastMsg &&
    prev.contentHit === next.contentHit &&
    prev.isSearching === next.isSearching &&
    prev.searchQuery === next.searchQuery &&
    prev.isEditing === next.isEditing &&
    prev.isUnread === next.isUnread &&
    prev.folderOrdinal === next.folderOrdinal &&
    prev.editTitleValue === next.editTitleValue &&
    prev.agents === next.agents
  );
});

interface VirtualGroupHeaderItem {
  type: 'header';
  key: string;
  dir: string | null;
  count: number;
  /** The starred band at the top of the list, rather than a project folder. */
  pinned?: boolean;
  isCollapsed?: boolean;
}

interface VirtualSessionItem {
  type: 'session';
  key: string;
  session: WorkspaceSession;
}

interface VirtualExpanderItem {
  type: 'expander';
  key: string;
  groupKey: string;
  totalCount: number;
  isExpanded: boolean;
}

type VirtualListItem = VirtualGroupHeaderItem | VirtualSessionItem | VirtualExpanderItem;

export function ThreadList() {
  const { loading, sessions, currentSessionId, setCurrentSessionId, agents, lastMessageBySession, activeSessionIds, completedSessionIds, updateSession, moveSessionToFolder, renameSession, dmConversations, createSession, userSentMessageTimestamps, recordUserMessageSent, todos } = useWorkspace();
  const { sidebarToggle, isMobile, openMobileDetail, setViewMode, viewMode } = useLayout();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toggleCollapseGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const toggleExpandGroup = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    setViewMode('threads');
    if (isMobile) openMobileDetail();
  }, [setCurrentSessionId, setViewMode, isMobile, openMobileDetail]);

  const handleStartEdit = useCallback((sessionId: string, title: string) => {
    setEditingSessionId(sessionId);
    setEditTitleValue(title);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingSessionId(null);
  }, []);

  const handleSaveEdit = useCallback((sessionId: string, title: string) => {
    renameSession(sessionId, title);
    setEditingSessionId(null);
  }, [renameSession]);

  const handleUpdateStarred = useCallback((sessionId: string, starred: boolean) => {
    updateSession(sessionId, { starred });
  }, [updateSession]);

  /*
   * DELETE IS UNDOABLE, SO IT DOES NOT ASK FIRST.
   *
   * This used to raise a modal saying "this cannot be undone" — which was not
   * true (the delete is a status flip, fully reversible) and charged a click
   * for every deletion including the ones that were meant. A desktop list
   * deletes on the key and gives you a few seconds to take it back.
   */
  const deleteSession = useCallback((sessionId: string, title: string) => {
    const previous = sessions.find((s) => s.sessionId === sessionId)?.status || 'active';
    runUndoable({
      message: `Deleted "${title}"`,
      onOptimistic: () => updateSession(sessionId, { status: 'deleted' }),
      onRevert: () => updateSession(sessionId, { status: previous }),
      // The status flip above IS the delete; there is nothing left to commit.
      onCommit: async () => {},
    });
  }, [sessions, updateSession]);

  const handleUpdateStatus = useCallback((sessionId: string, status: 'active' | 'archived' | 'deleted') => {
    if (status === 'deleted') {
      const target = sessions.find((s) => s.sessionId === sessionId);
      deleteSession(sessionId, target?.title || 'Untitled conversation');
      return;
    }
    updateSession(sessionId, { status });
  }, [sessions, updateSession, deleteSession]);

  // Debounced content search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await workspaceApi.searchMessages(searchQuery.trim());
        setSearchResults(hits);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery]);

  // When searching, show sessions that match by title OR have content hits
  const isSearching = searchQuery.trim().length > 0;
  const hitsByChannel = new Map<string, SearchHit>();
  for (const hit of searchResults) {
    if (!hitsByChannel.has(hit.channelName)) {
      hitsByChannel.set(hit.channelName, hit);
    }
  }

  const [showArchived, setShowArchived] = useState(false);

  const getSessionTime = useCallback((s: WorkspaceSession) => {
    const userTime = userSentMessageTimestamps[s.sessionId];
    if (userTime) return userTime;
    return s.lastEventAt || (s.createdAt ? new Date(s.createdAt).getTime() : 0);
  }, [userSentMessageTimestamps]);

  // Sort sessions by latest activity (lastEventAt, lastMessage timestamp, or createdAt)
  const sortedSessions = useMemo(() => {
    return [...sessions]
      .filter((s) => s.status !== 'deleted' && (!s.sessionId.startsWith('routine:') || s.sessionId === currentSessionId))
      .sort((a, b) => getSessionTime(b) - getSessionTime(a));
  }, [sessions, currentSessionId, getSessionTime]);

  const activeSessions = sortedSessions.filter((s) => s.status === 'active');
  const archivedSessions = sortedSessions.filter((s) => s.status === 'archived');
  const onlineAgentCount = agents.filter((a) => a.status === 'online').length;

  const filteredSessions = isSearching
    ? sortedSessions.filter((s) =>
        s.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        hitsByChannel.has(s.sessionId)
      )
    : activeSessions;

  /*
    STARRING DID NOTHING.

    These two lines existed already — computed, and then referenced nowhere in
    the file. The context menu offered Star / Unstar, the row drew a star, and
    the grouping below went on slicing `filteredSessions` by project directory
    as if the flag did not exist. So the feature looked implemented from every
    angle a user can see: you could turn it on, it remembered, and it changed
    nothing about where the thread lived.

    A star means "keep this one where I can reach it". It now gets a band at
    the very top of the list, above the project groups, holding starred threads
    from every project — which is the point, since the thread you want pinned
    is usually not in the folder you are looking at.
  */
  const pinnedSessions = useMemo(
    () => filteredSessions.filter((s) => s.starred),
    [filteredSessions],
  );

  // Channels grouped by Project Directory, sorted by most recent activity at both group & session level
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, { dir: string | null; maxTime: number; sessions: WorkspaceSession[] }>();
    for (const s of filteredSessions) {
      const key = s.workingDir || '';
      const sTime = getSessionTime(s);
      let group = groups.get(key);
      if (!group) {
        group = { dir: s.workingDir || null, maxTime: sTime, sessions: [] };
        groups.set(key, group);
      } else {
        if (sTime > group.maxTime) group.maxTime = sTime;
      }
      group.sessions.push(s);
    }
    // Sort project groups by most recently active group at the top
    const groupList = [...groups.values()].sort((a, b) => b.maxTime - a.maxTime);
    // Sort sessions within each group by recency
    for (const g of groupList) {
      g.sessions.sort((a, b) => getSessionTime(b) - getSessionTime(a));
    }
    return groupList;
  }, [filteredSessions, getSessionTime]);

  // Flattened render order, so the 1-9 shortcuts and the numbers shown on the
  // rows agree with what the grouped list actually looks like.
  const visualOrder = useMemo(() => groupedSessions.flatMap((g) => g.sessions), [groupedSessions]);
  const orderIndex = useMemo(
    () => new Map(visualOrder.map((s, i) => [s.sessionId, i])),
    [visualOrder],
  );

  /*
    One clock for the whole list, refreshed on the minute.

    `Date.now()` read inside the bucketing loop would let a slow pass straddle
    midnight and file two adjacent threads under different bands. Ticking it
    keeps "Today" honest without a render per second — the bands only ever
    change at a day boundary, but the relative times on the rows want the
    minute anyway.
  */
  // Auto-expand group if current session is past the preview limit
  useEffect(() => {
    if (!currentSessionId) return;
    for (const group of groupedSessions) {
      const groupKey = group.dir ?? '__no_folder__';
      const index = group.sessions.findIndex((s) => s.sessionId === currentSessionId);
      if (index >= 6) {
        setExpandedGroups((prev) => {
          if (prev.has(groupKey)) return prev;
          const next = new Set(prev);
          next.add(groupKey);
          return next;
        });
        setCollapsedGroups((prev) => {
          if (!prev.has(groupKey)) return prev;
          const next = new Set(prev);
          next.delete(groupKey);
          return next;
        });
        break;
      }
    }
  }, [currentSessionId, groupedSessions]);

  const PREVIEW_LIMIT = 6;

  // Flatten grouped sessions into list items for TanStack Virtual
  const virtualListItems = useMemo<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = [];

    // Pinned first, and only when there are any — an empty "Pinned" heading is
    // a promise about a section that is not there.
    if (pinnedSessions.length > 0) {
      items.push({
        type: 'header',
        key: 'header-__pinned__',
        dir: null,
        count: pinnedSessions.length,
        pinned: true,
      });
      for (const s of pinnedSessions) {
        items.push({ type: 'session', key: `pinned-${s.sessionId}`, session: s });
      }
    }

    for (const group of groupedSessions) {
      const groupKey = group.dir ?? '__no_folder__';
      const isCollapsed = collapsedGroups.has(groupKey);
      const isExpanded = expandedGroups.has(groupKey);

      items.push({
        type: 'header',
        key: `header-${groupKey}`,
        dir: group.dir,
        count: group.sessions.length,
        isCollapsed,
      });

      if (isCollapsed) continue;

      if (isSearching) {
        for (const s of group.sessions) {
          items.push({
            type: 'session',
            key: s.sessionId,
            session: s,
          });
        }
      } else {
        const hasMore = group.sessions.length > PREVIEW_LIMIT;
        const sessionsToShow = (hasMore && !isExpanded)
          ? group.sessions.slice(0, PREVIEW_LIMIT)
          : group.sessions;

        for (const s of sessionsToShow) {
          items.push({
            type: 'session',
            key: s.sessionId,
            session: s,
          });
        }

        if (hasMore) {
          items.push({
            type: 'expander',
            key: `expander-${groupKey}`,
            groupKey,
            totalCount: group.sessions.length,
            isExpanded,
          });
        }
      }
    }
    return items;
  }, [groupedSessions, pinnedSessions, isSearching, collapsedGroups, expandedGroups]);

  /*
    Titles are recorded by ChatView the first time a thread's transcript is
    read, which is usually while this list is already on screen. Without a
    subscription the row keeps its fallback name until something else happens
    to re-render it.
  */
  const [titleVersion, setTitleVersion] = useState(0);
  useEffect(() => subscribeToTitles(() => setTitleVersion((v) => v + 1)), []);

  const { isUnread, primeUnknown } = useThreadSeen(currentSessionId);

  /*
    Every thread this listing has ever shown gets a mark the first time it is
    seen. Without it `isUnread` has no baseline for a thread it has not met,
    and the choice is between lighting up the entire sidebar on first run or
    never lighting up at all. Priming picks a third answer: start measuring now.
  */
  useEffect(() => {
    if (sessions.length === 0) return;
    primeUnknown(sessions.map((s) => s.sessionId));
  }, [sessions, primeUnknown]);

  /*
    `java-to-go` EIGHT TIMES IS NOT A LIST.

    The last-resort title is the project folder's name, so every unnamed thread
    in one folder comes out identical and mutually unidentifiable. Numbering
    them is the cheap fix, but only the threads that actually FALL BACK get a
    number — a folder holding one unnamed thread and six named ones should not
    have that one thread called `java-to-go 1`.

    Computed over `visualOrder`, the flattened render order, so the numbers run
    down the list the way the eye does rather than following some internal sort.
  */
  const folderOrdinals = useMemo(() => {
    const counts = new Map<string, number>();
    const result = new Map<string, number>();
    for (const sess of visualOrder) {
      const raw = (sess.title || '').trim();
      const named = raw && !['新频道', 'New Channel', 'Untitled Channel', 'Untitled', 'New Chat'].includes(raw);
      if (named || !sess.workingDir) continue;
      if (getDerivedTitle(sess.sessionId)) continue;
      const key = sess.workingDir;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      result.set(sess.sessionId, n);
    }
    return result;
  }, [visualOrder, titleVersion]);

  const listContainerRef = useRef<HTMLDivElement>(null);

  /*
    REFILING A THREAD.

    The project groups in this list are derived from `workingDir`, so the
    order below is the order the headers are rendered in — the pinned band is
    skipped because it is a filter, not a folder, and dropping a thread on it
    would have nothing to write.
  */
  const folderOrder = useMemo(() => {
    const dirs: (string | null)[] = [];
    for (const item of virtualListItems) {
      if (item.type !== 'header' || item.pinned) continue;
      const dir = item.dir ?? null;
      if (!dirs.some((d) => d === dir)) dirs.push(dir);
    }
    return dirs;
  }, [virtualListItems]);

  const [dropFolderKey, setDropFolderKey] = useState<string | null>(null);

  const handleMoveToAdjacentFolder = useCallback(
    (sessionId: string, direction: -1 | 1) => {
      if (folderOrder.length < 2) return;
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) return;
      const current = session.workingDir ?? null;
      const at = folderOrder.findIndex((d) => d === current);
      if (at < 0) return;
      const next = folderOrder[at + direction];
      if (next === undefined) return;
      void moveSessionToFolder(sessionId, next);
    },
    [folderOrder, sessions, moveSessionToFolder]
  );

  const rowVirtualizer = useVirtualizer({
    count: virtualListItems.length,
    getScrollElement: () => listContainerRef.current,
    estimateSize: (index) => {
      const item = virtualListItems[index];
      if (item?.type === 'header') return 30;
      if (item?.type === 'expander') return 26;
      return 32;
    },
    overscan: 8,
    getItemKey: (index) => virtualListItems[index]?.key || index,
  });

  // Keep active session in view when navigating or switching threads
  const lastScrolledSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSessionId || currentSessionId === lastScrolledSessionIdRef.current) return;
    lastScrolledSessionIdRef.current = currentSessionId;
    const index = virtualListItems.findIndex(
      (item) => item.type === 'session' && item.session.sessionId === currentSessionId
    );
    if (index !== -1) {
      rowVirtualizer.scrollToIndex(index, { align: 'auto' });
    }
  }, [currentSessionId, virtualListItems]);

  const startChannel = async (dir: string | null) => {
    try {
      const session = await createSession({ workingDir: dir ?? undefined });
      if (session?.sessionId) recordUserMessageSent(session.sessionId);
      setViewMode('threads');
      if (isMobile) openMobileDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the channel');
    }
  };

  // The OS folder dialog is opened by wwj on the desktop and can take a moment
  // to appear. Without this the button looked dead and people clicked it twice.
  const [browsingFolder, setBrowsingFolder] = useState(false);

  /*
    Re-point an existing thread. `moveSessionToFolder` already does the work —
    optimistic update, PATCH, rollback on failure — and the backend's
    PatchChannel has always accepted `working_dir`. The only thing missing was
    a way to name a directory that is not already one of the groups, which
    drag-and-drop cannot express.

    The current directory seeds the dialog so "change" starts where the thread
    already is rather than at the filesystem root.
  */
  const handleChangeFolder = useCallback(async (sessionId: string, current: string | null) => {
    if (browsingFolder) return;
    setBrowsingFolder(true);
    try {
      const dir = await browseForFolder(current ?? undefined);
      if (!dir) return;
      await moveSessionToFolder(sessionId, dir);
      toast.success(`Thread moved to ${basename(dir)}`);
    } catch (e) {
      toast.error(
        e instanceof Error
          ? `Could not reach the local wwj daemon (${e.message}). Make sure \`wwj up\` is running.`
          : 'Could not open the folder picker.',
      );
    } finally {
      setBrowsingFolder(false);
    }
  }, [browsingFolder, moveSessionToFolder]);

  const handleClearFolder = useCallback(async (sessionId: string) => {
    try {
      await moveSessionToFolder(sessionId, null);
      toast.success('Thread removed from its project');
    } catch {
      toast.error('Could not remove the thread from its project');
    }
  }, [moveSessionToFolder]);

  const addProjectFolder = async () => {
    if (browsingFolder) return;
    setBrowsingFolder(true);
    try {
      const dir = await browseForFolder();
      if (dir) await startChannel(dir);
    } catch (e) {
      toast.error(
        e instanceof Error
          ? `Could not reach the local wwj daemon (${e.message}). Make sure \`wwj up\` is running.`
          : 'Could not open the folder picker.',
      );
    } finally {
      setBrowsingFolder(false);
    }
  };

  // Keyboard shortcuts:
  //   1-9       → open the Nth visible thread
  //   j / Down  → move selection down to next thread
  //   k / Up    → move selection up to previous thread
  //   /         → focus thread search filter
  //   c         → new direct chat
  //   i / Enter → focus chat input composer
  //   Esc       → blur/close search filter
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;

      // When inside an input/textarea
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        if (e.key === 'Escape') {
          if (target === searchInputRef.current) {
            e.preventDefault();
            setSearchQuery('');
            setShowSearch(false);
            searchInputRef.current?.blur();
          }
        }
        return;
      }

      // Skip when modifier keys are held (Cmd+1, Ctrl+R, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 1-9 → open thread by index
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9) {
        const session = visualOrder[num - 1];
        if (session) {
          e.preventDefault();
          setCurrentSessionId(session.sessionId, { skipFocus: true });
          if (isMobile) openMobileDetail();
        }
        return;
      }

      // j / ArrowDown → move to next thread
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (visualOrder.length === 0) return;
        e.preventDefault();
        const currentIndex = visualOrder.findIndex((s) => s.sessionId === currentSessionId);
        const nextIndex = currentIndex < 0 ? 0 : Math.min(visualOrder.length - 1, currentIndex + 1);
        const nextSession = visualOrder[nextIndex];
        if (nextSession) {
          setCurrentSessionId(nextSession.sessionId, { skipFocus: true });
          if (isMobile) openMobileDetail();
        }
        return;
      }

      // k / ArrowUp → move to previous thread
      if (e.key === 'k' || e.key === 'ArrowUp') {
        if (visualOrder.length === 0) return;
        e.preventDefault();
        const currentIndex = visualOrder.findIndex((s) => s.sessionId === currentSessionId);
        const prevIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        const prevSession = visualOrder[prevIndex];
        if (prevSession) {
          setCurrentSessionId(prevSession.sessionId, { skipFocus: true });
          if (isMobile) openMobileDetail();
        }
        return;
      }

      // '/' → search threads
      if (e.key === '/') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 10);
        return;
      }

      // 'c' → create new conversation
      if (e.key === 'c') {
        e.preventDefault();
        setViewMode('threads');
        startChannel(null);
        return;
      }

      // 'i' or 'Enter' → focus the chat input composer
      if (e.key === 'i' || e.key === 'Enter') {
        if (currentSessionId) {
          e.preventDefault();
          const el = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input]');
          el?.focus();
        }
        return;
      }
    };

    /*
      Ctrl/Cmd+F reaches the thread list through an event rather than through
      this key handler, because the filter bar is not in the DOM until it is
      asked for — so the global shortcut has no input to focus and must ask the
      list to produce one.
    */
    const onFind = () => {
      setShowSearch(true);
      setTimeout(() => searchInputRef.current?.focus(), 10);
    };

    window.addEventListener(FIND_EVENT, onFind);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(FIND_EVENT, onFind);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [visualOrder, currentSessionId, isMobile, setCurrentSessionId, openMobileDetail, setViewMode]);

  return (
    /* `data-thread-list` is a contract, not decoration: the global key handler
       (components/layout/global-shortcuts.tsx) looks for it to decide whether
       the bare letters below are already spoken for. Renaming it silently
       double-binds `c`. */
    <div data-thread-list className="flex flex-col h-full">

      {/* Projects Section Header & Actions (Figure 2 Style) */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 shrink-0 select-none">
        <span className="text-xs font-semibold text-foreground/80 tracking-tight">
          Projects
        </span>

        <div className="flex items-center gap-0.5">
          {/* Filter / Search Toggle */}
          <button
            type="button"
            onClick={() => {
              setShowSearch((prev) => {
                const next = !prev;
                if (next) setTimeout(() => searchInputRef.current?.focus(), 10);
                return next;
              });
            }}
            title="Filter & search chats (/)"
            className={cn(
              "size-6 flex items-center justify-center rounded-md hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors",
              (showSearch || searchQuery) && "bg-surface2 text-foreground"
            )}
          >
            <ListFilter className="size-3.5" />
          </button>

          {/* New Project / New Chat Dropdown (Figure 2 Style) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={browsingFolder}
                title="New Project or Chat"
                className="size-6 flex items-center justify-center rounded-md hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors disabled:opacity-50"
              >
                {browsingFolder ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 p-1">
              <DropdownMenuItem onClick={addProjectFolder} className="gap-2.5 py-2 px-2.5 text-xs rounded-lg cursor-pointer">
                <FolderPlus className="size-4 text-foreground-muted shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">New Project</span>
                  <span className="text-3xs text-muted-foreground">Select local folder</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startChannel(null)} className="gap-2.5 py-2 px-2.5 text-xs rounded-lg cursor-pointer">
                <MessageSquarePlus className="size-4 text-foreground-muted shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">New Chat</span>
                  <span className="text-3xs text-muted-foreground">Direct conversation</span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Collapsible Search Input (Only shown when toggled or search active) */}
      {(showSearch || searchQuery) && (
        <div className="px-3 pb-2 pt-0.5 shrink-0 animate-in fade-in duration-150">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 size-3 text-foreground-extra-muted pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats…"
              data-view-search
              className="w-full bg-surface2/80 border border-border rounded-lg pl-7 pr-7 py-1 text-xs text-foreground placeholder:text-foreground-extra-muted focus:outline-hidden focus:border-border-accent"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearchQuery('');
                  setShowSearch(false);
                  searchInputRef.current?.blur();
                }}
                className="absolute right-2 size-4 flex items-center justify-center rounded text-foreground-extra-muted hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Thread rows grouped by Project (TanStack Virtualized) */}
      <div
        ref={listContainerRef}
        /* The rows below are `role="option"`, which is only meaningful inside
           a listbox. Without this the roles are an assertion no assistive tech
           can act on. */
        role="listbox"
        aria-label="Conversations"
        className="flex-1 overflow-y-auto px-2 py-1 overscroll-contain transform-gpu [contain:content]"
      >
        {/* Placeholder rows while the first fetch is in flight. Without them
            the sidebar renders as a blank column and then fills, which reads
            as "no conversations" for as long as the request takes. */}
        {loading && sessions.length === 0 && <SkeletonRows rows={7} />}
        {virtualListItems.length > 0 && (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualListItems[virtualRow.index];
              if (!item) return null;

              return (
                <div
                  key={item.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="pb-0.5"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item.type === 'expander' ? (
                    <div className="ps-6 pe-2.5 py-0.5 select-none">
                      <button
                        type="button"
                        onClick={() => toggleExpandGroup(item.groupKey)}
                        className="text-xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer py-1"
                      >
                        {item.isExpanded ? 'Show less' : `See all (${item.totalCount})`}
                      </button>
                    </div>
                  ) : item.type === 'header' ? (
                    <div
                      onClick={() => toggleCollapseGroup(item.key.replace(/^header-/, ''))}
                      /*
                        The pinned band is a filter, not a folder — there is no
                        `workingDir` to write, so it does not accept a drop.
                      */
                      onDragOver={(e) => {
                        if (item.pinned) return;
                        if (!e.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDropFolderKey(item.key);
                      }}
                      onDragLeave={() => {
                        setDropFolderKey((current) => (current === item.key ? null : current));
                      }}
                      onDrop={(e) => {
                        setDropFolderKey(null);
                        if (item.pinned) return;
                        const sessionId = e.dataTransfer.getData(THREAD_DRAG_TYPE);
                        if (!sessionId) return;
                        e.preventDefault();
                        void moveSessionToFolder(sessionId, item.dir ?? null);
                      }}
                      className={cn(
                        /* beUI section item: `h-8`, `gap-2`, `rounded-lg`,
                           `px-2.5`, `text-xs`. Drop target uses the
                           reference's own `primary/10` + `ring-primary/45`. */
                        'group flex h-8 cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2.5 text-xs',
                        dropFolderKey === item.key &&
                          'bg-primary/10 ring-1 ring-primary/45 ring-inset'
                      )}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {item.pinned ? (
                          <Star className="size-3.5 shrink-0 fill-status-warning text-status-warning" />
                        ) : (
                          <Folder className="size-3.5 shrink-0 text-foreground-muted stroke-[1.5]" />
                        )}
                        <span
                          title={item.pinned ? 'Starred threads, from every project' : (item.dir ?? 'Direct chats')}
                          className="text-xs font-semibold text-foreground/80 truncate"
                        >
                          {item.pinned ? 'Pinned' : item.dir ? basename(item.dir) : 'Direct chats'}
                        </span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startChannel(item.dir);
                        }}
                        title={item.dir ? `New channel in ${basename(item.dir)}` : 'New direct chat'}
                        className="opacity-0 group-hover:opacity-100 transition-opacity size-5 flex items-center justify-center rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors shrink-0"
                      >
                        <Plus className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <ThreadRow
                      session={item.session}
                      isSelected={item.session.sessionId === currentSessionId}
                      lastMsg={lastMessageBySession[item.session.sessionId]}
                      isActive={activeSessionIds.has(item.session.sessionId)}
                      isCompleted={completedSessionIds.has(item.session.sessionId) && !activeSessionIds.has(item.session.sessionId)}
                      contentHit={hitsByChannel.get(item.session.sessionId)}
                      isSearching={isSearching}
                      searchQuery={searchQuery}
                      isEditing={editingSessionId === item.session.sessionId}
                      folderOrdinal={folderOrdinals.get(item.session.sessionId)}
                      isUnread={isUnread(
                        item.session.sessionId,
                        getSessionTime(item.session),
                        // The last thing said was yours — nothing to catch up on.
                        (lastMessageBySession[item.session.sessionId]?.senderName ?? '') === 'user',
                      )}
                      editTitleValue={editTitleValue}
                      agents={agents}
                      onSelect={handleSelectSession}
                      onStartEdit={handleStartEdit}
                      onCancelEdit={handleCancelEdit}
                      onSaveEdit={handleSaveEdit}
                      onUpdateStarred={handleUpdateStarred}
                      onUpdateStatus={handleUpdateStatus}
                      onChangeFolder={handleChangeFolder}
                      onClearFolder={handleClearFolder}
                      setEditTitleValue={setEditTitleValue}
                      onMoveToAdjacentFolder={handleMoveToAdjacentFolder}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-1">

          {filteredSessions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              {isSearching ? (
                <>
                  <p className="text-sm">No results found</p>
                  <p className="text-xs mt-1">Try a different search term</p>
                </>
              ) : (
                <>
                  <p className="text-sm">No channels yet</p>
                  <p className="text-xs mt-1">Start chatting, or pick a project folder first</p>
                  <button
                    onClick={() => startChannel(null)}
                    className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                  >
                    <MessageCircle className="size-3.5" />
                    Direct chats
                  </button>
                </>
              )}
            </div>
          )}

          {/* Agent DMs section — only show DMs whose agent participant(s) are currently online */}
          {(() => {
            if (isSearching) return null;
            const onlineAgentNames = new Set(
              agents.filter((a) => a.status === 'online').map((a) => a.agentName)
            );
            const visibleDMs = dmConversations.filter((c) => {
              // Empty shells are hidden. A handoff between agents leaves a
              // point-to-point record whose last event carries no content, and
              // those rendered as rows reading "human:user:" with nothing after
              // the colon — three entries that look like conversations you never
              // had. Only DMs with something actually said in them are listed.
              if (!(c.lastMessage?.content || '').trim()) return false;
              // For each side, if it's an agent it must be online; humans pass through.
              return (c.agents || []).every((addr: string) => {
                if (addr.startsWith('human:')) return true;
                const name = stripAddressPrefix(addr);
                return onlineAgentNames.has(name);
              });
            });
            if (visibleDMs.length === 0) return null;
            return (
              <DMSection
                conversations={visibleDMs}
                currentSessionId={currentSessionId}
                onSelect={(id) => {
                  setCurrentSessionId(id);
                  if (isMobile) openMobileDetail();
                }}
              />
            );
          })()}

          {/* Archived section */}
          {!isSearching && archivedSessions.length > 0 && (
            <div className="mt-5">
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
              >
                <Archive className="size-3" />
                <span>Archived ({archivedSessions.length})</span>
                <svg
                  className={cn('size-3 ml-auto transition-transform', showArchived && 'rotate-180')}
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 5l3 3 3-3" />
                </svg>
              </button>
              {showArchived && (
                <div className="mt-1 space-y-1 opacity-60">
                  {archivedSessions.map((session) => {
                    const isSelected = session.sessionId === currentSessionId;
                    const lastMsg = lastMessageBySession[session.sessionId];
                    const activityMs = session.lastEventAt;
                    const displayTime = activityMs
                      ? timeAgo(new Date(activityMs).toISOString())
                      : session.createdAt ? timeAgo(session.createdAt) : '';
                    const isThinking = lastMsg?.content ? (/^thinking(\.{0,3})?$/i.test(lastMsg.content.trim()) || /^<think/i.test(lastMsg.content.trim())) : false;
                    const preview = lastMsg && lastMsg.content && !isThinking && lastMsg.content.trim() !== 'sse-probe'
                      ? `${lastMsg.senderName === 'user' ? 'You' : lastMsg.senderName}: ${lastMsg.content}`
                      : 'No messages yet';

                    const itemSmartTitle = getSmartSessionTitle(session, lastMsg);
                    const directAgents = extractSessionAgents(session, agents, lastMsg, itemSmartTitle);

                    return (
                      <div
                        key={session.sessionId}
                        onClick={() => {
                          setCurrentSessionId(session.sessionId);
                          if (isMobile) openMobileDetail();
                        }}
                        className={cn(
                          'w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors relative group',
                          isSelected
                            ? 'bg-surface2 text-foreground font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-primary'
                            : 'border border-transparent hover:bg-surface2/60 text-foreground-muted hover:text-foreground',
                          'has-data-[state=open]:bg-surface2/60'
                        )}
                      >
                        <div className="shrink-0 flex items-center justify-center">
                          {directAgents.length > 0 ? (
                            <AgentAvatarStack
                              agents={directAgents}
                              size={18}
                            />
                          ) : (
                            <MessageSquare className="size-4 text-foreground-extra-muted shrink-0" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs flex-1 min-w-0 truncate font-normal text-foreground">
                              {itemSmartTitle}
                            </span>
                            <span className="text-2xs text-muted-foreground shrink-0 tabular-nums">
                              {displayTime}
                            </span>
                          </div>
                          <p className="text-2xs text-muted-foreground truncate">
                            {preview}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity p-1 rounded hover:bg-surface3 text-foreground-extra-muted hover:text-foreground shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="size-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                updateSession(session.sessionId, { status: 'active' });
                              }}
                              className="text-xs"
                            >
                              <ArchiveRestore className="size-3.5 mr-2" />
                              Unarchive
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                updateSession(session.sessionId, { status: 'deleted' });
                              }}
                              className="text-xs text-status-danger focus:text-status-danger"
                            >
                              <Trash2 className="size-3.5 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
