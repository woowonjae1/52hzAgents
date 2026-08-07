'use client';

import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { ChatMessages } from './chat-messages';
import { ChatInput, type PendingFile } from './chat-input';
import { ThreadStatusBar } from './thread-status-bar';
import { StatusLine } from './status-line';
import { EmptyState } from './empty-state';
import { useWorkspace } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { useComposingSignal } from '@/hooks/use-composing-signal';
import { workspaceApi } from '@/lib/api';
import { capture } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ListTree, MessageSquare, MessageSquarePlus, CalendarClock, Square, ChevronLeft, X, Plus, Globe, Share2, Crown, AlertTriangle, Sparkles, Users, FileText, PanelLeft, Terminal, FolderOpen } from 'lucide-react';
import { ShareDialog } from './share-dialog';
import { OrchestrationControl } from './orchestration-control';
import { useLayout } from '@/components/layout/layout-context';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { CreateRoutineDialog } from '@/components/routines/create-routine-dialog';
import { eventToMessage } from '@/lib/types'; 
import type { WorkspaceMessage } from '@/lib/types';

// Module-level message cache — survives component re-renders/unmounts.
// Keyed by sessionId, stores the last known messages for instant thread switching.
const messageCache = new Map<string, WorkspaceMessage[]>();
const CACHE_MAX_SESSIONS = 10;
// Track last seen message ID per cached session for incremental refresh
const cacheLastSeenId = new Map<string, string>();

function parseDMSession(sessionId: string | null): [string, string] | null {
  if (!sessionId?.startsWith('dm:')) return null;
  const parts = sessionId.slice(3).split(',', 2);
  if (parts.length === 2) return [parts[0], parts[1]];
  return null;
}

function normalizeAgentAddress(address: string): string {
  return address.replace(/^openagents:/, '');
}

/** Condense an agent description down to a few words for the roster bar. */
function shortDescription(desc: string | null, maxWords = 8): string {
  if (!desc) return '';
  const clean = desc.trim().replace(/\s+/g, ' ');
  const words = clean.split(' ');
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(' ') + '…';
}

function messagesForSession(sessionId: string, msgs: WorkspaceMessage[]): WorkspaceMessage[] {
  const dmPair = parseDMSession(sessionId);
  return msgs.flatMap((msg) => {
    const belongsToSession = dmPair
      ? msg.sessionId === sessionId ||
        dmPair.includes(msg.sessionId) ||
        dmPair.map(normalizeAgentAddress).includes(normalizeAgentAddress(msg.sessionId))
      : msg.sessionId === sessionId;
    if (!belongsToSession) return [];
    return dmPair ? [{ ...msg, sessionId }] : [msg];
  });
}

function cacheMessages(sessionId: string, msgs: WorkspaceMessage[]) {
  const scopedMessages = messagesForSession(sessionId, msgs);
  messageCache.set(sessionId, scopedMessages);
  if (scopedMessages.length > 0) {
    cacheLastSeenId.set(sessionId, scopedMessages[scopedMessages.length - 1].messageId);
  } else {
    cacheLastSeenId.delete(sessionId);
  }
  // Evict oldest entries if cache grows too large
  if (messageCache.size > CACHE_MAX_SESSIONS) {
    const oldest = messageCache.keys().next().value;
    if (oldest) {
      messageCache.delete(oldest);
      cacheLastSeenId.delete(oldest);
    }
  }
}

const PREFETCH_COUNT = 6;
const CACHE_REFRESH_INTERVAL = 5_000; // refresh caches every 5s

/** Fetch recent messages for a session (cache prefetch). */
async function fetchSessionMessages(sessionId: string): Promise<WorkspaceMessage[]> {
  try {
    const result = await workspaceApi.loadMessageHistory(sessionId, { limit: 50 });
    // Events come newest-first from sort=desc, reverse for chronological display
    return messagesForSession(sessionId, result.events.map(eventToMessage)).reverse();
  } catch {
    return [];
  }
}

/** Incrementally refresh a cached session — fetch only new messages since last seen. */
async function refreshCachedSession(sessionId: string): Promise<void> {
  const lastId = cacheLastSeenId.get(sessionId);
  if (!lastId) {
    // No cache yet — do full fetch
    const msgs = await fetchSessionMessages(sessionId);
    cacheMessages(sessionId, msgs);
    return;
  }
  try {
    const result = await workspaceApi.pollMessages(sessionId, lastId);
    const scopedMessages = messagesForSession(sessionId, result.messages);
    if (scopedMessages.length > 0) {
      const existing = messageCache.get(sessionId) || [];
      const existingIds = new Set(existing.map((m) => m.messageId));
      const unique = scopedMessages.filter((m) => !existingIds.has(m.messageId));
      if (unique.length > 0) {
        cacheMessages(sessionId, [...existing, ...unique]);
      }
    }
  } catch {
    // Best-effort
  }
}

export function ChatView() {
  const { agents, currentUser, currentSessionId, setCurrentSessionId, sessions, createSession, updateLastMessage, setSessionActive, updateAgentMode, stopAllAgents, activeSessionIds, stoppingSessionIds, renameSession, addParticipant, removeParticipant, setSessionMaster, setSessionOrchestration, consumeSkipFocus, createRoutine, knowledge } = useWorkspace();
  const [showCreateRoutine, setShowCreateRoutine] = useState(false);
  const {
    isMobile,
    openMobileList,
    viewMode,
    setViewMode,
    splitBrowser,
    setSplitBrowser,
    showBrowserPreview,
    setShowBrowserPreview,
    activeRightTab,
    setActiveRightTab,
    isSidebarOpen,
    sidebarToggle,
    openNewThread,
    setSelectedAgentName,
  } = useLayout();

  // Continuously refresh message caches for top recent sessions in the background.
  // This ensures clicking any recent thread shows messages instantly and up-to-date.
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  useEffect(() => {
    if (sessions.length === 0) return;

    const getTopSessions = () =>
      [...sessions]
        .filter((s) => s.status === 'active')
        .sort((a, b) => {
          const aTime = a.lastEventAt || (a.createdAt ? new Date(a.createdAt).getTime() : 0);
          const bTime = b.lastEventAt || (b.createdAt ? new Date(b.createdAt).getTime() : 0);
          return bTime - aTime;
        })
        .slice(0, PREFETCH_COUNT);

    // Initial fetch — staggered
    const initial = getTopSessions();
    initial.forEach((s, i) => {
      if (!messageCache.has(s.sessionId)) {
        setTimeout(() => fetchSessionMessages(s.sessionId).then((msgs) => {
          if (msgs.length > 0) cacheMessages(s.sessionId, msgs);
        }), i * 300);
      }
    });

    // Periodic incremental refresh — skip the session the user is currently viewing
    // (useMessagePolling handles that one)
    const interval = setInterval(async () => {
      const top = getTopSessions();
      for (const s of top) {
        if (s.sessionId === currentSessionIdRef.current) continue;
        await refreshCachedSession(s.sessionId);
      }
    }, CACHE_REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [sessions]);

  // Look up cached messages for the current session (read once per session switch)
  const initialMessagesRef = useRef<WorkspaceMessage[] | undefined>(undefined);
  const initialMessagesSessionRef = useRef<string | null>(null);
  if (currentSessionId !== initialMessagesSessionRef.current) {
    initialMessagesRef.current = currentSessionId
      ? messagesForSession(currentSessionId, messageCache.get(currentSessionId) || [])
      : undefined;
    initialMessagesSessionRef.current = currentSessionId;
  }

  const { messages, loading, forceRefresh, generation, loadOlder, hasOlder, loadingOlder } = useMessagePolling({
    sessionId: currentSessionId,
    initialMessages: initialMessagesRef.current,
  });
  const { notifyFocus, notifyBlur, notifyTyping } = useComposingSignal(currentSessionId);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Optimistic message state for instant feedback
  const [optimisticMessages, setOptimisticMessages] = useState<WorkspaceMessage[]>([]);
  // scrollKey triggers scroll-to-bottom: incremented on user send + backfill completion
  const [scrollKey, setScrollKey] = useState(0);
  const [focusKey, setFocusKey] = useState(0);

  // Scroll to bottom when backfill replaces messages (generation changes)
  useEffect(() => {
    if (generation > 0) setScrollKey((k) => k + 1);
  }, [generation]);

  const sessionMessages = useMemo(
    () => currentSessionId ? messagesForSession(currentSessionId, messages) : [],
    [currentSessionId, messages]
  );

  // Per-thread message drafts
  const draftsRef = useRef<Record<string, string>>({});
  const [currentDraft, setCurrentDraft] = useState('');

  // Save/restore draft when switching threads + cache messages
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Save draft and messages from previous session
    if (prevSessionIdRef.current && prevSessionIdRef.current !== currentSessionId) {
      draftsRef.current[prevSessionIdRef.current] = currentDraft;
      // Cache messages for instant switching back
      if (messages.length > 0) {
        cacheMessages(prevSessionIdRef.current, messages);
      }
    }
    // Restore draft for new session
    setCurrentDraft(currentSessionId ? (draftsRef.current[currentSessionId] ?? '') : '');
    prevSessionIdRef.current = currentSessionId;
    // Clear optimistic messages when switching sessions
    setOptimisticMessages([]);
    // Focus the input when switching threads — unless the switch was made
    // via a keyboard shortcut (e.g. 1-9 from the sidebar), in which case
    // the user wanted to navigate, not start typing.
    if (currentSessionId && !consumeSkipFocus()) setFocusKey((k) => k + 1);
  }, [currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep cache updated with latest messages for the current session
  useEffect(() => {
    if (currentSessionId) {
      cacheMessages(currentSessionId, messages);
    }
  }, [currentSessionId, messages]);

  const handleDraftChange = useCallback((draft: string) => {
    setCurrentDraft(draft);
    if (currentSessionId) {
      draftsRef.current[currentSessionId] = draft;
    }
    notifyTyping();
  }, [currentSessionId, notifyTyping]);

  const isDM = currentSessionId?.startsWith('dm:') ?? false;
  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const sessionOptimisticMessages = useMemo(
    () => currentSessionId ? messagesForSession(currentSessionId, optimisticMessages) : [],
    [currentSessionId, optimisticMessages]
  );

  // Clear optimistic messages progressively for the current session only:
  // 1. Remove optimistic user msg once the real user message arrives from the server
  // 2. Remove optimistic loading msg once any real agent message arrives after the user msg
  useEffect(() => {
    if (sessionOptimisticMessages.length === 0) return;
    const removeIds = new Set<string>();

    // Check if the real user message has arrived
    const optimisticUser = sessionOptimisticMessages.find((m) => m.messageId.startsWith('optimistic-user-'));
    if (optimisticUser) {
      // Prefer the exact client_message_id match, but always keep the
      // identity/content fallback: an echo carrying no client_message_id (an
      // older event, or the same text posted from another client) must still
      // retire the local copy. Gating solely on the id left the optimistic
      // message in place indefinitely — and since optimistic messages render
      // after every real one, the agent's reply appeared sandwiched between
      // the two copies of what the user sent.
      const realUserFound = sessionMessages.some(
        (m) => m.senderType !== 'agent' && (
          (!!optimisticUser.clientMessageId && m.clientMessageId === optimisticUser.clientMessageId)
          || m.messageId === optimisticUser.messageId
          || m.content === optimisticUser.content
        )
      );
      if (realUserFound) {
        removeIds.add(optimisticUser.messageId);
      }
    }

    // Check if a real agent message has arrived AFTER the user message — clear loading indicator
    const optimisticLoading = sessionOptimisticMessages.find((m) => m.messageId.startsWith('optimistic-loading-'));
    if (optimisticLoading) {
      // Find the index of the real user message that replaced the optimistic one
      const userMsgIdx = sessionMessages.findIndex(
        (m) => m.senderType !== 'agent' && m.content === optimisticLoading.metadata?._userContent
      );
      // Clear only once a real ANSWER arrives. Step events (thinking/status/
      // todos) are hidden from the transcript unless "show all steps" is on, so
      // treating them as "the agent replied" tore the pending row down and left
      // the thread visibly empty for the entire time the agent was working —
      // while the sidebar, which reads the raw last message, correctly showed
      // "thinking...". That mismatch is exactly what made sends look ignored.
      const isStepMessage = (m: WorkspaceMessage) =>
        m.messageType === 'status'
        || m.messageType === 'thinking'
        || m.messageType === 'todos'
        || m.messageType === 'loading';
      const isAgentAnswer = (m: WorkspaceMessage) => m.senderType === 'agent' && !isStepMessage(m);

      const hasAgentAfterUser = userMsgIdx >= 0
        ? sessionMessages.slice(userMsgIdx + 1).some(isAgentAnswer)
        // The user message is matched by exact content, which fails if the
        // backend normalises it at all. Fall back to wall-clock so a pending row
        // can never get stuck forever when that match misses.
        : sessionMessages.some(
            (m) => isAgentAnswer(m)
              && !!m.createdAt
              && !!optimisticLoading.createdAt
              && m.createdAt > optimisticLoading.createdAt,
          );
      if (hasAgentAfterUser) {
        removeIds.add(optimisticLoading.messageId);
      }
    }

    if (removeIds.size > 0) {
      setOptimisticMessages((prev) => prev.filter((m) => !removeIds.has(m.messageId)));
    }
  }, [sessionMessages, sessionOptimisticMessages]);

  // Merge real messages with optimistic messages for display
  const displayMessages = useMemo(
    () => [...sessionMessages, ...sessionOptimisticMessages],
    [sessionMessages, sessionOptimisticMessages]
  );

  const startEditingTitle = () => {
    setTitleDraft(currentSession?.title || '');
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && currentSessionId && trimmed !== currentSession?.title) {
      renameSession(currentSessionId, trimmed);
    }
  };

  // Update last message cache for thread list preview
  useEffect(() => {
    if (!currentSessionId) return;
    const lastMsg = displayMessages[displayMessages.length - 1];
    if (lastMsg) {
      const isTerminalStatus = /stopped|stopping failed|execution stopped/i.test(lastMsg.content);
      const isWorking = !isTerminalStatus && (
        lastMsg.messageType === 'status' ||
        lastMsg.messageType === 'thinking' ||
        lastMsg.messageType === 'loading'
      );
      updateLastMessage(currentSessionId, lastMsg.senderName, lastMsg.content, isWorking);
    } else {
      updateLastMessage(currentSessionId, '', '');
    }
  }, [currentSessionId, displayMessages, updateLastMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track whether the agent is actively working in this session
  const prevActiveSessionRef = useRef<string | null>(null);
  useEffect(() => {
    // Clear active state for previously viewed session when switching
    if (prevActiveSessionRef.current && prevActiveSessionRef.current !== currentSessionId) {
      setSessionActive(prevActiveSessionRef.current, false);
    }
    prevActiveSessionRef.current = currentSessionId;

    if (!currentSessionId || displayMessages.length === 0) {
      if (currentSessionId) setSessionActive(currentSessionId, false);
      return;
    }
    const lastMsg = displayMessages[displayMessages.length - 1];
    // A user message can replace the optimistic loading indicator before the
    // local CLI has emitted its first status update. Keep the session active in
    // that gap so the Stop button stays available for the whole request.
    if (lastMsg.senderType !== 'agent') return;
    const isTerminalStatus = /stopped|stopping failed|execution stopped/i.test(lastMsg.content);
    const isAgentWorking = lastMsg.senderType === 'agent' && !isTerminalStatus && (
      lastMsg.messageType === 'status' ||
      lastMsg.messageType === 'thinking' ||
      lastMsg.messageType === 'loading'
    );
    setSessionActive(currentSessionId, isAgentWorking);
  }, [currentSessionId, displayMessages, setSessionActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Extract agent mode from status message metadata
  useEffect(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const msg: WorkspaceMessage = displayMessages[i];
      if (msg.senderType === 'agent' && msg.metadata?.agent_mode) {
        updateAgentMode(msg.senderName, msg.metadata.agent_mode as string);
        break;
      }
    }
  }, [displayMessages, updateAgentMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(
    async (content: string, mentions: string[] = [], files: PendingFile[] = []) => {
      if (!currentSessionId) return;
      if (!currentUser.id || !currentUser.name.trim()) return;

      // Create optimistic messages for instant feedback
      const timestamp = Date.now();
      const clientMessageId = globalThis.crypto?.randomUUID?.() || `web-${timestamp}-${Math.random().toString(36).slice(2)}`;
      const userContent = content || (files.length > 0 ? files.map((f) => f.file.name).join(', ') : '');
      const userOptimisticMsg: WorkspaceMessage = {
        messageId: `optimistic-user-${timestamp}`,
        sessionId: currentSessionId,
        senderId: currentUser.id,
        senderName: currentUser.name,
        senderType: 'human',
        content: userContent,
        messageType: 'chat',
        mentions: [],
        targetAgents: null,
        createdAt: new Date().toISOString(),
        metadata: {},
        clientMessageId,
        deliveryStatus: 'sending',
      };
      const loadingOptimisticMsg: WorkspaceMessage = {
        messageId: `optimistic-loading-${timestamp}`,
        sessionId: currentSessionId,
        // Whoever the message is actually addressed to owns the pending row, so
        // "@openclaw ..." acknowledges as openclaw rather than as the master.
        senderName: mentions[0] || agents.find((a) => a.role === 'master')?.agentName || agents[0]?.agentName || 'Agent',
        senderType: 'agent',
        content: '',
        messageType: 'loading',
        mentions: [],
        targetAgents: null,
        createdAt: new Date().toISOString(),
        metadata: { _userContent: userContent },
      };

      // Add optimistic messages immediately and scroll to bottom
      setOptimisticMessages((prev) => [
        ...prev.filter((m) => !(m.sessionId === currentSessionId && m.messageId.startsWith('optimistic-loading-'))),
        userOptimisticMsg,
        loadingOptimisticMsg,
      ]);
      // Make cancellation available immediately, rather than waiting for a
      // remote agent to publish its first status event.
      setSessionActive(currentSessionId, true);
      setScrollKey((k) => k + 1);

      try {
        // Upload files first, then send message with attachment metadata
        let attachments: { fileId: string; filename: string; contentType: string; url: string }[] | undefined;
        if (files.length > 0) {
          const uploaded = await Promise.all(
            files.map((pf) => workspaceApi.uploadFile(pf.file, currentSessionId))
          );
          attachments = uploaded.map((f) => ({
            fileId: f.id,
            filename: f.filename,
            contentType: f.contentType,
            url: workspaceApi.getFileUrl(f.id),
          }));
        }

        const confirmation = await workspaceApi.sendMessage(
          currentSessionId,
          content || (attachments ? attachments.map((a) => a.filename).join(', ') : ''),
          currentUser.name,
          mentions.length > 0 ? mentions : undefined,
          attachments,
          currentUser.id,
          clientMessageId,
        );
        if (confirmation.status !== 'confirmed' || !confirmation.event_id) {
          throw new Error('Message was not confirmed by the workspace');
        }
        setOptimisticMessages((prev) => prev.map((message) =>
          message.messageId === userOptimisticMsg.messageId
            ? { ...message, deliveryStatus: 'confirmed' }
            : message
        ));
        capture('message_sent', {
          has_attachments: (attachments?.length ?? 0) > 0,
          has_mentions: mentions.length > 0,
          attachment_count: attachments?.length ?? 0,
        });
        forceRefresh();
      } catch {
        // Keep the failed message visible so delivery failure is explicit.
        setOptimisticMessages((prev) =>
          prev
            .filter((m) => m.messageId !== loadingOptimisticMsg.messageId)
            .map((m) => m.messageId === userOptimisticMsg.messageId ? { ...m, deliveryStatus: 'failed' } : m)
        );
      }
    },
    [currentSessionId, currentUser.id, currentUser.name, forceRefresh, agents, setSessionActive]
  );

  const hasStatusMessages = displayMessages.some((m) => m.messageType === 'status' || m.messageType === 'thinking');

  if (!currentSessionId) {
    const isRoutinesView = viewMode === 'routines';
    return (
      <div className="flex flex-col h-full items-center justify-center text-center text-muted-foreground px-8">
        {isRoutinesView ? (
          <>
            <div className="opacity-20 mb-3">
              <CalendarClock className="size-10" />
            </div>
            <p className="text-sm font-medium">No routines yet</p>
            <p className="text-xs mt-1">Create a routine to get started.</p>
          </>
        ) : (
          <>
            <div className="flex items-center p-4 rounded-full bg-primary/10 mb-4">
              <MessageSquare className="size-8 text-primary" />
            </div>
            <p className="text-lg font-semibold text-foreground">Start a new session</p>
            <p className="text-sm mt-1 max-w-xs">
              Create a session and pick which agents join to start collaborating.
            </p>
            {agents.length > 0 && (
              <Button className="mt-5 gap-1.5" onClick={openNewThread}>
                <Plus className="size-4" />
                New Thread
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface0">
      {/* Thread header */}
      <div className="flex items-center gap-2 px-4 lg:px-6 py-3 border-b border-border/80 shrink-0 bg-surface0 sticky top-0 z-10">
        <div className="flex flex-1 items-center gap-2 lg:gap-3 min-w-0">
          {/* Sidebar Toggle — desktop only, shown when sidebar is collapsed */}
          {!isMobile && !isSidebarOpen && (
            <button
              onClick={sidebarToggle}
              className="size-7 flex items-center justify-center rounded-lg hover:bg-surface-sidebar-hover text-muted-foreground hover:text-foreground transition-colors shrink-0 -ml-1 cursor-pointer"
              title="Expand Sidebar"
            >
              <PanelLeft className="size-4" />
            </button>
          )}
          {/* Return to workspace Overview */}
          <button
            onClick={() => {
              setCurrentSessionId(null);
              setViewMode('mission');
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors shrink-0 -ml-1 cursor-pointer border border-border/60"
            title="Back to workspace overview"
          >
            <ChevronLeft className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px]">Overview</span>
          </button>
          {isDM ? (
            <h2 className="text-sm font-normal lg:font-light tracking-tight truncate flex items-center gap-1.5 text-foreground">
              <MessageSquare className="size-3.5 text-muted-foreground" />
              {currentSessionId!.slice(3).split(',').map((a) => a.replace(/^openagents:/, '')).join(' ↔ ')}
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-surface3/80 text-muted-foreground border border-border/40 font-normal">
                read-only
              </span>
            </h2>
          ) : editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="text-sm font-normal tracking-tight bg-transparent border-b border-border outline-none min-w-0 max-w-[300px] text-foreground h-6"
              autoFocus
            />
          ) : (
            <h2
              className="text-sm font-normal lg:font-light tracking-tight truncate cursor-pointer hover:text-muted-foreground transition-colors text-foreground"
              onClick={startEditingTitle}
              title="Click to rename"
            >
              {currentSession?.title || 'Thread'}
            </h2>
          )}
          {currentSession?.workingDir && (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium shrink-0"
              title={`Open Folder: ${currentSession.workingDir}`}
            >
              <FolderOpen className="size-2.5" />
              {currentSession.workingDir.split(/[\\/]/).filter(Boolean).pop()}
            </span>
          )}
          {(() => {
            const participants = currentSession?.participants || [];
            const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
            return (
              <>
                {sessionAgents.length > 1 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface2 text-foreground-muted font-medium shrink-0">
                    group
                  </span>
                )}
              </>
            );
          })()}
        </div>
        <div className="flex items-center gap-1 lg:gap-1.5 shrink-0">
          {/* New topic — same agents, empty context. One click, no dialog. The
              participants are inherited from this thread on purpose: a channel
              with no members falls back to every agent in the workspace on the
              backend, which would make the first message fan out to everyone. */}
          {!isDM && (currentSession?.participants?.length ?? 0) > 0 && (
            <Button
              variant="ghost"
              mode="icon"
              size="sm"
              onClick={() => void createSession({ participants: currentSession!.participants })}
              title="New topic — same agents, fresh context"
            >
              <MessageSquarePlus className="size-4" />
            </Button>
          )}
          {/* Compact avatar stack — click to manage thread agents (add / remove /
              set leader). Replaces the old standalone manage-agents button. Not
              shown for DMs. */}
          {!isDM && (() => {
            const participants = currentSession?.participants || [];
            const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
            // Deliberately no early return when the thread has no agents: this
            // dropdown is the only way to add one, so bailing out left an empty
            // thread permanently unusable. The trigger becomes "Add agent".
            // In-thread list must include OFFLINE participants too — otherwise an
            // agent whose daemon is down can never be removed from the thread.
            const agentByName = new Map(agents.map((a) => [a.agentName, a]));
            const inThread = participants.map(
              (name) => agentByName.get(name) || { agentName: name, status: 'offline' }
            );
            // The "Add to thread" picker still only offers online agents.
            const notInThread = agents.filter(
              (a) => a.status === 'online' && !participants.includes(a.agentName)
            );
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex -space-x-1.5 shrink-0 mr-1 items-center rounded-full outline-none hover:opacity-80 transition-opacity cursor-pointer"
                    title="Manage thread agents"
                  >
                    {sessionAgents.length === 0 ? (
                      <span className="flex items-center gap-1 rounded-full border border-dashed border-amber-400/80 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:text-amber-300">
                        <Plus className="size-3" />
                        Add agent
                      </span>
                    ) : (
                      <>
                        {sessionAgents.slice(0, 3).map((agent) => (
                          <div key={agent.agentName} className="border-2 border-background rounded-full" title={agent.agentName}>
                            <AgentAvatar name={agent.agentName} size={18} />
                          </div>
                        ))}
                        {sessionAgents.length > 3 && (
                          <div className="size-5 rounded-full bg-surface3 flex items-center justify-center text-[7px] font-medium text-foreground-muted border-2 border-background" title={sessionAgents.map((agent) => agent.agentName).join(', ')}>
                            +{sessionAgents.length - 3}
                          </div>
                        )}
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {inThread.length > 0 && (
                    <>
                      <DropdownMenuLabel>In this thread</DropdownMenuLabel>
                      {inThread.map((agent) => (
                        <div
                          key={agent.agentName}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md group"
                        >
                          <AgentAvatar name={agent.agentName} size={20} />
                          <span className="text-sm flex-1 truncate">{agent.agentName}</span>
                          {agent.status !== 'online' && (
                            <span className="text-[10px] text-muted-foreground shrink-0">offline</span>
                          )}
                          {currentSession?.master === agent.agentName ? (
                            <span
                              className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 shrink-0"
                              title="Thread leader — receives messages that don't @mention anyone"
                            >
                              <Crown className="size-3" /> leader
                            </span>
                          ) : (
                            <button
                              onClick={() => currentSessionId && setSessionMaster(currentSessionId, agent.agentName)}
                              className="size-5 flex items-center justify-center rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                              title="Set as thread leader"
                            >
                              <Crown className="size-3" />
                            </button>
                          )}
                          {inThread.length > 1 && (
                            <button
                              onClick={() => currentSessionId && removeParticipant(currentSessionId, agent.agentName)}
                              className="size-5 flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                              title="Remove from thread"
                            >
                              <X className="size-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                  {notInThread.length > 0 && (
                    <>
                      {inThread.length > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel>Add to thread</DropdownMenuLabel>
                      {notInThread.map((agent) => (
                        <button
                          key={agent.agentName}
                          onClick={() => currentSessionId && addParticipant(currentSessionId, agent.agentName)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent transition-colors"
                        >
                          <AgentAvatar name={agent.agentName} size={20} />
                          <span className="text-sm flex-1 truncate text-left">{agent.agentName}</span>
                          <Plus className="size-3 text-muted-foreground shrink-0" />
                        </button>
                      ))}
                    </>
                  )}
                  {inThread.length === 0 && notInThread.length === 0 && (
                    <p className="text-sm text-muted-foreground px-2 py-3 text-center">No agents online</p>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}

          {/* Stop button — visible when agents are working */}
          {currentSessionId && (activeSessionIds.has(currentSessionId) || stoppingSessionIds.has(currentSessionId)) && (
            <button
              onClick={() => stopAllAgents(currentSessionId!)}
              disabled={stoppingSessionIds.has(currentSessionId)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors shrink-0 disabled:opacity-60 disabled:pointer-events-none"
            >
              <Square className="size-3 fill-current" />
              {stoppingSessionIds.has(currentSessionId) ? 'Stopping...' : 'Stop'}
            </button>
          )}

          {/* All steps toggle */}
          {hasStatusMessages && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAllSteps((prev) => !prev)}
              className={cn(
                'gap-1.5 h-7 text-xs font-semibold rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground',
                showAllSteps && 'bg-surface2 text-foreground border border-border/50'
              )}
              title={showAllSteps ? 'Showing all intermediate steps' : 'Showing only latest steps'}
            >
              <ListTree className="size-3.5" />
            </Button>
          )}

          {/* Right workspace panels toggles (Desktop only) */}
          {!isMobile && (
            <div className="flex items-center gap-1 border-r border-border/60 pr-1.5 mr-0.5">
              {/* Web Sandbox */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveRightTab(activeRightTab === 'browser' ? null : 'browser')}
                className={cn(
                  'gap-1 h-7 text-xs font-semibold rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground',
                  activeRightTab === 'browser' && 'bg-surface2 text-foreground border border-border/50 font-bold'
                )}
                title="Web Sandbox Preview"
              >
                <Globe className="size-3.5" />
                <span className="text-[10px] hidden xl:inline">Sandbox</span>
              </Button>

              {/* Agents inspector */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveRightTab(activeRightTab === 'radar' ? null : 'radar')}
                className={cn(
                  'gap-1 h-7 text-xs font-semibold rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground',
                  activeRightTab === 'radar' && 'bg-surface2 text-foreground border border-border/50 font-bold'
                )}
                title="Inspect agents"
              >
                <Users className="size-3.5" />
                <span className="text-[10px] hidden xl:inline">Agents</span>
              </Button>

              {/* File Preview */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveRightTab(activeRightTab === 'file' ? null : 'file')}
                className={cn(
                  'gap-1 h-7 text-xs font-semibold rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground',
                  activeRightTab === 'file' && 'bg-surface2 text-foreground border border-border/50 font-bold'
                )}
                title="File Preview"
              >
                <FileText className="size-3.5" />
                <span className="text-[10px] hidden xl:inline">File</span>
              </Button>

              {/* Terminal Logs */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveRightTab(activeRightTab === 'terminal' ? null : 'terminal')}
                className={cn(
                  'gap-1 h-7 text-xs font-semibold rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground',
                  activeRightTab === 'terminal' && 'bg-surface2 text-foreground border border-border/50 font-bold'
                )}
                title="Terminal Logs Stream"
              >
                <Terminal className="size-3.5" />
                <span className="text-[10px] hidden xl:inline">Terminal</span>
              </Button>
            </div>
          )}

          {/* Orchestration mode picker — only for multi-agent threads */}
          {!isDM && currentSession && (() => {
            const participants = currentSession.participants || [];
            const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
            if (sessionAgents.length < 2) return null;
            return (
              <OrchestrationControl
                session={currentSession}
                agents={sessionAgents}
                onChange={(updates) => setSessionOrchestration(currentSessionId!, updates)}
              />
            );
          })()}

          {/* Share conversation */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShareDialogOpen(true)}
            className="gap-1.5 h-7 text-xs font-semibold rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground"
            title="Share conversation"
          >
            <Share2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Agent roster bar — thin strip listing who's in the thread + a hint of
          their responsibility. Only shown for group threads (>1 agent), never DMs. */}
      {!isDM && (() => {
        const participants = currentSession?.participants || [];
        const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
        if (sessionAgents.length <= 1) return null;
        return (
          <div className="flex items-center gap-2 px-2 lg:px-4 py-1.5 border-b shrink-0 overflow-x-auto bg-surface1/60">
            {sessionAgents.map((agent, i) => {
              const desc = shortDescription(agent.description);
              const isMaster = currentSession?.master === agent.agentName;
              return (
                <div key={agent.agentName} className="flex items-center gap-2 shrink-0">
                  {i > 0 && <span className="text-foreground-extra-muted select-none">|</span>}
                  <div
                    className="flex items-center gap-1.5 shrink-0"
                    title={agent.description ? `${agent.agentName} — ${agent.description}` : agent.agentName}
                  >
                    <AgentAvatar name={agent.agentName} size={16} status={agent.status} showStatus />
                    <span className="text-[11px] font-semibold text-foreground shrink-0">
                      {agent.agentName}
                    </span>
                    {isMaster && <Crown className="size-2.5 text-amber-500 shrink-0" />}
                    {desc && (
                      <span className="text-[11px] text-muted-foreground truncate max-w-[220px]">
                        {desc}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Missing-description warning — routing accuracy (dynamic/workflow router
          and the master's own delegation) depends on agent descriptions. Nudge
          the user to fill any that are blank; each chip opens that agent's
          profile, where a one-click auto-generate button drafts one. */}
      {!isDM && (() => {
        const participants = currentSession?.participants || [];
        const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
        if (sessionAgents.length <= 1) return null;
        const missing = sessionAgents.filter((a) => !a.description || !a.description.trim());
        if (missing.length === 0) return null;
        return (
          <div className="flex items-center gap-2 px-2 lg:px-4 py-1.5 border-b shrink-0 overflow-x-auto bg-amber-50 dark:bg-amber-900/15 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="text-[11px] leading-snug shrink-0">
              Routing may be less accurate — no description for:
            </span>
            {missing.map((a) => (
              <button
                key={a.agentName}
                onClick={() => setSelectedAgentName(a.agentName)}
                className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors shrink-0"
                title={`Add a description for ${a.agentName}`}
              >
                <Sparkles className="size-2.5" />
                {a.agentName}
              </button>
            ))}
          </div>
        );
      })()}

      {/* Messages */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : displayMessages.length === 0 ? (
          <EmptyState />
        ) : (
          <ChatMessages
            messages={displayMessages}
            agents={agents}
            showAllSteps={showAllSteps}
            scrollKey={scrollKey}
            loadOlder={loadOlder}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            className="flex-1 overflow-y-auto px-3 lg:px-5 py-3"
          />
        )}

        {/* Input — hidden for read-only DM views */}
        {!isDM && (
          <div className="px-3 lg:px-4 py-2 lg:py-3">
            <div className="max-w-3xl mx-auto w-full">
              {/* A thread with no agents gets no reply: the backend only borrows a
                  workspace agent when the choice is unambiguous. Say so instead of
                  letting the message vanish into silence. */}
              {currentSession && (currentSession.participants?.length ?? 0) === 0 && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span className="flex-1">
                    No agents in this thread — messages won&apos;t be answered. Use
                    {' '}<span className="font-medium">Add agent</span> in the header.
                  </span>
                </div>
              )}
              {currentSessionId && <ThreadStatusBar channelName={currentSessionId} messages={displayMessages} />}
              <ChatInput
                onSend={handleSend}
                agents={agents}
                knowledge={knowledge}
                draft={currentDraft}
                onDraftChange={handleDraftChange}
                onFocusChange={(focused) => focused ? notifyFocus() : notifyBlur()}
                focusKey={focusKey}
                onCreateRoutine={() => setShowCreateRoutine(true)}
                disabled={!currentUser.name.trim()}
              />
            </div>
          </div>
        )}

        <CreateRoutineDialog
          open={showCreateRoutine}
          onOpenChange={setShowCreateRoutine}
          agents={agents}
          conversationHistory={(() => {
            if (!sessionMessages.length) return undefined;
            const recent = sessionMessages.filter((m) => m.messageType === 'chat').slice(-20);
            if (!recent.length) return undefined;
            return recent.map((m) => `${m.senderName}: ${m.content}`).join('\n');
          })()}
          onCreateRoutine={createRoutine}
        />

        {currentSessionId && (
          <ShareDialog
            open={shareDialogOpen}
            onOpenChange={setShareDialogOpen}
            sessionId={currentSessionId}
          />
        )}
      </div>

      {/* Persistent status line — always-on thread context */}
      {!isDM && currentSessionId && <StatusLine />}
    </div>
  );
}
