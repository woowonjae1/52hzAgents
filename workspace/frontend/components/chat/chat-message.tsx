'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, Check, User, FileIcon, Download, Eye, GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { MarkdownContent } from './markdown-content';
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
              className="block rounded-lg overflow-hidden border hover:shadow-md transition-shadow max-w-sm cursor-pointer text-left"
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
                className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted hover:bg-muted/80 transition-colors text-sm cursor-pointer"
              >
                <Eye className="size-4 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[200px]">{file.filename}</span>
              </button>
            ) : (
              <a
                key={file.fileId}
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted hover:bg-muted/80 transition-colors text-sm"
              >
                <FileIcon className="size-4 text-muted-foreground shrink-0" />
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
}

function isCurrentHumanMessage(message: WorkspaceMessage, currentUser: { id: string; name: string }): boolean {
  const currentUserId = currentUser.id.trim();
  const senderId = (message.senderId || '').replace(/^human:/, '').trim();
  if (currentUserId && senderId === currentUserId) return true;

  const currentUserName = currentUser.name.trim().toLocaleLowerCase();
  const senderName = message.senderName.trim().toLocaleLowerCase();
  return Boolean(currentUserName && senderName === currentUserName);
}

export const ChatMessage = memo(function ChatMessage({ message, agents = [], isApproved, isRejected }: ChatMessageProps) {
  const { currentUser } = useWorkspace();
  const isHuman = message.senderType === 'human' || message.senderType === 'user';
  const isSystem = message.messageType === 'status';
  const [copied, setCopied] = useState(false);
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

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

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
      <div className="py-2 flex justify-end">
        <div className="flex items-start gap-2.5 flex-row-reverse max-w-[82%] lg:max-w-[72%] group">
          {/* Avatar Icon */}
          <div className="size-7 rounded-full shrink-0 flex items-center justify-center border border-border/60 overflow-hidden bg-surface2 shadow-xs mt-0.5">
            <img src="/logo-icon.png" alt="You" className="size-4.5 object-contain" />
          </div>

          <div className="flex flex-col items-end min-w-0">
            {/* Header: Name & Time */}
            <div className="flex items-center gap-1.5 mb-1 px-0.5 text-[11px] text-foreground-extra-muted select-none">
              {timestamp && <span className="font-mono opacity-80">{timestamp}</span>}
              <span className="font-semibold text-foreground">{displayName}</span>
            </div>

            {/* Message Bubble */}
            <div className="text-sm leading-relaxed text-foreground bg-surface2/90 border border-border/80 dark:bg-surface2/80 dark:border-border/60 px-3.5 py-2.5 rounded-2xl rounded-tr-xs shadow-xs text-left inline-block max-w-full break-words">
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
          </div>
        </div>
      </div>
    );
  }

  // ── AI Agent Messages (Left Aligned) ──
  // Derived from the name (not the roster) so it stays stable even for a sender
  // who has since left the workspace.
  const identityColour = deriveIdentityColor(message.senderName);

  // No avatar and no card: a bubble or a portrait per reply stacks into a wall
  // of boxes once several agents are in one thread. What identifies the
  // speaker is a 2px rail in the agent's identity colour plus a matching 6px
  // dot beside the name — unlike a portrait, a rail shows where a block
  // STARTS and ENDS, which is the thing that's hard to follow when three
  // agents interleave. Only the human's message keeps a filled bubble, so the
  // two sides stay easy to tell apart.
  return (
    <div className="py-2.5 group/msg">
      <div
        className="pl-3 border-l-2"
        style={{ borderColor: identityColour }}
      >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="size-1.5 rounded-full shrink-0" style={{ background: identityColour }} />
            <span className="text-xs font-semibold truncate" style={{ color: identityColour }}>
              {message.senderName}
            </span>
            {agent && (
              // Role reads as normal-case text, not a shouted chip: the uppercase
              // + letter-spaced treatment is the "instrument panel" signal this
              // direction drops. `master` is distinguished by surface weight
              // rather than a colour, since the palette has no brand accent.
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 border',
                agent.role === 'master'
                  ? 'bg-surface3 text-foreground border-border-accent'
                  : 'bg-surface2/80 text-foreground-muted border-border/40'
              )}>
                {agent.role}
              </span>
            )}
            {timestamp && (
              <span className="text-[11px] text-foreground-extra-muted ml-auto font-mono">{timestamp}</span>
            )}
          </div>
          <div className="text-sm leading-[1.78] text-foreground">
            <MarkdownContent content={message.content} agentNames={agentNames} />
            <Attachments items={attachments} />

            {approvalRequest && (
              <div className="mt-3.5 p-3.5 rounded-lg border bg-surface1/50 border-border space-y-2.5 max-w-full">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-status-warning animate-pulse" />
                    Action Approval Required
                  </span>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    ID: {approvalRequest.approval_id}
                  </span>
                </div>
                <div className="text-xs space-y-1.5 font-mono bg-surface2/50 border border-border/80 p-2.5 rounded overflow-x-auto max-w-full text-foreground">
                  <div className="font-semibold">Tool: {approvalRequest.tool}</div>
                  {approvalRequest.args?.command && (
                    <div className="whitespace-pre-wrap text-foreground-muted font-mono">$ {approvalRequest.args.command}</div>
                  )}
                  {approvalRequest.args?.path && (
                    <div className="text-foreground-muted">File: {approvalRequest.args.path}</div>
                  )}
                </div>
                
                <div className="flex items-center gap-2 mt-2">
                  {hasStatus ? (
                    <span className={cn(
                      "text-xs font-semibold px-2 py-1 rounded",
                      currentApproved 
                        ? "bg-surface2 text-foreground"
                        : "bg-surface2 text-foreground"
                    )}>
                      {currentApproved ? '✓ Approved' : '✗ Denied'}
                    </span>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        className="h-8 px-3 bg-primary hover:bg-primary text-white dark:hover:bg-surface3 font-medium"
                        onClick={handleApprove}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-3 text-muted-foreground border-border hover:bg-surface2 hover:text-foreground font-medium"
                        onClick={handleReject}
                      >
                        Deny
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Model Metadata Footer matching mockup */}
            <div className="flex items-center justify-between gap-2 mt-2.5 pt-1.5 border-t border-border/40 text-[11px] font-mono text-foreground-extra-muted">
              <div className="flex items-center gap-2">
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
              <div className="flex items-center gap-1.5 opacity-80 hover:opacity-100 transition-opacity">
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
                  title="Copy text"
                >
                  {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`@${message.senderName} ${message.content}`);
                    toast.success(`Forked from @${message.senderName}`);
                  }}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
                  title="Fork thread"
                >
                  <GitBranch className="size-3" />
                  <span>Fork</span>
                </button>
              </div>
            </div>
          </div>
        </div>
    </div>
  );
});
