'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, Check, User, FileIcon, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { AgentAvatar } from '@/components/agents/agent-avatar';
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

function humanColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 82%)`;
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

  // Regenerate URLs from fileId to ensure they include current auth token
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

  // Status messages — subtle inline
  if (isSystem) {
    const isQueued = message.content.includes('queued');
    return (
      <div className="flex justify-center py-1">
        <span className={cn(
          'text-xs italic',
          isQueued
            ? 'text-blue-500 dark:text-blue-400'
            : 'text-muted-foreground'
        )}>
          {message.senderName}: {message.content}
        </span>
      </div>
    );
  }

  // ── Human message — inline style ──
  if (isHuman) {
    const isCurrentUser = !!message.senderId && message.senderId === currentUser.id;
    const displayName = isCurrentUser
      ? 'You'
      : (message.senderName && message.senderName !== 'user' ? message.senderName : 'User');

    return (
      <div className="py-2.5">
        <div className="flex items-start gap-3">
          <div
            className="size-8 rounded-lg shrink-0 flex items-center justify-center mt-0.5 bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/50 dark:border-zinc-700/40 text-zinc-600 dark:text-zinc-400"
          >
            <User className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold text-zinc-900 dark:text-zinc-50">{displayName}</span>
              {timestamp && (
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono font-medium ml-auto">{timestamp}</span>
              )}
            </div>
            <div className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
              <MarkdownContent content={message.content} agentNames={agentNames} />
              <Attachments items={attachments} />
              
              <div className="flex items-center gap-3.5 mt-2 text-[10px] font-medium">
                {isCurrentUser && message.deliveryStatus === 'sending' && (
                  <span className="text-zinc-400">Sending...</span>
                )}
                {isCurrentUser && message.deliveryStatus === 'confirmed' && (
                  <span className="text-emerald-600 dark:text-emerald-400">✓ Sent</span>
                )}
                {isCurrentUser && message.deliveryStatus === 'failed' && (
                  <span className="text-red-600 dark:text-red-400">✗ Failed to send</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Agent message — nested card style ──
  return (
    <div className="py-2.5">
      <div className="flex items-start gap-3">
        <AgentAvatar name={message.senderName} size={32} square className="mt-1 shrink-0" />
        <div className="flex-1 min-w-0 bg-white dark:bg-zinc-900/50 border border-zinc-200/70 dark:border-zinc-800/60 rounded-xl p-4 shadow-xs">
          <div className="flex items-center gap-2 mb-2 pb-2 border-b border-zinc-100 dark:border-zinc-800/30">
            <span className="text-xs font-bold text-zinc-900 dark:text-zinc-50 truncate">
              {message.senderName}
            </span>
            {agent && (
              <span className={cn(
                'text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider shrink-0 border border-zinc-200/40 dark:border-zinc-800/30',
                agent.role === 'master'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200/20'
                  : 'bg-zinc-100/80 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
              )}>
                {agent.role}
              </span>
            )}
            {timestamp && (
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium ml-auto font-mono">{timestamp}</span>
            )}
          </div>
          <div className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
            <MarkdownContent content={message.content} agentNames={agentNames} />
            <Attachments items={attachments} />

            {approvalRequest && (
              <div className="mt-3.5 p-3.5 rounded-lg border bg-zinc-50/50 dark:bg-zinc-950/30 border-zinc-200 dark:border-zinc-800 space-y-2.5 max-w-full">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Action Approval Required
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase font-mono">
                    ID: {approvalRequest.approval_id}
                  </span>
                </div>
                <div className="text-xs space-y-1.5 font-mono bg-zinc-100 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800/80 p-2.5 rounded overflow-x-auto max-w-full text-zinc-800 dark:text-zinc-200">
                  <div className="font-semibold">Tool: {approvalRequest.tool}</div>
                  {approvalRequest.args?.command && (
                    <div className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400 font-mono">$ {approvalRequest.args.command}</div>
                  )}
                  {approvalRequest.args?.path && (
                    <div className="text-zinc-600 dark:text-zinc-400">File: {approvalRequest.args.path}</div>
                  )}
                </div>
                
                <div className="flex items-center gap-2 mt-2">
                  {hasStatus ? (
                    <span className={cn(
                      "text-xs font-semibold px-2 py-1 rounded",
                      currentApproved 
                        ? "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                        : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                    )}>
                      {currentApproved ? '✓ Approved' : '✗ Denied'}
                    </span>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        className="h-8 px-3 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 font-medium"
                        onClick={handleApprove}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-3 text-muted-foreground border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-900 hover:text-foreground font-medium"
                        onClick={handleReject}
                      >
                        Deny
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Copy button */}
            <div className="flex items-center gap-1 mt-2.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground gap-1"
                onClick={handleCopy}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
