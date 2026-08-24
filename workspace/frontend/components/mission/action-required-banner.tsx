'use client';

import * as React from 'react';
import { Check, X, Square, Clock, Terminal, ShieldAlert, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';

export interface PendingActionItem {
  id: string;
  type: 'approval' | 'stalled' | 'error';
  agentName: string;
  channelId: string;
  channelTitle?: string;
  toolName?: string;
  command?: string;
  path?: string;
  approvalId?: string;
  stalledMs?: number;
  errorMessage?: string;
  timestamp: Date;
}

interface ActionRequiredBannerProps {
  items: PendingActionItem[];
  onOpenThread: (sessionId: string) => void;
  onResolved?: (id: string) => void;
  className?: string;
}

export function ActionRequiredBanner({
  items,
  onOpenThread,
  onResolved,
  className,
}: ActionRequiredBannerProps) {
  const [processingId, setProcessingId] = React.useState<string | null>(null);

  if (!items || items.length === 0) return null;

  const handleApprove = async (item: PendingActionItem) => {
    if (!item.approvalId) return;
    setProcessingId(item.id);
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: 'human:user',
        target: `channel/${item.channelId}`,
        payload: {
          content: 'Approved command execution via Mission Control.',
          sender_type: 'human',
          sender_name: 'user',
        },
        metadata: {
          target_agents: [item.agentName],
          tool_approval_response: {
            approval_id: item.approvalId,
            granted: true,
          },
        },
        visibility: 'channel',
      });
      toast.success(`Approved @${item.agentName}`);
      onResolved?.(item.id);
    } catch {
      toast.error('Approval failed');
    } finally {
      setProcessingId(null);
    }
  };

  const handleDeny = async (item: PendingActionItem) => {
    if (!item.approvalId) return;
    setProcessingId(item.id);
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: 'human:user',
        target: `channel/${item.channelId}`,
        payload: {
          content: 'Rejected command execution via Mission Control.',
          sender_type: 'human',
          sender_name: 'user',
        },
        metadata: {
          target_agents: [item.agentName],
          tool_approval_response: {
            approval_id: item.approvalId,
            granted: false,
          },
        },
        visibility: 'channel',
      });
      toast.info(`Denied @${item.agentName}`);
      onResolved?.(item.id);
    } catch {
      toast.error('Could not submit the denial');
    } finally {
      setProcessingId(null);
    }
  };

  const handleForceStop = async (item: PendingActionItem) => {
    setProcessingId(item.id);
    try {
      await workspaceApi.sendAgentControl(item.agentName, 'stop', { channel: item.channelId || undefined });
      if (item.channelId) {
        try {
          await workspaceApi.haltChannelPipeline(item.channelId);
        } catch {}
        try {
          await workspaceApi.sendEvent({
            type: 'workspace.message.posted',
            source: 'human:user',
            target: `channel/${item.channelId}`,
            payload: {
              content: `[System] Agent @${item.agentName} was force-stopped.`,
              sender_type: 'system',
              sender_name: 'system',
              message_type: 'chat',
            },
            visibility: 'channel',
          });
        } catch {}
      }
      toast.success(`Force-stopped @${item.agentName}`);
      onResolved?.(item.id);
    } catch {
      toast.error('Stop request failed');
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] dark:bg-amber-500/[0.06] p-3.5 space-y-2.5 shadow-xs animate-in fade-in slide-in-from-top-2 duration-200',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="size-3.5 animate-pulse" />
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-amber-900 dark:text-amber-200">
              Needs attention
            </span>
            <span className="px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 text-3xs font-mono font-bold">
              {items.length}
            </span>
          </div>
        </div>

        <span className="text-2xs text-amber-700/80 dark:text-amber-400/80 hidden sm:inline">
          Agents are waiting on human approval, or have stalled past their timeout
        </span>
      </div>

      {/* Items list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {items.map((item) => {
          const isApproval = item.type === 'approval';
          const isStalled = item.type === 'stalled';
          const isBusy = processingId === item.id;

          return (
            <div
              key={item.id}
              className="flex flex-col justify-between p-3 rounded-xl bg-surface1/95 border border-amber-500/25 shadow-2xs space-y-2"
            >
              {/* Top info */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                  <span className="font-semibold text-xs text-foreground truncate">
                    @{item.agentName}
                  </span>
                  <span className="text-3xs text-muted-foreground truncate font-mono">
                    #{item.channelTitle || item.channelId}
                  </span>
                </div>

                <span
                  className={cn(
                    'text-3xs px-1.5 py-0.5 rounded font-mono font-medium shrink-0',
                    isApproval
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                      : isStalled
                      ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                      : 'bg-surface2 text-muted-foreground'
                  )}
                >
                  {isApproval ? 'Awaiting approval' : isStalled ? 'Stalled' : 'Error'}
                </span>
              </div>

              {/* Command / Details Preview */}
              <div className="p-2 rounded-lg bg-surface2 font-mono text-2xs text-foreground-muted space-y-1">
                {item.toolName && (
                  <div className="flex items-center gap-1 text-3xs text-foreground font-medium">
                    <Terminal className="size-3 text-amber-500" />
                    <span>Tool: {item.toolName}</span>
                  </div>
                )}
                {item.command && (
                  <div className="truncate text-foreground font-medium">$ {item.command}</div>
                )}
                {item.path && <div className="truncate">File: {item.path}</div>}
                {isStalled && (
                  <div className="flex items-center gap-1 text-rose-600 dark:text-rose-400 font-medium">
                    <Clock className="size-3" />
                    <span>
                      Stalled for over {item.stalledMs ? `${Math.round(item.stalledMs / 1000)}s` : '30s'}
                    </span>
                  </div>
                )}
              </div>

              {/* Actions Footer */}
              <div className="flex items-center justify-between gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => onOpenThread(item.channelId)}
                  className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <span>Open channel</span>
                  <ArrowRight className="size-3" />
                </button>

                <div className="flex items-center gap-1.5">
                  {isApproval ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleDeny(item)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-500/10 border border-rose-500/20 transition-colors cursor-pointer"
                      >
                        <X className="size-3" />
                        <span>Deny</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApprove(item)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
                      >
                        <Check className="size-3" />
                        <span>Approve</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleForceStop(item)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-600 text-white hover:bg-rose-700 transition-colors cursor-pointer shadow-xs"
                    >
                      <Square className="size-3 fill-current" />
                      <span>Force stop</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
