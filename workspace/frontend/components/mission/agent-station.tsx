'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import {
  MessageSquare,
  Wrench,
  Plug,
  ShieldAlert,
  Clock,
  Check,
  X,
  RotateCw,
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
    .replace(/```[\s\S]*?```/g, '[代码块]')
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
  const heartbeatDiffSec = React.useMemo(() => {
    if (!lastHeartbeatAt) return null;
    const timeMs = typeof lastHeartbeatAt === 'string' ? new Date(lastHeartbeatAt).getTime() : lastHeartbeatAt;
    if (!timeMs || isNaN(timeMs)) return null;
    return Math.max(1, Math.round((Date.now() - timeMs) / 1000));
  }, [lastHeartbeatAt]);

  const isHeartbeatTimeout = heartbeatDiffSec !== null && heartbeatDiffSec > 30;

  // Single Source of Truth for Status Badge
  const statusBadge = React.useMemo(() => {
    if (isBlocked) {
      return {
        label: '等待审批',
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/25',
        badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium',
      };
    }
    if (isStalled) {
      const sec = stalledMs ? Math.round(stalledMs / 1000) : 30;
      return {
        label: `停滞 · ${sec}s`,
        dot: 'bg-rose-500',
        ring: 'ring-rose-500/25',
        badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium',
      };
    }
    if (isHeartbeatTimeout) {
      const hbTime = typeof lastHeartbeatAt === 'string' ? lastHeartbeatAt : new Date(lastHeartbeatAt!).toISOString();
      return {
        label: `心跳超时 · ${timeAgo(hbTime)}`,
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/25',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium',
      };
    }
    if (isWorking) {
      return {
        label: '执行中',
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/25',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium',
      };
    }
    if (status === 'ready') {
      return {
        label: '在线就绪',
        dot: 'bg-emerald-500',
        ring: 'ring-emerald-500/25',
        badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium',
      };
    }
    if (isCatalogPlaceholder) {
      return {
        label: '未接入',
        dot: 'bg-muted-foreground/40',
        ring: 'ring-muted-foreground/10',
        badge: 'bg-surface2/60 text-muted-foreground font-medium',
      };
    }
    return {
      label: '离线',
      dot: 'bg-muted-foreground/50',
      ring: 'ring-muted-foreground/10',
      badge: 'bg-surface2/80 text-muted-foreground font-medium',
    };
  }, [isBlocked, isStalled, isHeartbeatTimeout, isWorking, status, isCatalogPlaceholder, stalledMs, lastHeartbeatAt]);

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
      toast.success(`已批准 @${agent.agentName} 执行`);
      onApprovalResolved?.();
    } catch {
      toast.error('批准失败');
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
      toast.info(`已拒绝 @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('拒绝操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'group relative flex flex-col justify-between rounded-2xl p-3.5',
        'bg-surface1/70 dark:bg-surface1/40 backdrop-blur-md shadow-2xs transition-all duration-150',
        'border border-border/30 hover:border-border/60 hover:shadow-xs',
        isBlocked && 'ring-2 ring-amber-500/20 bg-amber-500/[0.02]',
        isStalled && 'ring-2 ring-rose-500/20 bg-rose-500/[0.02]',
        isHeartbeatTimeout && 'border-amber-500/30',
        status === 'offline' && !isCatalogPlaceholder && 'opacity-85',
        isCatalogPlaceholder && 'bg-surface1/30'
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
                <span className="text-[9px] px-1 rounded bg-surface3 text-foreground font-mono font-medium">
                  主导
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
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] shrink-0',
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
        <div className="my-2 p-2 rounded-xl bg-amber-500/10 space-y-1.5 text-xs animate-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3" />
              <span>待批执行 · {pendingApproval.tool}</span>
            </span>
          </div>
          {pendingApproval.command && (
            <div className="font-mono text-[10.5px] text-foreground font-medium truncate p-1 bg-surface1 rounded">
              $ {pendingApproval.command}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={handleDeny}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-[11px] font-medium text-rose-600 hover:bg-rose-500/10 cursor-pointer"
            >
              <X className="size-2.5" />
              <span>拒绝</span>
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:opacity-90 cursor-pointer shadow-xs"
            >
              <Check className="size-2.5" />
              <span>批准</span>
            </button>
          </div>
        </div>
      ) : !isCatalogPlaceholder ? (
        /* Configured Agent: 3 Micro Metrics Grid + Activity */
        <div className="my-2 space-y-1.5">
          <div className="grid grid-cols-3 gap-1 p-1.5 rounded-xl bg-surface2/50 text-[10.5px]">
            <div className="flex flex-col min-w-0 px-1 text-center">
              <span className="text-[9.5px] uppercase font-mono text-muted-foreground truncate">Tokens</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {fmtTokens(tokenCount)}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 text-center">
              <span className="text-[9.5px] uppercase font-mono text-muted-foreground truncate">频道</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {threads.length}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 text-center">
              <span className="text-[9.5px] uppercase font-mono text-muted-foreground truncate">技能</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {skillCount}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 text-[11px] text-muted-foreground px-1 truncate">
            {isWorking ? (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium truncate animate-pulse">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate">{stripMarkdown(activity?.content || '正在执行任务...')}</span>
              </span>
            ) : activeThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(activeThread.sessionId)}
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors truncate cursor-pointer text-left text-[10.5px]"
              >
                <span className="text-primary font-medium">#{activeThread.title || '新频道'}</span>
                {activeThread.lastEventAt && (
                  <span className="text-muted-foreground/70">
                    · {timeAgo(new Date(activeThread.lastEventAt).toISOString())}
                  </span>
                )}
              </button>
            ) : (
              <span className="text-muted-foreground/60 italic text-[10.5px]">
                {isHeartbeatTimeout ? '进程心跳中断' : status === 'offline' ? '进程未启动' : '待命中'}
              </span>
            )}
          </div>
        </div>
      ) : (
        /* Unconnected Template Agent */
        <div className="my-2 px-1 py-1 text-[11px] text-muted-foreground leading-relaxed line-clamp-2 min-h-[38px]">
          {agent.description || '支持 ACP / MCP 协议的智能体工作区适配器。'}
        </div>
      )}

      {/* Footer Controls */}
      <div className="flex items-center gap-1.5 pt-2">
        {!isCatalogPlaceholder && (
          <button
            type="button"
            onClick={onOpenAgent}
            className="flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg bg-surface2/80 hover:bg-surface3 text-xs font-medium text-foreground transition-colors cursor-pointer shadow-2xs"
          >
            <MessageSquare className="size-3 text-muted-foreground" />
            <span>对话</span>
          </button>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPairAgent?.();
          }}
          disabled={status === 'ready' && !isHeartbeatTimeout}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg text-xs font-medium transition-all shadow-2xs',
            status === 'ready' && !isHeartbeatTimeout
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 cursor-default'
              : isHeartbeatTimeout
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 cursor-pointer font-semibold'
              : 'bg-surface2/80 hover:bg-surface3 text-foreground cursor-pointer'
          )}
        >
          {status === 'ready' && !isHeartbeatTimeout ? (
            <span>已连接</span>
          ) : isHeartbeatTimeout ? (
            <>
              <RotateCw className="size-3" />
              <span>重新连接</span>
            </>
          ) : isCustomPlaceholder ? (
            <span>配置</span>
          ) : (
            <>
              <Plug className="size-3 text-muted-foreground" />
              <span>连接</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
