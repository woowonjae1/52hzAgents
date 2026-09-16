'use client';

import { Hint } from '@/components/ui/hint';
import { SkeletonRows } from '@/components/ui/skeleton';
import { runUndoable } from '@/lib/undoable';
import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import { PanelLeft, Pencil, RefreshCw, Search, Star, Archive, Trash2, MoreVertical, ArchiveRestore, Wrench, Loader2, CheckCircle2, MessageCircle, MessageSquare, Plus, FolderPlus, FolderOpen, MessageSquarePlus, Command, History as HistoryIcon, CalendarClock, BookOpen, Sparkles, X } from 'lucide-react';
import { browseForFolder, basename } from '@/components/chat/project-folder-picker';
import { cn } from '@/lib/utils';
import { useWorkspace, type LastMessageInfo } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { timeAgo, formatRowTime } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { SignalMark } from '@/components/brand/signal-mark';
import { AgentStatusStrip } from '@/components/agents/agent-status-strip';
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
  (the colour this list actually sits on), not the hardcoded `ring-white` it
  was, which drew a white halo around every avatar in dark mode. The single
  case also used `size={30}` against the stack's 18, so a one-agent channel
  and a two-agent channel disagreed on row height.
*/
function AvatarStack({
  agents,
  max = 3,
  size = 18,
}: { agents: WorkspaceAgent[]; max?: number; size?: number }) {
  const shown = agents.slice(0, max);
  const extra = agents.length - max;

  if (shown.length === 0) return null;

  if (shown.length === 1) {
    return <AgentAvatar name={shown[0].agentName} agentType={shown[0].agentType} size={size} />;
  }

  return (
    <div className="flex -space-x-1">
      {shown.map((agent) => (
        <div key={agent.agentName} className="rounded-full ring-2 ring-surface-sidebar">
          <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={size} />
        </div>
      ))}
      {extra > 0 && (
        <div
          className="px-0.5 rounded-full bg-surface3 flex items-center justify-center font-mono font-medium tracking-tighter text-foreground-muted ring-2 ring-surface-sidebar leading-none select-none"
          style={{ height: size, minWidth: size, fontSize: Math.max(8, Math.round(size * 0.5)) }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
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
                  isSelected
                    ? 'bg-surface2 text-foreground font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-primary'
                    : 'border border-transparent hover:bg-surface2/60 text-foreground-muted hover:text-foreground'
                )}
              >
                <div className="shrink-0 flex items-center justify-center border border-border rounded-full size-[30px] bg-card">
                  <MessageCircle className="size-3.5 text-muted-foreground" />
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
function getSmartSessionTitle(
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

  // Dated rather than bare: "New Chat" repeated is the same collision again.
  if (session.createdAt) {
    const d = new Date(session.createdAt);
    if (!Number.isNaN(d.getTime())) {
      return `New chat · ${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`;
    }
  }
  return 'New chat';
}

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
  setEditTitleValue: (v: string) => void;
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
  setEditTitleValue,
}: ThreadRowProps) {
  const activityMs = session.lastEventAt;
  const displayTime = formatRowTime(
    activityMs || (session.createdAt ? new Date(session.createdAt).getTime() : 0),
  );

  const rawSender = lastMsg?.senderName ? stripAddressPrefix(lastMsg.senderName).trim() : '';
  const lastSpeaker: WorkspaceAgent | 'you' | null = !lastMsg
    ? null
    : rawSender === 'user' || rawSender === 'human'
      ? 'you'
      : agents.find((a) => a.agentName.toLowerCase() === rawSender.toLowerCase()) ?? null;

  // Fallback to thread's assigned master agent or first participant if lastSpeaker is not found
  const fallbackAgentName = !lastSpeaker
    ? (session.master || (session.participants && session.participants.length > 0 ? session.participants[0] : null))
    : null;
  const cleanFallback = fallbackAgentName ? stripAddressPrefix(fallbackAgentName).trim() : '';
  const fallbackAgent = cleanFallback
    ? agents.find((a) => a.agentName.toLowerCase() === cleanFallback.toLowerCase()) ?? null
    : null;

  const displayAgent = (lastSpeaker && lastSpeaker !== 'you') ? lastSpeaker : fallbackAgent;

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

  const smartTitle = getSmartSessionTitle(session, lastMsg, folderOrdinal);

  /*
    THE SECOND LINE IS DROPPED WHEN IT RESTATES THE FIRST.

    `getSmartSessionTitle` falls back to the last message's content for any
    session without a real title — cleaned, then cut at 24 characters with an
    ellipsis. `preview` is that same message. So on every unnamed thread the row
    spent two lines of height and a 10px type step to say one thing twice:
      看了下现有覆盖（9 篇 /...
      看了下现有覆盖（9 篇 / 40+ 节，基础→并...
    Four of six rows looked like that. Comparing on normalised text — same
    markdown/emoji stripping the title got, trailing ellipsis removed — catches
    the truncation case, which a plain equality check cannot.

    `No messages yet` deliberately survives: it does not repeat the title, and
    "this thread is empty" is the one thing the second line can say that the
    first cannot.
  */
  const normalizeForCompare = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_#~>]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .replace(/(\.{3}|…)$/, '')
      .trim()
      .toLowerCase();
  /*
    `preview` is a ReactNode, not a string — a search hit, a running tool chip
    and the `thinking` sweep are all JSX. Those can never be a restatement of
    the title, and the empty string below makes the test fall through to
    "show it", which is the right answer for all three.
  */
  const normalizedPreview = typeof preview === 'string' ? normalizeForCompare(preview) : '';
  const normalizedTitle = normalizeForCompare(smartTitle);
  const previewRestatesTitle =
    normalizedPreview.length > 0 &&
    normalizedTitle.length > 0 &&
    (normalizedPreview === normalizedTitle ||
      normalizedPreview.startsWith(normalizedTitle) ||
      normalizedTitle.startsWith(normalizedPreview));
  /*
    EVERY ROW IS THE SAME HEIGHT.

    Two rules had accumulated for hiding the second line — "the preview repeats
    the title" and "the preview is content-free chatter" — and between them
    they collapsed most but not all rows. The result was a column alternating
    62px and 42px in no pattern the eye could predict, which is worse than
    either height consistently: scanning a list is a rhythm, and a list with no
    rhythm has to be read instead of scanned.

    Fixed single line, not fixed double. The second line's content here is an
    agent's status output, not a person's message — the thing that makes
    Slack's and Linear's two-line rows worth their height. Half the previews
    were already being suppressed as noise by those two rules, which is the
    measurement that settles it: a line that is empty half the time should not
    be reserving space the other half.

    Nothing is lost. The preview is now the row's hover text, where it costs
    nothing until asked for.
  */
  const previewText = typeof preview === 'string' ? preview.trim() : '';
  const hoverPreview =
    previewText && !previewRestatesTitle && previewText !== 'No messages yet'
      ? previewText
      : null;

  return (
    <div
      /*
        THE MOST-USED LIST IN THE APP WAS THE ONE YOU COULD NOT TAB INTO.

        Files, Inbox, Knowledge and Tasks all went through
        `useListKeyboardNav`, which gives their rows `role="option"`, a roving
        tabindex and `aria-selected`. This list kept its own hand-rolled j/k
        handler — which works, and stays — but its rows were bare `<div
        onClick>`: no role, no tab stop, no focus ring, invisible to a screen
        reader as anything but text.

        The roving tabindex is the part that matters: exactly one row is in the
        tab order, the SELECTED one, so Tab reaches the list in a single press
        and lands where the user already is rather than walking twenty threads.
        Enter and Space then open it, which is what `role="option"` promises.

        Deliberately NOT swapping in the shared hook. It owns a cursor of its
        own, and this list already has one expressed through `currentSessionId`
        plus the 1-9 number shortcuts; running both would give the list two
        disagreeing notions of "the current row".
      */
      role="option"
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      onKeyDown={(e) => {
        if (isEditing) return;
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
        'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors relative group select-none',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-accent',
        /*
          4. A SOFTER SELECTED STATE.

          This was a 4px `bg-primary` bar pinned to the row's left edge. In the
          dark theme `--primary` is near-white, so the marker for "you are here"
          was the highest-contrast object on the entire screen — brighter than
          any text, for a state the user already knows they are in. Selection
          needs to be unmistakable when scanned, not loud when stared at.

          The fill does the work; the bar is now half the width, inset from the
          rounded corner rather than butting against it, and tinted rather than
          full-strength.
        */
        isSelected
          ? 'bg-surface2 text-foreground font-medium before:absolute before:left-0.5 before:top-2.5 before:bottom-2.5 before:w-0.5 before:rounded-full before:bg-primary/60'
          : 'border border-transparent hover:bg-surface2/60 text-foreground-muted hover:text-foreground',
        'has-data-[state=open]:bg-surface2/60',
        isActive && 'thread-wip',
        isCompleted && !isSelected && 'bg-surface2/50 border border-border/60'
      )}
    >
      <div className="shrink-0 self-start pt-0.5 size-[18px]">
        {lastSpeaker === 'you' ? (
          <SignalMark size={18} still />
        ) : displayAgent ? (
          <AgentAvatar
            name={displayAgent.agentName}
            agentType={displayAgent.agentType}
            size={18}
          />
        ) : (
          <div className="size-[18px] flex items-center justify-center rounded-md bg-surface2/80 text-foreground-extra-muted border border-border/40">
            <MessageSquare className="size-2.5 opacity-60" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1.5">
          {/*
            The unread mark goes BEFORE the title, not after the timestamp.

            It has to be findable by sweeping one vertical line down the list —
            that is the entire job — and the right edge already holds the
            relative time, which changes length per row and would make the dots
            zigzag. A filled disc rather than a count: how many messages
            arrived is not a decision input, whether any did is.
          */}
          {isUnread && (
            <span
              aria-label="Unread"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
          {session.starred && (
            <Star className="size-3 shrink-0 fill-amber-500 text-status-warning" />
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
              className="text-xs font-semibold flex-1 min-w-0 px-1 py-0.5 rounded bg-surface1 text-foreground border border-primary"
            />
          ) : (
            <Hint
              label={
                hoverPreview
                  ? `${smartTitle} — ${hoverPreview}`
                  : `${smartTitle} · double-click to rename`
              }
            >
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onStartEdit(session.sessionId, smartTitle);
                }}
                className={cn(
                  'text-xs flex-1 min-w-0 truncate tracking-tight',
                  isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'
                )}
              >
                {isSearching ? highlightMatch(smartTitle, searchQuery) : smartTitle}
              </span>
            </Hint>
          )}
          {/*
            3. FOUR CHARACTERS, NOT ELEVEN.

            "2 weeks ago" on every row said what the date band directly above
            the row had already said, and took 30-40% of the width to say it —
            which is why the titles beside it were being cut to a dozen
            characters. `formatRowTime` narrows as the band widens: the clock
            today, the weekday this week, a date beyond that. The width goes
            back to the title, which is the part that identifies the thread.
          */}
          <span className="text-2xs text-foreground-extra-muted shrink-0 tabular-nums">
            {displayTime}
          </span>
        </div>
      </div>

      {/* Hover actions */}
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
}

interface VirtualSessionItem {
  type: 'session';
  key: string;
  session: WorkspaceSession;
}

/**
 * A date band inside a project group — "Today", "Previous 7 Days".
 *
 * WHY THE LIST NEEDED ONE. Every row already printed its own relative time, so
 * a folder holding twenty threads printed "5 days ago" nine times in a column
 * down the right edge: twenty timestamps to answer one question, and no shape
 * to the list at all. A band answers it once for the whole run beneath it, and
 * it is what turns a flat stack of titles into "here is today, here is the
 * week, here is everything older" — the thing that makes a long chat list
 * scannable in every application that has one.
 */
interface VirtualDateHeaderItem {
  type: 'datehead';
  key: string;
  label: string;
}

type VirtualListItem = VirtualGroupHeaderItem | VirtualSessionItem | VirtualDateHeaderItem;

/** Which band a timestamp falls into. Boundaries are calendar days, not
 *  rolling 24h windows: something from 11pm last night is "Yesterday", not
 *  "Today", which is how a person reading the list thinks about it. */
function dateBandFor(ms: number, now: number): string {
  if (!ms) return 'Older';
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayStart = startOfToday.getTime();
  if (ms >= dayStart) return 'Today';
  if (ms >= dayStart - 86_400_000) return 'Yesterday';
  if (ms >= dayStart - 7 * 86_400_000) return 'Previous 7 Days';
  if (ms >= dayStart - 30 * 86_400_000) return 'Previous 30 Days';
  return 'Older';
}

export function ThreadList() {
  const { loading, sessions, currentSessionId, setCurrentSessionId, agents, lastMessageBySession, activeSessionIds, completedSessionIds, updateSession, renameSession, dmConversations, createSession, userSentMessageTimestamps, recordUserMessageSent, todos } = useWorkspace();
  const { sidebarToggle, isMobile, openMobileDetail, setViewMode, viewMode } = useLayout();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

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
      items.push({
        type: 'header',
        key: `header-${groupKey}`,
        dir: group.dir,
        count: group.sessions.length,
      });
      /*
        Sessions arrive already sorted newest-first, so the band only has to
        change when the run does — no second pass, no re-sort, and the bands
        come out in order for free.

        A band is NOT emitted while searching: results are ranked by relevance
        and chopping them into date buckets would imply an ordering the list
        does not have.
      */
      let band: string | null = null;
      for (const s of group.sessions) {
        if (!isSearching) {
          const next = dateBandFor(getSessionTime(s), now);
          if (next !== band) {
            band = next;
            items.push({
              type: 'datehead',
              key: `band-${groupKey}-${next}`,
              label: next,
            });
          }
        }
        items.push({
          type: 'session',
          key: s.sessionId,
          session: s,
        });
      }
    }
    return items;
    // `now` is captured once per rebuild rather than read inside the loop, so
    // every row in one pass is bucketed against the same instant — otherwise a
    // list rebuilt across midnight can put two adjacent threads in bands that
    // disagree.
  }, [groupedSessions, pinnedSessions, isSearching, getSessionTime, now]);

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

  const rowVirtualizer = useVirtualizer({
    count: virtualListItems.length,
    getScrollElement: () => listContainerRef.current,
    estimateSize: (index) => {
      const item = virtualListItems[index];
      /*
        Every row is one line now, so this is no longer a hedge between two
        possible heights — it is the actual height, and `measureElement` has
        nothing left to correct. 44 was the midpoint of a range that no longer
        exists; 36 is a single line at `py-2`.
      */
      if (item?.type === 'header') return 34;
      if (item?.type === 'datehead') return 26;
      return 36;
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

      {/* Top Action & Navigation Block */}
      <div className="px-3.5 pt-2.5 pb-1 shrink-0 select-none">
        {/* + New Conversation Primary Button */}
        <button
          onClick={() => {
            setViewMode('threads');
            startChannel(null);
          }}
          /*
            A row, not a filled pill.

            This was `bg-primary` — in dark mode a near-white block spanning the
            full sidebar width, which made the single loudest element on screen
            a button you press once per conversation. It also sat one idiom
            apart from the three navigation rows directly beneath it while
            being the same shape and size, so the group read as "one CTA plus
            some links" rather than a nav list. It is now the same row as its
            neighbours, distinguished by weight and a filled icon rather than by
            inverting the palette.
          */
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-semibold text-foreground hover:bg-surface2 transition-colors group"
        >
          <div className="flex items-center gap-2">
            <Plus className="size-3.5 text-primary" />
            <span>New chat</span>
          </div>
          <kbd className="inline-flex items-center px-1.5 py-0.2 text-3xs font-mono rounded bg-surface3 text-foreground-extra-muted opacity-0 group-hover:opacity-100 transition-opacity motion-reduce:transition-none">
            C
          </kbd>
        </button>

        {/*
          COMMANDS AND DESTINATIONS ARE NOT THE SAME KIND OF ROW.

          `New chat` above and `Command Palette` below DO something; the two in
          between GO somewhere. One undifferentiated column of four is why only
          half the rows carried a shortcut badge and the right edge came out
          ragged — the badge was quietly marking which rows were commands. The
          grouping is spacing, not a rule: this sidebar already has enough
          horizontal lines in it.
        */}
        <div className="mt-1.5 flex flex-col gap-0.5">
          {/* Chats & Threads */}
          <button
            type="button"
            onClick={() => setViewMode('threads')}
            className={cn(
              'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              viewMode === 'threads'
                ? 'bg-surface2 text-foreground font-semibold'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
            )}
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="size-3.5 text-foreground-extra-muted" />
              <span>Chats & Threads</span>
            </div>
          </button>

          {/* Tasks & Issues (Linear Style!) */}
          <button
            type="button"
            onClick={() => setViewMode('tasks')}
            className={cn(
              'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              viewMode === 'tasks'
                ? 'bg-surface2 text-foreground font-semibold'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
            )}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-3.5 text-foreground-extra-muted" />
              <span>Tasks & Issues</span>
            </div>
            {todos && todos.length > 0 && (
              <span className="text-3xs px-1.5 py-0.2 rounded-full bg-status-success/10 text-status-success font-medium">
                {todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length || todos.length}
              </span>
            )}
          </button>

        </div>

        {/*
          THE COMMAND PALETTE ROW IS GONE, AND SEARCH TOOK ITS PLACE.

          It sat in a column of destinations while being a command — it opened
          an overlay, it did not go anywhere — and it was the third way into a
          palette that already answers Ctrl+K everywhere in the app and now has
          a File-menu item in the desktop shell too. A row whose entire content
          is the name of a keystroke earns its place only while nothing else
          teaches that keystroke.

          What the column was actually missing is the thing every chat sidebar
          has second from the top: a search box that is simply there. This list
          reaches twenty-plus threads, and its filter was behind `/` or a
          magnifier icon inside the Projects header — an entrance you had to
          already know about. It is now permanent (see below), which is both
          the ChatGPT-desktop arrangement and the reason the palette row is no
          longer carrying a job it was bad at.
        */}
      </div>

      {/*
        5. THE HEADER IS SIX CONTROLS DEEP BEFORE THE FIRST CONVERSATION.

        Every band up here had its own generous padding, and stacked they
        pushed the list — the thing this sidebar is for — a third of the way
        down the window. The rows are unchanged; only the air between them is,
        which is the cheapest third of the problem and the one that does not
        require deciding what the header should contain.
      */}
      <div className="px-3 pt-1.5 pb-0.5 shrink-0">
        <AgentStatusStrip />
      </div>

      {/* Projects Section Header & Create Dropdown (Antigravity 2.0 style) */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1 shrink-0 select-none">
        {/*
          THE SAME LABEL TREATMENT AS THE GROUPS ABOVE IT.

          This was the only `uppercase tracking-wider` label in the sidebar,
          sitting at the same level as "Chats & Threads", which is sentence
          case at normal tracking. Two heading systems in one column is what
          made this sidebar look cut into zones -- not rules, of which there
          are none between these groups, but type. Uppercase plus letter
          spacing is the machine-console idiom; it was removed from the Mission
          Control section headings for the same reason.
        */}
        <span className="text-xs font-semibold text-foreground">
          Projects
        </span>

        <div className="flex items-center gap-1">
          {/* Quick Search Toggle */}
          <Hint label="Search threads (/)">
            <button
              onClick={() => {
                setShowSearch((prev) => {
                  const next = !prev;
                  if (next) setTimeout(() => searchInputRef.current?.focus(), 10);
                  return next;
                });
              }}
              className={cn(
                "p-1 rounded-md hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors",
                (showSearch || searchQuery) && "bg-surface2 text-foreground"
              )}
            >
              <Search className="size-3.5" />
            </button>
          </Hint>

          {/* New Project / Quick Start Dropdown Menu (Image 2) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Hint label="New Project / Quick Start">
                <button
                  disabled={browsingFolder}
                  className="p-1 rounded-md hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {browsingFolder ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
                </button>
              </Hint>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 p-1">
            <DropdownMenuItem onClick={addProjectFolder} className="gap-2.5 py-2 px-2.5 text-xs rounded-lg">
                <FolderPlus className="size-4 text-foreground-muted shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">New Project</span>
                  <span className="text-3xs text-muted-foreground">Select a folder</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startChannel(null)} className="gap-2.5 py-2 px-2.5 text-xs rounded-lg">
                <MessageSquarePlus className="size-4 text-foreground-muted shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">Quick Start</span>
                  <span className="text-3xs text-muted-foreground">Direct conversation</span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/*
        ALWAYS RENDERED, not revealed. `/` and Ctrl+F still focus it; they no
        longer have to conjure it first, and a user who knows neither key can
        still see that this list can be searched.
      */}
      <div className="px-3 pb-2 pt-0.5 shrink-0">
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
              /* `autoFocus` came off with the conditional rendering. It was
                 correct while the bar only existed once you asked for it; on a
                 box that is always present it means the sidebar takes the caret
                 away from the message composer on every single mount. */
            />
            {/* Only while there is something to clear — an X sitting in an
                empty box is a control for a state that does not exist. */}
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
                  {item.type === 'datehead' ? (
                    <div className="px-2 pt-2 pb-0.5 select-none">
                      <span className="text-3xs font-medium uppercase tracking-wide text-foreground-extra-muted">
                        {item.label}
                      </span>
                    </div>
                  ) : item.type === 'header' ? (
                    <div className="flex items-center gap-1.5 px-2 pt-2.5 pb-1 select-none">
                      {item.pinned ? (
                        <Star className="size-3.5 shrink-0 fill-status-warning text-status-warning" />
                      ) : (
                        <FolderOpen className="size-3.5 shrink-0 text-foreground-extra-muted" />
                      )}
                      <Hint label={item.pinned ? 'Starred threads, from every project' : (item.dir ?? 'Direct chats')}>
                        <span
                          className="text-sm font-semibold text-foreground truncate"
                        >
                          {item.pinned ? 'Pinned' : item.dir ? basename(item.dir) : 'Direct chats'}
                        </span>
                      </Hint>
                      <span className="text-2xs font-mono tabular-nums text-foreground-extra-muted shrink-0">
                        {item.count}
                      </span>
                      <Hint label={item.dir ? `New channel in ${item.dir}` : 'New direct chat'}>
                        <button
                          onClick={() => startChannel(item.dir)}
                          className="ml-auto size-5 flex items-center justify-center rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors shrink-0"
                        >
                          <Plus className="size-3" />
                        </button>
                      </Hint>
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
                      setEditTitleValue={setEditTitleValue}
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
                        <div className="shrink-0">
                          <AvatarStack agents={
                            agents.filter((a) => session.participants.includes(a.agentName))
                          } />
                        </div>
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs flex-1 min-w-0 truncate font-normal text-foreground">
                              {getSmartSessionTitle(session, lastMsg)}
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
                            >
                              <ArchiveRestore className="size-4" />
                              <span>Unarchive</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSession(session.sessionId, session.title || 'Untitled conversation');
                              }}
                            >
                              <Trash2 className="size-4" />
                              <span>Delete</span>
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
