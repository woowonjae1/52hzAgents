'use client';

import { memo, useCallback } from 'react';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { Copy, Check, X, Quote, FileCode, Pencil } from 'lucide-react';
import { SignalMark } from '@/components/brand/signal-mark';
import { copyWithToast } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
import { MarkdownContent } from './markdown-content';
import { MessageAttachments, type Attachment } from './message-attachments';
import type { WorkspaceMessage } from '@/lib/types';

interface UserChatMessageProps {
  message: WorkspaceMessage;
  agentNames: string[];
  workingDir?: string;
  hideHeader?: boolean;
  currentUser: { id: string; name: string };
  timestamp: string | null;
  attachments: Attachment[];
  onReusePrompt?: (message: WorkspaceMessage) => void;
  onRegenerate?: (message: WorkspaceMessage) => void;
  onQuoteReply?: (message: WorkspaceMessage) => void;
}

export const UserChatMessage = memo(function UserChatMessage({
  message,
  agentNames,
  workingDir,
  hideHeader = false,
  currentUser,
  timestamp,
  attachments,
  onReusePrompt,
  onRegenerate,
  onQuoteReply,
}: UserChatMessageProps) {
  const currentUserId = currentUser.id.trim();
  const senderId = (message.senderId || '').replace(/^human:/, '').trim();
  const isCurrentUser = Boolean(
    (currentUserId && senderId === currentUserId) ||
    (currentUser.name.trim().toLowerCase() && message.senderName.trim().toLowerCase() === currentUser.name.trim().toLowerCase())
  );

  const handleCopyPlain = useCallback(() => {
    void copyWithToast(message.content, 'Copied plain text');
  }, [message.content]);

  const handleCopyMarkdown = useCallback(() => {
    void copyWithToast(message.content, 'Copied markdown source');
  }, [message.content]);

  const handleQuote = useCallback(() => {
    if (onQuoteReply) {
      onQuoteReply(message);
    } else {
      const quoted = message.content
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      void copyWithToast(`${quoted}\n\n`, 'Quoted to clipboard');
    }
  }, [onQuoteReply, message]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group/usermsg relative select-text selectable',
            hideHeader ? 'py-1' : 'py-2',
            !hideHeader && 'mt-1.5',
          )}
        >
          <div className="flex w-full flex-row-reverse items-start gap-2">
            <div
              className={cn(
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
                  'relative rounded-xl px-3.5 py-2 text-xs sm:text-[13px] leading-relaxed shadow-xs',
                  'bg-bubble-user text-bubble-user-foreground dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)]',
                  '[&_p]:text-bubble-user-foreground [&_li]:text-bubble-user-foreground',
                  '[&_ul]:text-bubble-user-foreground [&_ol]:text-bubble-user-foreground',
                  '[&_h1]:text-bubble-user-foreground [&_h2]:text-bubble-user-foreground [&_h3]:text-bubble-user-foreground [&_h4]:text-bubble-user-foreground',
                  '[&_ul]:marker:text-bubble-user-foreground/55 [&_ol]:marker:text-bubble-user-foreground/55',
                  '[&_blockquote]:text-bubble-user-foreground/85 [&_blockquote]:border-bubble-user-foreground/30',
                  '[&_del]:text-bubble-user-foreground/60',
                  '[&_a]:text-bubble-user-foreground [&_strong]:text-bubble-user-foreground [&_em]:text-bubble-user-foreground',
                  '[&_code]:bg-bubble-user-foreground/15 [&_code]:text-bubble-user-foreground [&_code]:border-bubble-user-foreground/20',
                  '[&_pre]:bg-bubble-user-foreground/15 [&_pre]:text-bubble-user-foreground',
                  '[&_[class*=bg-surface]]:bg-bubble-user-foreground/15 [&_[class*=bg-surface]]:text-bubble-user-foreground [&_[class*=bg-surface]]:border-bubble-user-foreground/25',
                  'transition-all duration-150 break-words'
                )}
              >
                <div className="reading-prose font-normal select-text text-bubble-user-foreground">
                  <MarkdownContent
                    content={message.content}
                    agentNames={agentNames}
                    sessionId={message.sessionId}
                    workingDir={workingDir}
                  />
                  <MessageAttachments items={attachments} />
                </div>
              </div>

              {/* Minimalist Hover Actions & Status Row */}
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
                      <span className="text-destructive font-medium inline-flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-0.5">
                          <X className="size-2.5" />
                          <span>Failed</span>
                        </span>
                        {onReusePrompt && (
                          <button
                            type="button"
                            onClick={() => onReusePrompt(message)}
                            className="underline underline-offset-2 hover:text-foreground transition-colors ml-0.5 cursor-pointer"
                          >
                            Restore
                          </button>
                        )}
                        {onRegenerate && (
                          <button
                            type="button"
                            onClick={() => onRegenerate(message)}
                            className="underline underline-offset-2 hover:text-foreground transition-colors cursor-pointer"
                          >
                            Retry
                          </button>
                        )}
                      </span>
                    )}
                  </span>
                )}

                {timestamp && (
                  <span className="text-3xs text-foreground-extra-muted/70 font-mono tabular-nums">
                    {timestamp}
                  </span>
                )}

                <div className="order-first flex items-center gap-1 opacity-0 group-hover/usermsg:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                  {onReusePrompt && (
                    <Hint label="Edit as new message">
                      <button
                        type="button"
                        onClick={() => onReusePrompt(message)}
                        className="size-5 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
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
                      className="size-5 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
                      aria-label="Copy plain text"
                    >
                      <Copy className="size-3" />
                    </button>
                  </Hint>
                  <Hint label="Quote Reply">
                    <button
                      type="button"
                      onClick={handleQuote}
                      className="size-5 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
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
});
