'use client';

import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, Check, X, User, FileIcon, Download, Eye, GitBranch, Sparkles, AlertCircle, Crown, Quote, FileCode, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { SignalMark } from '@/components/brand/signal-mark';
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
import { useArtifacts, type ArtifactItem } from '@/lib/artifacts-context';
import { ArtifactInlineCard } from '../canvas/artifact-inline-card';

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

function extractThinking(text: string): { thinking: string | null; answer: string; isStreamingThink?: boolean } {
  if (!text || typeof text !== 'string') return { thinking: null, answer: text || '', isStreamingThink: false };

  // 1. Tag-based thinking: <think>...</think> or <thinking>...</thinking>
  const tagRegex = /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i;
  const thinkMatch = text.match(tagRegex);
  if (thinkMatch) {
    const thinking = thinkMatch[1].trim();
    const answer = text.replace(tagRegex, '').trim();
    return { thinking, answer, isStreamingThink: false };
  }

  // 2. Open thinking tag while streaming: <think>... (not yet closed)
  if (/^<(?:think|thinking)>/i.test(text)) {
    const thinking = text.replace(/^<(?:think|thinking)>/i, '').trim();
    return { thinking, answer: '', isStreamingThink: true };
  }

  // 3. Explicit Thought headers at the start: e.g. "Thought:\n..."
  const headerPrefix = text.match(/^(?:(?:\*\*|\*|#+)?\s*(?:Thought|Thinking Process|Reasoning|Planning Process|思考过程)\s*(?:\*\*|\*|#+)?:?\s*\n+)/i);
  if (headerPrefix) {
    const rest = text.slice(headerPrefix[0].length);
    const answerDivider = rest.match(/\n+(?:(?:\*\*|\*|#+)?\s*(?:Answer|Deliverable|Response|Final Response|回答|总结|结论)\s*(?:\*\*|\*|#+)?:?\s*\n+|#{1,3}\s+|经过|基于|根据|Here is|Based on)/i);
    if (answerDivider && answerDivider.index !== undefined) {
      const thinking = rest.slice(0, answerDivider.index).trim();
      const answer = rest.slice(answerDivider.index).trim();
      return { thinking, answer, isStreamingThink: false };
    }
  }

  return { thinking: null, answer: text, isStreamingThink: false };
}

function Attachments({ items }: { items: Attachment[] }) {
  if (!items || items.length === 0) return null;

  const { setViewMode } = useLayout();
  const { setSelectedFileId } = useWorkspace();

  const openPreview = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    setViewMode('files');
  }, [setSelectedFileId, setViewMode]);

  const handleDownload = useCallback((url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }, []);

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
              className="block rounded-xl overflow-hidden border border-border hover:border-primary/40 hover:shadow-md transition-all max-w-sm cursor-pointer text-left"
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
            return (
              <div
                key={file.fileId}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-surface2 hover:bg-surface3 transition-colors text-xs font-medium group"
              >
                <Hint label="View in Files">
                  <button
                    type="button"
                    onClick={() => openPreview(file.fileId)}
                    className="inline-flex items-center gap-2 cursor-pointer text-foreground hover:text-primary transition-colors"
                  >
                    {previewable ? (
                      <Eye className="size-3.5 text-primary shrink-0" />
                    ) : (
                      <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate max-w-[200px]">{file.filename}</span>
                  </button>
                </Hint>
                <Hint label="Download file">
                  <button
                    type="button"
                    onClick={() => handleDownload(file.url, file.filename)}
                    className="size-5 rounded hover:bg-surface1 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer ml-1"
                  >
                    <Download className="size-3" />
                  </button>
                </Hint>
              </div>
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
  /** Current session working directory for resolving local path links */
  workingDir?: string;
  onRegenerate?: (message: WorkspaceMessage) => void;
  onQuoteReply?: (message: WorkspaceMessage) => void;
}

function isCurrentHumanMessage(message: WorkspaceMessage, currentUser: { id: string; name: string }): boolean {
  const currentUserId = currentUser.id.trim();
  const senderId = (message.senderId || '').replace(/^human:/, '').trim();
  if (currentUserId && senderId === currentUserId) return true;

  const currentUserName = currentUser.name.trim().toLocaleLowerCase();
  const senderName = message.senderName.trim().toLocaleLowerCase();
  return Boolean(currentUserName && senderName === currentUserName);
}

export const ChatMessage = memo(function ChatMessage({
  message,
  agents = [],
  isApproved,
  isRejected,
  steps,
  hideHeader = false,
  isDecisionAnswered = false,
  workingDir,
  onRegenerate,
  onQuoteReply,
}: ChatMessageProps) {
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

  const { openArtifact } = useArtifacts();

  // Extract or infer structured artifact for Canvas (code deliverables, standalone HTML/SVG, explicit artifact tags/metadata)
  // Conversational Q&A, markdown text answers, explanations, and lists are NEVER turned into artifacts.
  const inferredArtifact = useMemo<ArtifactItem | null>(() => {
    if (message.senderType !== 'agent' || !cleanContent) return null;

    // 1. Explicit metadata artifact from backend or tool execution
    if (message.metadata?.artifact && typeof message.metadata.artifact === 'object') {
      const meta = message.metadata.artifact as Partial<ArtifactItem>;
      if (meta.title && meta.content) {
        return {
          id: meta.id || `art-${message.messageId}`,
          title: meta.title,
          type: meta.type || 'markdown',
          content: meta.content,
          authorAgent: meta.authorAgent || message.senderName,
          sourceMessageId: message.messageId,
          updatedAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
          filePath: meta.filePath,
        };
      }
    }

    // 2. Explicit <artifact ...> or <antArtifact ...> markup tags
    const artifactTagMatch = cleanContent.match(/<(?:artifact|antArtifact)\s+([^>]*?)>([\s\S]*?)<\/(?:artifact|antArtifact)>/i);
    if (artifactTagMatch) {
      const attrs = artifactTagMatch[1];
      const body = artifactTagMatch[2].trim();
      const titleMatch = attrs.match(/title="([^"]+)"/i);
      const typeMatch = attrs.match(/type="([^"]+)"/i);
      const identifierMatch = attrs.match(/identifier="([^"]+)"/i);
      return {
        id: identifierMatch ? identifierMatch[1] : `art-${message.messageId}`,
        title: titleMatch ? titleMatch[1] : `${message.senderName} Deliverable`,
        type: (typeMatch?.[1] === 'code' ? 'code' : 'markdown') as 'code' | 'markdown',
        content: body,
        authorAgent: message.senderName,
        sourceMessageId: message.messageId,
        updatedAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
      };
    }

    // 3. Standalone HTML / SVG deliverables
    if (
      cleanContent.includes('<!DOCTYPE html>') ||
      (cleanContent.includes('<html') && cleanContent.includes('</html>')) ||
      (cleanContent.includes('<svg xmlns="http://www.w3.org/2000/svg"') && cleanContent.includes('</svg>'))
    ) {
      const isSvg = cleanContent.includes('<svg');
      return {
        id: `art-${message.messageId}`,
        title: isSvg ? `${message.senderName} Vector Graphic (SVG)` : `${message.senderName} Webpage Deliverable`,
        type: 'code',
        language: isSvg ? 'svg' : 'html',
        content: cleanContent,
        authorAgent: message.senderName,
        sourceMessageId: message.messageId,
        updatedAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
      };
    }

    // 4. Standalone Code File Deliverable:
    // Only when the message contains a code block explicitly tagged with a filename (e.g. ```tsx:App.tsx or ```python:main.py)
    // or has a file header comment like `// filename: ...`, OR is a large standalone code block (>= 30 lines) that dominates the message (>= 75% code).
    const codeBlocks = Array.from(cleanContent.matchAll(/```([a-zA-Z0-9_\-\.\/]+)?\n([\s\S]*?)```/g));
    if (codeBlocks.length === 1) {
      const match = codeBlocks[0];
      const fenceTag = (match[1] || '').trim();
      const codeBody = match[2].trim();
      const lineCount = codeBody.split('\n').length;
      const isNamedFile = /\.[a-zA-Z0-9]{1,6}$/.test(fenceTag);
      const fileHeaderMatch = codeBody.match(/^(?:\/\/|#|--|\/\*)\s*(?:file(?:name)?|path):\s*([a-zA-Z0-9_\-\.\/]+)/im);
      const isDominantCode = lineCount >= 30 && (codeBody.length / cleanContent.length) >= 0.75;

      if (isNamedFile || fileHeaderMatch || isDominantCode) {
        const title = isNamedFile
          ? fenceTag
          : fileHeaderMatch
          ? fileHeaderMatch[1].trim()
          : `${message.senderName} Code File`;
        const language = fenceTag.includes(':')
          ? fenceTag.split(':')[0]
          : fenceTag.includes('.')
          ? fenceTag.split('.').pop() || 'code'
          : fenceTag || 'code';

        return {
          id: `art-${message.messageId}`,
          title,
          type: 'code',
          language,
          content: codeBody,
          filePath: isNamedFile ? fenceTag : fileHeaderMatch ? fileHeaderMatch[1].trim() : undefined,
          authorAgent: message.senderName,
          sourceMessageId: message.messageId,
          updatedAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
        };
      }
    }

    // 5. Normal markdown text, explanations, lists, Q&A: NEVER an artifact
    return null;
  }, [message.messageId, message.senderName, message.senderType, message.createdAt, message.metadata?.artifact, cleanContent]);

  // Detect system errors or daemon interruptions (only for short runtime error notices, not content responses)
  const isErrorMessage = useMemo(() => {
    if (!cleanContent) return false;
    // Deliverable content, code blocks, or markdown articles are NEVER system errors
    if (cleanContent.length > 300 || cleanContent.includes('```') || /^#{1,4}\s+/m.test(cleanContent)) {
      return false;
    }
    if (message.messageType === 'error' || Boolean(message.metadata?.error || message.metadata?.is_error)) {
      return true;
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
      lower.startsWith('error: rate limit')
    );
  }, [cleanContent, message.messageType, message.metadata]);

  if (isSystem) {
    const isQueued = message.content.includes('queued');
    return (
      <div className="flex justify-center py-2">
        <span className={cn(
          'text-xs font-mono px-3 py-0.5 rounded-full border border-border/60 bg-surface1/60',
          isQueued
            ? 'text-foreground-muted'
            : 'text-muted-foreground'
        )}>
          {message.senderName}: {message.content}
        </span>
      </div>
    );
  }

  const handleCopyPlain = useCallback(() => {
    const raw = cleanContent || message.content;
    const plain = raw
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .trim();
    navigator.clipboard.writeText(plain || raw);
    toast.success('Plain text copied');
  }, [cleanContent, message.content]);

  const handleCopyMarkdown = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    toast.success('Markdown source copied');
  }, [message.content]);

  const handleQuote = useCallback(() => {
    if (onQuoteReply) {
      onQuoteReply(message);
    } else {
      navigator.clipboard.writeText(`> ${message.content.slice(0, 200)}...\n\n@${message.senderName} `);
      toast.success('Quote copied to clipboard');
    }
  }, [onQuoteReply, message]);

  const handleRegenerate = useCallback(async () => {
    if (onRegenerate) {
      onRegenerate(message);
    } else {
      const agentName = message.senderName;
      try {
        toast.info(`Regenerating response from @${agentName}...`);
        await workspaceApi.sendMessage(
          message.sessionId,
          `@${agentName} please regenerate your previous response with improvements`,
          currentUser.name || 'user',
          [agentName]
        );
      } catch {
        toast.error('Failed to trigger regenerate');
      }
    }
  }, [onRegenerate, message, currentUser.name]);

  // ── User Messages (Modern Engineering Full-Width Stream) ──
  if (isHuman) {
    const isCurrentUser = isCurrentHumanMessage(message, currentUser);
    const displayName = isCurrentUser ? (currentUser.name || message.senderName || 'You') : (message.senderName || 'User');

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/usermsg py-3.5 select-text">
            <div className="flex items-start gap-3 w-full">
              <div className="mt-0.5 shrink-0">
                <SignalMark size={28} still={false} />
              </div>

              <div className="flex-1 min-w-0 space-y-2">
                {/* Identity Header */}
                <div className="flex items-baseline gap-2 select-none">
                  <span className="text-sm font-semibold text-foreground tracking-tight">
                    {displayName}
                  </span>
                  <span className="text-3xs px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted font-mono">
                    User
                  </span>
                  {isCurrentUser && message.deliveryStatus && (
                    <span className="text-3xs font-mono ml-1">
                      {message.deliveryStatus === 'sending' && (
                        <span className="event-running text-foreground-extra-muted">Sending…</span>
                      )}
                      {message.deliveryStatus === 'confirmed' && (
                        <span className="text-foreground-extra-muted inline-flex items-baseline gap-1">
                          <Check className="size-2.5 translate-y-px" />
                          <span>Sent</span>
                        </span>
                      )}
                      {message.deliveryStatus === 'failed' && (
                        <span className="text-destructive font-medium inline-flex items-baseline gap-1">
                          <X className="size-2.5 translate-y-px" />
                          <span>Failed</span>
                        </span>
                      )}
                    </span>
                  )}
                  {timestamp && (
                    <span className="text-3xs text-foreground-extra-muted font-mono ml-auto tabular-nums">
                      {timestamp}
                    </span>
                  )}
                </div>

                {/* Main Full-Width Content */}
                <div className="text-sm leading-7 text-foreground font-normal break-words">
                  <MarkdownContent
                    content={message.content}
                    agentNames={agentNames}
                    sessionId={message.sessionId}
                    workingDir={workingDir}
                  />
                  <Attachments items={attachments} />
                </div>

                {/* Minimalist Hover Actions Row */}
                <div className="flex items-center gap-1 opacity-0 group-hover/usermsg:opacity-100 focus-within:opacity-100 transition-opacity duration-150 pt-0.5">
                  <Hint label="Copy Markdown">
                    <button
                      type="button"
                      onClick={handleCopyMarkdown}
                      className="size-6 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
                      aria-label="Copy markdown"
                    >
                      <Copy className="size-3" />
                    </button>
                  </Hint>
                  <Hint label="Quote Reply">
                    <button
                      type="button"
                      onClick={handleQuote}
                      className="size-6 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
                      aria-label="Quote reply"
                    >
                      <Quote className="size-3" />
                    </button>
                  </Hint>
                </div>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
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
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // ── AI Agent Messages (Modern Clean AI Layout) ──
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn('group/agentmsg', hideHeader ? 'pb-3.5' : 'py-3.5')}>
      <div className="flex items-start gap-3">
        {hideHeader ? (
          <div className="size-7 shrink-0" aria-hidden />
        ) : (
          <AgentAvatar
            name={message.senderName}
            agentType={agent?.agentType}
            size={28}
            className="mt-0.5 shrink-0"
          />
        )}

        <div className="flex-1 min-w-0 space-y-2">
          {/* Identity Header */}
          {!hideHeader && (
          /*
            `items-baseline`: the name, the type chip and the timestamp are three
            different sizes on one line, and centring each of their boxes
            independently is what made this row read as loosely stacked rather
            than set. One baseline, three sizes.
          */
          <div className="flex items-baseline gap-2 select-none">
            <span className="text-sm font-semibold text-foreground tracking-tight">
              {message.senderName}
            </span>
            {agent?.agentType && (
              <span className="text-3xs px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted font-mono border border-border">
                {agent.agentType}
              </span>
            )}
            {/*
              "Lead" is a role, not a state — it says who this agent is, not that
              something needs attention. It was amber (a hue no token defines),
              which put it in the same visual register as a warning while sitting
              directly beside a neutral chip carrying the same kind of fact. Both
              chips are the same chip now.
            */}
            {agent?.role === 'master' && (
              <span className="text-3xs px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted border border-border inline-flex items-center gap-1">
                <Crown className="size-2.5" />
                <span>Lead</span>
              </span>
            )}
            {timestamp && (
              <span className="text-3xs text-foreground-extra-muted font-mono ml-auto tabular-nums">
                {timestamp}
              </span>
            )}
          </div>
          )}

          {/* 1. Collapsible Reasoning (o1 / o3 style - Top of message body) */}
          {activeThinking ? (
            <Reasoning
              content={activeThinking}
              isStreaming={Boolean(isStreamingThink)}
              defaultExpanded={Boolean(isStreamingThink)}
            />
          ) : null}

          {/* 2. Tool Calls & Intermediate Steps */}
          {nonThinkingSteps.length > 0 && <ToolCallsDisclosure steps={nonThinkingSteps} />}

          {/* Multi-step Plan / Todo List */}
          {planItems && planItems.length > 0 ? (
            <TodoList items={planItems} />
          ) : null}

          {/* Canvas Artifact Card for Long Deliverables / Documents */}
          {inferredArtifact && (
            <ArtifactInlineCard artifact={inferredArtifact} />
          )}

          {/* Main Answer Content OR Formatted Error Callout */}
          {isErrorMessage ? (
            <div className="my-2 p-3.5 rounded-xl border border-destructive/25 bg-destructive/5 dark:bg-destructive/10 text-foreground flex items-start gap-3">
              <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs font-semibold text-destructive">Interrupted, or an auth problem</p>
                <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {cleanContent}
                </div>
              </div>
            </div>
          ) : cleanContent ? (
            <div className="text-sm leading-7 text-foreground font-normal">
              <MarkdownContent content={cleanContent} agentNames={agentNames} sessionId={message.sessionId} workingDir={workingDir} />
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
              onOpenCanvas={inferredArtifact ? () => openArtifact(inferredArtifact) : undefined}
              onRegenerate={handleRegenerate}
            />
          </div>
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
      <ContextMenuSeparator />
      <ContextMenuItem onClick={handleRegenerate}>
        <RotateCw className="size-4 mr-2 text-primary" />
        <span>Regenerate Response</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
  );
});
