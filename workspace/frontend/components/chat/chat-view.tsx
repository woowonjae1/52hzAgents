'use client';

import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { ChatMessages } from './chat-messages';
import { ChatInput, type PendingFile } from './chat-input';
import { ThreadStatusBar } from './thread-status-bar';
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
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ListTree, ListChecks, MessageSquare, MessageSquarePlus, CalendarClock, Square, MoreHorizontal, X, Plus, Globe, Share2, Crown, AlertTriangle, Sparkles, Users, FileText, PanelLeft, PanelRight, Terminal, Check, Code2, Search, Zap, Layers, ArrowRight } from 'lucide-react';
import { ShareDialog } from './share-dialog';
import { OrchestrationControl } from './orchestration-control';
import { useLayout } from '@/components/layout/layout-context';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { CreateRoutineDialog } from '@/components/routines/create-routine-dialog';
import { GitChip } from '@/components/git/git-chip';
import { useGitStatus } from '@/lib/use-git-status';
import { AgentQuotaCapsule } from './agent-quota-capsule';
import { AgentModelSwitcher } from './agent-model-switcher';
import { eventToMessage } from '@/lib/types'; 
import type { WorkspaceMessage } from '@/lib/types';

const PROMPT_SUGGESTIONS = [
  {
    icon: '⚡',
    title: '代码重构与审查',
    desc: '审查当前工作区代码质量，指出潜在隐患并给出重构建议',
    prompt: '请帮我全面审查当前工作区的核心代码架构与实现，指出潜在的逻辑或性能隐患，并给出优化建议。',
  },
  {
    icon: '🔍',
    title: '深度搜索与调研',
    desc: '联网检索主流技术方案，输出对比评测分析报告',
    prompt: '请帮我调研当前主流的本地多 Agent 协同架构方案与最佳实践，并对比它们的优缺点。',
  },
  {
    icon: '💻',
    title: '终端自动化排查',
    desc: '运行本地命令，检测开发环境依赖与系统运行状态',
    prompt: '请帮我检查当前项目的 Git 提交状态与环境依赖完整性，并排查潜在异常。',
  },
  {
    icon: '📐',
    title: '架构设计与接口规划',
    desc: '规划新业务模块的架构设计与前后端 API 规范',
    prompt: '请为我们即将开发的新功能编写一份系统架构设计说明书与核心接口定义草案。',
  },
];

/**
 * The side panels, previously four always-visible toolbar buttons. They are
 * collapsed into a single dropdown to keep the thread header quiet — but they
 * stay in the header rather than moving into Settings, because these are view
 * switchers people toggle constantly, not configuration.
 */
const SIDE_PANELS = [
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
  return address.replace(/^openagents:/, '');
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
  const { agents, currentUser, currentSessionId, setCurrentSessionId, sessions, createSession, updateLastMessage, setSessionActive, updateAgentMode, stopAllAgents, activeSessionIds, workingAgentNames, stoppingSessionIds, renameSession, addParticipant, removeParticipant, setSessionMaster, setSessionOrchestration, consumeSkipFocus, createRoutine, knowledge, recordUserMessageSent } = useWorkspace();
  
  useEffect(() => {
    console.log('[52hzAgents Monitor] 💬 [ChatView] Active session:', currentSessionId, 'at', new Date().toISOString());
  }, [currentSessionId]);

  const [showCreateRoutine, setShowCreateRoutine] = useState(false);
  const {
    isMobile,
    openMobileList,
    viewMode,
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
  const channelAgentNames = currentSession?.participants ?? [];
  const workingHere = channelAgentNames.filter((name) => workingAgentNames.has(name));
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
    // Name the agent behind the status only when it is a real event. The
    // optimistic loading row guesses the recipient (the server decides the
    // actual target), so it must not put a name on the roster.
    const isOptimistic = Boolean(lastMsg.messageId?.startsWith('optimistic-'));
    setSessionActive(currentSessionId, isAgentWorking, isOptimistic ? null : lastMsg.senderName);
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
      updateLastMessage(currentSessionId, currentUser.name, content || 'Sent an attachment', false);
      recordUserMessageSent(currentSessionId);
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
            <p className="text-lg font-semibold text-foreground">开一个新频道</p>
            <p className="text-sm mt-1 max-w-xs">
              建一个频道,选好参与的 agent,就可以开始协作了。
            </p>
            {agents.length > 0 && (
              <Button className="mt-5 gap-1.5" onClick={openNewThread}>
                <Plus className="size-4" />
                New Channel
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  const isDesktop = typeof window !== 'undefined' && !!(window as unknown as { electronBridge?: unknown }).electronBridge;

  return (
    <div className="flex flex-col h-full bg-surface0">
      {/* Thread header */}
      <div className={`flex items-center gap-2 px-4 lg:px-6 py-3 border-b border-border/80 shrink-0 bg-surface0 sticky top-0 z-10 [app-region:drag] select-none ${isDesktop ? 'pr-36' : ''}`}>
        <div className="flex flex-1 items-center gap-2 lg:gap-3 min-w-0 [app-region:no-drag]">
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
          {isDM ? (
            <h2 className="text-sm font-semibold tracking-tight truncate flex items-center gap-1.5 text-foreground">
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
              className="text-sm font-semibold tracking-tight truncate cursor-pointer hover:text-muted-foreground transition-colors text-foreground"
              onClick={startEditingTitle}
              title="Click to rename"
            >
              {currentSession?.title || 'Channel'}
            </h2>
          )}

          {/* Agent status for this channel — moved here from the sidebar roster.
              Working is a property of a conversation, not of the workspace
              list. */}
          {!isDM && channelAgentNames.length > 0 && (
            <div className="hidden sm:flex items-center gap-2 shrink min-w-0 max-w-[45%]">
              <span className="h-3.5 w-px bg-border/70 shrink-0" />
              {workingHere.length > 0 ? (
                <span className="flex items-center gap-1.5 min-w-0 text-[12.5px]">
                  <span className="flex items-end gap-[2px] h-3 shrink-0">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="working-bar w-[2px] h-3 rounded-full bg-status-warning"
                        style={{ animationDelay: `${i * 0.2}s` }}
                      />
                    ))}
                  </span>
                  <span className="font-medium text-foreground truncate">{workingHere.join('、')}</span>
                  <span className="text-foreground-muted shrink-0">工作中</span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5 min-w-0 text-[12.5px] text-foreground-muted">
                  <span className="size-1.5 rounded-full bg-surface4 shrink-0" />
                  <span className="truncate">{channelAgentNames.join('、')}</span>
                  <span className="shrink-0">空闲</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 [app-region:no-drag]">
          {/* Claude Model Switcher (only shown when Claude is in thread & connected) */}
          <AgentModelSwitcher
            agentName={channelAgentNames.find((n) => n.toLowerCase().includes('claude')) || 'claude'}
            sessionId={currentSessionId}
          />

          {/* Claude 5-hour & weekly quota capsule (only shown when Claude is in thread & connected) */}
          <AgentQuotaCapsule agentName={channelAgentNames.find((n) => n.toLowerCase().includes('claude')) || 'claude'} />

          {/* Git — a compose surface (stage/commit/sync), not a settings
              toggle, so it keeps its own always-visible trigger rather than
              nesting a commit textarea inside the overflow menu below. */}
          <GitChip channelId={gitChannelId} status={gitStatus} refresh={refreshGit} />

          {/* Everything else — new topic, agent membership, step detail,
              side panels, collaboration mode, share — lives behind one
              overflow menu so the header reads as title-plus-one-button. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" mode="icon" size="sm" title="More">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* New topic — same agents, empty context. The participants are
                  inherited from this thread on purpose: a channel with no
                  members falls back to every agent in the workspace on the
                  backend, which would make the first message fan out to everyone. */}
              {!isDM && (currentSession?.participants?.length ?? 0) > 0 && (
                <DropdownMenuItem
                  onClick={() => void createSession({ participants: currentSession!.participants })}
                  className="gap-2 text-xs"
                >
                  <MessageSquarePlus className="size-3.5 text-foreground-muted" />
                  New topic
                </DropdownMenuItem>
              )}

              {/* Manage thread agents (add / remove / set leader). Deliberately
                  shown even with zero agents: this is the only way to add one. */}
              {!isDM && (() => {
                const participants = currentSession?.participants || [];
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
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2 text-xs">
                      <Users className="size-3.5 text-foreground-muted" />
                      Manage agents
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56">
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
                                  className="flex items-center gap-1 text-[10px] text-status-warning shrink-0"
                                  title="Channel leader — receives messages that don't @mention anyone"
                                >
                                  <Crown className="size-3" /> leader
                                </span>
                              ) : (
                                <button
                                  onClick={() => currentSessionId && setSessionMaster(currentSessionId, agent.agentName)}
                                  className="size-5 flex items-center justify-center rounded hover:bg-surface3 text-muted-foreground hover:text-status-warning opacity-0 group-hover:opacity-100 transition-all shrink-0"
                                  title="Set as thread leader"
                                >
                                  <Crown className="size-3" />
                                </button>
                              )}
                              {inThread.length > 1 && (
                                <button
                                  onClick={() => currentSessionId && removeParticipant(currentSessionId, agent.agentName)}
                                  className="size-5 flex items-center justify-center rounded hover:bg-surface3 text-muted-foreground hover:text-status-danger opacity-0 group-hover:opacity-100 transition-all shrink-0"
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
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors"
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
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })()}

              {/* All steps toggle */}
              {hasStatusMessages && (
                <DropdownMenuCheckboxItem
                  checked={showAllSteps}
                  onCheckedChange={(v) => setShowAllSteps(v)}
                  className="gap-2 text-xs"
                >
                  <ListTree className="size-3.5 text-foreground-muted" />
                  Show all steps
                </DropdownMenuCheckboxItem>
              )}

              {/* Side panels (see SIDE_PANELS) */}
              {!isMobile && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2 text-xs">
                    <PanelRight className="size-3.5 text-foreground-muted" />
                    Panels
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44">
                    {SIDE_PANELS.map((panel) => {
                      const Icon = panel.icon;
                      const isOpen = activeRightTab === panel.id;
                      return (
                        <DropdownMenuItem
                          key={panel.id}
                          onClick={() => setActiveRightTab(isOpen ? null : panel.id)}
                          className="gap-2 text-xs"
                        >
                          <Icon className="size-3.5 text-foreground-muted" />
                          <span className="flex-1">{panel.label}</span>
                          {isOpen && <Check className="size-3.5" />}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}

              {/* Collaboration mode — only for multi-agent threads */}
              {!isDM && currentSession && (() => {
                const participants = currentSession.participants || [];
                const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
                if (sessionAgents.length < 2) return null;
                return (
                  <OrchestrationControl
                    variant="submenu"
                    session={currentSession}
                    agents={sessionAgents}
                    onChange={(updates) => setSessionOrchestration(currentSessionId!, updates)}
                  />
                );
              })()}

              <DropdownMenuSeparator />

              {/* Share conversation */}
              <DropdownMenuItem onClick={() => setShareDialogOpen(true)} className="gap-2 text-xs">
                <Share2 className="size-3.5 text-foreground-muted" />
                Share conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
          <div className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 overflow-x-auto bg-surface2 text-status-warning">
            <AlertTriangle className="size-3.5 shrink-0 text-status-warning" />
            <span className="text-[11px] leading-snug shrink-0 font-medium">
              Routing may be less accurate — no description for:
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {missing.map((a) => (
                <button
                  key={a.agentName}
                  onClick={() => setSelectedAgentName(a.agentName)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-surface3 hover:bg-surface4 transition-colors cursor-pointer text-foreground"
                  title={`Add a description for ${a.agentName}`}
                >
                  <Sparkles className="size-2.5 text-status-warning" />
                  {a.agentName}
                </button>
              ))}
            </div>
            <button
              onClick={() => setDismissedRoutingWarning(true)}
              className="ml-auto p-1 rounded-md hover:bg-surface3 text-foreground-extra-muted hover:text-foreground transition-colors shrink-0 cursor-pointer"
              title="Dismiss warning"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })()}

      {/* Messages */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {loading && displayMessages.length === 0 ? (
          <div className="flex items-center justify-center flex-1">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : displayMessages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 select-none overflow-y-auto">
            <div className="w-full max-w-2xl flex flex-col items-center text-center space-y-5 animate-[fadeIn_0.2s_ease-out]">
              {/* Brand Emblem */}
              <div className="size-12 rounded-2xl bg-surface2/80 border border-border/80 flex items-center justify-center shadow-xs">
                <Sparkles className="size-6 text-primary" />
              </div>

              {/* Title & Greeting */}
              <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                  有什么我可以协助你构建的？
                </h1>
                <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
                  52hzAgents 本地多 Agent 协同工作区 · 快捷呼出 · 深度推理与安全执行
                </p>
              </div>

              {/* 4 Interactive Prompt Starter Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left pt-2">
                {PROMPT_SUGGESTIONS.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      handleDraftChange(item.prompt);
                      setFocusKey((k) => k + 1);
                    }}
                    className="flex items-start gap-3 p-3 rounded-xl bg-surface1/80 hover:bg-surface2/90 border border-border/60 hover:border-border-accent/80 transition-all duration-150 cursor-pointer group shadow-2xs hover:shadow-xs text-left"
                  >
                    <div className="size-8 rounded-lg bg-surface2 flex items-center justify-center shrink-0 text-base group-hover:scale-105 transition-transform">
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-foreground group-hover:text-primary transition-colors flex items-center justify-between">
                        <span>{item.title}</span>
                        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity font-normal">
                          ↵
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5 leading-snug">
                        {item.desc}
                      </div>
                    </div>
                  </button>
                ))}
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
            className="flex-1 overflow-y-auto px-4 lg:px-8 py-4"
          />
        )}

        {/* Input — hidden for read-only DM views */}
        {!isDM && (
          <div className="px-4 lg:px-8 py-3 lg:py-4">
            {/* Shares `--chat-column` with the message list above it. */}
            <div className="mx-auto w-full max-w-(--chat-column)">
              {/* Agent Quick Selector Tray */}
              {currentSession && (currentSession.participants?.length ?? 0) === 0 && (
                <div className="mb-2.5 flex items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-surface1/90 border border-border/60 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Sparkles className="size-3.5 text-primary" />
                    <span>选择参与对话的 Agent：</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {agents.filter(a => a.status === 'online').length > 0 ? (
                      agents.filter(a => a.status === 'online').map((agent) => (
                        <button
                          key={agent.agentName}
                          onClick={() => {
                            if (currentSessionId) addParticipant(currentSessionId, agent.agentName);
                          }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface2 hover:bg-primary/15 hover:text-primary border border-border/50 text-[11px] font-medium transition-colors cursor-pointer"
                        >
                          <AgentAvatar name={agent.agentName} size={14} />
                          <span>@{agent.agentName}</span>
                          <Plus className="size-3 opacity-60" />
                        </button>
                      ))
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        默认自动路由至本地可用 Agent
                      </span>
                    )}
                  </div>
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
                workingDir={currentSessionWorkingDir}
                isWorking={!!currentSessionId && (activeSessionIds.has(currentSessionId) || stoppingSessionIds.has(currentSessionId))}
                stopping={!!currentSessionId && stoppingSessionIds.has(currentSessionId)}
                onStop={() => currentSessionId && stopAllAgents(currentSessionId)}
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

    </div>
  );
}
