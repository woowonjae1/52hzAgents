'use client';

import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, Check, X, User, FileIcon, Download, Eye, GitBranch, Sparkles, AlertCircle, Quote, FileCode, RotateCw , Pencil} from 'lucide-react';
import { toast } from '@/lib/toast';
import { SignalMark } from '@/components/brand/signal-mark';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { MarkdownContent } from './markdown-content';
import { ToolCallsDisclosure } from './intermediate-steps';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { ToolCard } from '@/components/ai-elements/tool-card';
import { ToolConfirmation } from '@/components/ai-elements/tool-confirmation';
import { TodoList, type TodoItem } from '@/components/agents/todo-list';
import { FileDiff, type DiffLine } from '@/components/ai-elements/file-diff';
import { ApprovalCard, type ApprovalCardQuestion } from '@/components/ai-elements/approval-card';
import { MessageActions } from '@/components/ai-elements/message-actions';
import { SourcesCard, type SourceItem } from '@/components/ai-elements/sources-card';
import { TurnChangesCapsule } from './turn-changes-capsule';
import { workspaceApi } from '@/lib/api';
import { downloadUrl } from '@/lib/download';
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
    downloadUrl(url, filename);
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
              className="block rounded-xl overflow-hidden border border-border hover:border-primary/40 hover:shadow-md ui-transition max-w-sm text-left"
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
                    className="inline-flex items-center gap-2 text-foreground hover:text-primary transition-colors"
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
                    className="size-5 rounded hover:bg-surface1 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors ml-1"
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
  /**
   * The newest message in the channel. Its action toolbar stays visible;
   * every other message reveals one on hover. See the note at the toolbar.
   */
  isLast?: boolean;
  /** Current session working directory for resolving local path links */
  workingDir?: string;
  onRegenerate?: (message: WorkspaceMessage) => void;
  onQuoteReply?: (message: WorkspaceMessage) => void;
  /** Load this message's text back into the composer for correction. */
  onReusePrompt?: (message: WorkspaceMessage) => void;
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
  isLast = false,
  workingDir,
  onRegenerate,
  onQuoteReply,
  onReusePrompt,
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

  // ── User Messages (Modern ChatGPT/Claude Refined Bubble Card) ──
  if (isHuman) {
    const isCurrentUser = isCurrentHumanMessage(message, currentUser);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/*
            A TURN IS A THING YOU CAN POINT AT.

            Every message was its own flat row: nothing answered the pointer
            except the little icon strip fading in, so scrolling a long thread
            gave no sense of which exchange you were reading. ChatGPT and Claude
            both treat a prompt and its answer as one hoverable object, and that
            is most of why their transcripts feel like an application rather
            than a log.

            Two parts. The hover plate is full-bleed — `-mx-3 px-3` widens the
            row past the list's own 1rem gutter so the highlight runs to the
            edges of the reading column instead of stopping at the text. It has
            to be margin-and-padding rather than an absolutely-positioned
            `::before`, because a pseudo-element behind this content would need
            a negative z-index and would then paint behind the main pane's own
            background, not on top of it.

            `w-full` went with it: a block child already fills its container, so
            the class was doing nothing except pinning the width to the parent's
            and cancelling the negative margins it now has to outgrow.

            And `mt-3` when this message OPENS a turn (a same-speaker burst sets
            `hideHeader`, and those stay tight). Space, not a rule: the daybreak
            separator is the only horizontal line this transcript draws, and it
            means something. Rhythm does the same job without spending it.
          */}
          <div
            className={cn(
              'group/usermsg py-2.5',
              'select-text flex flex-col items-end',
              /*
                Opens a turn, so it gets air above it — but 6px, not 12px. The
                12px was sized against a hover plate that made the whole turn
                one visible object and could carry the extra room; with the
                plate gone it was just a loose transcript, and it was spending
                back most of the 33px per turn that removing the reserved
                toolbar bought. Within a turn the gap is 24px, between turns
                30px: enough to group, not enough to drift.
              */
              !hideHeader && 'mt-1.5',
            )}
          >
            {/*
              THE SENDER'S OWN MARK.

              beUI puts an avatar on both sides of the transcript; this side
              had none, so a turn read as "someone spoke, then a bubble
              appeared". The row is `flex-row-reverse` so the mark lands on
              the trailing edge, and it uses the same `size-7` disc as the
              agent avatars opposite it.

              `hideHeader` means this message continues the previous one, so
              the mark is held (invisible, not removed) to keep the bubbles
              on one vertical line.
            */}
            <div className="flex w-full flex-row-reverse items-start gap-2">
              <div
                className={cn(
                  /* The mark FILLS the disc, the way the agent avatars
                     opposite it do. 16px inside a 28px circle read as a dot
                     with a lot of ring around it. */
                  'mt-0.5 grid size-7 shrink-0 place-items-center overflow-hidden rounded-full',
                  hideHeader && 'invisible'
                )}
                aria-hidden={hideHeader || undefined}
              >
                <SignalMark size={26} still title={currentUser.name || 'You'} />
              </div>
            <div className="max-w-[82%] flex flex-col items-end">
              <div
                className={cn(
                  // On the ramp — see the note in prompt-composer.tsx. The
                  // notched corner keeps its relationship to the others
                  // (`--radius-base`, the ramp's own small step) rather than
                  // being a second arbitrary number.
                  /* beUI bubble metrics: `rounded-2xl px-3.5 py-2.5 text-sm
                     leading-6`, and no notched corner — the reference does
                     not taper the trailing edge. */
                  'relative rounded-2xl px-3.5 py-2.5 text-sm leading-6',
                  /*
                    OPAQUE, AND ON THE ELEVATION RAMP.

                    `bg-surface2/90` composited to roughly #fefefe over the
                    #fafafa content ground — a bubble a single value lighter
                    than the page it floats on, held together by its border
                    alone. Solid `--surface2` is the full four-value step, and
                    it is the honest one: nothing behind a chat bubble wants to
                    show through it.

                    Shadows come from the ramp now rather than a hand-written
                    dark-only drop. `shadow-sm` is `--elevation-2`, which on
                    light carries the hairline ring the whole light ramp uses
                    and on dark leads with the 1px inset highlight that is the
                    only thing that makes a near-black surface read as raised.
                    The literal it replaces had no highlight and no light-mode
                    counterpart at all.

                    Dark moves to `--surface3` because `--surface-sidebar` is
                    `#15151a` now and `--surface2` (#18181e) sits too close to
                    it to read as a different layer.
                  */
                  /*
                    No shadow. A chat bubble is the flattest thing in a
                    transcript — it is inline content, not an object resting on
                    top of one — and `--elevation-2` under every one of them
                    turned a scrolling column of text into a stack of cards.
                    The fill plus the hairline is the whole separation, which
                    is what Claude's own transcript does. See the composer for
                    the rule this follows.
                  */
                  /*
                    beUI's `solid` variant: `bg-foreground` with
                    `text-background`. That is the inversion the reference
                    uses to separate what you said from what came back —
                    stronger than the one-step surface lift this had, and it
                    drops the border, because a fully inverted plate does not
                    need one to be found.
                  */
                  'bg-foreground text-background',
                  /*
                    AN INVERTED BUBBLE HAS TO INVERT WHAT IS INSIDE IT TOO.

                    `text-background` on the bubble only reaches children that
                    inherit. The markdown renderer was built for a normal
                    ground, so its inline chips, links and code spans carry
                    `text-foreground` and `bg-surface2` of their own — on a
                    `bg-foreground` plate those land as the bubble's own
                    colour and the message reads as an empty pill, in BOTH
                    themes, because the inversion flips with the theme.

                    These scope the known offenders back onto the bubble's
                    own pair instead of the page's.
                  */
                  /*
                    Element by element, because the markdown renderer puts
                    `text-foreground` on the ELEMENTS, not on its container:
                    `p`, `ul`, `ol` and `h1`-`h4` each carry it (see
                    markdown-content.tsx). A rule on `.markdown-content` loses
                    to a class on the `<p>` itself, which is why the first
                    attempt at this left the text exactly as invisible as
                    before. `[&_p]` is a descendant selector, so it outranks
                    the element's own single class.
                  */
                  '[&_p]:text-background [&_li]:text-background',
                  '[&_ul]:text-background [&_ol]:text-background',
                  '[&_h1]:text-background [&_h2]:text-background [&_h3]:text-background [&_h4]:text-background',
                  '[&_ul]:marker:text-background/55 [&_ol]:marker:text-background/55',
                  '[&_blockquote]:text-background/85 [&_blockquote]:border-background/30',
                  '[&_del]:text-background/60',
                  '[&_a]:text-background [&_strong]:text-background [&_em]:text-background',
                  '[&_code]:bg-background/15 [&_code]:text-background [&_code]:border-background/20',
                  '[&_pre]:bg-background/15 [&_pre]:text-background',
                  '[&_[class*=bg-surface]]:bg-background/15 [&_[class*=bg-surface]]:text-background [&_[class*=bg-surface]]:border-background/25',
                  'transition-all duration-150 break-words'
                )}
              >
                <div className="reading-prose font-normal select-text text-background">
                  <MarkdownContent
                    content={message.content}
                    agentNames={agentNames}
                    sessionId={message.sessionId}
                    workingDir={workingDir}
                  />
                  <Attachments items={attachments} />
                </div>
              </div>

              {/*
                Minimalist Hover Actions & Status Row.

                `pe-1.5` rather than `px-1.5`: the row is the last child of an
                `items-end` column, so its END edge is what lines up with the
                bubble above it, and a symmetric inset was quietly pulling the
                timestamp 6px off that line for no reason — the start side has
                nothing to clear.
              */}
              <div className="flex items-center gap-2 mt-1 pe-1.5 select-none">
                {isCurrentUser && message.deliveryStatus && (
                  <span className="text-3xs font-mono">
                    {message.deliveryStatus === 'sending' && (
                      <span className="event-running text-foreground-extra-muted">Sending…</span>
                    )}
                    {message.deliveryStatus === 'confirmed' && (
                      <span className="text-foreground-extra-muted/70 inline-flex items-center gap-0.5">
                        <Check className="size-2.5" />
                      </span>
                    )}
                    {message.deliveryStatus === 'failed' && (
                      <span className="text-destructive font-medium inline-flex items-center gap-0.5">
                        <X className="size-2.5" />
                        <span>Failed</span>
                      </span>
                    )}
                  </span>
                )}

                {timestamp && (
                  <span className="text-3xs text-foreground-extra-muted/70 font-mono tabular-nums">
                    {timestamp}
                  </span>
                )}

                {/*
                  `order-first` — THE TIMESTAMP HAS TO BE THE LAST THING IN
                  THIS ROW.

                  These three buttons are hidden with `opacity-0`, which hides
                  them without giving back their ~66px of width. Written last
                  in the markup they therefore held the row's end position at
                  all times, and the timestamp — the only thing here that is
                  always visible — floated 66px short of the bubble's edge with
                  apparently nothing to its right. That reads as a bug in the
                  alignment every time, because it is one.

                  Ordering rather than moving the JSX: the buttons belong next
                  to the handlers they call, and an edit that drags a
                  forty-line block across a status row to fix a visual
                  alignment is a worse diff than one word. Actions to the start
                  of the row is also where ChatGPT and Claude put them.
                */}
                <div className="order-first flex items-center gap-1 opacity-0 group-hover/usermsg:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                  {/*
                    "EDIT AS NEW MESSAGE", AND IT SAYS SO.

                    ChatGPT's edit rewrites history: it truncates the thread at
                    that turn and re-runs from there. This backend has no
                    endpoint for that — no message delete, no update, no
                    truncate — so the honest version of this button puts the
                    text back in the composer and sends a NEW message.

                    Naming matters more than usual here. Calling it "Edit"
                    would promise the rewrite and quietly append instead, which
                    in a channel with eight agents means the old prompt is
                    still there and every one of them still reads it. The label
                    says what happens, and the real edit stays on the list of
                    things that need the server.

                    The practical win is still the whole point: a long prompt
                    with one wrong word does not have to be retyped.
                  */}
                  {onReusePrompt && (
                    <Hint label="Edit as new message">
                      <button
                        type="button"
                        onClick={() => onReusePrompt(message)}
                        className="size-5 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors"
                        aria-label="Edit as new message"
                      >
                        <Pencil className="size-3" />
                      </button>
                    </Hint>
                  )}
                  <Hint label="Copy Plain Text">
                    <button
                      type="button"
                      onClick={handleCopyPlain}
                      className="size-5 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors"
                      aria-label="Copy plain text"
                    >
                      <Copy className="size-3" />
                    </button>
                  </Hint>
                  <Hint label="Quote Reply">
                    <button
                      type="button"
                      onClick={handleQuote}
                      className="size-5 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors"
                      aria-label="Quote reply"
                    >
                      <Quote className="size-3" />
                    </button>
                  </Hint>
                </div>
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
        {/* Same hover plate as the user turn above — see the comment there. */}
        <div
          className={cn(
            'group/agentmsg relative',
            'select-text selectable',
            hideHeader ? 'pb-3.5' : 'py-3.5',
            /*
              A reply should arrive, not blink into existence. 160ms and a 2px
              rise — under the shell's own 150ms budget for anything the user
              did not ask for, and small enough that it reads as the text
              settling rather than as a card animating in.

              ONLY THE NEWEST MESSAGE. This list is virtualised: rows mount and
              unmount as they cross the viewport, so animating every mount
              would make the whole transcript twinkle while you scroll through
              it — which is the opposite of the calm this is for. `isLast` is
              the one row that mounts because something actually happened.

              `motion-safe:` because a rise is motion, and the file already
              respects `prefers-reduced-motion` for the working indicator.
            */
            isLast && 'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150',
          )}
        >
      <div className="flex w-full items-start gap-2">
        {hideHeader ? (
          <div className="size-7 shrink-0" aria-hidden />
        ) : (
          <div className="relative mt-0.5 shrink-0">
            <AgentAvatar
              name={message.senderName}
              agentType={agent?.agentType}
              size={28}
              className="rounded-full"
            />
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Identity Header */}
          {!hideHeader && (
          <div className="flex items-center gap-1.5 px-1 text-[11px] leading-none text-muted-foreground select-none">
            <span className="font-medium text-foreground">
              {message.senderName}
            </span>
            {timestamp && (
              <span className="ml-auto tabular-nums">{timestamp}</span>
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
          ) : cleanContent ? (
            /*
              beUI's `soft` bubble, and only around the ANSWER.

              In the reference shell the prose sits on `bg-muted` while tool
              results, diffs, plans and approval cards are siblings OUTSIDE
              the bubble — they are already cards and would read as a card
              inside a card. So the bubble stops here rather than wrapping
              the whole content column.

              `w-fit max-w-[82%]` are the bubble's own numbers: a one-word
              reply should not draw a full-width plate.
            */
            <div className="w-fit max-w-[82%] rounded-2xl bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground">
              <div className="reading-prose font-normal select-text selectable">
                <MarkdownContent content={cleanContent} agentNames={agentNames} sessionId={message.sessionId} workingDir={workingDir} />
              </div>
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
                : 'absolute start-10 end-0 bottom-0 opacity-0 pointer-events-none group-hover/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto',
            )}
          >
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
