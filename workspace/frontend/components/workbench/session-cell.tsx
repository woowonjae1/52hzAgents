'use client';

import * as React from 'react';
import { useState, useCallback, useMemo } from 'react';
import {
  MessageSquare,
  ArrowLeftRight,
  X,
  Send,
  Loader2,
  ChevronDown,
  Maximize2,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';
import { useWorkspace } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { ChatMessages } from '@/components/chat/chat-messages';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SessionCellProps {
  sessionId: string;
  onSelectSession?: (id: string) => void;
  onSwap?: () => void;
  onClose?: () => void;
  className?: string;
}

export function SessionCell({
  sessionId,
  onSelectSession,
  onSwap,
  onClose,
  className,
}: SessionCellProps) {
  const { sessions, agents, activeSessionIds } = useWorkspace();
  const session = useMemo(() => sessions.find((s) => s.sessionId === sessionId), [sessions, sessionId]);
  const isChannelActive = activeSessionIds.has(sessionId);

  const { messages, loading, forceRefresh, loadOlder, hasOlder, loadingOlder } = useMessagePolling({
    sessionId,
  });

  const [inputVal, setInputVal] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    const text = inputVal.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await workspaceApi.sendMessage(sessionId, text);
      setInputVal('');
      void forceRefresh();
    } catch (err) {
      toast.error(`Failed to send message: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }, [inputVal, sending, sessionId, forceRefresh]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className={cn('flex flex-col h-full bg-surface0 overflow-hidden select-text border-l border-border', className)}>
      {/* Pane Header (matching cdesktop CellHost header) */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-chrome bg-surface1/80 select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-surface2 text-left transition-colors cursor-pointer min-w-0 max-w-[200px]"
              >
                <MessageSquare className="size-3.5 text-primary shrink-0" />
                <span className="text-xs font-semibold text-foreground truncate">
                  {session?.title || 'Session'}
                </span>
                <ChevronDown className="size-3 text-foreground-extra-muted shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {sessions.map((s) => (
                <DropdownMenuItem
                  key={s.sessionId}
                  onClick={() => onSelectSession?.(s.sessionId)}
                  className="flex items-center justify-between text-xs cursor-pointer"
                >
                  <span className="truncate">{s.title || 'Untitled Session'}</span>
                  {s.sessionId === sessionId && <Check className="size-3.5 text-primary shrink-0 ml-2" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {isChannelActive && (
            <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded-full bg-status-success/10 text-status-success font-medium">
              <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
              <span>Active</span>
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1">
          {onSwap && (
            <Hint label="Swap with primary pane">
              <button
                type="button"
                onClick={onSwap}
                className="p-1 rounded-md hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
              >
                <ArrowLeftRight className="size-3.5" />
              </button>
            </Hint>
          )}

          {onClose && (
            <Hint label="Close split pane">
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-md hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            </Hint>
          )}
        </div>
      </div>

      {/* Messages Transcript */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-foreground-muted gap-2">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>Loading session...</span>
          </div>
        ) : (
          <ChatMessages
            messages={messages}
            agents={agents}
            showAllSteps={false}
            loadOlder={loadOlder}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
          />
        )}
      </div>

      {/* Compact Bottom Composer */}
      <div className="p-2.5 border-t border-border bg-surface1/60 shrink-0">
        <div className="flex items-end gap-2 bg-surface0 rounded-lg border border-border/80 px-2.5 py-1.5 focus-within:border-primary/60 transition-colors">
          <textarea
            rows={1}
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${session?.title || 'session'}...`}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-foreground-extra-muted outline-hidden resize-none max-h-24 leading-relaxed font-sans"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !inputVal.trim()}
            className="p-1 rounded-md bg-primary hover:bg-primary-hover text-primary-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
