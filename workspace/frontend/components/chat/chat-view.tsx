'use client';

import { Hint } from '@/components/ui/hint';
import { KeyCombo } from '@/components/ui/kbd';
import { shortcutKeys } from '@/lib/shortcuts';
import { SHORTCUTS_EVENT } from '@/components/layout/global-shortcuts';
import * as React from 'react';
import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { ChatMessages } from './chat-messages';
import { ChatInput, type PendingFile, type MentionSegment } from './chat-input';
import { ComposerHeaderBar, type TurnNavigationItem, type TeamPillMember } from './composer-header-bar';
import { ThreadStatusBar } from './thread-status-bar';
import { useWorkspace, isDraftSessionId } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { loadWorkspaceSnapshots, saveThreadSnapshot, SNAPSHOT_THREADS } from '@/lib/message-snapshot';
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
import { Download, Filter, ListTree, ListChecks, MessageSquare, MessageSquarePlus, Square, MoreHorizontal, X, Plus, Share2, Crown, AlertTriangle, Sparkles, PanelLeft, PanelRight, Terminal, Check, Code2, Search, Zap, Layers, ArrowRight, Radio, Plug, Settings, Loader2, CheckCircle2, Copy, FolderGit2 } from 'lucide-react';
import { ShareDialog } from './share-dialog';
import { ProjectWorkspaceDialog } from '@/components/project/project-workspace-dialog';

import { ParallelBatchPanel } from './parallel-batch-panel';
import { useLayout } from '@/components/layout/layout-context';
import { useArtifacts } from '@/lib/artifacts-context';
import { cn } from '@/lib/utils';
import { ChannelHeader } from './channel-header';
import { SidebarExpandButton } from '@/components/layout/sidebar-expand-button';
import { getApiBaseUrl } from '@/lib/config';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { basename } from '@/components/chat/project-folder-picker';
import {
  deriveTitleFromMessages,
  rememberDerivedTitle,
  getDerivedTitle,
} from '@/lib/thread-title';
import {
  TranscriptFilterBar,
  applyTranscriptFilter,
  isTranscriptFilterActive,
  EMPTY_TRANSCRIPT_FILTER,
  type TranscriptFilterState,
} from './transcript-filter';
import { SignalMark } from '@/components/brand/signal-mark';
import { CreateRoutineDialog } from '@/components/routines/create-routine-dialog';
import { SEND_FIRST_MESSAGE_EVENT, consumePendingFirstMessage, type FirstMessageRequest } from '@/lib/first-message';
import { useGitStatus } from '@/lib/use-git-status';

import { AgentModelSwitcher } from './agent-model-switcher';
import { getSnapshot, currentModelFor } from '@/lib/agent-model-store';
import { threadAgentMode } from '@/lib/agent-profiles';
import { PipelineStepper } from './pipeline-stepper';
import { AgentLanes } from './agent-lanes';
import { useAgentTurns } from '@/lib/use-agent-turns';
import { TRANSCRIPT_REVEAL_EVENT } from './chat-messages';
import { deduplicateAndSortMessages, eventToMessage, stripAddressPrefix } from '@/lib/types';
import type { WorkspaceMessage } from '@/lib/types';
import { conversationFilename, downloadTextFile, messagesToMarkdown } from '@/lib/export-markdown';
import { collectOutputs } from '@/lib/artifacts';
import { toast } from '@/lib/toast';

import { ChatWelcomeScreen, PROMPT_SUGGESTIONS } from './chat-welcome-screen';
import { SessionEmptyHero, HERO_SUGGESTIONS } from './session-empty-hero';
export { PROMPT_SUGGESTIONS, HERO_SUGGESTIONS };



import {
  SessionMessagesProvider,
  useSessionMessages,
  type SessionMessagesValue,
  messagesForSession,
  cacheMessages,
} from './session-messages-context';

export {
  SessionMessagesProvider,
  useSessionMessages,
  type SessionMessagesValue,
  messagesForSession,
  cacheMessages,
};

export function ChatView() {
  const { agents, currentUser, currentSessionId, setCurrentSessionId, sessions, createSession, updateLastMessage, setSessionActive, updateAgentMode, stopAllAgents, activeSessionIds, workingAgentNames, stoppingSessionIds, renameSession, addParticipant, removeParticipant, setSessionMaster, setSessionOrchestration, consumeSkipFocus, createRoutine, routines, routinesLoaded, knowledge, recordUserMessageSent, workspaceId, draftSession, materializeDraft, todos } = useWorkspace();
  
  useEffect(() => {
    console.log('[52hzAgents Monitor] [ChatView] Active session:', currentSessionId, 'at', new Date().toISOString());
  }, [currentSessionId]);

  const [showCreateRoutine, setShowCreateRoutine] = useState(false);
  const [projectWorkspaceOpen, setProjectWorkspaceOpen] = useState(false);
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
    selectedAgentName,
    setSelectedAgentName,
    openSettings,
  } = useLayout();
  const { isCanvasOpen, closeCanvas } = useArtifacts();
  const isStudioOpen = (activeRightTab !== null || isCanvasOpen) && !selectedAgentName;
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // The single poll for this session — shared with TracePanel. See
  // SessionMessagesProvider above.
  const { messages, loading, error: messagesError, forceRefresh, retryInitial, generation, loadOlder, hasOlder, loadingOlder } =
    useSessionMessages();

  const [parallelReviewNeeded, setParallelReviewNeeded] = useState(false);

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

  // Per-thread message drafts stored without triggering full ChatView re-renders
  const draftsRef = useRef<Record<string, string>>({});
  const [injectedDraft, setInjectedDraft] = useState<string | undefined>(undefined);

  // Save/restore draft when switching threads + cache messages
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Cache messages for instant switching back
    if (prevSessionIdRef.current && prevSessionIdRef.current !== currentSessionId && messages.length > 0) {
      cacheMessages(prevSessionIdRef.current, messages);
    }
    // Check if a pending draft was requested (e.g. from Skills view "Use in Chat")
    const pendingDraft = typeof window !== 'undefined' ? localStorage.getItem('52hz_pending_composer_draft') : null;
    if (pendingDraft) {
      try {
        localStorage.removeItem('52hz_pending_composer_draft');
      } catch {}
      setInjectedDraft(pendingDraft);
      prevSessionIdRef.current = currentSessionId;
      setOptimisticMessages([]);
      if (currentSessionId && !consumeSkipFocus()) setFocusKey((k) => k + 1);
      return;
    }
    // Restore draft for new session
    const restored = currentSessionId
      ? (draftsRef.current[currentSessionId] ?? (typeof window !== 'undefined' ? localStorage.getItem(`composer_draft_${currentSessionId}`) ?? '' : ''))
      : '';
    setInjectedDraft(restored);
    prevSessionIdRef.current = currentSessionId;
    // Clear optimistic messages when switching sessions
    setOptimisticMessages([]);
    // Focus the input when switching threads — unless the switch was made
    // via a keyboard shortcut (e.g. 1-9 from the sidebar), in which case
    // the user wanted to navigate, not start typing.
    if (currentSessionId && !consumeSkipFocus()) setFocusKey((k) => k + 1);
  }, [currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also listen for runtime draft injection (e.g. while already in the thread view)
  useEffect(() => {
    const handleApplyDraft = (e: Event) => {
      const custom = e as CustomEvent<string>;
      if (typeof custom.detail === 'string') {
        setInjectedDraft(custom.detail);
        setFocusKey((k) => k + 1);
      }
    };
    window.addEventListener('52hz_apply_composer_draft', handleApplyDraft);
    return () => window.removeEventListener('52hz_apply_composer_draft', handleApplyDraft);
  }, []);

  // Keep cache updated with latest messages for the current session
  useEffect(() => {
    if (currentSessionId) {
      cacheMessages(currentSessionId, messages);
    }
  }, [currentSessionId, messages]);

  const handleDraftChange = useCallback((draft: string) => {
    if (currentSessionId) {
      draftsRef.current[currentSessionId] = draft;
      try {
        localStorage.setItem(`composer_draft_${currentSessionId}`, draft);
      } catch {}
    }
    notifyTyping();
  }, [currentSessionId, notifyTyping]);

  const isDM = currentSessionId?.startsWith('dm:') ?? false;
  // The id to hand anything that talks to the server: null while the open
  // chat is still an unsent draft, which has nothing there to fetch.
  const serverSessionId = isDraftSessionId(currentSessionId) ? null : currentSessionId;
  const currentSession =
    sessions.find((s) => s.sessionId === currentSessionId) ??
    (draftSession && draftSession.sessionId === currentSessionId ? draftSession : undefined);

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
  const { status: gitStatus, refresh: refreshGit, channelId: gitChannelId } = useGitStatus(isDraftSessionId(currentSession?.sessionId) ? undefined : currentSession?.sessionId);
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
  const { rows: agentTurnRows } = useAgentTurns();

  const channelTurnRows = useMemo(
    () => currentSessionId ? agentTurnRows.filter((r) => r.channelName === currentSessionId) : [],
    [agentTurnRows, currentSessionId]
  );

  const runningTurnsHere = useMemo(
    () => channelTurnRows.filter((r) => r.state === 'running'),
    [channelTurnRows]
  );
  const agentTypeByName = useMemo(
    () => new Map(agents.map((a) => [a.agentName.toLowerCase(), a.agentType] as const)),
    [agents]
  );

  const runningAgentsInChannel = useMemo(() => {
    const s = new Set<string>();
    for (const r of channelTurnRows) {
      if (r.state === 'running') {
        s.add(r.agentName.toLowerCase());
      }
    }
    return s;
  }, [channelTurnRows]);

  const workingHere = useMemo(() => {
    return activeHeaderAgents.filter((name) => runningAgentsInChannel.has(name.toLowerCase()));
  }, [activeHeaderAgents, runningAgentsInChannel]);

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

  /*
    Transcript filter — the useful half of the old Trace panel, applied to the
    transcript itself. Reset whenever the thread changes: a filter is a question
    about ONE conversation, and carrying "only @pi" into the next thread would
    silently hide most of it.
  */
  const [filterOpen, setFilterOpen] = useState(false);
  const [transcriptFilter, setTranscriptFilter] = useState<TranscriptFilterState>(EMPTY_TRANSCRIPT_FILTER);
  useEffect(() => {
    setFilterOpen(false);
    setTranscriptFilter(EMPTY_TRANSCRIPT_FILTER);
  }, [currentSessionId]);
  const filterActive = isTranscriptFilterActive(transcriptFilter);
  const filteredMessages = useMemo(
    () => applyTranscriptFilter(displayMessages, transcriptFilter),
    [displayMessages, transcriptFilter]
  );
  const speakingAgents = useMemo(
    () =>
      Array.from(
        new Set(displayMessages.filter((m) => m.senderType === 'agent' && m.senderName).map((m) => m.senderName))
      ).sort(),
    [displayMessages]
  );
  const closeFilter = useCallback(() => {
    setFilterOpen(false);
    setTranscriptFilter(EMPTY_TRANSCRIPT_FILTER);
  }, []);

  const approvalResponses = useMemo(() => {
    const set = new Set<string>();
    for (const m of displayMessages) {
      const resp = m.metadata?.tool_approval_response;
      if (resp?.approval_id) {
        set.add(resp.approval_id);
      }
    }
    return set;
  }, [displayMessages]);

  const collectedOutputs = useMemo(() => {
    if (!displayMessages || displayMessages.length === 0) {
      return { documents: [], changedFiles: [] };
    }
    return collectOutputs(displayMessages);
  }, [displayMessages]);

  const outputsCount = useMemo(
    () => collectedOutputs.documents.length + collectedOutputs.changedFiles.length,
    [collectedOutputs]
  );

  const answeredDecisionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of displayMessages) {
      const resp = m.metadata?.decision_response;
      if (resp?.source_message_id) {
        ids.add(resp.source_message_id);
      }
    }
    return ids;
  }, [displayMessages]);

  const pendingActions = useMemo(() => {
    const list: { id: string; type: string; label: string }[] = [];
    for (const m of displayMessages) {
      const req = m.metadata?.tool_approval_request;
      if (req?.approval_id && !approvalResponses.has(req.approval_id)) {
        list.push({ id: m.messageId, type: 'approval', label: 'Tool approval' });
      }
      const hasQuestions =
        (Array.isArray(m.metadata?.questions) && m.metadata.questions.length > 0) ||
        (Array.isArray(m.metadata?.decision_questions) && m.metadata.decision_questions.length > 0);
      if (hasQuestions && !answeredDecisionIds.has(m.messageId)) {
        list.push({ id: m.messageId, type: 'decision', label: 'Decision needed' });
      }
      const routineId = m.metadata?.routine_proposal?.routine_id;
      if (routineId) {
        const listed = (routines || []).find((r) => r.id === routineId);
        const isPending = listed ? listed.status === 'pending_approval' : !routinesLoaded;
        if (isPending) {
          list.push({ id: m.messageId, type: 'routine', label: 'Routine proposal' });
        }
      }
    }
    if (parallelReviewNeeded) {
      list.push({ id: 'parallel-batch-panel', type: 'merge', label: 'Parallel merge review' });
    }
    return list;
  }, [displayMessages, approvalResponses, answeredDecisionIds, routines, routinesLoaded, parallelReviewNeeded]);

  // cdesktop-style ComposerHeaderBar derived props
  const userMessageTurns = useMemo<TurnNavigationItem[]>(() => {
    const turns: TurnNavigationItem[] = [];
    let turnNum = 1;
    for (const m of displayMessages) {
      const isHuman =
        m.senderType === 'human' ||
        m.senderType === 'user' ||
        m.senderName === 'User' ||
        (Boolean(currentUser?.name) && m.senderName === currentUser.name);
      if (isHuman && m.content.trim()) {
        turns.push({
          patchKey: m.messageId,
          content: m.content.trim().split('\n')[0] || m.content.trim(),
          turnNumber: turnNum++,
        });
      }
    }
    return turns;
  }, [displayMessages, currentUser?.name]);

  const sessionTodoItems = useMemo(() => {
    if (!currentSessionId) return [];
    return (todos || [])
      .filter((t) => t.channelName === currentSessionId)
      .map((t) => ({ content: t.content, status: t.status }));
  }, [todos, currentSessionId]);

  const inProgressTodoItem = useMemo(
    () =>
      sessionTodoItems.find(
        (t) => t.status === 'in_progress'
      ) ?? null,
    [sessionTodoItems]
  );

  const teamMembers = useMemo<TeamPillMember[]>(() => {
    const names =
      sessionParticipants.length > 0
        ? sessionParticipants
        : activeHeaderAgents;
    const hasPendingApproval = pendingActions.length > 0;
    return names.map((name, idx) => {
      const agentObj = agents.find(
        (a) => a.agentName.toLowerCase() === name.toLowerCase()
      );
      const isLead =
        (currentSession?.master &&
          currentSession.master.toLowerCase() === name.toLowerCase()) ||
        (!currentSession?.master && idx === 0);
      const isRunning = runningAgentsInChannel.has(name.toLowerCase());
      const status: TeamPillMember['status'] = isRunning
        ? 'running'
        : hasPendingApproval && isLead
          ? 'awaiting_approval'
          : agentObj?.status === 'offline'
            ? 'errored'
            : 'idle';
      return {
        agentName: name,
        agentType: agentObj?.agentType,
        isLead: Boolean(isLead),
        status,
      };
    });
  }, [
    sessionParticipants,
    activeHeaderAgents,
    agents,
    currentSession?.master,
    runningAgentsInChannel,
    pendingActions.length,
  ]);

  const composerFilesChanged = gitStatus?.available
    ? gitStatus.files.length
    : collectedOutputs.changedFiles.length;
  const composerLinesAdded = gitStatus?.available
    ? gitStatus.additions
    : undefined;
  const composerLinesRemoved = gitStatus?.available
    ? gitStatus.deletions
    : undefined;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const target = e.target as HTMLElement | null;
        if (target && target.getAttribute('data-transcript-search') === 'true') {
          return;
        }
        e.preventDefault();
        setFilterOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

    if (!currentSessionId) {
      return;
    }

    const isRunning = channelTurnRows.some((r) => r.state === 'running');
    const runningAgent = channelTurnRows.find((r) => r.state === 'running')?.agentName || null;
    const hasOptimistic = sessionOptimisticMessages.some((m) => m.messageType === 'loading');

    if (isRunning) {
      setSessionActive(currentSessionId, true, runningAgent);
      return;
    }

    if (hasOptimistic) {
      setSessionActive(currentSessionId, true, null);
      return;
    }

    // Authoritative idle if turns are reported
    if (channelTurnRows.length > 0) {
      setSessionActive(currentSessionId, false, null);
      return;
    }

    // Fallback heuristic only when turns have not been reported yet
    if (displayMessages.length === 0) {
      setSessionActive(currentSessionId, false, null);
      return;
    }

    const lastMsg = displayMessages[displayMessages.length - 1];
    if (lastMsg.senderType !== 'agent') {
      setSessionActive(currentSessionId, false, null);
      return;
    }
    const isTerm = isTerminalStatus(lastMsg.content);
    const isAgentWorking = !isTerm && (
      lastMsg.messageType === 'status' ||
      lastMsg.messageType === 'thinking' ||
      lastMsg.messageType === 'loading'
    );
    setSessionActive(currentSessionId, isAgentWorking, isAgentWorking ? lastMsg.senderName : null);
  }, [currentSessionId, channelTurnRows, sessionOptimisticMessages, displayMessages, setSessionActive, isTerminalStatus]);

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
      if (!currentUser.id || !currentUser.name.trim()) return;

      let sessionId: string;
      if (!currentSessionId) {
        try {
          const s = await createSession({ workingDir: currentSessionWorkingDir || undefined });
          sessionId = s.sessionId;
          setCurrentSessionId(sessionId);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not create new session');
          return;
        }
      } else {
        sessionId = currentSessionId;
      }

      // A new chat exists only as a draft until now: create the real channel
      // (with the agents, leader, mode and folder picked on the draft) and
      // send into that. Everything below uses the real id.
      const draftId = isDraftSessionId(sessionId) ? sessionId : null;

      // Create optimistic messages for instant feedback
      const timestamp = Date.now();
      const clientMessageId = globalThis.crypto?.randomUUID?.() || `web-${timestamp}-${Math.random().toString(36).slice(2)}`;
      const userContent = content || (files.length > 0 ? files.map((f) => f.file.name).join(', ') : '');
      const userOptimisticMsg: WorkspaceMessage = {
        messageId: `optimistic-user-${timestamp}`,
        sessionId: sessionId,
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
        sessionId: sessionId,
        senderName: predictedAgentName,
        senderType: 'agent',
        content: '',
        messageType: 'loading',
        mentions: [],
        targetAgents: null,
        createdAt: new Date().toISOString(),
        metadata: { _userContent: userContent },
      };

      // Add optimistic messages immediately and scroll to bottom so the UI transitions instantly without blank flash
      setOptimisticMessages((prev) => [
        ...prev.filter((m) => !(m.sessionId === sessionId && m.messageId.startsWith('optimistic-loading-'))),
        userOptimisticMsg,
        loadingOptimisticMsg,
      ]);
      updateLastMessage(sessionId, currentUser.name, content || 'Sent an attachment', false);
      recordUserMessageSent(sessionId);
      setSessionActive(sessionId, true);
      setScrollKey((k) => k + 1);

      // Materialize draft channel in background while optimistic message is already shown
      if (draftId) {
        try {
          sessionId = await materializeDraft(draftId);
          setOptimisticMessages((prev) =>
            prev.map((m) => (m.sessionId === draftId ? { ...m, sessionId } : m))
          );
          updateLastMessage(sessionId, currentUser.name, content || 'Sent an attachment', false);
          recordUserMessageSent(sessionId);
          setSessionActive(sessionId, true);
        } catch (err) {
          setOptimisticMessages((prev) => prev.filter((m) => m.sessionId !== draftId));
          toast.error(err instanceof Error ? err.message : 'Could not start the conversation');
          return;
        }
      }

      try {
        // Upload files first, then send message with attachment metadata
        let attachments: { fileId: string; filename: string; contentType: string; url: string }[] | undefined;
        if (files.length > 0) {
          const uploaded = await Promise.all(
            files.map((pf) => workspaceApi.uploadFile(pf.file, sessionId))
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
              (sessionId && localStorage.getItem(`52hz_model_${sessionId}_${agent.agentName}`)) ||
              (sessionId && localStorage.getItem(`52hz_model_${sessionId}_${agent.agentName.toLowerCase()}`)) ||
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
        // The thread's Fix/Review profile rides on every message: the adapter
        // runs this turn in that mode, whatever the agent does in other threads.
        msgMetadata.agent_mode = threadAgentMode(sessionId);

        const confirmation = await workspaceApi.sendMessage(
          sessionId,
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
        setSessionActive(sessionId, false);
      }
    },
    [currentSessionId, currentSessionWorkingDir, createSession, setCurrentSessionId, materializeDraft, currentUser.id, currentUser.name, forceRefresh, agents, setSessionActive, updateLastMessage, recordUserMessageSent]
  );

  const handleRegenerateMessage = useCallback(async (msg: WorkspaceMessage) => {
    if (!currentSessionId) return;
    const isHuman = msg.senderType === 'human' || msg.senderType === 'user' || msg.senderName === 'User' || (currentUser?.name && msg.senderName === currentUser.name);

    if (isHuman) {
      // Re-send user prompt directly to target agent(s) instead of requesting regeneration from user themselves
      const targetAgent = currentSession?.master || (agents.find((a) => a.status === 'online')?.agentName);
      if (targetAgent) {
        toast.info(`Retrying message to @${targetAgent}...`);
        await handleSend(msg.content, [targetAgent]);
      } else {
        await handleSend(msg.content);
      }
      return;
    }

    const agentName = msg.senderName;
    const msgIdx = messages.findIndex((m) => m.messageId === msg.messageId);
    let promptSnippet = '';
    if (msgIdx > 0) {
      for (let i = msgIdx - 1; i >= 0; i--) {
        const prev = messages[i];
        if (prev.senderType === 'human' || prev.senderType === 'user') {
          promptSnippet = prev.content.trim().split('\n').slice(0, 3).join(' ');
          break;
        }
      }
    }
    const isOldTurn = msgIdx >= 0 && msgIdx < messages.length - 2;
    const prompt = (isOldTurn && promptSnippet)
      ? `@${agentName} regarding "${promptSnippet}", please regenerate your response with improvements.`
      : `@${agentName} please regenerate your previous response with improvements`;
    toast.info(`Regenerating response from @${agentName}...`);
    await handleSend(prompt, [agentName]);
  }, [currentSessionId, handleSend, messages, currentSession, agents, currentUser?.name]);

  const handleQuoteReply = useCallback((msg: WorkspaceMessage) => {
    const lines = msg.content.trim().split('\n');
    const quoteSnippet = lines.slice(0, 4).map((l) => `> ${l}`).join('\n') + (lines.length > 4 ? '\n> ...' : '');
    const isSelfOrHuman = msg.senderType === 'human' || msg.senderType === 'user' || msg.senderName === 'User' || (currentUser?.name && msg.senderName === currentUser.name);
    const prefix = isSelfOrHuman ? '' : `@${msg.senderName} `;
    const curDraft = (currentSessionIdRef.current && draftsRef.current[currentSessionIdRef.current]) || '';
    const next = curDraft ? `${curDraft}\n\n${quoteSnippet}\n\n${prefix}` : `${quoteSnippet}\n\n${prefix}`;
    if (currentSessionIdRef.current) {
      draftsRef.current[currentSessionIdRef.current] = next;
      try {
        localStorage.setItem(`composer_draft_${currentSessionIdRef.current}`, next);
      } catch {}
    }
    setInjectedDraft(next);
    setFocusKey((k) => k + 1);
    toast.success(isSelfOrHuman ? 'Quoted message into composer' : `Quoted @${msg.senderName}'s message into composer`);
  }, [currentUser?.name]);

  /*
    Replace the draft rather than append to it: this is "say that again, but
    right", not "add this below what I was writing". Anything already typed
    would be a different thought and joining the two produces neither.
  */
  // Home's task box: "start the session and send this". See lib/first-message.
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // Consume any pending first message queued for this session immediately upon mount / session change
  useEffect(() => {
    if (!currentSessionId) return;
    const pending = consumePendingFirstMessage(currentSessionId);
    if (pending) {
      void handleSendRef.current(pending);
    }
  }, [currentSessionId]);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<FirstMessageRequest>).detail;
      if (!detail) return;
      if (detail.sessionId === currentSessionIdRef.current) {
        consumePendingFirstMessage(detail.sessionId);
        void handleSendRef.current(detail.text.trim());
      }
    };
    window.addEventListener(SEND_FIRST_MESSAGE_EVENT, onRequest);
    return () => window.removeEventListener(SEND_FIRST_MESSAGE_EVENT, onRequest);
  }, []);

  const handleReusePrompt = useCallback((msg: WorkspaceMessage) => {
    if (currentSessionIdRef.current) {
      draftsRef.current[currentSessionIdRef.current] = msg.content;
      try {
        localStorage.setItem(`composer_draft_${currentSessionIdRef.current}`, msg.content);
      } catch {}
    }
    setInjectedDraft(msg.content);
    setFocusKey((k) => k + 1);
  }, []);

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
    return (
      <div className="flex flex-col flex-1 min-w-0 h-full bg-surface0 overflow-hidden">
        {/* Empty state header providing window drag region and sidebar toggle */}
        <div className="app-header app-header-fade sticky top-0 z-10 px-3.5">
          <div className="flex flex-1 items-center gap-2 lg:gap-3 min-w-0">
            <SidebarExpandButton />
            <span className="text-xs font-medium text-foreground-extra-muted">
              Messages
            </span>
          </div>
        </div>

        <div className="flex flex-col flex-1 items-center justify-center text-center text-muted-foreground px-8">
          <div className="flex items-center justify-center size-11 rounded-xl bg-surface2 border border-border mb-4">
            <MessageSquare className="size-5 text-foreground-muted" />
          </div>
          <p className="text-sm font-semibold text-foreground">
            {agents.length > 0 ? 'No session selected' : 'No agents connected yet'}
          </p>
          <p className="text-xs mt-1 max-w-xs">
            {agents.length > 0
              ? 'Pick a session from the sidebar, or start a new one.'
              : 'Connect an agent first — a session needs at least one participant.'}
          </p>
          {/*
            There is always an action here. Previously the button was gated on
            `agents.length > 0`, so the state a brand-new workspace actually
            lands in — no agents — was the one with nothing to click.
          */}
          <Button
            variant="outline"
            className="mt-5 gap-1.5"
            onClick={agents.length > 0 ? openNewThread : () => setViewMode('home')}
          >
            <Plus className="size-4" />
            {agents.length > 0 ? 'New session' : 'Connect an agent'}
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
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full bg-surface0 overflow-hidden">
      <ChannelHeader
        currentSession={currentSession}
        currentSessionId={currentSessionId}
        isDM={isDM}
        agents={agents}
        activeHeaderAgents={activeHeaderAgents}
        sessionParticipants={sessionParticipants}
        workingHere={workingHere}
        currentSessionWorkingDir={currentSessionWorkingDir}
        gitChannelId={gitChannelId}
        gitStatus={gitStatus}
        refreshGit={refreshGit}
        outputsCount={outputsCount}
        isStudioOpen={isStudioOpen}
        filterOpen={filterOpen}
        filterActive={filterActive}
        exporting={exporting}
        onRenameSession={async (title) => {
          if (!currentSessionId) return;
          await renameSession(currentSessionId, title);
        }}
        onToggleFilter={() => {
          if (filterOpen || filterActive) closeFilter();
          else setFilterOpen(true);
        }}
        onToggleStudio={() => {
          if (isStudioOpen) {
            setActiveRightTab(null);
            closeCanvas();
          } else {
            if (selectedAgentName) setSelectedAgentName(null);
            setActiveRightTab('canvas');
          }
        }}
        onOpenProjectWorkspace={() => setProjectWorkspaceOpen(true)}
        onExportMarkdown={handleExportMarkdown}
      />

      {/* Missing-description warning — only shown in active threads with completely unconfigured agents */}
      {!isDM && !dismissedRoutingWarning && displayMessages.length > 0 && (() => {
        const participants = currentSession?.participants || [];
        const sessionAgents = agents.filter((a) => participants.includes(a.agentName));
        if (sessionAgents.length <= 1) return null;
        const missing = sessionAgents.filter((a) => (!a.description || !a.description.trim()) && (!a.role || !a.role.trim()));
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
      <PipelineStepper channelId={serverSessionId} verificationCmd={currentSession?.verificationCmd} />

      {/*
        Several agents mid-turn at once: one lane each. Parallel mode is left
        to ParallelBatchPanel below, whose lanes also carry worktree and diff.
      */}
      {(currentSession?.orchestrationMode || '') !== 'parallel' && (
        <AgentLanes
          className="mx-3 mb-2"
          runningTurns={runningTurnsHere}
          messages={messages}
          agentTypes={agentTypeByName}
        />
      )}

      {/*
        Parallel batches get their own view because the transcript stops being
        one. Sits beside the pipeline stepper for the same reason that exists:
        process that several messages belong to is not readable from the
        messages themselves.
      */}
      {serverSessionId && (
        <div className="px-3 pb-2" id="parallel-batch-panel">
          <ParallelBatchPanel
            channelName={serverSessionId}
            active={(currentSession?.orchestrationMode || '') === 'parallel'}
            onReviewStateChange={setParallelReviewNeeded}
          />
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {loading && displayMessages.length === 0 ? (
          <div className="flex-1 flex flex-col justify-end p-6 space-y-5 max-w-(--chat-column) mx-auto w-full animate-pulse select-none">
            <div className="flex items-start gap-3">
              <div className="size-8 rounded-full bg-surface2 shrink-0" />
              <div className="space-y-2 flex-1">
                <div className="h-4 bg-surface2 rounded w-28" />
                <div className="h-16 bg-surface2/70 rounded-2xl w-3/4" />
              </div>
            </div>
            <div className="flex items-start gap-3 justify-end">
              <div className="space-y-2 w-1/2">
                <div className="h-12 bg-surface3/80 rounded-2xl" />
              </div>
            </div>
          </div>
        ) : displayMessages.length === 0 ? (
          !loading && (messagesError || (currentSession && !isDraftSessionId(currentSession.sessionId) && currentSession.lastEventAt)) ? (
            <div className="relative flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
              <AlertTriangle className="size-8 text-status-warning mb-3 opacity-80" />
              <h3 className="text-sm font-semibold text-foreground">Could not load messages</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                {messagesError || 'This thread has past activity, but messages could not be retrieved from the server.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (retryInitial) retryInitial();
                  else forceRefresh();
                }}
                className="mt-4 px-3.5 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 border border-border text-xs font-medium text-foreground transition-colors cursor-pointer hover:border-border-hover"
              >
                Retry loading
              </button>
            </div>
          ) : (
            <SessionEmptyHero
              hasOnlineAgents={hasOnlineAgents}
              onlineAgentCount={onlineAgents.length}
              onConnectAgent={() => setViewMode('home')}
              onSelectPrompt={(prompt) => {
                setInjectedDraft(prompt);
                handleDraftChange(prompt);
                setFocusKey((k) => k + 1);
              }}
            >
              {!isDM && (
                <ChatInput
                  key={currentSessionId || 'empty-hero'}
                  onSend={handleSend}
                  agents={agents}
                  knowledge={knowledge}
                  session={currentSession || undefined}
                  onOrchestrationChange={(updates) => currentSessionId && setSessionOrchestration(currentSessionId, updates)}
                  onMasterChange={(agentName) => currentSessionId && setSessionMaster(currentSessionId, agentName)}
                  draft={injectedDraft}
                  onDraftChange={handleDraftChange}
                  onFocusChange={(focused) => (focused ? notifyFocus() : notifyBlur())}
                  focusKey={focusKey}
                  onCreateRoutine={() => setShowCreateRoutine(true)}
                  workingDir={currentSessionWorkingDir}
                  isWorking={!!currentSessionId && (activeSessionIds.has(currentSessionId) || stoppingSessionIds.has(currentSessionId))}
                  stopping={!!currentSessionId && stoppingSessionIds.has(currentSessionId)}
                  onStop={() => currentSessionId && stopAllAgents(currentSessionId)}
                  disabled={!currentUser.name.trim()}
                  disabledReason={!currentUser.name.trim() ? 'Set your username in settings to start chatting' : undefined}
                  sendBlockedReason={
                    !canChatInCurrentSession
                      ? (hasSpecificParticipants
                          ? 'All participant agents in this thread are offline. Connect one to send.'
                          : 'No agents are online in this workspace. Connect one to send.')
                      : undefined
                  }
                  suppressSendBlockedNotice={isMissingParticipant}
                />
              )}
            </SessionEmptyHero>
          )
        ) : (
          <>
          {(filterOpen || filterActive) && (
            <div className="px-4 lg:px-8 pt-2">
              <TranscriptFilterBar
                value={transcriptFilter}
                onChange={setTranscriptFilter}
                onClose={closeFilter}
                agentNames={speakingAgents}
                shown={filteredMessages.length}
                total={displayMessages.length}
              />
              {hasOlder && (
                <div className="mt-1.5 px-2.5 py-1 bg-surface2/60 border border-border/50 rounded-lg text-3xs text-foreground-extra-muted flex items-center justify-between">
                  <span>Showing matches from loaded messages. Earlier messages are not searched.</span>
                  <button
                    type="button"
                    onClick={() => loadOlder?.()}
                    disabled={loadingOlder}
                    className="text-primary hover:underline font-medium ml-2 cursor-pointer"
                  >
                    {loadingOlder ? 'Loading...' : 'Load earlier messages'}
                  </button>
                </div>
              )}
            </div>
          )}

          {pendingActions.length > 0 && (
            <div className="px-4 lg:px-8 pt-2">
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                  <span>
                    You have <strong>{pendingActions.length}</strong> item{pendingActions.length > 1 ? 's' : ''} waiting for your review ({pendingActions[0].label})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent(TRANSCRIPT_REVEAL_EVENT, { detail: { messageId: pendingActions[0].id } })
                    );
                  }}
                  className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 font-medium transition-colors cursor-pointer text-2xs"
                >
                  Jump to item
                </button>
              </div>
            </div>
          )}
          <ChatMessages
            messages={filteredMessages}
            agents={agents}
            // A kind filter IS a step view: collapsing the steps it selected
            // would show a filtered transcript with nothing in it.
            showAllSteps={showAllSteps || transcriptFilter.kind !== 'all'}
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
          </>
        )}

        {/* Input — hidden for read-only DM views or when empty hero has its own centered composer */}
        {!isDM && displayMessages.length > 0 && (
          <div className="relative px-4 lg:px-8 pb-4 pt-3 bg-gradient-to-t from-background via-background/95 to-transparent">
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
                    {/*
                      THE NAMES WERE COSTING THE WHOLE LINE AND BUYING NOTHING.

                      This listed every assigned agent inline — eight @names on
                      a real thread, which overran the row and truncated, so the
                      end of the sentence ("are offline") was the part that got
                      cut. And the names are not actionable HERE: the buttons to
                      the right add ONLINE agents, so reading the offline ones
                      one by one changes nothing you can do.

                      Few enough to be useful, name them. More than that, the
                      count is the fact and the roster is a detail — kept on the
                      tooltip rather than deleted, since "which ones" is a fair
                      question, just not one worth the whole row.
                    */}
                    {sessionParticipants.length <= 2 ? (
                      <span className="truncate">
                        {sessionParticipants.map((p) => `@${p}`).join(' and ')}{' '}
                        {sessionParticipants.length === 1 ? 'is' : 'are'} offline
                      </span>
                    ) : (
                      <Hint label={sessionParticipants.map((p) => `@${p}`).join(', ')}>
                        <span className="truncate cursor-default">
                          All {sessionParticipants.length} agents in this thread are offline
                        </span>
                      </Hint>
                    )}
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
                      onClick={() => setViewMode('home')}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface2 hover:bg-surface3 border border-border/60 text-foreground text-2xs font-medium transition-colors"
                    >
                      <span>Connect</span>
                    </button>
                  </div>
                </div>
              ) : currentSession && (currentSession.participants?.length ?? 0) === 0 && displayMessages.length === 0 && onlineAgents.length > 1 && (
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

              {serverSessionId && <ThreadStatusBar channelName={serverSessionId} messages={displayMessages} />}
              <ChatInput
                key={currentSessionId || 'empty'}
                onSend={handleSend}
                agents={agents}
                knowledge={knowledge}
                session={currentSession || undefined}
                onOrchestrationChange={(updates) => currentSessionId && setSessionOrchestration(currentSessionId, updates)}
                onMasterChange={(agentName) => currentSessionId && setSessionMaster(currentSessionId, agentName)}
                draft={injectedDraft}
                onDraftChange={handleDraftChange}
                onFocusChange={(focused) => focused ? notifyFocus() : notifyBlur()}
                focusKey={focusKey}
                onCreateRoutine={() => setShowCreateRoutine(true)}
                workingDir={currentSessionWorkingDir}
                isWorking={!!currentSessionId && (activeSessionIds.has(currentSessionId) || stoppingSessionIds.has(currentSessionId))}
                stopping={!!currentSessionId && stoppingSessionIds.has(currentSessionId)}
                onStop={() => currentSessionId && stopAllAgents(currentSessionId)}
                headerBar={
                  <ComposerHeaderBar
                    filesChanged={composerFilesChanged}
                    linesAdded={composerLinesAdded}
                    linesRemoved={composerLinesRemoved}
                    onViewCode={() => {
                      if (selectedAgentName) setSelectedAgentName(null);
                      setActiveRightTab('diff');
                    }}
                    inProgressTodo={inProgressTodoItem}
                    isRunning={!!currentSessionId && activeSessionIds.has(currentSessionId)}
                    todos={sessionTodoItems}
                    userMessageTurns={userMessageTurns}
                    onScrollToUserMessage={(messageId) => {
                      window.dispatchEvent(
                        new CustomEvent(TRANSCRIPT_REVEAL_EVENT, { detail: { messageId } })
                      );
                    }}
                    teamMembers={teamMembers}
                    availableAgents={agents}
                    activeAgentName={activeModelAgentName}
                    onSelectTeamAgent={(agentName) => {
                      if (currentSessionId) setSessionMaster(currentSessionId, agentName);
                    }}
                    onAddTeammate={(agentName) => {
                      if (currentSessionId) addParticipant(currentSessionId, agentName);
                    }}
                    onOpenAgentsHub={() => setViewMode('home')}
                  />
                }
                disabled={!currentUser.name.trim()}
                disabledReason={!currentUser.name.trim() ? 'Set your username in settings to start chatting' : undefined}
                // Offline agents block SENDING only: the box stays editable so a
                // message can be drafted while you bring an agent back.
                sendBlockedReason={
                  !canChatInCurrentSession
                    ? (hasSpecificParticipants
                        ? 'All participant agents in this thread are offline. Connect one to send.'
                        : 'No agents are online in this workspace. Connect one to send.')
                    : undefined
                }
                // The offline banner right above already says this.
                suppressSendBlockedNotice={isMissingParticipant}
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

        {serverSessionId && (
          <ShareDialog
            open={shareDialogOpen}
            onOpenChange={setShareDialogOpen}
            sessionId={serverSessionId}
          />
        )}

        {currentSessionWorkingDir && (
          <ProjectWorkspaceDialog
            open={projectWorkspaceOpen}
            onOpenChange={setProjectWorkspaceOpen}
            dir={currentSessionWorkingDir}
          />
        )}
      </div>
    </div>
  );
}
