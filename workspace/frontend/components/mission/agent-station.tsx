'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import {
  MessageSquare,
  Zap,
  Radio,
  Wrench,
  ChevronRight,
  Plug,
  ShieldAlert,
  Clock,
  Check,
  X,
  Terminal,
  Activity,
  Sparkles,
} from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';

export type StationStatus = 'working' | 'ready' | 'offline' | 'blocked' | 'stalled';

export interface StationData {
  agent: WorkspaceAgent;
  status: StationStatus;
  threads: WorkspaceSession[];
  focusThread: WorkspaceSession | null;
  activity: { content: string; senderName: string; isStatus?: boolean } | null;
  skillCount: number;
  tokenCount?: number;
  isCatalogPlaceholder?: boolean;
  stalledMs?: number;
  pendingApproval?: {
    approvalId: string;
    tool: string;
    command?: string;
    path?: string;
  };
  lastHeartbeatAt?: string | number | null;
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '0';
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

interface AgentStationProps {
  data: StationData;
  onOpenAgent: () => void;
  onOpenThread: (sessionId: string) => void;
  onPairAgent?: () => void;
  onApprovalResolved?: () => void;
}

export function AgentStation({
  data,
  onOpenAgent,
  onOpenThread,
  onPairAgent,
  onApprovalResolved,
}: AgentStationProps) {
  const {
    agent,
    status,
    threads,
    activity,
    skillCount,
    tokenCount = 0,
    isCatalogPlaceholder = false,
    stalledMs,
    pendingApproval,
    lastHeartbeatAt,
  } = data;

  const isWorking = status === 'working';
  const isBlocked = status === 'blocked';
  const isStalled = status === 'stalled';
  const isCustomPlaceholder = isCatalogPlaceholder === true && agent.agentName.toLowerCase() === 'custom';
  const activeThread = threads[0];
  const [busy, setBusy] = React.useState(false);

  // Heartbeat timeout calculation
  const isHeartbeatTimeout = React.useMemo(() => {
    if (!lastHeartbeatAt || status !== 'ready') return false;
    const timeMs = typeof lastHeartbeatAt === 'string' ? new Date(lastHeartbeatAt).getTime() : lastHeartbeatAt;
    if (!timeMs || isNaN(timeMs)) return false;
    return Date.now() - timeMs > 30000;
  }, [lastHeartbeatAt, status]);

  // Single Source of Truth for Status Badge
  const statusBadge = React.useMemo(() => {
    if (isBlocked) {
      return {
        label: 'Action Required',
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/25',
        badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 font-medium',
      };
    }
    if (isStalled) {
      const sec = stalledMs ? Math.round(stalledMs / 1000) : 30;
      return {
        label: `Stalled · ${sec}s`,
        dot: 'bg-rose-500',
        ring: 'ring-rose-500/25',
        badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25 font-medium',
      };
    }
    if (isHeartbeatTimeout) {
      return {
        label: 'Heartbeat Timeout',
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/25',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 font-medium',
      };
    }
    if (isWorking) {
      return {
        label: 'Working',
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/25',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 font-medium',
      };
    }
    if (status === 'ready') {
      return {
        label: 'Online',
        dot: 'bg-emerald-500',
        ring: 'ring-emerald-500/25',
        badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 font-medium',
      };
    }
    if (isCatalogPlaceholder) {
      return {
        label: 'Available',
        dot: 'bg-muted-foreground/40',
        ring: 'ring-muted-foreground/10',
        badge: 'bg-surface2/80 text-muted-foreground border-border/40 font-medium',
      };
    }
    return {
      label: 'Offline',
      dot: 'bg-muted-foreground/50',
      ring: 'ring-muted-foreground/10',
      badge: 'bg-surface2 text-muted-foreground border-border/50 font-medium',
    };
  }, [isBlocked, isStalled, isHeartbeatTimeout, isWorking, status, isCatalogPlaceholder, stalledMs]);

  const handleApprove = async () => {
    if (!pendingApproval || !activeThread) return;
    setBusy(true);
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: 'human:user',
        target: `channel/${activeThread.sessionId}`,
        payload: {
          content: 'Approved command execution via Agent Card.',
          sender_type: 'human',
          sender_name: 'user',
        },
        metadata: {
          target_agents: [agent.agentName],
          tool_approval_response: {
            approval_id: pendingApproval.approvalId,
            granted: true,
          },
        },
        visibility: 'channel',
      });
      toast.success(`Approved @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('Failed to submit approval');
    } finally {
      setBusy(false);
    }
  };

  const handleDeny = async () => {
    if (!pendingApproval || !activeThread) return;
    setBusy(true);
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: 'human:user',
        target: `channel/${activeThread.sessionId}`,
        payload: {
          content: 'Rejected command execution via Agent Card.',
          sender_type: 'human',
          sender_name: 'user',
        },
        metadata: {
          target_agents: [agent.agentName],
          tool_approval_response: {
            approval_id: pendingApproval.approvalId,
            granted: false,
          },
        },
        visibility: 'channel',
      });
      toast.info(`Rejected @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('Failed to reject');
    } finally {
      setBusy(false);
    }
  };

  const hasTelemetry = (tokenCount > 0 || threads.length > 0) && !isCatalogPlaceholder;

  return (
    <div
      className={cn(
        'group relative flex flex-col justify-between rounded-2xl border p-3.5',
        'bg-surface1/80 dark:bg-surface1/50 backdrop-blur-md shadow-2xs transition-all duration-150',
        'hover:border-border-accent/80 hover:shadow-xs',
        isBlocked && 'border-amber-500/50 ring-2 ring-amber-500/20 bg-amber-500/[0.02]',
        isStalled && 'border-rose-500/50 ring-2 ring-rose-500/20 bg-rose-500/[0.02]',
        status === 'offline' && !isCatalogPlaceholder && 'border-border/60 opacity-85',
        isCatalogPlaceholder && 'border-border/40 bg-surface1/40'
      )}
    >
      {/* Top Header */}
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onOpenAgent}
          className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer group/title"
        >
          <AgentAvatar
            name={agent.agentName}
            agentType={agent.agentType}
            size={28}
            status={agent.status}
          />

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs text-foreground truncate group-hover/title:text-primary transition-colors">
                {agent.agentName}
              </span>
              {agent.role === 'master' && (
                <span className="text-[9px] px-1 rounded bg-surface3 border border-border-accent text-foreground font-mono font-medium">
                  leader
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground truncate font-mono mt-0.5">
              {agent.agentType || 'agent'}
            </div>
          </div>
        </button>

        {/* Unified Status Badge */}
        <span
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border shrink-0',
            statusBadge.badge
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full ring-2',
              statusBadge.dot,
              statusBadge.ring,
              (isWorking || isBlocked) && 'animate-pulse'
            )}
          />
          <span>{statusBadge.label}</span>
        </span>
      </div>

      {/* Inline Blocked Approval */}
      {isBlocked && pendingApproval ? (
        <div className="my-2 p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-1.5 text-xs animate-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3" />
              <span>Approval · {pendingApproval.tool}</span>
            </span>
          </div>
          {pendingApproval.command && (
            <div className="font-mono text-[10.5px] text-foreground font-medium truncate p-1 bg-surface1 rounded border border-border/40">
              $ {pendingApproval.command}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={handleDeny}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-[11px] font-medium text-rose-600 hover:bg-rose-500/10 border border-rose-500/20 cursor-pointer"
            >
              <X className="size-2.5" />
              <span>Deny</span>
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:opacity-90 cursor-pointer shadow-xs"
            >
              <Check className="size-2.5" />
              <span>Approve</span>
            </button>
          </div>
        </div>
      ) : hasTelemetry ? (
        /* Connected Agent with Real Telemetry */
        <div className="my-2 space-y-1.5">
          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-surface2/60 border border-border/40 text-[10.5px]">
            <div className="flex flex-col min-w-0 px-1">
              <span className="text-[9px] uppercase font-mono text-muted-foreground truncate">Tokens</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {fmtTokens(tokenCount)}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 border-l border-border/40">
              <span className="text-[9px] uppercase font-mono text-muted-foreground truncate">Threads</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {threads.length}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 border-l border-border/40">
              <span className="text-[9px] uppercase font-mono text-muted-foreground truncate">Skills</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {skillCount}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 text-[11px] text-muted-foreground px-1 truncate">
            {isWorking ? (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium truncate animate-pulse">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate">{stripMarkdown(activity?.content || 'Executing task...')}</span>
              </span>
            ) : activeThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(activeThread.sessionId)}
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors truncate cursor-pointer text-left font-mono text-[10.5px]"
              >
                <span className="text-primary font-medium">#{activeThread.title || 'channel'}</span>
                {activeThread.lastEventAt && (
                  <span className="text-muted-foreground/70">
                    · {timeAgo(new Date(activeThread.lastEventAt).toISOString())}
                  </span>
                )}
              </button>
            ) : (
              <span className="text-muted-foreground/60 italic text-[10.5px]">
                {status === 'offline' ? 'Daemon offline' : 'Standby / Ready'}
              </span>
            )}
          </div>
        </div>
      ) : (
        /* Unconnected / Template Agent: Show Capability Description instead of empty 0 boxes */
        <div className="my-2 px-1 py-1 text-[11px] text-muted-foreground leading-relaxed line-clamp-2 min-h-[38px]">
          {agent.description || 'Configurable ACP/MCP agent workspace adapter with tool support.'}
        </div>
      )}

      {/* Footer Controls */}
      <div className="flex items-center gap-1.5 pt-2 border-t border-border/40">
        {!isCatalogPlaceholder && (
          <button
            type="button"
            onClick={onOpenAgent}
            className="flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg bg-surface2 hover:bg-surface3 border border-border/60 text-xs font-medium text-foreground transition-colors cursor-pointer shadow-2xs"
          >
            <MessageSquare className="size-3 text-muted-foreground" />
            <span>Chat</span>
          </button>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPairAgent?.();
          }}
          disabled={status !== 'offline'}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg text-xs font-medium transition-all shadow-2xs',
            status === 'offline'
              ? 'bg-surface2 hover:bg-surface3 text-foreground border border-border/80 cursor-pointer'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 cursor-default'
          )}
        >
          {status !== 'offline' ? (
            <span>Connected</span>
          ) : isCustomPlaceholder ? (
            <span>Configure</span>
          ) : (
            <>
              <Plug className="size-3 text-muted-foreground" />
              <span>Connect</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
