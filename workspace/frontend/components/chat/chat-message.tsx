'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, Check, X, User, FileIcon, Download, Eye, GitBranch, Sparkles, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { MarkdownContent } from './markdown-content';
import { ToolCallsDisclosure } from './intermediate-steps';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { ToolCard } from '@/components/ai-elements/tool-card';
import { ToolConfirmation } from '@/components/ai-elements/tool-confirmation';
import { TodoList, type TodoItem } from '@/components/ai-elements/todo-list';
import { FileDiff, type DiffLine } from '@/components/ai-elements/file-diff';
import { ApprovalCard, type ApprovalCardQuestion } from '@/components/ai-elements/approval-card';
import { MessageActions } from '@/components/ai-elements/message-actions';
import { SourcesCard, type SourceItem } from '@/components/ai-elements/sources-card';
import { TurnChangesCapsule } from './turn-changes-capsule';
import { workspaceApi } from '@/lib/api';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';

interface Attachment {
  fileId: string;
  filename: string;
  contentType: string;
  url: string;
}

function isPreviewable(contentType: string, filename: string): boolean {
  if (contentType?.startsWith('image/')) return true;
  if (contentType === 'text/html' || /\.html?$/i.test(filename)) return true;
  if (contentType === 'text/markdown' || /\.mdx?$/i.test(filename)) return true;
  if (contentType?.startsWith('text/') || /\.(json|js|ts|tsx|jsx|py|rs|go|java|rb|sh|yaml|yml)$/i.test(filename)) return true;
  return false;
}

function extractThinking(text: string): { thinking: string | null; answer: string } {
  if (!text || typeof text !== 'string') return { thinking: null, answer: text || '' };
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    const thinking = thinkMatch[1].trim();
    const answer = text.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    return { thinking, answer };
  }
  return { thinking: null, answer: text };
}

function Attachments({ items }: { items: Attachment[] }) {
  if (!items || items.length === 0) return null;

  const { setViewMode } = useLayout();
  const { setSelectedFileId } = useWorkspace();

  const openPreview = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    setViewMode('files');
  }, [setSelectedFileId, setViewMode]);

  const fixedItems = useMemo(() =>
    items.map((a) => ({ ...a, url: workspaceApi.getFileUrl(a.fileId) })),
    [items]
  );

  const images = fixedItems.filter((a) => a.contentType?.startsWith('image/'));
  const files = fixedItems.filter((a) => !a.contentType?.startsWith('image/'));

  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <button
              key={img.fileId}
              type="button"
              onClick={() => openPreview(img.fileId)}
              className="block rounded-xl overflow-hidden border border-border/70 hover:border-primary/40 hover:shadow-md transition-all max-w-sm cursor-pointer text-left shadow-2xs"
            >
              <img
                src={img.url}
                alt={img.filename}
                className="max-h-64 w-auto object-contain"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => {
            const previewable = isPreviewable(file.contentType, file.filename);
            return previewable ? (
              <button
                key={file.fileId}
                type="button"
                onClick={() => openPreview(file.fileId)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border/80 bg-surface2 hover:bg-surface3 transition-colors text-xs font-medium cursor-pointer shadow-2xs"
              >
                <Eye className="size-3.5 text-primary shrink-0" />
                <span className="truncate max-w-[200px]">{file.filename}</span>
              </button>
            ) : (
              <a
                key={file.fileId}
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border/80 bg-surface2 hover:bg-surface3 transition-colors text-xs font-medium shadow-2xs"
              >
                <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[200px]">{file.filename}</span>
                <Download className="size-3 text-muted-foreground shrink-0" />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ChatMessageProps {
  message: WorkspaceMessage;
  agents?: WorkspaceAgent[];
  isApproved?: boolean;
  isRejected?: boolean;
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
}

function isCurrentHumanMessage(message: WorkspaceMessage, currentUser: { id: string; name: string }): boolean {
  const currentUserId = currentUser.id.trim();
  const senderId = (message.senderId || '').replace(/^human:/, '').trim();
  if (currentUserId && senderId === currentUserId) return true;

  const currentUserName = currentUser.name.trim().toLocaleLowerCase();
  const senderName = message.senderName.trim().toLocaleLowerCase();
  return Boolean(currentUserName && senderName === currentUserName);
}

export const ChatMessage = memo(function ChatMessage({ message, agents = [], isApproved, isRejected, steps, hideHeader = false, isDecisionAnswered = false }: ChatMessageProps) {
  const { currentUser } = useWorkspace();
  const isHuman = message.senderType === 'human' || message.senderType === 'user';
  const isSystem = message.messageType === 'status';
  const [localStatus, setLocalStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');

  // Submission state for the decision card. ApprovalCard implements
  // pending/submitting/answered in full — spinner, confirmation banner, locked
  // options — but it is a controlled component and nothing was driving it, so
  // it sat on `pending` forever: clicking Confirm produced no feedback and left
  // the card live, which let the same decision be posted to the agent twice.
  const [localDecisionStatus, setDecisionStatus] =
    useState<'pending' | 'submitting' | 'answered'>('pending');

  // The durable flag wins: it comes from an actual `[Decision]` message in the
  // channel, so it holds across reloads and remounts. Local state only covers
  // the gap between clicking Confirm and that message coming back round.
  const decisionStatus = isDecisionAnswered ? 'answered' : localDecisionStatus;

  const approvalRequest = message.metadata?.tool_approval_request;
  const currentApproved = isApproved || localStatus === 'approved';
  const currentRejected = isRejected || localStatus === 'rejected';
  const hasStatus = currentApproved || currentRejected;

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
  const { thinking: inlineThinking, answer: cleanContent } = useMemo(
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

  // Extract sources if any
  const sources = useMemo<SourceItem[]>(() => {
    const rawSources = (message.metadata?.sources || []) as SourceItem[];
    return rawSources;
  }, [message.metadata]);

  // Extract execution plan / todo list if any
  const planItems = useMemo<TodoItem[] | null>(() => {
    const raw = message.metadata?.plan || message.metadata?.todos || message.metadata?.todo_list;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw as TodoItem[];
    }
    return null;
  }, [message.metadata]);

  // Extract file diff if any
  const fileDiff = useMemo<{ file: string; lines?: DiffLine[]; rawDiff?: string } | null>(() => {
    const raw = message.metadata?.file_diff as { file?: string; lines?: DiffLine[]; rawDiff?: string } | undefined;
    if (raw && raw.file) {
      return { file: raw.file, lines: raw.lines, rawDiff: raw.rawDiff };
    }
    return null;
  }, [message.metadata]);

  // Extract approval decision questions if any
  const decisionQuestions = useMemo<ApprovalCardQuestion[] | null>(() => {
    const raw = message.metadata?.questions || message.metadata?.decision_questions;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw as ApprovalCardQuestion[];
    }
    return null;
  }, [message.metadata]);

  // Detect system errors or daemon interruptions
  const isErrorMessage = useMemo(() => {
    if (!cleanContent) return false;
    const lower = cleanContent.toLowerCase();
    return (
      lower.includes('authentication failed') ||
      lower.includes('oauth session expired') ||
      lower.includes('task interrupted — daemon restarting') ||
      lower.includes('failed to authenticate') ||
      lower.includes('invalid api key') ||
      lower.includes('daemon restarting')
    );
  }, [cleanContent]);

  if (isSystem) {
    const isQueued = message.content.includes('queued');
    return (
      <div className="flex justify-center py-2">
        <span className={cn(
          'text-xs font-mono px-3 py-0.5 rounded-full border border-border/40 bg-surface1/60',
          isQueued
            ? 'text-foreground-muted'
            : 'text-muted-foreground'
        )}>
          {message.senderName}: {message.content}
        </span>
      </div>
    );
  }

  // ── User Messages (OpenAI ChatGPT Native Style) ──
  if (isHuman) {
    const isCurrentUser = isCurrentHumanMessage(message, currentUser);

    return (
      <div className="py-2.5 flex justify-end group/usermsg select-text">
        <div className="flex items-center gap-2 flex-row-reverse max-w-[85%] lg:max-w-[70%] min-w-0">
          {/* ChatGPT Style Refined Bubble */}
          <div className="relative text-sm leading-relaxed text-foreground bg-surface2/90 dark:bg-[#2f2f2f] border border-border/40 dark:border-white/[0.06] px-4 py-2.5 rounded-2xl rounded-tr-xs shadow-2xs break-words inline-block max-w-full">
            <MarkdownContent content={message.content} agentNames={agentNames} sessionId={message.sessionId} />
            <Attachments items={attachments} />

            {isCurrentUser && message.deliveryStatus && (
              <div className="flex items-center justify-end gap-1 mt-1 text-3xs">
                {message.deliveryStatus === 'sending' && (
                  <span className="text-foreground-extra-muted">发送中...</span>
                )}
                {message.deliveryStatus === 'confirmed' && (
                  <span className="text-status-success font-medium inline-flex items-center gap-0.5"><Check className="size-2.5" />已发送</span>
                )}
                {message.deliveryStatus === 'failed' && (
                  <span className="text-status-danger font-medium inline-flex items-center gap-0.5"><X className="size-2.5" />发送失败</span>
                )}
              </div>
            )}
          </div>

          {/* Minimalist Hover Copy Button */}
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(message.content);
              toast.success('已复制');
            }}
            className="opacity-0 group-hover/usermsg:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 size-7 rounded-lg hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center shrink-0 cursor-pointer self-center"
            title="复制内容"
            aria-label="复制内容"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // ── AI Agent Messages (OpenAI ChatGPT Full-Width Native Style) ──
  return (
    // Top padding is dropped when continuing: the trace group above already
    // opened the block, and keeping it would put a full gap between a reply and
    // the reasoning it belongs to.
    <div className={cn('group/agentmsg', hideHeader ? 'pb-3.5' : 'py-3.5')}>
      <div className="flex items-start gap-3">
        {/* Agent Avatar Icon — replaced by a spacer of identical width when the
            trace above already showed it, so the reply's text stays on the same
            left edge instead of sliding under the avatar column. */}
        {hideHeader ? (
          <div className="size-6 shrink-0" aria-hidden />
        ) : (
          <AgentAvatar
            name={message.senderName}
            agentType={agent?.agentType}
            size={24}
            className="mt-0.5 shrink-0 rounded-full ring-1 ring-border/40"
          />
        )}

        <div className="flex-1 min-w-0 space-y-2">
          {/* Minimalist Identity Header */}
          {!hideHeader && (
          <div className="flex items-center gap-2 select-none">
            <span className="text-sm font-semibold text-foreground tracking-tight">
              {message.senderName}
            </span>
            {agent?.agentType && (
              <span className="text-2xs text-muted-foreground font-normal">
                {agent.agentType}
              </span>
            )}
            {agent?.role === 'master' && (
              <span className="text-3xs px-1.5 py-0.2 rounded bg-surface2 text-muted-foreground border border-border/40 font-medium">
                Leader
              </span>
            )}
            {timestamp && (
              <span className="text-2xs text-foreground-extra-muted font-mono ml-auto">
                {timestamp}
              </span>
            )}
          </div>
          )}

          {/* 1. Collapsible Reasoning (o1 / o3 style - Top of message body) */}
          {activeThinking ? (
            <Reasoning content={activeThinking} defaultExpanded={false} />
          ) : null}

          {/* 2. Tool Calls & Intermediate Steps */}
          {nonThinkingSteps.length > 0 && <ToolCallsDisclosure steps={nonThinkingSteps} />}

          {/* Multi-step Plan / Todo List */}
          {planItems && planItems.length > 0 ? (
            <TodoList items={planItems} />
          ) : null}

          {/* Main Answer Content OR Formatted Error Callout */}
          {isErrorMessage ? (
            <div className="my-2 p-3.5 rounded-xl border border-destructive/25 bg-destructive/5 dark:bg-destructive/10 text-foreground flex items-start gap-3">
              <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs font-semibold text-destructive">异常中断与鉴权提示</p>
                <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {cleanContent}
                </div>
              </div>
            </div>
          ) : cleanContent ? (
            <div className="text-sm leading-7 text-foreground font-normal">
              <MarkdownContent content={cleanContent} agentNames={agentNames} sessionId={message.sessionId} />
            </div>
          ) : null}

          {/* Interactive File Diff */}
          {fileDiff ? (
            <FileDiff
              file={fileDiff.file}
              lines={fileDiff.lines}
              rawDiff={fileDiff.rawDiff}
            />
          ) : null}

          {/* Decision Question Card */}
          {decisionQuestions && decisionQuestions.length > 0 ? (
            <ApprovalCard
              questions={decisionQuestions}
              status={decisionStatus}
              onSubmit={async (answers) => {
                // Guard against a second post: the card locks itself once
                // `status` leaves `pending`, but a remount resets its internal
                // answers and would re-arm the button.
                if (decisionStatus !== 'pending') return;

                // Key the reply by the question's TITLE, not its id. The agent
                // reads this text to learn what was decided, and an id it
                // never chose ("q1", or a slug the parser derived) tells it
                // nothing. Falls back to the id if a title is somehow missing.
                const titleById = new Map(
                  decisionQuestions.map((q) => [q.id, q.title])
                );
                const answerSummary = Object.entries(answers)
                  .map(([k, v]) => `${titleById.get(k) || k}: ${v}`)
                  .join('\n');

                setDecisionStatus('submitting');
                try {
                  // Was fire-and-forget: a failed post looked identical to a
                  // successful one, so the agent silently never received the
                  // decision and the user had no reason to retry.
                  //
                  // Posted via sendEvent rather than sendMessage only because
                  // sendMessage takes no metadata and this needs to carry the
                  // back-reference. Every other field below is exactly what
                  // sendMessage would have produced, so delivery and
                  // attribution are unchanged.
                  await workspaceApi.sendEvent({
                    type: 'workspace.message.posted',
                    source: 'human:User',
                    target: `channel/${message.sessionId}`,
                    payload: {
                      content: `[Decision]\n${answerSummary}`,
                      sender_type: 'human',
                      sender_name: 'User',
                    },
                    metadata: {
                      decision_response: { source_message_id: message.messageId },
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
          <Attachments items={attachments} />

          {/* Knowledge & Sources Citations */}
          {sources.length > 0 && (
            <SourcesCard sources={sources} />
          )}

          {/* Action Tool Confirmation */}
          {approvalRequest && (
            <ToolConfirmation
              toolName={approvalRequest.tool || 'command'}
              args={approvalRequest.args}
              approvalId={approvalRequest.approval_id}
              status={currentApproved ? 'approved' : currentRejected ? 'denied' : 'pending'}
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

          {/* OpenAI ChatGPT Signature Bottom Action Toolbar */}
          <div className="pt-0.5">
            <MessageActions
              content={cleanContent || message.content}
              senderType="agent"
              variant="toolbar"
              onRegenerate={() => {
                navigator.clipboard.writeText(`@${message.senderName} please regenerate your last answer`);
                toast.success('已复制重新生成指令');
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
