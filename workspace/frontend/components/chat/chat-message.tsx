'use client';

import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BookPlus, Copy, Check, X, User, GitBranch, Sparkles, AlertCircle, Quote, FileCode, RotateCw } from 'lucide-react';
import { toast } from '@/lib/toast';
import { copyWithToast } from '@/lib/desktop';
import { SignalMark } from '@/components/brand/signal-mark';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { MarkdownContent } from './markdown-content';
import { extractThinking } from '@/lib/message-text';
import { inferArtifact } from '@/lib/artifacts';
import { ToolCallsDisclosure } from './intermediate-steps';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { ToolCard } from '@/components/ai-elements/tool-card';
import { ToolConfirmation } from '@/components/ai-elements/tool-confirmation';
import { TodoList, type TodoItem } from '@/components/agents/todo-list';
import { FileDiff, type DiffLine } from '@/components/ai-elements/file-diff';
import { ApprovalCard, type ApprovalCardQuestion } from '@/components/ai-elements/approval-card';
import { RoutineProposalCard } from '@/components/chat/routine-proposal-card';
import { MessageActions } from '@/components/ai-elements/message-actions';
import { StreamingResponse, type StreamingResponseStatus } from '@/components/agents/streaming-response';
import { Citations, Citation, type CitationItem } from '@/components/agents/citations';
import { TurnChangesCapsule } from './turn-changes-capsule';
import { workspaceApi } from '@/lib/api';
import { useLayout } from '@/components/layout/layout-context';
import { draftFromMessage, requestKnowledgeIntent } from '@/lib/knowledge-intent';
import { useWorkspace } from '@/lib/workspace-context';
import { useArtifacts, type ArtifactItem } from '@/lib/artifacts-context';
import { ArtifactInlineCard } from '../canvas/artifact-inline-card';

import { MessageAttachments, type Attachment } from './message-attachments';
import { SystemNotice } from './system-notice';
import { UserChatMessage } from './user-chat-message';
import { RuntimeToolCard, type RuntimeTool } from './runtime-tool-card';
import { ExecutionEvidenceCard } from './execution-evidence-card';

interface ChatMessageProps {
  message: WorkspaceMessage;
  agents?: WorkspaceAgent[];
  isApproved?: boolean;
  isRejected?: boolean;
  isExpired?: boolean;
  /** Tool calls / status this sender emitted before this message, if any. */
  steps?: WorkspaceMessage[];
  /**
   * Suppress the avatar + sender row. Set when a thinking/steps group for this
   * same sender sits directly above and has already printed it — otherwise the
   * identity line appears twice in a row.
   */
  hideHeader?: boolean;
  /**
   * A `[Decision]` reply for this message's card already exists in the channel.
   * Derived from the message list by the parent — the same arrangement as
   * `isApproved`/`isRejected` — because local state alone reverts to `pending`
   * on reload and re-arms a card that has already been answered.
   */
  isDecisionAnswered?: boolean;
  savedDecisionAnswers?: Record<string, string>;
  /**
   * The newest message in the channel. Its action toolbar stays visible;
   * every other message reveals one on hover. See the note at the toolbar.
   */
  isLast?: boolean;
  /** Whether the message is currently streaming live content */
  isStreaming?: boolean;
  /** Whether the message is an intermediate progress message (followed by more work) */
  isIntermediate?: boolean;
  /** Current session working directory for resolving local path links */
  workingDir?: string;
  onRegenerate?: (message: WorkspaceMessage) => void;
  onQuoteReply?: (message: WorkspaceMessage) => void;
  /** Load this message's text back into the composer for correction. */
  onReusePrompt?: (message: WorkspaceMessage) => void;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  agents = [],
  isApproved,
  isRejected,
  isExpired = false,
  steps,
  hideHeader = false,
  isDecisionAnswered = false,
  savedDecisionAnswers,
  isLast = false,
  isStreaming = false,
  isIntermediate = false,
  workingDir,
  onRegenerate,
  onQuoteReply,
  onReusePrompt,
}: ChatMessageProps) {
  const { currentUser } = useWorkspace();
  const { setViewMode } = useLayout();
  const isHuman = message.senderType === 'human' || message.senderType === 'user';
  const isSystemSender =
    message.senderType === 'system' ||
    message.senderType === 'parallel' ||
    message.senderType === 'routine' ||
    message.senderType === 'pipeline' ||
    message.senderName === 'parallel' ||
    message.senderName === 'routine' ||
    message.senderName === 'system' ||
    message.senderName === 'Pipeline Relay' ||
    message.senderName === 'Pipeline Supervisor';
  const isSystem = message.messageType === 'status' || isSystemSender;
  const [localStatus, setLocalStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');

  // Submission state for the decision card. ApprovalCard implements
  // pending/submitting/answered in full — spinner, confirmation banner, locked
  // options — but it is a controlled component and nothing was driving it, so
  // it sat on `pending` forever: clicking Confirm produced no feedback and left
  // the card live, which let the same decision be posted to the agent twice.
  const [localDecisionStatus, setDecisionStatus] =
    useState<'pending' | 'submitting' | 'answered'>('pending');
  const [localAnswers, setLocalAnswers] = useState<Record<string, string> | undefined>();

  // The durable flag wins: it comes from an actual `[Decision]` message in the
  // channel, so it holds across reloads and remounts. Local state only covers
  // the gap between clicking Confirm and that message coming back round.
  const decisionStatus = isDecisionAnswered ? 'answered' : localDecisionStatus;
  const currentDecisionAnswers = localAnswers || savedDecisionAnswers;

  const approvalRequest = message.metadata?.tool_approval_request;
  const currentApproved = isApproved || localStatus === 'approved';
  const currentRejected = isRejected || localStatus === 'rejected';
  const currentExpired = !currentApproved && !currentRejected && Boolean(isExpired);
  const hasStatus = currentApproved || currentRejected || currentExpired;

  const handleApprove = async () => {
    if (!approvalRequest) return;
    setLocalStatus('approved');
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: `human:${currentUser.id || 'user'}`,
        target: `channel/${message.sessionId}`,
        payload: {
          content: 'Approved command execution.',
          sender_type: 'human',
          sender_name: currentUser.name || 'user',
        },
        metadata: {
          target_agents: [message.senderName],
          tool_approval_response: {
            approval_id: approvalRequest.approval_id,
            granted: true,
          }
        },
        visibility: 'channel',
      });
    } catch {
      toast.error('Failed to submit approval');
      setLocalStatus('pending');
    }
  };

  const handleReject = async () => {
    if (!approvalRequest) return;
    setLocalStatus('rejected');
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: `human:${currentUser.id || 'user'}`,
        target: `channel/${message.sessionId}`,
        payload: {
          content: 'Rejected command execution.',
          sender_type: 'human',
          sender_name: currentUser.name || 'user',
        },
        metadata: {
          target_agents: [message.senderName],
          tool_approval_response: {
            approval_id: approvalRequest.approval_id,
            granted: false,
          }
        },
        visibility: 'channel',
      });
    } catch {
      toast.error('Failed to submit rejection');
      setLocalStatus('pending');
    }
  };

  const agentNames = useMemo(() => agents.map((a) => a.agentName), [agents]);
  const agent = agents.find((a) => a.agentName === message.senderName);
  const rawAttachments = (message.metadata?.attachments as Record<string, unknown>[]) || [];
  const attachments: Attachment[] = rawAttachments.map((a) => ({
    fileId: (a.fileId || a.file_id || '') as string,
    filename: (a.filename || '') as string,
    contentType: (a.contentType || a.content_type || '') as string,
    url: '',
  }));

  const timestamp = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  // Extract thinking content from inline text, steps, or metadata
  const { thinking: inlineThinking, answer: cleanContent, isStreamingThink } = useMemo(
    () => extractThinking(message.content),
    [message.content]
  );
  const stepsThinking = useMemo(() => {
    if (!steps || steps.length === 0) return null;
    const thinkMsgs = steps.filter((s) => s.messageType === 'thinking');
    if (thinkMsgs.length === 0) return null;
    const filtered = thinkMsgs
      .map((m) => m.content.trim())
      .filter((t) => t && t.toLowerCase() !== 'thinking...' && t.toLowerCase() !== 'thinking');
    return filtered.length > 0 ? filtered.join('\n\n') : null;
  }, [steps]);

  const nonThinkingSteps = useMemo(() => {
    if (!steps || steps.length === 0) return [];
    return steps.filter((s) => s.messageType !== 'thinking');
  }, [steps]);

  const explicitThinking = (message.metadata?.thinking || message.metadata?.reasoning) as string | undefined;
  const activeThinking: string | null = inlineThinking || stepsThinking || (typeof explicitThinking === 'string' ? explicitThinking : null);

  const [sourcesOpen, setSourcesOpen] = useState(false);

  const sourceIdPrefix = useMemo(
    () => `citation-${(message.messageId || 'msg').replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [message.messageId]
  );

  // Extract sources/citations into CitationItem[]
  const citationSources = useMemo<CitationItem[]>(() => {
    const list: CitationItem[] = [];
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();

    const addSource = (title: string, url?: string, domain?: string, id?: string) => {
      const cleanTitle = title.trim();
      const cleanUrl = url?.trim();
      if (!cleanTitle && !cleanUrl) return;

      if (cleanUrl && seenUrls.has(cleanUrl)) return;
      if (!cleanUrl && seenTitles.has(cleanTitle)) return;
      if (cleanUrl) seenUrls.add(cleanUrl);
      if (cleanTitle) seenTitles.add(cleanTitle);

      let resolvedDomain = domain;
      if (!resolvedDomain && cleanUrl) {
        try {
          resolvedDomain = new URL(cleanUrl).hostname.replace(/^www\./, '');
        } catch {
          resolvedDomain = undefined;
        }
      }

      list.push({
        id: id || String(list.length + 1),
        title: cleanTitle || resolvedDomain || 'Source document',
        domain: resolvedDomain,
        url: cleanUrl,
      });
    };

    // 1. From message metadata sources/citations
    const rawSources = (message.metadata?.sources || message.metadata?.citations || []) as any[];
    if (Array.isArray(rawSources)) {
      for (const [idx, s] of rawSources.entries()) {
        const title = s.title || s.name || s.slug || '';
        const url = s.url;
        const domain = s.domain || (s.slug ? `@knowledge:${s.slug}` : undefined);
        addSource(title, url, domain, s.id ? String(s.id) : String(idx + 1));
      }
    }

    // 2. From tool steps (e.g. workspace_search_knowledge, web_search, fetch)
    for (const step of steps || []) {
      const text = step.content || '';
      // Knowledge results format: ### [1] Title > Section (@knowledge:slug)
      const knowledgeMatches = text.matchAll(/###\s*\[(\d+)\]\s*([^>\n]+)(?:>\s*([^\n(]+))?(?:\(@knowledge:([a-zA-Z0-9_-]+)\))?/g);
      for (const m of knowledgeMatches) {
        const id = m[1];
        const title = (m[2] || '').trim() + (m[3] ? ` > ${m[3].trim()}` : '');
        const slug = m[4] ? m[4].trim() : undefined;
        addSource(title, undefined, slug ? `@knowledge:${slug}` : 'Knowledge', id);
      }

      // Web search results or URLs in steps
      const meta = step.metadata || {};
      const toolName = String(meta.tool_name || meta.tool || meta.tool_call || '').toLowerCase();
      if (toolName.includes('search') || toolName.includes('web') || toolName.includes('fetch')) {
        const urlMatches = text.matchAll(/https?:\/\/[^\s)\]"'>]+/g);
        for (const u of urlMatches) {
          addSource('', u[0]);
        }
      }
    }

    // 3. From markdown footnote references [1]: https://...
    if (cleanContent) {
      const refMatches = cleanContent.matchAll(/^\[(\d+)\]:\s*(https?:\/\/[^\s]+)(?:\s+"([^"]+)")?/gm);
      for (const m of refMatches) {
        addSource(m[3] || '', m[2], undefined, m[1]);
      }
    }

    return list;
  }, [message.metadata, steps, cleanContent]);

  // Extract execution plan / todo list if any
  const planItems = useMemo<TodoItem[] | null>(() => {
    const raw = message.metadata?.plan || message.metadata?.todos || message.metadata?.todo_list;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw as TodoItem[];
    }
    return null;
  }, [message.metadata]);

  // Extract file diff if any
  const fileDiff = useMemo<{ file: string; lines?: DiffLine[]; rawDiff?: string; status?: 'streaming' | 'complete' } | null>(() => {
    const raw = message.metadata?.file_diff as { file?: string; lines?: DiffLine[]; rawDiff?: string; status?: 'streaming' | 'complete' } | undefined;
    if (raw && raw.file) {
      return { file: raw.file, lines: raw.lines, rawDiff: raw.rawDiff, status: raw.status || (isStreaming ? 'streaming' : 'complete') };
    }
    return null;
  }, [message.metadata, isStreaming]);

  // Extract approval decision questions if any
  const decisionQuestions = useMemo<ApprovalCardQuestion[] | null>(() => {
    const raw = message.metadata?.questions || message.metadata?.decision_questions;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw as ApprovalCardQuestion[];
    }
    return null;
  }, [message.metadata]);

  const { openArtifact, openOutput } = useArtifacts();

  // Extract or infer structured artifact for Canvas (code deliverables, standalone HTML/SVG, explicit artifact tags/metadata)
  // Conversational Q&A, markdown text answers, explanations, and lists are NEVER turned into artifacts.
  // Shared with the Outputs panel, which lists the same documents (lib/artifacts.ts).
  const inferredArtifact = useMemo(() => inferArtifact(message, cleanContent), [message, cleanContent]);

  // Detect system errors or daemon interruptions (only for short runtime error notices, not content responses)
  const isErrorMessage = useMemo(() => {
    // 1. Explicit error signals from backend or runtime
    if (message.messageType === 'error' || Boolean(message.metadata?.error || message.metadata?.is_error)) {
      return true;
    }
    if (!cleanContent) return false;
    // 2. Deliverable content, code blocks, or markdown articles are NEVER system errors
    if (cleanContent.length > 300 || cleanContent.includes('```') || /^#{1,4}\s+/m.test(cleanContent)) {
      return false;
    }
    const lower = cleanContent.toLowerCase().trim();
    // Only detect genuine short runtime fault strings from daemon or adapter
    return (
      lower.startsWith('authentication failed') ||
      lower.startsWith('oauth session expired') ||
      lower.includes('task interrupted — daemon restarting') ||
      lower.startsWith('failed to authenticate') ||
      lower.startsWith('invalid api key') ||
      lower.startsWith('daemon restarting') ||
      lower.startsWith('error: quota reached') ||
      lower.startsWith('error: rate limit') ||
      lower.startsWith('error:')
    );
  }, [cleanContent, message.messageType, message.metadata]);

  const streamingStatus: StreamingResponseStatus = isErrorMessage
    ? 'error'
    : isStreaming
      ? 'streaming'
      : 'complete';

  const handleCopyPlain = useCallback(() => {
    const raw = cleanContent || message.content;
    let plain = raw
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(?<!\S)\*{3}(?!\s)([^*]+?)(?<!\s)\*{3}(?!\S)/g, '$1')
      .replace(/(?<!\S)\*{2}(?!\s)([^*]+?)(?<!\s)\*{2}(?!\S)/g, '$1')
      .replace(/(?<!\S)\*(?!\s)([^*]+?)(?<!\s)\*(?!\S)/g, '$1')
      .replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, '$1')
      .replace(/(?:^|(?<=\s))___(?!\s)([^_]+?\s+[^_]+?)(?<!\s)___(?=\s|$|[.,!?;:](?:\s|$))/g, '$1')
      .replace(/(?:^|(?<=\s))__(?!\s)([^_]+?\s+[^_]+?)(?<!\s)__(?=\s|$|[.,!?;:](?:\s|$))/g, '$1')
      .replace(/(?:^|(?<=\s))_(?!\s)([^_]+?\s+[^_]+?)(?<!\s)_(?=\s|$|[.,!?;:](?:\s|$))/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/^>\s*/gm, '')
      .replace(/^(\s*)[*+-]\s+/gm, '$1')
      .replace(/^(\s*)\d+\.\s+/gm, '$1')
      .trim();
    void copyWithToast(plain || raw, 'Plain text copied');
  }, [cleanContent, message.content]);

  const handleCopyMarkdown = useCallback(() => {
    void copyWithToast(message.content, 'Markdown source copied');
  }, [message.content]);

  // Nothing is written here: the editor opens on the message text and the
  // person decides what, if anything, becomes an entry every agent can read.
  const handleSaveToKnowledge = useCallback(() => {
    const text = (cleanContent || message.content || '').trim();
    if (!text) return;
    requestKnowledgeIntent({ kind: 'draft', draft: draftFromMessage(text, message.senderName) });
    setViewMode('knowledge');
  }, [cleanContent, message.content, message.senderName, setViewMode]);

  const handleQuote = useCallback(() => {
    if (onQuoteReply) {
      onQuoteReply(message);
    } else {
      void copyWithToast(`> ${message.content.slice(0, 200)}...\n\n@${message.senderName} `, 'Quote copied to clipboard');
    }
  }, [onQuoteReply, message]);

  const handleRegenerate = useCallback(async () => {
    if (onRegenerate) {
      onRegenerate(message);
    } else {
      const agentName = message.senderName;
      try {
        toast.info(`Regenerating response from @${agentName}...`);
        const preview = (cleanContent || message.content || '').slice(0, 80).replace(/\n/g, ' ').trim();
        const prompt = preview
          ? `@${agentName} please regenerate your response to "${preview}..." with improvements`
          : `@${agentName} please regenerate your previous response with improvements`;
        await workspaceApi.sendMessage(
          message.sessionId,
          prompt,
          currentUser.name || 'user',
          [agentName]
        );
      } catch {
        toast.error('Failed to trigger regenerate');
      }
    }
  }, [onRegenerate, message, currentUser.name, cleanContent]);

  // An agent's proposed routine: decided in place (Approve / Reject).
  const routineProposal = message.metadata?.routine_proposal;
  if (message.metadata?.runtime_tool) return <RuntimeToolCard initial={message.metadata.runtime_tool as RuntimeTool} />;

  if (routineProposal && typeof routineProposal === 'object' && routineProposal.routine_id) {
    return (
      <div className="py-1">
        <RoutineProposalCard proposal={routineProposal} />
      </div>
    );
  }

  if (isSystem) {
    return <><SystemNotice message={message} agentNames={agentNames} workingDir={workingDir} />{Boolean(message.metadata?.execution_evidence) && <ExecutionEvidenceCard evidence={message.metadata.execution_evidence as import('./execution-evidence-card').ExecutionEvidence} usage={message.metadata?.usage} />}</>;
  }

  // ── User Messages (Modularized Memoized Component) ──
  if (isHuman) {
    return (
      <UserChatMessage
        message={message}
        agentNames={agentNames}
        workingDir={workingDir}
        hideHeader={hideHeader}
        currentUser={currentUser}
        timestamp={timestamp}
        attachments={attachments}
        onReusePrompt={onReusePrompt}
        onRegenerate={onRegenerate}
        onQuoteReply={onQuoteReply}
      />
    );
  }

  // ── AI Agent Messages (Modern Clean AI Layout) ──
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Same hover plate as the user turn above — see the comment there. */}
        <div
          className={cn(
            'group/agentmsg relative',
            'select-text selectable',
            hideHeader ? 'pb-3.5' : 'py-3.5',
            isLast && 'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150',
          )}
        >
      <div className="w-full space-y-2">
        {/* Identity Header */}
        {!hideHeader && (
          <div className="flex items-center gap-2 px-1 text-2xs leading-none text-muted-foreground select-none mb-1">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <AgentAvatar
                name={message.senderName}
                agentType={agent?.agentType}
                size={18}
                className="rounded-full"
              />
              <span>{message.senderName}</span>
            </div>
            {(() => {
              const handoffFrom = (message.metadata?.handoff_from || message.metadata?.previous_agent || message.metadata?.delegated_from || message.metadata?.handed_off_by) as string | undefined;
              if (!handoffFrom) return null;
              return (
                <span className="inline-flex items-center gap-1 text-3xs text-foreground-extra-muted bg-surface2 px-1.5 py-0.5 rounded border border-border/50 font-mono">
                  <span>Handed off by @{handoffFrom}</span>
                </span>
              );
            })()}
            {timestamp && (
              <span className="ml-auto tabular-nums">{timestamp}</span>
            )}
          </div>
        )}

        {hideHeader && timestamp && (
          <div className="flex justify-end px-1 text-[11px] leading-none text-muted-foreground tabular-nums select-none">
            {timestamp}
          </div>
        )}

        <div className="w-full min-w-0 space-y-2">

          {/* 1. Collapsible Reasoning (o1 / o3 style - Top of message body) */}
          {activeThinking ? (
            <Reasoning
              content={activeThinking}
              isStreaming={Boolean(isStreamingThink)}
              defaultExpanded={false}
            />
          ) : null}

          {/* 2. Tool Calls & Intermediate Steps */}
          {nonThinkingSteps.length > 0 && <ToolCallsDisclosure steps={nonThinkingSteps} />}

          {/* Multi-step Plan / Todo List */}
          {planItems && planItems.length > 0 ? (
            <TodoList items={planItems} title="Plan" />
          ) : null}

          {/* Canvas Artifact Card for Long Deliverables / Documents */}
          {inferredArtifact && (
            <ArtifactInlineCard artifact={inferredArtifact} />
          )}

          {/* Main Answer Content OR Formatted Error Callout */}
          {isErrorMessage ? (
            <div className="my-2 p-3.5 rounded-xl border border-destructive/25 bg-destructive/5 dark:bg-destructive/10 text-foreground flex items-start gap-3 select-text selectable">
              <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs font-semibold text-destructive">Interrupted, or an auth problem</p>
                <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed select-text selectable">
                  {cleanContent}
                </div>
              </div>
            </div>
          ) : cleanContent && (!inferredArtifact || inferredArtifact.content.trim() !== cleanContent.trim()) ? (
            <StreamingResponse
              status={streamingStatus}
              copyText={cleanContent}
              onRetry={handleRegenerate}
              sources={citationSources}
              sourceIdPrefix={sourceIdPrefix}
              sourcesOpen={sourcesOpen}
              onSourcesOpenChange={setSourcesOpen}
              showActions={!isIntermediate}
              announce={false}
              className="py-0.5"
            >
              <div className="reading-prose font-normal select-text selectable">
                <MarkdownContent
                  content={cleanContent}
                  agentNames={agentNames}
                  sessionId={message.sessionId}
                  workingDir={workingDir}
                  citationSources={citationSources}
                  sourceIdPrefix={sourceIdPrefix}
                  onSelectCitation={() => setSourcesOpen(true)}
                />
              </div>
            </StreamingResponse>
          ) : citationSources.length > 0 ? (
            <Citations citations={citationSources} defaultOpen={false} idPrefix={sourceIdPrefix} />
          ) : null}

          {/* Interactive File Diff */}
          {fileDiff ? (
            <FileDiff
              file={fileDiff.file}
              lines={fileDiff.lines}
              rawDiff={fileDiff.rawDiff}
              status={fileDiff.status === 'streaming' ? 'in-progress' : 'complete'}
              onOpenStudio={() => {
                openOutput({ kind: 'local_file', path: fileDiff.file });
              }}
            />
          ) : null}

          {/* Decision Question Card */}
          {decisionQuestions && decisionQuestions.length > 0 ? (
            <ApprovalCard
              questions={decisionQuestions}
              status={decisionStatus}
              answers={decisionStatus === 'answered' ? currentDecisionAnswers : undefined}
              result={
                decisionStatus === 'answered'
                  ? currentDecisionAnswers && Object.keys(currentDecisionAnswers).length > 0
                    ? Object.entries(currentDecisionAnswers)
                        .map(([k, v]) => {
                          const title = decisionQuestions.find((q) => q.id === k)?.title || k;
                          const valStr = typeof v === 'string' ? v : ((v as { custom?: string; selected?: string[] })?.custom || (v as { custom?: string; selected?: string[] })?.selected?.join(', ') || '');
                          return `${title}: ${valStr}`;
                        })
                        .join('; ')
                    : 'Decision confirmed'
                  : undefined
              }
              onSubmit={async (answers) => {
                // Guard against a second post: the card locks itself once
                // `status` leaves `pending`, but a remount resets its internal
                // answers and would re-arm the button.
                if (decisionStatus !== 'pending') return;

                // Flatten answers so values are human-readable strings
                const flatLocalAnswers: Record<string, string> = {};
                for (const [k, v] of Object.entries(answers)) {
                  if (typeof v === 'string') {
                    flatLocalAnswers[k] = v;
                  } else if (v && typeof v === 'object') {
                    const obj = v as { selected?: string[]; custom?: string };
                    flatLocalAnswers[k] = obj.custom?.trim() || obj.selected?.join(', ') || '';
                  }
                }

                // Key the reply by the question's TITLE, not its id. The agent
                // reads this text to learn what was decided, and an id it
                // never chose ("q1", or a slug the parser derived) tells it
                // nothing. Falls back to the id if a title is somehow missing.
                const titleById = new Map(
                  decisionQuestions.map((q) => [q.id, q.title])
                );
                const answerSummary = Object.entries(flatLocalAnswers)
                  .map(([k, v]) => `${titleById.get(k) || k}: ${v}`)
                  .join('\n');

                setDecisionStatus('submitting');
                setLocalAnswers(flatLocalAnswers);
                const userName = currentUser.name || currentUser.id || 'User';
                try {
                  await workspaceApi.sendEvent({
                    type: 'workspace.message.posted',
                    source: `human:${currentUser.id || 'user'}`,
                    target: `channel/${message.sessionId}`,
                    payload: {
                      content: `[Decision]\n${answerSummary}`,
                      sender_type: 'human',
                      sender_name: userName,
                    },
                    metadata: {
                      decision_response: {
                        source_message_id: message.messageId,
                        answers,
                      },
                    },
                    visibility: 'channel',
                  });
                  setDecisionStatus('answered');
                } catch {
                  setDecisionStatus('pending');
                  toast.error('Failed to send decision — try again');
                }
              }}
            />
          ) : null}

          {/* Attachments */}
          <MessageAttachments items={attachments} />


          {/* Action Tool Confirmation */}
          {approvalRequest && (
            <ToolConfirmation
              toolName={approvalRequest.tool || 'command'}
              args={approvalRequest.args}
              approvalId={approvalRequest.approval_id}
              status={currentApproved ? 'approved' : currentRejected ? 'denied' : currentExpired ? 'expired' : 'pending'}
              onApprove={handleApprove}
              onDeny={handleReject}
            />
          )}

          {/* Agent Turn Code Changes Capsule & Rollback */}
          {message.metadata?.turn_changes && (
            <TurnChangesCapsule
              channelId={message.sessionId}
              turnChanges={message.metadata.turn_changes}
            />
          )}

          {/* Objective Execution Evidence (Facts separated from Model text) */}
          {Boolean(message.metadata?.execution_evidence) && (
            <ExecutionEvidenceCard
              evidence={message.metadata.execution_evidence as any}
              usage={message.metadata.usage}
            />
          )}

          {/*
            HOVER, EXCEPT ON THE LAST MESSAGE.

            The comment this replaces called the row a "ChatGPT signature
            toolbar", and it was — except that ChatGPT reveals it on hover and
            keeps it pinned only under the newest reply. Here it was pinned
            under every reply, so a scrolled-back transcript carried five icons
            (copy, retry, up, down, download) under every single turn: more
            persistent controls on screen than messages, none of them wanted
            until the moment they are.

            The user-message toolbar a few hundred lines up already did this
            correctly with `group-hover/usermsg`; this is the same treatment on
            the group this block already sits inside.

            `focus-within` is not decoration — without it the row cannot be
            reached by keyboard at all, because it never becomes visible.

            IT ALSO MUST NOT RESERVE ITS HEIGHT.

            Hiding it with `opacity-0` alone left the row in flow: a full 28px
            of toolbar plus the parent's 10px `space-y-2.5`, invisible, under
            every reply in the transcript. With the agent turn's own `py-3.5`
            and the user bubble's `py-2.5` on either side, two consecutive
            turns sat ~100px apart with nothing drawn in between, and the
            channel read like a blog post rather than a tool. That gap was
            never a spacing decision — no value in this file says 100 — it was
            four paddings and a hidden control adding up.

            So the hidden state comes OUT of flow entirely and floats in the
            padding below the message, which is dead space anyway and exactly
            where the toolbar belongs when it does appear. The pinned copy
            under the newest reply stays in flow, because there the row is real
            content and the transcript should end above it, not on top of it.

            Absolute rather than a collapsed height on purpose: this list is
            virtualised and `measureElement` observes each row, so a hover that
            changed a row's height would remeasure it and shove everything
            below it down while the pointer was still moving.

            `pointer-events-none` while hidden matters for the same reason the
            opacity does — an invisible toolbar that still swallows clicks over
            the gap between turns is worse than a visible one.
          */}
          {!cleanContent && (
            <div
              className={cn(
                'transition-opacity duration-150',
                isLast
                  ? 'pt-0.5'
                  // `start-10` puts the floating copy on the text column rather
                  // than the avatar gutter: 28px avatar + the row's 12px gap.
                  // It tracks the wrapper's horizontal padding, so it went to 13
                  // while the hover plate added `px-3` and back to 10 now that
                  // the plate is gone.
                  : 'absolute start-0 end-0 bottom-0 opacity-0 pointer-events-none group-hover/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto',
              )}
            >
              <MessageActions
                content={message.content}
                senderType="agent"
                variant="toolbar"
                onOpenCanvas={inferredArtifact ? () => openArtifact(inferredArtifact) : undefined}
                onSaveToKnowledge={handleSaveToKnowledge}
                onQuote={handleQuote}
                onRegenerate={handleRegenerate}
              />
            </div>
          )}
        </div>
      </div>
    </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-60">
      <ContextMenuItem onClick={handleCopyPlain}>
        <Copy className="size-4 mr-2 text-muted-foreground" />
        <span>Copy Plain Text</span>
      </ContextMenuItem>
      <ContextMenuItem onClick={handleCopyMarkdown}>
        <FileCode className="size-4 mr-2 text-muted-foreground" />
        <span>Copy Markdown Source</span>
      </ContextMenuItem>
      <ContextMenuItem onClick={handleQuote}>
        <Quote className="size-4 mr-2 text-muted-foreground" />
        <span>Quote Reply</span>
      </ContextMenuItem>
      {inferredArtifact && (
        <ContextMenuItem onClick={() => openArtifact(inferredArtifact)}>
          <Sparkles className="size-4 mr-2 text-primary" />
          <span>Open in Canvas</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={handleSaveToKnowledge}>
        <BookPlus className="size-4 mr-2 text-muted-foreground" />
        <span>Save to Knowledge…</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={handleRegenerate}>
        <RotateCw className="size-4 mr-2 text-primary" />
        <span>Regenerate Response</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
  );
});
