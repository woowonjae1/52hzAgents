'use client';

import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import { PanelLeft, Pencil, RefreshCw, Search, Star, Archive, Trash2, MoreVertical, ArchiveRestore, Wrench, Loader2, CheckCircle2, MessageCircle, MessageSquare, Plus, FolderPlus, FolderOpen, MessageSquarePlus, History as HistoryIcon, CalendarClock, BookOpen, Sparkles } from 'lucide-react';
import { browseForFolder, basename } from '@/components/chat/project-folder-picker';
import { cn } from '@/lib/utils';
import { useWorkspace, type LastMessageInfo } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { timeAgo } from '@/lib/helpers';
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
import { stripAddressPrefix } from '@/lib/types';

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
      <mark className="bg-yellow-200 dark:bg-yellow-800 text-foreground rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
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
    <div className="mt-3 pt-3 border-t border-border">
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
                  'w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors cursor-pointer relative',
                  isSelected
                    ? 'bg-white dark:bg-surface2 text-foreground font-medium border border-black/10 dark:border-white/10 shadow-xs before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-primary'
                    : 'border border-transparent hover:bg-surface2/60 text-foreground-muted hover:text-foreground'
                )}
              >
                <div className="shrink-0 flex items-center justify-center border border-border rounded-full size-[30px] bg-card">
                  <MessageCircle className="size-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm flex-1 min-w-0 truncate font-normal text-foreground">
                      {agentA} ↔ {agentB}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{displayTime}</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{preview}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getSmartSessionTitle(session: WorkspaceSession, lastMsg?: LastMessageInfo | null): string {
  const rawTitle = (session.title || '').trim();
  const isGeneric =
    !rawTitle ||
    rawTitle === '新频道' ||
    rawTitle === 'New Channel' ||
    rawTitle === 'Untitled Channel' ||
    rawTitle === 'Untitled' ||
    rawTitle === 'New Chat';

  if (!isGeneric) {
    return rawTitle;
  }

  if (lastMsg && lastMsg.content) {
    const trimmed = lastMsg.content.trim();
    const isStatusOrThinking =
      lastMsg.isStatus ||
      /^thinking(\.{0,3})?$/i.test(trimmed) ||
      /^<think/i.test(trimmed) ||
      /^Using tool/i.test(trimmed) ||
      /^sse-probe/i.test(trimmed);

    if (!isStatusOrThinking) {
      let clean = trimmed
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_#~>]/g, '')
        .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean && !/^thinking(\.{0,3})?$/i.test(clean)) {
        if (clean.length > 24) {
          clean = clean.slice(0, 24).trim() + '...';
        }
        return clean;
      }
    }
  }

  if (session.workingDir) {
    const parts = session.workingDir.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  return 'New Chat';
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
  const displayTime = activityMs
    ? timeAgo(new Date(activityMs).toISOString())
    : session.createdAt ? timeAgo(session.createdAt) : '';

  const lastSpeaker: WorkspaceAgent | 'you' | null = !lastMsg
    ? null
    : lastMsg.senderName === 'user'
      ? 'you'
      : agents.find((a) => a.agentName === lastMsg.senderName) ?? null;

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

  const smartTitle = getSmartSessionTitle(session, lastMsg);

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
  const showPreview = !previewRestatesTitle;

  return (
    <div
      onClick={() => {
        if (isEditing) return;
        onSelect(session.sessionId);
      }}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-colors relative group cursor-pointer select-none',
        isSelected
          ? 'bg-white dark:bg-surface2 text-foreground font-medium border border-black/10 dark:border-white/10 shadow-xs before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-primary'
          : 'border border-transparent hover:bg-surface2/60 text-foreground-muted hover:text-foreground',
        'has-data-[state=open]:bg-surface2/60',
        isActive && 'thread-wip',
        isCompleted && !isSelected && 'bg-surface2/50 border border-border/60'
      )}
    >
      <div className="shrink-0 self-start pt-0.5 size-[18px]">
        {lastSpeaker === 'you' ? (
          <SignalMark size={18} still />
        ) : lastSpeaker ? (
          <AgentAvatar
            name={lastSpeaker.agentName}
            agentType={lastSpeaker.agentType}
            size={18}
          />
        ) : null}
      </div>

      {/* No `space-y-1` here any more: the gap belongs to the preview line,
          which is now conditional, and a `space-y` that only ever applies to
          one optional child is a rule looking for a sibling. */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1.5">
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
              className="text-xs font-semibold flex-1 min-w-0 px-1 py-0.5 rounded bg-surface1 text-foreground border border-primary outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation();
                onStartEdit(session.sessionId, smartTitle);
              }}
              className={cn(
                'text-xs flex-1 min-w-0 truncate tracking-tight',
                isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'
              )}
              title="Double-click to rename"
            >
              {isSearching ? highlightMatch(smartTitle, searchQuery) : smartTitle}
            </span>
          )}
          {/* `font-sans`, not `font-mono tabular-nums`: this is "5 hours ago",
              not a column of figures. Monospacing prose sets it in a second
              typeface for no alignment benefit, and at 10px the mono face is
              the widest thing in a row that is fighting for width. */}
          <span className="text-3xs text-foreground-extra-muted shrink-0">
            {displayTime}
          </span>
        </div>
        {showPreview && (
          <p className={cn(
            'text-3xs truncate leading-relaxed font-sans mt-1',
            isSelected ? 'text-foreground/70' : 'text-foreground-muted',
            previewIsStatus && 'italic text-foreground-muted'
          )}>
            {preview}
          </p>
        )}
      </div>

      {/* Hover actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity p-1 rounded hover:bg-surface3 dark:hover:bg-primary shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="size-3.5 text-muted-foreground" />
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
    prev.editTitleValue === next.editTitleValue &&
    prev.agents === next.agents
  );
});

interface VirtualGroupHeaderItem {
  type: 'header';
  key: string;
  dir: string | null;
  count: number;
}

interface VirtualSessionItem {
  type: 'session';
  key: string;
  session: WorkspaceSession;
}

type VirtualListItem = VirtualGroupHeaderItem | VirtualSessionItem;

export function ThreadList() {
  const { sessions, currentSessionId, setCurrentSessionId, agents, lastMessageBySession, activeSessionIds, completedSessionIds, updateSession, renameSession, dmConversations, createSession, userSentMessageTimestamps, recordUserMessageSent, todos } = useWorkspace();
  const { sidebarToggle, isMobile, openMobileDetail, setViewMode, viewMode } = useLayout();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
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

  const handleUpdateStatus = useCallback((sessionId: string, status: 'active' | 'archived' | 'deleted') => {
    updateSession(sessionId, { status });
  }, [updateSession]);

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
  const pinnedSessions = activeSessions.filter((s) => s.starred);
  const unpinnedSessions = activeSessions.filter((s) => !s.starred);
  const onlineAgentCount = agents.filter((a) => a.status === 'online').length;

  const filteredSessions = isSearching
    ? sortedSessions.filter((s) =>
        s.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        hitsByChannel.has(s.sessionId)
      )
    : activeSessions;

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

  // Flatten grouped sessions into list items for TanStack Virtual
  const virtualListItems = useMemo<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = [];
    for (const group of groupedSessions) {
      const groupKey = group.dir ?? '__no_folder__';
      items.push({
        type: 'header',
        key: `header-${groupKey}`,
        dir: group.dir,
        count: group.sessions.length,
      });
      for (const s of group.sessions) {
        items.push({
          type: 'session',
          key: s.sessionId,
          session: s,
        });
      }
    }
    return items;
  }, [groupedSessions]);

  const listContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: virtualListItems.length,
    getScrollElement: () => listContainerRef.current,
    estimateSize: (index) => {
      const item = virtualListItems[index];
      // 52 assumed every row carried a preview line. Most no longer do (see
      // `previewRestatesTitle` in ThreadRow), so the estimate sat ~18px over
      // the common case and the scrollbar was wrong until `measureElement`
      // caught up. 44 is between a one-line and a two-line row.
      return item?.type === 'header' ? 34 : 44;
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
  //   1-9  → open the Nth visible thread (mirrors monitor mode's 1-6)
  //   i    → focus the chat input of the current thread
  //   Esc  → handled inside chat-input (blurs the textarea)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack typing in any input/textarea, and skip when modifier
      // keys are held (so Cmd+1 / Ctrl+R / etc. still reach the browser).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (target?.isContentEditable) return;

      // 1-9 → open thread by index (uses the same list the user is looking at).
      // Pass skipFocus so the chat input doesn't steal focus — the user is
      // navigating with the keyboard and presses 'i' explicitly to type.
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

      // Any single printable character → focus the chat input and let the
      // keystroke pass through so the character appears in the textarea.
      // Only fires when a thread is open.
      if (e.key.length === 1 && currentSessionId) {
        const el = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input]');
        if (el) {
          el.focus();
          // Don't preventDefault — let the character be typed into the textarea
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visualOrder, currentSessionId, isMobile, setCurrentSessionId, openMobileDetail]);

  return (
    <div className="flex flex-col h-full">


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
          <kbd className="inline-flex items-center px-1.5 py-0.2 text-3xs font-mono rounded bg-surface3 text-foreground-extra-muted border border-border/50">
            Ctrl+N
          </kbd>
        </button>

        {/* Workspace Quick Navigation Items (Linear / Circle Style) */}
        <div className="flex flex-col gap-0.5">
          {/* Chats & Threads */}
          <button
            type="button"
            onClick={() => setViewMode('threads')}
            className={cn(
              'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
              viewMode === 'threads'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
            )}
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="size-3.5 text-primary" />
              <span>Chats & Threads</span>
            </div>
          </button>

          {/* Tasks & Issues (Linear Style!) */}
          <button
            type="button"
            onClick={() => setViewMode('tasks')}
            className={cn(
              'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
              viewMode === 'tasks'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
            )}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>Tasks & Issues</span>
            </div>
            {todos && todos.length > 0 && (
              <span className="text-3xs font-mono px-1.5 py-0.2 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                {todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length || todos.length}
              </span>
            )}
          </button>

          {/* Command Palette (Ctrl+K) Trigger Button */}
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
            }}
            className="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-surface2/60 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Search className="size-3.5 text-foreground-extra-muted" />
              <span>Command Palette</span>
            </div>
            <kbd className="inline-flex items-center px-1.5 py-0.2 text-3xs font-mono rounded bg-surface3 text-foreground-extra-muted border border-border/50">
              Ctrl+K
            </kbd>
          </button>
        </div>
      </div>

      {/* Agent presence — one strip, not a roster. See AgentStatusStrip. */}
      <div className="px-3 pt-2.5 pb-1 shrink-0">
        <AgentStatusStrip />
      </div>

      {/* Projects Section Header & Create Dropdown (Antigravity 2.0 style) */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1 shrink-0 select-none">
        <span className="text-2xs font-semibold text-foreground-extra-muted uppercase tracking-wider">
          Projects
        </span>

        <div className="flex items-center gap-1">
          {/* New Project / Quick Start Dropdown Menu (Image 2) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={browsingFolder}
                className="p-1 rounded-md hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
                title="New Project / Quick Start"
              >
                {browsingFolder ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 p-1">
              <DropdownMenuItem onClick={addProjectFolder} className="gap-2.5 py-2 px-2.5 text-xs cursor-pointer rounded-lg">
                <FolderPlus className="size-4 text-foreground-muted shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-foreground">New Project</span>
                  <span className="text-3xs text-muted-foreground">Select a folder</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startChannel(null)} className="gap-2.5 py-2 px-2.5 text-xs cursor-pointer rounded-lg">
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

      {/* Thread rows grouped by Project (TanStack Virtualized) */}
      <div
        ref={listContainerRef}
        className="flex-1 overflow-y-auto px-2 py-1 overscroll-contain transform-gpu [contain:content]"
      >
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
                  {item.type === 'header' ? (
                    <div className="flex items-center gap-1.5 px-2 pt-2.5 pb-1 select-none">
                      <FolderOpen className="size-3.5 shrink-0 text-foreground-extra-muted" />
                      <span
                        className="text-sm font-semibold text-foreground truncate"
                        title={item.dir ?? 'Direct chats'}
                      >
                        {item.dir ? basename(item.dir) : 'Direct chats'}
                      </span>
                      <span className="text-2xs font-mono tabular-nums text-foreground-extra-muted shrink-0">
                        {item.count}
                      </span>
                      <button
                        onClick={() => startChannel(item.dir)}
                        title={item.dir ? `New channel in ${item.dir}` : 'New direct chat'}
                        className="ml-auto size-5 flex items-center justify-center rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors shrink-0 cursor-pointer"
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
                    className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer"
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
            <div className="mt-3 pt-3 border-t border-border">
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
                          'w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors relative group cursor-pointer',
                          isSelected
                            ? 'bg-white dark:bg-surface2 text-foreground font-medium border border-black/10 dark:border-white/10 shadow-xs before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-primary'
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
                            <span className="text-sm flex-1 min-w-0 truncate font-normal text-foreground">
                              {getSmartSessionTitle(session, lastMsg)}
                            </span>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {displayTime}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {preview}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity p-1 rounded hover:bg-surface3 dark:hover:bg-primary shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="size-3.5 text-muted-foreground" />
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
                                updateSession(session.sessionId, { status: 'deleted' });
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
