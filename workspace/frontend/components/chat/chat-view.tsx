'use client';

import { Hint } from '@/components/ui/hint';
import { KeyCombo } from '@/components/ui/kbd';
import { shortcutKeys } from '@/lib/shortcuts';
import { SHORTCUTS_EVENT } from '@/components/layout/global-shortcuts';
import * as React from 'react';
import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { ChatMessages } from './chat-messages';
import { ChatInput, type PendingFile, type MentionSegment } from './chat-input';
import { ThreadStatusBar } from './thread-status-bar';
import { EmptyState } from './empty-state';
import { useWorkspace } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { useComposingSignal } from '@/hooks/use-composing-signal';
import { isComposing } from '@/lib/ime';
import { workspaceApi } from '@/lib/api';
import { capture } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Download, ListTree, ListChecks, MessageSquare, MessageSquarePlus, CalendarClock, Square, MoreHorizontal, X, Plus, Globe, Share2, Crown, AlertTriangle, Sparkles, Users, FileText, PanelLeft, PanelRight, Terminal, Check, Code2, Search, Zap, Layers, ArrowRight, Radio, Plug, Settings, Loader2, Activity, CheckCircle2, Copy, Coins } from 'lucide-react';
import { ShareDialog } from './share-dialog';
import { OrchestrationControl } from './orchestration-control';
import { useLayout } from '@/components/layout/layout-context';
import { cn } from '@/lib/utils';
import { headerIconButtonClass } from '@/components/headers/header-chip';
import { getApiBaseUrl } from '@/lib/config';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { basename } from '@/components/chat/project-folder-picker';
import {
  deriveTitleFromMessages,
  rememberDerivedTitle,
  getDerivedTitle,
} from '@/lib/thread-title';
import { SignalMark } from '@/components/brand/signal-mark';
import { CreateRoutineDialog } from '@/components/routines/create-routine-dialog';
import { GitChip } from '@/components/git/git-chip';
import { useGitStatus } from '@/lib/use-git-status';
import { AgentQuotaCapsule } from './agent-quota-capsule';
import { ContextHealthIndicator } from './context-health-indicator';
import { AgentModelSwitcher } from './agent-model-switcher';
import { getSnapshot, currentModelFor } from '@/lib/agent-model-store';
import { PipelineStepper } from './pipeline-stepper';
import { deduplicateAndSortMessages, eventToMessage, stripAddressPrefix } from '@/lib/types';
import type { WorkspaceMessage } from '@/lib/types';
import { conversationFilename, downloadTextFile, messagesToMarkdown } from '@/lib/export-markdown';
import { toast } from '@/lib/toast';

const PROMPT_SUGGESTIONS = [
  {
    icon: Zap,
    title: 'Refactor & review',
    desc: 'Review the code in this workspace, flag risks, suggest refactors',
    prompt: 'Review the core architecture and implementation of this workspace. Point out logic or performance risks and suggest concrete improvements.',
  },
  {
    icon: Search,
    title: 'Research & compare',
    desc: 'Search the web for approaches and write a comparison',
    prompt: 'Research current approaches and best practices for local multi-agent orchestration, then compare their trade-offs.',
  },
  {
    icon: Terminal,
    title: 'Diagnose environment',
    desc: 'Check installed runtimes, tools, and local servers',
    prompt: 'Diagnose the local environment: check Node, Python, and Go runtimes, running background tasks, and active ports.',
  },
  {
    icon: Layers,
    title: 'Design architecture',
    desc: 'Propose module boundaries, data flow, and file layout',
    prompt: 'Draft an architectural plan for this workspace, proposing clear module boundaries, data flow, and a scalable file layout.',
  },
];

/**
 * Quick-open panels available in the thread header.
 *
 * `LocalPreview` (the dev-server viewer) has its own dedicated button beside
 * these. The rest — sandbox browser, radar, file tree, tasks, terminal, and trace — are
 * collapsed into a single dropdown to keep the thread header quiet — but they
 * stay in the header rather than moving into Settings, because these are view
 * switchers people toggle constantly, not configuration.
 */
const SIDE_PANELS = [
  { id: 'trace' as const, label: 'Trace', icon: Activity },
  { id: 'browser' as const, label: 'Sandbox', icon: Globe },
  { id: 'radar' as const, label: 'Agents', icon: Users },
  { id: 'file' as const, label: 'Files', icon: FileText },
  { id: 'tasks' as const, label: 'Tasks', icon: ListChecks },
  { id: 'terminal' as const, label: 'Terminal', icon: Terminal },
];

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
  return stripAddressPrefix(address);
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
  const scopedMessages = deduplicateAndSortMessages(messagesForSession(sessionId, msgs));
  if (scopedMessages.length === 0) {
    // Never overwrite an existing populated cache with empty during session transitions
    return;
  }
  messageCache.set(sessionId, scopedMessages);
  cacheLastSeenId.set(sessionId, scopedMessages[scopedMessages.length - 1].messageId);
  // Evict oldest entries if cache grows too large
  if (messageCache.size > CACHE_MAX_SESSIONS) {
    const oldest = messageCache.keys().next().value;
    if (oldest) {
      messageCache.delete(oldest);
      cacheLastSeenId.delete(oldest);
    }
  }
}

/*
  ── ONE POLL PER SESSION, SHARED ──

  `useMessagePolling` is not a selector over a cache — it owns an SSE
  connection, a pair of message-id cursors and its own `messages` state. Two
  components calling it for the same session therefore opened TWO streams and
  kept TWO independently-advancing copies of the same transcript, which is what
  `TracePanel` was doing: every time the Studio panel showed the trace, the
  request rate for that channel doubled and the two caches could disagree
  mid-flight about what the newest message was.

  Trace is a second VIEW of the conversation, not a second source of it, so the
  poll is lifted to a provider that wraps both panes (see wrapper.tsx) and both
  read the same array.

  It lives in this file rather than its own because the seeding it does —
  `messageCache`, for instant thread switching — is module-private here, and
  splitting the provider from the cache it reads would be the more surprising
  arrangement of the two.
*/
type SessionMessagesValue = ReturnType<typeof useMessagePolling>;
const SessionMessagesContext = React.createContext<SessionMessagesValue | null>(null);

export function SessionMessagesProvider({ children }: { children: React.ReactNode }) {
  const { currentSessionId } = useWorkspace();

  // Cached messages for this session, read once per session switch.
  const initialMessagesRef = useRef<WorkspaceMessage[] | undefined>(undefined);
  const initialMessagesSessionRef = useRef<string | null>(null);
  if (currentSessionId !== initialMessagesSessionRef.current) {
    initialMessagesRef.current = currentSessionId
      ? messagesForSession(currentSessionId, messageCache.get(currentSessionId) || [])
      : undefined;
    initialMessagesSessionRef.current = currentSessionId;
  }

  const value = useMessagePolling({
    sessionId: currentSessionId,
    initialMessages: initialMessagesRef.current,
  });

  return (
    <SessionMessagesContext.Provider value={value}>{children}</SessionMessagesContext.Provider>
  );
}

/**
 * The shared transcript for the current session. Throws rather than falling
 * back to its own poll: a silent second stream is the exact bug this replaced,
 * and it is invisible until someone profiles the network tab.
 */
export function useSessionMessages(): SessionMessagesValue {
  const ctx = React.useContext(SessionMessagesContext);
  if (!ctx) throw new Error('useSessionMessages must be used inside <SessionMessagesProvider>');
  return ctx;
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
  const { agents, currentUser, currentSessionId, setCurrentSessionId, sessions, createSession, updateLastMessage, setSessionActive, updateAgentMode, stopAllAgents, activeSessionIds, workingAgentNames, stoppingSessionIds, renameSession, addParticipant, removeParticipant, setSessionMaster, setSessionOrchestration, consumeSkipFocus, createRoutine, knowledge, recordUserMessageSent, workspaceId } = useWorkspace();
  
  useEffect(() => {
    console.log('[52hzAgents Monitor] [ChatView] Active session:', currentSessionId, 'at', new Date().toISOString());
  }, [currentSessionId]);

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
    openSettings,
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
      if (typeof document !== 'undefined' && document.hidden) return;
      const top = getTopSessions();
      for (const s of top) {
        if (s.sessionId === currentSessionIdRef.current) continue;
        await refreshCachedSession(s.sessionId);
      }
    }, CACHE_REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [sessions]);

  // The single poll for this session — shared with TracePanel. See
  // SessionMessagesProvider above.
  const { messages, loading, forceRefresh, generation, loadOlder, hasOlder, loadingOlder } =
    useSessionMessages();

  // Persisted (not just component state): dismissing this once shouldn't mean
  // seeing it again on every reload — that's what made it feel like a
  // permanent nag bar instead of a one-time nudge.
  const [dismissedRoutingWarning, setDismissedRoutingWarningState] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('dismissed_routing_warning') === '1';
    } catch {
      return false;
    }
  });
  const setDismissedRoutingWarning = (v: boolean) => {
    setDismissedRoutingWarningState(v);
    try {
      localStorage.setItem('dismissed_routing_warning', v ? '1' : '0');
    } catch {}
  };
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

  const [exporting, setExporting] = useState(false);

  /**
   * Export the whole thread as one Markdown file.
   *
   * Deliberately not built from the in-view `messages`: that list is paginated
   * (loadOlder / hasOlder), so exporting it would silently truncate any thread
   * long enough to be worth archiving. Page the history from the API instead,
   * and say so out loud if even that hits the page ceiling.
   */
  const handleExportMarkdown = useCallback(async () => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId || exporting) return;
    setExporting(true);
    try {
      const MAX_PAGES = 40;
      const PAGE_SIZE = 100;
      const chronological: WorkspaceMessage[] = [];
      let before: string | undefined;
      let truncated = false;

      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) { truncated = true; break; }
        const res = await workspaceApi.loadMessageHistory(sessionId, { before, limit: PAGE_SIZE });
        const batch = res.events
          .map(eventToMessage)
          .filter((m) => m.sessionId === sessionId);
        if (batch.length === 0) break;
        // The API returns newest-first; each page is older than the last.
        chronological.unshift(...batch.slice().reverse());
        before = batch[batch.length - 1].messageId;
        if (!res.has_more) break;
      }

      const title = currentSession?.title || sessionId;
      const markdown = messagesToMarkdown(chronological, {
        title,
        channelName: sessionId,
        participants: currentSession?.participants,
      });
      downloadTextFile(conversationFilename(title), markdown);

      toast.success(
        truncated
          ? `Exported the most recent ${chronological.length} messages (thread is longer)`
          : 'Conversation exported',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [currentSession, exporting]);

  // Which repository the git chip and the context line report on: the folder
  // this channel is bound to, resolved server-side from the channel id.
  const { status: gitStatus, refresh: refreshGit, channelId: gitChannelId } = useGitStatus(currentSession?.sessionId);
  // The composer's folder pill answers "what directory is THIS channel bound
  // to", so it reads the channel's own binding. It used to read gitStatus.dir —
  // the agent *member's* working directory, which is fixed when that agent
  // launches and is identical across every channel the agent sits in. A channel
  // created with no folder therefore still displayed the previous folder, which
  // looked like the binding had been inherited when no binding existed at all.
  const currentSessionWorkingDir = currentSession?.workingDir ?? undefined;
  // Who is answering in THIS channel. The sidebar roster reports reachability
  // (online / offline); "working" belongs next to the conversation it is
  // happening in, which is also the only place the distinction is actionable.
  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);
  const hasOnlineAgents = onlineAgents.length > 0;
  const sessionParticipants = currentSession?.participants || [];
  const hasSpecificParticipants = sessionParticipants.length > 0;
  const sessionOnlineAgents = useMemo(
    () => hasSpecificParticipants ? onlineAgents.filter((a) => sessionParticipants.includes(a.agentName)) : onlineAgents,
    [hasSpecificParticipants, onlineAgents, sessionParticipants]
  );
  const canChatInCurrentSession = hasSpecificParticipants ? sessionOnlineAgents.length > 0 : hasOnlineAgents;
  const isMissingParticipant = hasSpecificParticipants && sessionOnlineAgents.length === 0;

  // Only display agents who are currently connected / online or actively working in this session,
  // rather than cluttering with offline historical agents from the database roster.
  const activeHeaderAgents = useMemo(() => {
    const onlineSet = new Set(onlineAgents.map((a) => a.agentName));
    if (sessionParticipants.length > 0) {
      const active = sessionParticipants.filter((name) => onlineSet.has(name) || workingAgentNames.has(name));
      return active;
    }
    return onlineAgents.map((a) => a.agentName);
  }, [sessionParticipants, onlineAgents, workingAgentNames]);

  const channelAgentNames = currentSession?.participants ?? [];
  const workingHere = activeHeaderAgents.filter((name) => workingAgentNames.has(name));

  const activeModelAgentName = useMemo(() => {
    if (currentSession?.master) {
      return currentSession.master;
    }
    if (channelAgentNames.length > 0) {
      return channelAgentNames[0];
    }
    return onlineAgents[0]?.agentName || 'claude';
  }, [currentSession?.master, channelAgentNames, onlineAgents]);

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
      const isStepMessage = (m: WorkspaceMessage) =>
        m.messageType === 'status'
        || m.messageType === 'thinking'
        || m.messageType === 'todos'
        || m.messageType === 'loading';
      const isAgentAnswer = (m: WorkspaceMessage) => m.senderType === 'agent' && !isStepMessage(m);

      const userMsgIdx = sessionMessages.findIndex(
        (m) => m.senderType !== 'agent' && (
          m.content === optimisticLoading.metadata?._userContent
          || (!!optimisticLoading.createdAt && !!m.createdAt && m.createdAt >= optimisticLoading.createdAt)
        )
      );

      // If any real agent answer arrived after the user message, or if the latest message in sessionMessages is an agent answer
      const hasAgentAfterUser = userMsgIdx >= 0
        ? sessionMessages.slice(userMsgIdx + 1).some(isAgentAnswer)
        : sessionMessages.some(isAgentAnswer);

      if (hasAgentAfterUser || (sessionMessages.length > 0 && isAgentAnswer(sessionMessages[sessionMessages.length - 1]))) {
        removeIds.add(optimisticLoading.messageId);
      }
    }

    if (removeIds.size > 0) {
      setOptimisticMessages((prev) => prev.filter((m) => !removeIds.has(m.messageId)));
    }
  }, [sessionMessages, sessionOptimisticMessages]);

  // Merge real messages with optimistic messages for display
  const displayMessages = useMemo(
    () => deduplicateAndSortMessages([...sessionMessages, ...sessionOptimisticMessages]),
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

  const isTerminalStatus = useCallback((content: string) => {
    return /stopped|stopping failed|execution stopped|idle|done|completed|finished|ready|success/i.test(content.trim());
  }, []);

  // Update last message cache for thread list preview
  useEffect(() => {
    if (!currentSessionId) return;
    const lastMsg = displayMessages[displayMessages.length - 1];
    if (lastMsg) {
      const isTerm = isTerminalStatus(lastMsg.content);
      const isOptimistic = Boolean(lastMsg.messageId?.startsWith('optimistic-'));
      const msgTime = lastMsg.createdAt ? new Date(lastMsg.createdAt).getTime() : 0;
      const isRecent = isOptimistic || (msgTime > 0 && Date.now() - msgTime < 60_000);
      const isWorking = !isTerm && isRecent && (
        lastMsg.messageType === 'status' ||
        lastMsg.messageType === 'thinking' ||
        lastMsg.messageType === 'loading'
      );
      updateLastMessage(currentSessionId, lastMsg.senderName, lastMsg.content, isWorking);
    } else {
      updateLastMessage(currentSessionId, '', '');
    }
  }, [currentSessionId, displayMessages, updateLastMessage, isTerminalStatus]);

  // Track whether the agent is actively working in this session
  const prevActiveSessionRef = useRef<string | null>(null);
  useEffect(() => {
    prevActiveSessionRef.current = currentSessionId;

    if (!currentSessionId || displayMessages.length === 0) {
      if (currentSessionId) {
        setSessionActive(currentSessionId, false, null);
      }
      return;
    }
    const lastMsg = displayMessages[displayMessages.length - 1];
    if (lastMsg.senderType !== 'agent') {
      // If the latest message in this thread is not an agent message and there is no pending loading row,
      // the agent is not working.
      const hasOptimisticLoading = displayMessages.some((m) => m.messageType === 'loading');
      if (!hasOptimisticLoading) {
        setSessionActive(currentSessionId, false, null);
      }
      return;
    }
    const isTerm = isTerminalStatus(lastMsg.content);
    const isOptimistic = Boolean(lastMsg.messageId?.startsWith('optimistic-'));
    const msgTime = lastMsg.createdAt ? new Date(lastMsg.createdAt).getTime() : 0;
    const isRecent = isOptimistic || (msgTime > 0 && Date.now() - msgTime < 60_000);
    const isAgentWorking = !isTerm && isRecent && (
      lastMsg.messageType === 'status' ||
      lastMsg.messageType === 'thinking' ||
      lastMsg.messageType === 'loading'
    );
    setSessionActive(currentSessionId, isAgentWorking, isOptimistic ? null : (isAgentWorking ? lastMsg.senderName : null));

    if (isAgentWorking && !isOptimistic && msgTime > 0) {
      const remainingMs = Math.max(1000, 60_000 - (Date.now() - msgTime));
      const timer = setTimeout(() => {
        setSessionActive(currentSessionId, false, null);
      }, remainingMs);
      return () => clearTimeout(timer);
    }
  }, [currentSessionId, displayMessages, setSessionActive, isTerminalStatus]);

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
    async (
      content: string,
      mentions: string[] = [],
      files: PendingFile[] = [],
      segments?: MentionSegment[]
    ) => {
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
      const onlineAgents = agents.filter((a) => a.status === 'online');
      const predictedAgentName =
        (segments && segments.length > 0 ? segments[0].agent : null) ||
        mentions[0] ||
        (currentSession?.master && onlineAgents.some((a) => a.agentName === currentSession.master) ? currentSession.master : null) ||
        (onlineAgents.length === 1 ? onlineAgents[0].agentName : null) ||
        (onlineAgents.length > 1 ? onlineAgents[0].agentName : null) ||
        agents.find((a) => a.role === 'master')?.agentName ||
        agents[0]?.agentName ||
        'Agent';

      const loadingOptimisticMsg: WorkspaceMessage = {
        messageId: `optimistic-loading-${timestamp}`,
        sessionId: currentSessionId,
        senderName: predictedAgentName,
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
      updateLastMessage(currentSessionId, currentUser.name, content || 'Sent an attachment', false);
      recordUserMessageSent(currentSessionId);
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

        // Per-agent model hints, keyed by agent name and agent type
        const agentModelsMeta: Record<string, string> = {};
        try {
          const modelSnapshot = getSnapshot();
          for (const agent of agents) {
            const saved =
              (currentSessionId && localStorage.getItem(`52hz_model_${currentSessionId}_${agent.agentName}`)) ||
              (currentSessionId && localStorage.getItem(`52hz_model_${currentSessionId}_${agent.agentName.toLowerCase()}`)) ||
              currentModelFor(modelSnapshot, agent.agentName) ||
              localStorage.getItem(`52hz_model_default_${agent.agentName}`) ||
              localStorage.getItem(`52hz_model_default_${agent.agentName.toLowerCase()}`);
            if (saved) {
              agentModelsMeta[agent.agentName] = saved;
              agentModelsMeta[agent.agentName.toLowerCase()] = saved;
              if (agent.agentType) {
                agentModelsMeta[agent.agentType] = saved;
                agentModelsMeta[agent.agentType.toLowerCase()] = saved;
              }
            }
          }
        } catch {}

        const msgMetadata: Record<string, unknown> = {};
        if (Object.keys(agentModelsMeta).length > 0) {
          msgMetadata.agent_models = agentModelsMeta;
        }
        if (segments && segments.length >= 2) {
          msgMetadata.mention_segments = segments;
        }

        const confirmation = await workspaceApi.sendMessage(
          currentSessionId,
          content || (attachments ? attachments.map((a) => a.filename).join(', ') : ''),
          currentUser.name,
          mentions.length > 0 ? mentions : undefined,
          attachments,
          currentUser.id,
          clientMessageId,
          Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined,
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
      } catch (err) {
        console.error('[52hzAgents] Failed to send message:', err);
        // Keep the failed message visible so delivery failure is explicit.
        setOptimisticMessages((prev) =>
          prev
            .filter((m) => m.messageId !== loadingOptimisticMsg.messageId)
            .map((m) => m.messageId === userOptimisticMsg.messageId ? { ...m, deliveryStatus: 'failed' } : m)
        );
        setSessionActive(currentSessionId, false);
      }
    },
    [currentSessionId, currentUser.id, currentUser.name, forceRefresh, agents, setSessionActive, updateLastMessage, recordUserMessageSent]
  );

  const handleRegenerateMessage = useCallback(async (msg: WorkspaceMessage) => {
    if (!currentSessionId) return;
    const agentName = msg.senderName;
    const prompt = `@${agentName} please regenerate your previous response with improvements`;
    toast.info(`Regenerating response from @${agentName}...`);
    await handleSend(prompt, [agentName]);
  }, [currentSessionId, handleSend]);

  const handleQuoteReply = useCallback((msg: WorkspaceMessage) => {
    const lines = msg.content.trim().split('\n');
    const quoteSnippet = lines.slice(0, 4).map((l) => `> ${l}`).join('\n') + (lines.length > 4 ? '\n> ...' : '');
    const prefix = `@${msg.senderName} `;
    const next = currentDraft ? `${currentDraft}\n\n${quoteSnippet}\n\n${prefix}` : `${quoteSnippet}\n\n${prefix}`;
    handleDraftChange(next);
    setFocusKey((k) => k + 1);
    toast.success(`Quoted @${msg.senderName}'s message into composer`);
  }, [currentDraft, handleDraftChange]);

  /*
    Replace the draft rather than append to it: this is "say that again, but
    right", not "add this below what I was writing". Anything already typed
    would be a different thought and joining the two produces neither.
  */
  const handleReusePrompt = useCallback((msg: WorkspaceMessage) => {
    handleDraftChange(msg.content);
    setFocusKey((k) => k + 1);
  }, [handleDraftChange]);

  /*
    RECORD WHAT THIS THREAD IS ABOUT, ONCE.

    The sidebar cannot compute this: the sessions list carries no transcript,
    only the newest message, which is how threads ended up named after whatever
    an agent last said — including its crashes. Here the whole conversation is
    loaded, so the first thing the user actually asked for is available, and it
    is written down the first time it is seen and never again.

    Deliberately not gated on the session being untitled: the cache is a
    fallback the sidebar consults only when there is no explicit title, so
    recording it for a named thread costs one localStorage entry and makes the
    name correct the moment someone clears the title.
  */
  useEffect(() => {
    if (!currentSessionId || displayMessages.length === 0) return;
    if (getDerivedTitle(currentSessionId)) return;
    const derived = deriveTitleFromMessages(displayMessages);
    if (derived) rememberDerivedTitle(currentSessionId, derived);
  }, [currentSessionId, displayMessages]);

  const hasStatusMessages = displayMessages.some((m) => m.messageType === 'status' || m.messageType === 'thinking');

  if (!currentSessionId) {
    const isRoutinesView = viewMode === 'routines';
    return (
      <div className="flex flex-col flex-1 min-w-0 h-full bg-surface0 overflow-hidden">
        {/* Empty state header providing window drag region and sidebar toggle */}
        <div className="app-header sticky top-0 z-10 px-3.5">
          <div className="flex flex-1 items-center gap-2 lg:gap-3 min-w-0">
            {!isMobile && !isSidebarOpen && (
              <Hint label="Expand Sidebar">
                <button
                  onClick={sidebarToggle}
                  className="size-7 flex items-center justify-center rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors shrink-0 -ml-1"
                >
                  <PanelLeft className="size-4" />
                </button>
              </Hint>
            )}
            <span className="text-xs font-medium text-foreground-extra-muted">
              {isRoutinesView ? 'Routines' : 'Messages'}
            </span>
          </div>
        </div>

        <div className="flex flex-col flex-1 items-center justify-center text-center text-muted-foreground px-8">
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
            <div className="flex items-center justify-center size-11 rounded-xl bg-surface2 border border-border mb-4">
              <MessageSquare className="size-5 text-foreground-muted" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {agents.length > 0 ? 'No channel selected' : 'No agents connected yet'}
            </p>
            <p className="text-xs mt-1 max-w-xs">
              {agents.length > 0
                ? 'Pick a channel from the sidebar, or create one and choose who joins.'
                : 'Connect an agent first — a channel needs at least one participant.'}
            </p>
            {/*
              There is always an action here. Previously the button was gated on
              `agents.length > 0`, so the state a brand-new workspace actually
              lands in — no agents — was the one with nothing to click.
            */}
            <Button
              variant="outline"
              className="mt-5 gap-1.5"
              onClick={agents.length > 0 ? openNewThread : () => setViewMode('mission')}
            >
              <Plus className="size-4" />
              {agents.length > 0 ? 'New channel' : 'Connect an agent'}
            </Button>
            {/* Desktop apps teach their shortcuts in the empty pane. Every
                cap here is read from the keymap (lib/shortcuts.ts), so it
                cannot go back to advertising a key nothing listens for —
                which is what `Ctrl+N` was doing here. */}
            <div className="mt-7 flex items-center gap-4 text-3xs text-foreground-extra-muted">
              <span className="inline-flex items-center gap-1.5">
                <KeyCombo keys={shortcutKeys('new-chat')} />
                new chat
              </span>
              <span className="inline-flex items-center gap-1.5">
                <KeyCombo keys={shortcutKeys('palette')} />
                commands
              </span>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event(SHORTCUTS_EVENT))}
                className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
              >
                <KeyCombo keys={shortcutKeys('help')} />
                all shortcuts
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full bg-surface0 overflow-hidden">
        {/* Thread header */}
      {/*
        `.app-header` (globals.css) owns the height, border, fill and padding —
        the same contract Tasks / Mission / Skills / Knowledge / Settings use, so
        this bottom border and the sidebar's are one continuous line. It no
        longer reserves space for the native window buttons either: those live
        in AppTitlebar above, which is also the app's single drag region.
      */}
      <div className="app-header sticky top-0 z-10 px-3.5">
        <div className="flex flex-1 items-center gap-2 lg:gap-3 min-w-0">
          {/* Sidebar Toggle — desktop only, shown when sidebar is collapsed */}
          {!isMobile && !isSidebarOpen && (
            <Hint label="Expand Sidebar">
              <button
                onClick={sidebarToggle}
                className="size-7 flex items-center justify-center rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors shrink-0 -ml-1"
              >
                <PanelLeft className="size-4" />
              </button>
            </Hint>
          )}
          {isDM ? (
            <h2 className="text-sm font-bold tracking-tight truncate flex items-center gap-2 text-foreground">
              <MessageSquare className="size-4 text-muted-foreground" />
              <span>{currentSessionId!.slice(3).split(',').map(stripAddressPrefix).join(' ↔ ')}</span>
              <span className="text-3xs px-2 py-0.5 rounded-full bg-surface3/80 text-muted-foreground border border-border/60 font-mono">
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
                if (isComposing(e)) return;
                if (isComposing(e)) return;
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="text-sm font-semibold tracking-tight bg-surface2/50 border-b-2 border-border-accent px-2 py-0.5 rounded-t min-w-0 max-w-[300px] text-foreground h-7"
              autoFocus
            />
          ) : (
            /*
              beUI stacks a muted subtitle under the title ("Checkout release"
              over "Agent workspace · focused patch"). The second line here is
              the two facts this header already had scattered across it: which
              folder the thread is bound to, and how many agents are in it.
            */
            <Hint label="Click to rename">
              <div className="flex min-w-0 flex-col" onClick={startEditingTitle}>
                <h2 className="truncate text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-foreground-muted">
                  {currentSession?.title || 'Channel'}
                </h2>
                <span className="truncate text-[11px] leading-tight text-muted-foreground">
                  {[
                    currentSessionWorkingDir ? basename(currentSessionWorkingDir) : null,
                    activeHeaderAgents.length > 0
                      ? `${activeHeaderAgents.length} agent${activeHeaderAgents.length > 1 ? 's' : ''}`
                      : 'no agents',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            </Hint>
          )}

          {/*
            beUI's connection pill, top-right of the shell: `bg-emerald-500/10`
            when live. It replaces nothing — this header never said, in one
            place, whether the workspace was actually connected.
          */}
          {!isDM && (
            <span
              className={cn(
                'ml-auto hidden shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline-flex',
                activeHeaderAgents.length > 0
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {activeHeaderAgents.length > 0 ? 'Connected' : 'Offline'}
            </span>
          )}

          {/*
            Who is in this channel, and whether any of them is mid-task.
            "Working" used to be an amber pill wrapping a three-bar audio
            equalizer, each bar carrying its own amber glow — five moving parts
            and a fourth accent hue to say one thing. It now says it the same way
            a running tool call and a streaming reasoning block do: the shimmer
            (`.event-running`), on the words themselves. One signal for "still
            going", everywhere in the app.
          */}
          {!isDM && activeHeaderAgents.length > 0 && (
            <div className="hidden sm:flex items-baseline gap-2 shrink min-w-0 max-w-[45%]">
              {workingHere.length > 0 ? (
                <span className="event-running inline-flex items-baseline gap-1.5 text-xs min-w-0 text-foreground-muted">
                  <span className="truncate text-foreground">{workingHere.join(', ')}</span>
                  <span className="shrink-0">working</span>
                </span>
              ) : (
                <Hint label={`${activeHeaderAgents.length} connected agent${activeHeaderAgents.length > 1 ? 's' : ''} — ${activeHeaderAgents.join(', ')}`}>
                  <span className="flex items-center gap-1.5 min-w-0 text-xs text-foreground-muted">
                    <span className="flex items-center -space-x-1.5">
                      {activeHeaderAgents.slice(0, 4).map((name) => (
                        <AgentAvatar
                          key={name}
                          name={name}
                          agentType={agents.find((a) => a.agentName === name)?.agentType}
                          size={18}
                          status="online"
                          className="ring-1 ring-surface0 rounded-full shrink-0"
                        />
                      ))}
                    </span>
                    {activeHeaderAgents.length > 4 && (
                      <span className="shrink-0 text-3xs font-mono tabular-nums text-foreground-extra-muted">
                        +{activeHeaderAgents.length - 4}
                      </span>
                    )}
                    <span className="shrink-0 text-3xs font-mono text-emerald-500 font-medium">online</span>
                  </span>
                </Hint>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Orchestration Mode Header Control */}
          {currentSession && !isDM && (
            <OrchestrationControl
              session={currentSession}
              agents={agents}
              onChange={(updates) => {
                if (currentSessionId) {
                  setSessionOrchestration(currentSessionId, updates);
                }
              }}
              variant="standalone"
            />
          )}

          {/*
            THE ROW HAS TWO KINDS OF THING IN IT, AND NOW SAYS SO.

            Five controls sat in one undifferentiated 8px-gapped line: mode,
            quota, context, branch, panel, overflow. Three of them REPORT
            something you can open for detail; two PERFORM something. Nothing on
            screen distinguished those, so the header read as a row of assorted
            widgets — which is most of why it felt busy at a glance while
            actually carrying very little.

            Shape carries the distinction (pills report, squares act — see
            headers/header-chip.ts) and a hairline carries the grouping. The
            reporting chips also drop the `bg-surface2/60` tray they used to
            share: a translucent ground behind two chips that already have their
            own ground was a third fill for one idea, and with the chips now on
            one recipe the grouping no longer needs a container to be legible.
          */}
          <div className="flex items-center gap-1.5">
            <AgentQuotaCapsule agentName={activeModelAgentName} />
            <ContextHealthIndicator channelName={currentSessionId} />
            <GitChip channelId={gitChannelId} status={gitStatus} refresh={refreshGit} />
          </div>

          <span className="h-4 w-px bg-border shrink-0 mx-0.5" aria-hidden />

          {/* Unified Studio Panel Toggle */}
          <Hint label={activeRightTab !== null ? 'Close Studio panel' : 'Open Studio panel'}>
            <button
              onClick={() => setActiveRightTab(activeRightTab !== null ? null : 'preview')}
              className={cn(
                headerIconButtonClass,
                activeRightTab !== null && 'bg-surface3 text-foreground border border-border',
              )}
            >
              <PanelRight className="size-4" />
            </button>
          </Hint>

          {/* More Actions Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Hint label="More actions">
                <button className={headerIconButtonClass}>
                  <MoreHorizontal className="size-4" />
                </button>
              </Hint>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => setActiveRightTab(activeRightTab === 'tokens' ? null : 'tokens')}>
                <Coins className="size-4 mr-2 text-foreground-muted" />
                <span>Token & Context Dashboard</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setActiveRightTab(activeRightTab === 'trace' ? null : 'trace')}>
                <Activity className="size-4 mr-2 text-foreground-muted" />
                <span>Execution Trace</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleExportMarkdown()} disabled={exporting || !currentSessionId}>
                <Download className="size-4 mr-2" />
                <span>Export as Markdown</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShareDialogOpen(true)}>
                <Share2 className="size-4 mr-2" />
                <span>Share conversation</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setViewMode(viewMode === 'tasks' ? 'threads' : 'tasks')}>
                <ListChecks className="size-4 mr-2" />
                <span>Tasks &amp; Issues</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/*
            THE APP'S BUTTONS END HERE; THE OPERATING SYSTEM'S BEGIN.

            `.app-header` reserves `--window-controls-inset` (138px) at its end
            so nothing is drawn under the native minimise / maximise / close
            glyphs — but reserving space is not the same as marking a boundary.
            On screen the app's own 30px icon buttons ran straight into three
            OS buttons of a different size, a different weight and a different
            hit target, with nothing between them but empty chrome, so the six
            read as one ragged row.

            The rule above separates pills from squares — things that report
            from things that act. This one separates ours from the system's,
            which is the bigger jump of the two and was the only one unmarked.
            It is drawn only on desktop, because in a browser tab the reserve
            is 0 and there is nothing on the other side of it.
          */}
          <span
            className="desktop-only h-4 w-px bg-border shrink-0 ms-1"
            aria-hidden
          />
        </div>
      </div>

      {/* Missing-description warning — routing accuracy (dynamic/workflow router
          and the master's own delegation) depends on agent descriptions. Nudge
          the user to fill any that are blank; each chip opens that agent's
          profile, where a one-click auto-generate button drafts one. */}
      {!isDM && !dismissedRoutingWarning && (() => {
        const participants = currentSession?.participants || [];
        const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
        if (sessionAgents.length <= 1) return null;
        const missing = sessionAgents.filter((a) => !a.description || !a.description.trim());
        if (missing.length === 0) return null;
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 overflow-x-auto bg-surface2 text-status-warning">
            <AlertTriangle className="size-3.5 shrink-0 text-status-warning" />
            <span className="text-2xs leading-snug shrink-0 font-medium">
              Routing may be less accurate — no description for:
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {missing.map((a) => (
                <Hint key={a.agentName} label={`Add a description for ${a.agentName}`}>
                  <button
                    onClick={() => setSelectedAgentName(a.agentName)}
                    className="inline-flex items-center gap-1 text-2xs font-medium px-2 py-0.5 rounded-md bg-surface3 hover:bg-surface4 transition-colors text-foreground"
                  >
                    <Sparkles className="size-2.5 text-status-warning" />
                    {a.agentName}
                  </button>
                </Hint>
              ))}
            </div>
            <Hint label="Dismiss warning">
              <button
                onClick={() => setDismissedRoutingWarning(true)}
                className="ml-auto p-1 rounded-md hover:bg-surface3 text-foreground-extra-muted hover:text-foreground transition-colors shrink-0"
              >
                <X className="size-3.5" />
              </button>
            </Hint>
          </div>
        );
      })()}

      {/* Pipeline Stepper Widget */}
      <PipelineStepper channelId={currentSessionId} />

      {/* Messages */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {loading && displayMessages.length === 0 ? (
          /*
            `.event-running` — the app's ONE "still going" signal — instead of a
            ring spinner. globals.css says not to add a second one, and this was
            a second one: a 24px `animate-spin` in the middle of an otherwise
            empty pane, which reads as a stalled page rather than a thread that
            is a few hundred milliseconds from arriving.
          */
          <div className="flex items-center justify-center flex-1">
            <span className="event-running text-xs text-foreground-muted">Loading conversation</span>
          </div>
        ) : displayMessages.length === 0 ? (
          <div className="relative flex-1 flex flex-col items-center justify-center p-6 select-none overflow-y-auto">
            <div className="relative z-10 w-full max-w-2xl flex flex-col items-center text-center space-y-6 my-auto py-6">
              {/* Refined subtle status pill */}
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border/70 dark:border-white/[0.08] bg-surface1/80 dark:bg-white/[0.03] text-2xs font-medium text-muted-foreground shadow-xs">
                <span
                  className={cn(
                    'size-1.5 rounded-full shrink-0',
                    hasOnlineAgents
                      ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                      : 'bg-muted-foreground/40'
                  )}
                />
                <span>
                  {hasOnlineAgents
                    ? `${onlineAgents.length} ${onlineAgents.length === 1 ? 'agent' : 'agents'} online`
                    : 'Autonomous Workspace Ready'}
                </span>
                {!hasOnlineAgents && (
                  <button
                    type="button"
                    onClick={() => setViewMode('mission')}
                    className="text-foreground-extra-muted hover:text-foreground transition-colors ml-0.5 underline underline-offset-2"
                  >
                    Connect agent
                  </button>
                )}
              </div>

              {/* Brand SignalMark with subtle ambient scale */}
              <div className="relative flex items-center justify-center">
                <SignalMark size={72} />
              </div>

              {/* Dynamic OpenAI/Claude Greeting Header */}
              <div className="space-y-1.5 max-w-lg">
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
                  {(() => {
                    const h = new Date().getHours();
                    if (h < 5) return 'Good night';
                    if (h < 12) return 'Good morning';
                    if (h < 18) return 'Good afternoon';
                    return 'Good evening';
                  })()}, what can I help you build?
                </h1>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  Select a prompt below, or start typing to collaborate with your agents.
                </p>
              </div>

              {/* 4 Enterprise Interactive Prompt Inspiration Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full text-left pt-2">
                {PROMPT_SUGGESTIONS.map((item, idx) => {
                  const SuggestionIcon = item.icon;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        handleDraftChange(item.prompt);
                        setFocusKey((k) => k + 1);
                      }}
                      className={cn(
                        'flex items-start gap-3.5 p-3.5 rounded-2xl text-left cursor-pointer select-none group',
                        'bg-white/80 dark:bg-surface2/60 backdrop-blur-md hover:bg-white dark:hover:bg-[#202028]',
                        'border border-black/[0.08] dark:border-white/[0.08] hover:border-black/[0.16] dark:hover:border-white/[0.18]',
                        'shadow-xs hover:shadow-[0_4px_16px_rgba(0,0,0,0.05)] dark:hover:shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:-translate-y-0.5',
                        'transition-all duration-200 active:scale-[0.99]'
                      )}
                    >
                      <div className="size-8 rounded-xl bg-surface1/80 dark:bg-white/[0.06] border border-black/[0.05] dark:border-white/[0.08] flex items-center justify-center shrink-0 group-hover:border-primary/30 group-hover:bg-primary/5 transition-colors">
                        <SuggestionIcon className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-foreground flex items-center justify-between">
                          <span>{item.title}</span>
                          <span className="text-3xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity font-mono">
                            ↵
                          </span>
                        </div>
                        <div className="text-2xs text-muted-foreground line-clamp-2 mt-1 leading-relaxed">
                          {item.desc}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Sleek Workspace Navigation Quick Bar */}
              <div className="pt-2 flex flex-wrap items-center justify-center gap-4 text-2xs text-foreground-extra-muted select-none">
                <button
                  type="button"
                  onClick={() => setViewMode('tasks')}
                  className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  <CheckCircle2 className="size-3.5" />
                  <span>Tasks &amp; Issues</span>
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
                  }}
                  className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  <Search className="size-3.5" />
                  <span>Command Palette (Ctrl+K)</span>
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => openSettings('general')}
                  className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  <Settings className="size-3.5" />
                  <span>Settings</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <ChatMessages
            messages={displayMessages}
            agents={agents}
            showAllSteps={showAllSteps}
            scrollKey={scrollKey}
            loadOlder={loadOlder}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            workingDir={currentSessionWorkingDir}
            onRegenerate={handleRegenerateMessage}
            onQuoteReply={handleQuoteReply}
            onReusePrompt={handleReusePrompt}
            className="flex-1 overflow-y-auto px-4 lg:px-8 py-4"
          />
        )}

        {/* Input — hidden for read-only DM views */}
        {!isDM && (
          <div className="px-4 lg:px-8 pb-4 pt-1">
            {/* Shares `--chat-column` with the message list above it. */}
            <div className="mx-auto w-full max-w-(--chat-column)">
              {/*
                THE "NO AGENTS ONLINE" BANNER WAS DELETED, not restyled.

                It said "No agents are online -- connect one before starting a
                conversation" in an amber box. Twelve pixels below it the
                composer's own placeholder says "Connect an agent to start
                chatting...", and twenty pixels below THAT the agent switcher
                reads "Offline" and opens a picker that lists the unconfigured
                agents you would connect. One fact, three statements, one
                screenful apart -- and the banner was the only one of the three
                that could not act on it directly.

                Amber was also the wrong register. Nothing has gone wrong here:
                you have not connected an agent yet, which is the ordinary
                first-run state of a fresh workspace. Spending the warning
                colour on a normal precondition is how users learn to ignore
                amber where it does mean something.

                What is lost is the "Go to connect" shortcut into Mission
                Control. The switcher below reaches the same agents in one
                click without leaving the thread, so that is a shorter path,
                not a missing one.

                The `isMissingParticipant` banner below stays: an agent that
                WAS in this thread having gone offline is genuinely unexpected,
                nothing else on screen says it, and there is no control in the
                composer that fixes it.
              */}
              {isMissingParticipant ? (
                /*
                  THE BANNER KEEPS ITS AMBER, THE BANNER IS NOT MADE OF AMBER.

                  It was a full-width `--status-muted-warning` fill (#fef3c7)
                  directly above the composer — and since the rest of the
                  palette is achromatic, that made a routine "an agent went
                  offline" notice the single most saturated object in a healthy
                  window. The eye went there first, every time, past the
                  transcript and past the composer.

                  The signal now lives where signals belong: the icon. The
                  container is ordinary chrome with a warning-tinted border, so
                  the banner still reads as "something is off" at a glance
                  without outranking the conversation it is interrupting. This
                  is the same argument the deleted "no agents online" banner
                  lost above — spending the warning colour freely is how it
                  stops meaning anything.
                */
                <div /*
                    Same radius and the same border token as the composer it
                    sits 10px above. It had `rounded-xl` against the composer's
                    24, and `border-status-warning/35` against the composer's
                    `--border` — two surfaces that read as one stacked object
                    and disagreed about both of its edges. The warning now
                    lives only in the icon, which is where the earlier pass
                    already decided it belongs.
                  */
                  className="mb-2.5 flex items-center justify-between gap-3 px-3.5 py-2 rounded-2xl bg-surface1 border border-border text-foreground text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle className="size-3.5 shrink-0 text-status-warning" />
                    <span className="truncate">
                      The agents assigned to this thread ({sessionParticipants.map(p => `@${p}`).join(', ')}) are offline
                    </span>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {onlineAgents.slice(0, 2).map((a) => (
                      <button
                        key={a.agentName}
                        type="button"
                        onClick={() => currentSessionId && addParticipant(currentSessionId, a.agentName)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface2 hover:bg-surface3 border border-border/60 text-foreground text-2xs font-medium transition-colors"
                      >
                        <Plus className="size-3" />
                        <span>Add @{a.agentName}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setViewMode('mission')}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface2 hover:bg-surface3 border border-border/60 text-foreground text-2xs font-medium transition-colors"
                    >
                      <span>Connect</span>
                    </button>
                  </div>
                </div>
              ) : currentSession && (currentSession.participants?.length ?? 0) === 0 && (
                <div className="mb-2.5 flex items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-surface1/90 border border-border/60 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Sparkles className="size-3.5 text-primary" />
                    <span>Choose the agents for this conversation</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {onlineAgents.map((agent) => (
                      <button
                        key={agent.agentName}
                        onClick={() => {
                          if (currentSessionId) addParticipant(currentSessionId, agent.agentName);
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface2 hover:bg-primary/15 hover:text-primary border border-border/60 text-2xs font-medium transition-colors"
                      >
                        <AgentAvatar name={agent.agentName} size={14} />
                        <span>@{agent.agentName}</span>
                        <Plus className="size-3 opacity-60" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {currentSessionId && <ThreadStatusBar channelName={currentSessionId} messages={displayMessages} />}
              <ChatInput
                onSend={handleSend}
                agents={agents}
                knowledge={knowledge}
                session={currentSession || undefined}
                onOrchestrationChange={(updates) => currentSessionId && setSessionOrchestration(currentSessionId, updates)}
                onMasterChange={(agentName) => currentSessionId && setSessionMaster(currentSessionId, agentName)}
                draft={currentDraft}
                onDraftChange={handleDraftChange}
                onFocusChange={(focused) => focused ? notifyFocus() : notifyBlur()}
                focusKey={focusKey}
                onCreateRoutine={() => setShowCreateRoutine(true)}
                workingDir={currentSessionWorkingDir}
                isWorking={!!currentSessionId && (activeSessionIds.has(currentSessionId) || stoppingSessionIds.has(currentSessionId))}
                stopping={!!currentSessionId && stoppingSessionIds.has(currentSessionId)}
                onStop={() => currentSessionId && stopAllAgents(currentSessionId)}
                disabled={!currentUser.name.trim() || !canChatInCurrentSession}
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
    </div>
  );
}
