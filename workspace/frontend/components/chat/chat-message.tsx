'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, Check, User, FileIcon, Download, Eye, GitBranch, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { deriveIdentityColor } from '@/lib/identity-colors';
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
}

function isCurrentHumanMessage(message: WorkspaceMessage, currentUser: { id: string; name: string }): boolean {
  const currentUserId = currentUser.id.trim();
  const senderId = (message.senderId || '').replace(/^human:/, '').trim();
  if (currentUserId && senderId === currentUserId) return true;

  const currentUserName = currentUser.name.trim().toLocaleLowerCase();
  const senderName = message.senderName.trim().toLocaleLowerCase();
  return Boolean(currentUserName && senderName === currentUserName);
}

export const ChatMessage = memo(function ChatMessage({ message, agents = [], isApproved, isRejected, steps }: ChatMessageProps) {
  const { currentUser } = useWorkspace();
  const isHuman = message.senderType === 'human' || message.senderType === 'user';
  const isSystem = message.messageType === 'status';
  const [localStatus, setLocalStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');

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

  // Extract thinking content if any
  const { thinking: inlineThinking, answer: cleanContent } = useMemo(
    () => extractThinking(message.content),
    [message.content]
  );
  const explicitThinking = (message.metadata?.thinking || message.metadata?.reasoning) as string | undefined;
  const activeThinking: string | null = inlineThinking || (typeof explicitThinking === 'string' ? explicitThinking : null);

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

  if (isSystem) {
    const isQueued = message.content.includes('queued');
    return (
      <div className="flex justify-center py-1">
        <span className={cn(
          'text-xs italic',
          isQueued
            ? 'text-foreground-muted'
            : 'text-muted-foreground'
        )}>
          {message.senderName}: {message.content}
        </span>
      </div>
    );
  }

  // ── User Messages (Right Aligned) ──
  if (isHuman) {
    const isCurrentUser = isCurrentHumanMessage(message, currentUser);
    const displayName = isCurrentUser
      ? 'You'
      : (message.senderName && message.senderName !== 'user' ? message.senderName : 'User');

    return (
      <div className="py-2.5 flex justify-end group/usermsg">
        <div className="flex items-start gap-2.5 flex-row-reverse max-w-[85%] lg:max-w-[75%] relative">
          {/* Avatar Icon */}
          <div className="size-7 rounded-full shrink-0 flex items-center justify-center border border-border/60 overflow-hidden bg-surface2 shadow-xs mt-0.5">
            <img src="/logo-icon.png" alt="You" className="size-4 object-contain" />
          </div>

          <div className="flex flex-col items-end min-w-0">
            {/* Header: Name & Time */}
            <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] text-foreground-extra-muted select-none">
              {timestamp && <span className="font-mono opacity-80">{timestamp}</span>}
              <span className="font-semibold text-foreground">{displayName}</span>
            </div>

            {/* Message Bubble */}
            <div className="relative text-[13.5px] leading-relaxed text-foreground bg-surface2/90 border border-border/80 dark:bg-surface2/80 dark:border-border/60 px-4 py-2.5 rounded-2xl rounded-tr-xs shadow-xs text-left inline-block max-w-full break-words">
              <MarkdownContent content={message.content} agentNames={agentNames} />
              <Attachments items={attachments} />

              {isCurrentUser && message.deliveryStatus && (
                <div className="flex items-center justify-end gap-1 mt-1 text-[10px]">
                  {message.deliveryStatus === 'sending' && (
                    <span className="text-foreground-extra-muted">Sending...</span>
                  )}
                  {message.deliveryStatus === 'confirmed' && (
                    <span className="text-status-success font-medium">✓ Sent</span>
                  )}
                  {message.deliveryStatus === 'failed' && (
                    <span className="text-status-danger font-medium">✗ Failed to send</span>
                  )}
                </div>
              )}
            </div>

            {/* Hover Message Actions */}
            <div className="mt-1 flex justify-end">
              <MessageActions content={message.content} senderType="user" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── AI Agent Messages (Left Aligned) ──
  const identityColour = deriveIdentityColor(message.senderName);

  return (
    <div className="py-3 group/agentmsg">
      <div
        className="pl-3.5 border-l-2 relative"
        style={{ borderColor: identityColour }}
      >
        {/* Header: Agent Identity */}
        <div className="flex items-center gap-2 mb-1.5 select-none">
          <span className="size-2 rounded-full shrink-0 animate-pulse" style={{ background: identityColour }} />
          <span className="text-xs font-semibold truncate tracking-tight" style={{ color: identityColour }}>
            {message.senderName}
          </span>
          {agent && (
            <span className={cn(
              'text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 border',
              agent.role === 'master'
                ? 'bg-surface3 text-foreground border-border-accent shadow-2xs'
                : 'bg-surface2 text-foreground-muted border-border/40'
            )}>
              {agent.role}
            </span>
          )}
          {timestamp && (
            <span className="text-[11px] text-foreground-extra-muted ml-auto font-mono">{timestamp}</span>
          )}
        </div>

        {/* Content Body */}
        <div className="text-[13.5px] leading-[1.68] text-foreground font-normal space-y-2">
          {/* Tool Calls & Intermediate Steps */}
          {steps && steps.length > 0 && <ToolCallsDisclosure steps={steps} />}

          {/* Vercel AI Elements Collapsible Reasoning */}
          {activeThinking ? (
            <Reasoning content={activeThinking} defaultExpanded={false} />
          ) : null}

          {/* Multi-step Plan / Todo List */}
          {planItems && planItems.length > 0 ? (
            <TodoList items={planItems} />
          ) : null}

          {/* Main Answer Content */}
          {cleanContent ? (
            <MarkdownContent content={cleanContent} agentNames={agentNames} />
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
              onSubmit={(answers) => {
                const answerSummary = Object.entries(answers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n');
                workspaceApi.sendMessage(
                  message.sessionId,
                  `【决策确认】\n${answerSummary}`,
                  'User'
                );
                toast.success('决策已提交');
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

          {/* Model Metadata Footer & Message Actions */}
          <div className="flex items-center justify-between gap-2 pt-1 text-[11px] font-mono text-foreground-extra-muted border-t border-border/30">
            <div className="flex items-center gap-1.5 truncate">
              <span>
                {typeof message.metadata?.model === 'string'
                  ? message.metadata.model
                  : agent?.agentType
                  ? `${agent.agentType}-agent`
                  : message.senderName}
              </span>
              <span>·</span>
              <span>{typeof message.metadata?.mode === 'string' ? message.metadata.mode : (agent?.role || 'exec')}</span>
              {typeof message.metadata?.elapsed === 'string' && (
                <>
                  <span>·</span>
                  <span>{message.metadata.elapsed}</span>
                </>
              )}
            </div>

            {/* Hover Action Bar */}
            <MessageActions
              content={cleanContent || message.content}
              senderType="agent"
              onRegenerate={() => {
                navigator.clipboard.writeText(`@${message.senderName} 请重新生成上一轮回答`);
                toast.success('已复制重新生成指令');
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
