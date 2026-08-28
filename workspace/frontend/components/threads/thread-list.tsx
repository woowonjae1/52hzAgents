'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { PanelLeft, Pencil, RefreshCw, Search, Star, Archive, Trash2, MoreVertical, ArchiveRestore, Wrench, Loader2, CheckCircle2, MessageCircle, MessageSquare, Plus, FolderPlus, FolderOpen, MessageSquarePlus, History as HistoryIcon, CalendarClock, BookOpen, Sparkles } from 'lucide-react';
import { browseForFolder, basename } from '@/components/chat/project-folder-picker';
import { cn } from '@/lib/utils';
import { useWorkspace, type LastMessageInfo } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
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

function AvatarStack({ agents, max = 2 }: { agents: WorkspaceAgent[]; max?: number }) {
  const shown = agents.slice(0, max);
  const extra = agents.length - max;

  if (shown.length <= 1) {
    const agent = shown[0];
    if (!agent) return null;
    return <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={30} />;
  }

  return (
    <div className="flex -space-x-1.5">
      {shown.map((agent) => (
        <div key={agent.agentName} className="ring-2 ring-white rounded-full">
          <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={18} />
        </div>
      ))}
      {extra > 0 && (
        <div className="h-[18px] min-w-[18px] px-0.5 rounded-full bg-surface3 flex items-center justify-center text-[9px] font-mono font-medium tracking-tighter text-foreground-muted ring-2 ring-surface0 leading-none select-none">
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
            const agentA = agent0.replace(/^openagents:/, '');
            const agentB = agent1.replace(/^openagents:/, '');
            const sender = (convo.lastMessage?.sender || '').replace(/^openagents:/, '');
            const preview = `${sender}: ${convo.lastMessage?.content || ''}`;
            const displayTime = convo.lastMessage?.timestamp
              ? timeAgo(new Date(convo.lastMessage.timestamp).toISOString())
              : '';

            return (
              <div
                key={dmId}
                onClick={() => onSelect(dmId)}
                className={cn(
                  'w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors cursor-pointer',
                  isSelected ? 'bg-surface2 ring-2 ring-border-accent' : 'hover:bg-surface1 dark:hover:bg-primary/50'
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
    let clean = lastMsg.content
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_#~>]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean) {
      if (clean.length > 24) {
        clean = clean.slice(0, 24).trim() + '...';
      }
      return clean;
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

export function ThreadList() {
  const { sessions, currentSessionId, setCurrentSessionId, agents, lastMessageBySession, activeSessionIds, completedSessionIds, updateSession, renameSession, dmConversations, createSession, userSentMessageTimestamps, recordUserMessageSent } = useWorkspace();
  const { sidebarToggle, isMobile, openMobileDetail, setViewMode, viewMode } = useLayout();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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
      <div className="px-3.5 pt-2.5 pb-2 shrink-0 space-y-3 select-none">
        {/* + New Conversation Primary Button */}
        <button
          onClick={() => startChannel(null)}
          className="w-full flex items-center justify-between py-2.5 px-3.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.99] transition-all cursor-pointer shadow-xs group font-medium text-xs"
        >
          <div className="flex items-center gap-2">
            <Plus className="size-4 group-hover:rotate-90 transition-transform duration-200" />
            <span className="font-semibold">New chat</span>
          </div>
          <kbd className="inline-flex items-center px-1.5 py-0.5 text-3xs font-mono rounded bg-primary-foreground/15 text-primary-foreground font-medium">
            Ctrl+N
          </kbd>
        </button>

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

      {/* Thread rows grouped by Project */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="space-y-1">
          {groupedSessions.map((group) => (
          <div key={group.dir ?? '__no_folder__'} className="mb-2">
            <div className="flex items-center gap-1.5 px-2 mt-1 mb-1">
              <FolderOpen className="size-3.5 shrink-0 text-foreground-extra-muted" />
              <span
                className="text-sm font-semibold text-foreground truncate"
                title={group.dir ?? 'Direct chats'}
              >
                {group.dir ? basename(group.dir) : 'Direct chats'}
              </span>
              <span className="text-2xs font-mono tabular-nums text-foreground-extra-muted shrink-0">
                {group.sessions.length}
              </span>
              <button
                onClick={() => startChannel(group.dir)}
                title={group.dir ? `New channel in ${group.dir}` : 'New direct chat'}
                className="ml-auto size-5 flex items-center justify-center rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors shrink-0 cursor-pointer"
              >
                <Plus className="size-3" />
              </button>
            </div>
          {group.sessions.map((session) => {
            const idx = orderIndex.get(session.sessionId) ?? 0;
            const isSelected = session.sessionId === currentSessionId;
            const lastMsg = lastMessageBySession[session.sessionId];
            const isActive = activeSessionIds.has(session.sessionId);
            const isCompleted = completedSessionIds.has(session.sessionId) && !isActive;
            const contentHit = hitsByChannel.get(session.sessionId);
            // Numeric shortcut hint for the first 9 active threads. Hidden
            // while searching because the rendered list reorders and the
            // 1-9 handler operates on activeSessions, not search results.
            const shortcutKey = !isSearching && idx < 9 ? idx + 1 : null;

            // Show last activity time from backend
            const activityMs = session.lastEventAt;
            const displayTime = activityMs
              ? timeAgo(new Date(activityMs).toISOString())
              : session.createdAt ? timeAgo(session.createdAt) : '';

            // Determine the preview line
            let preview: React.ReactNode;
            let previewIsStatus = false;
            if (isSearching && contentHit) {
              // Show matching snippet with highlight
              const snippet = contentHit.snippet.length > 80
                ? contentHit.snippet.slice(0, 80) + '...'
                : contentHit.snippet;
              preview = highlightMatch(snippet, searchQuery);
            } else if (lastMsg && lastMsg.content) {
              const sender = lastMsg.senderName === 'user' ? 'You' : lastMsg.senderName;
              if (lastMsg.isStatus) {
                previewIsStatus = true;
                // Parse "Using tool: <tool_name>" pattern from status messages
                const toolMatch = lastMsg.content.match(/Using tool:?\**\s*`?([^`\n]+)`?/i);
                if (toolMatch) {
                  // Clean MCP prefix: mcp__openagents-workspace__foo → foo, mcp__playwright__bar → bar
                  const rawTool = toolMatch[1].trim();
                  const cleanTool = rawTool.replace(/^mcp__[^_]+__/, '');
                  preview = (
                    <span className="flex items-center gap-1">
                      {sender}: <Wrench className="size-3 shrink-0" /> {cleanTool}
                    </span>
                  );
                } else if (lastMsg.content.includes('thinking')) {
                  preview = (
                    <span className="flex items-center gap-1">
                      {sender}: <Loader2 className="size-3 shrink-0 animate-spin" /> thinking...
                    </span>
                  );
                } else {
                  // Other status messages — strip markdown
                  const cleaned = lastMsg.content
                    .replace(/\*\*/g, '')
                    .replace(/`/g, '')
                    .replace(/```[\s\S]*/g, '')
                    .trim();
                  preview = `${sender}: ${cleaned}`;
                }
              } else {
                preview = `${sender}: ${lastMsg.content}`;
              }
            } else {
              preview = 'No messages yet';
            }

            const smartTitle = getSmartSessionTitle(session, lastMsg);
            const isEditing = editingSessionId === session.sessionId;

            return (
              <div
                key={session.sessionId}
                onClick={() => {
                  if (isEditing) return;
                  setCurrentSessionId(session.sessionId);
                  setViewMode('threads');
                  if (isMobile) openMobileDetail();
                }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all relative group cursor-pointer select-none',
                  isSelected
                    ? 'bg-surface2/90 dark:bg-surface2/80 text-foreground border border-border/80 dark:border-white/[0.1] shadow-xs before:absolute before:left-0 before:top-2.5 before:bottom-2.5 before:w-1 before:rounded-r-full before:bg-surface2'
                    : 'border border-transparent hover:bg-surface2/40 text-foreground-muted hover:text-foreground',
                  'has-data-[state=open]:bg-surface2/40',
                  isActive && 'thread-wip',
                  isCompleted && !isSelected && 'bg-surface2/50 border border-border/60'
                )}
              >
                {/* Content */}
                <div className="flex-1 min-w-0 space-y-1">
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
                            if (trimmed) renameSession(session.sessionId, trimmed);
                            setEditingSessionId(null);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingSessionId(null);
                          }
                        }}
                        onBlur={() => {
                          const trimmed = editTitleValue.trim();
                          if (trimmed) renameSession(session.sessionId, trimmed);
                          setEditingSessionId(null);
                        }}
                        className="text-xs font-semibold flex-1 min-w-0 px-1 py-0.5 rounded bg-surface1 text-foreground border border-primary outline-none"
                      />
                    ) : (
                      <span
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingSessionId(session.sessionId);
                          setEditTitleValue(smartTitle);
                        }}
                        className="text-xs font-semibold flex-1 min-w-0 truncate text-foreground tracking-tight"
                        title="Double-click to rename"
                      >
                        {isSearching ? highlightMatch(smartTitle, searchQuery) : smartTitle}
                      </span>
                    )}
                    <span className="text-3xs text-foreground-extra-muted shrink-0 font-mono tabular-nums">
                      {displayTime}
                    </span>
                  </div>
                  <p className={cn(
                    'text-3xs text-foreground-muted truncate leading-relaxed font-sans',
                    previewIsStatus && 'italic text-foreground-muted'
                  )}>
                    {preview}
                  </p>
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
                        setEditingSessionId(session.sessionId);
                        setEditTitleValue(smartTitle);
                      }}
                    >
                      <Pencil className="size-4" />
                      <span>Rename</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        updateSession(session.sessionId, { starred: !session.starred });
                      }}
                    >
                      <Star className={cn('size-4', session.starred && 'fill-status-warning text-status-warning')} />
                      <span>{session.starred ? 'Unstar' : 'Star'}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        updateSession(session.sessionId, { status: session.status === 'archived' ? 'active' : 'archived' });
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
          ))}

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
                const name = addr.replace(/^openagents:/, '');
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
                    const preview = lastMsg && lastMsg.content
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
                          isSelected ? 'bg-surface2 ring-2 ring-border-accent' : 'hover:bg-surface1 dark:hover:bg-primary/50',
                          'has-data-[state=open]:bg-surface1 dark:has-data-[state=open]:bg-primary/50'
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
