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
} from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import { deriveIdentityColor } from '@/lib/identity-colors';
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

const STATUS_META: Record<
  StationStatus,
  { label: string; dot: string; ring: string; badge: string }
> = {
  blocked: {
    label: '等待审批',
    dot: 'bg-amber-500',
    ring: 'ring-amber-500/25',
    badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30 font-semibold',
  },
  stalled: {
    label: '执行停滞',
    dot: 'bg-rose-500',
    ring: 'ring-rose-500/25',
    badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25 font-semibold',
  },
  working: {
    label: '工作中',
    dot: 'bg-amber-500',
    ring: 'ring-amber-500/25',
    badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  },
  ready: {
    label: '就绪',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500/25',
    badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  },
  offline: {
    label: '离线',
    dot: 'bg-muted-foreground/50',
    ring: 'ring-muted-foreground/10',
    badge: 'bg-surface2 text-muted-foreground border-border/50',
  },
};

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
    tokenCount,
    isCatalogPlaceholder,
    stalledMs,
    pendingApproval,
    lastHeartbeatAt,
  } = data;
  const meta = STATUS_META[status];
  const isWorking = status === 'working';
  const isBlocked = status === 'blocked';
  const isStalled = status === 'stalled';
  const isCustomPlaceholder = isCatalogPlaceholder === true && agent.agentName.toLowerCase() === 'custom';
  const activeThread = threads[0];

  const [busy, setBusy] = React.useState(false);

  // Heartbeat text
  const heartbeatText = React.useMemo(() => {
    if (!lastHeartbeatAt) return null;
    const timeMs = typeof lastHeartbeatAt === 'string' ? new Date(lastHeartbeatAt).getTime() : lastHeartbeatAt;
    if (!timeMs || isNaN(timeMs)) return null;
    const diff = Math.max(1, Math.round((Date.now() - timeMs) / 1000));
    if (diff < 5) return '心跳正常';
    if (diff < 30) return `心跳 ${diff}s 前`;
    return '心跳超时';
  }, [lastHeartbeatAt]);

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
      toast.info(`已拒绝 @${agent.agentName} 执行`);
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
        'group relative flex flex-col justify-between rounded-2xl border p-3.5',
        'bg-surface1/90 dark:bg-surface1/60 backdrop-blur-md shadow-2xs transition-all duration-200',
        'hover:border-border-accent hover:shadow-md',
        isBlocked && 'border-amber-500/50 ring-2 ring-amber-500/20 bg-amber-500/[0.02]',
        isStalled && 'border-rose-500/50 ring-2 ring-rose-500/20 bg-rose-500/[0.02]',
        status === 'offline' ? 'border-border/60 opacity-90' : 'border-border/90'
      )}
    >
      {/* Top Header Row */}
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onOpenAgent}
          className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer group/title"
        >
          <AgentAvatar
            name={agent.agentName}
            agentType={agent.agentType}
            size={30}
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
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground truncate font-mono mt-0.5">
              <span>{agent.agentType || 'agent'}</span>
              {heartbeatText && (
                <>
                  <span>·</span>
                  <span className={heartbeatText === '心跳超时' ? 'text-rose-500 font-medium' : ''}>
                    {heartbeatText}
                  </span>
                </>
              )}
            </div>
          </div>
        </button>

        {/* Status Badge */}
        <span
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0',
            meta.badge
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full ring-2',
              meta.dot,
              meta.ring,
              (isWorking || isBlocked) && 'animate-pulse'
            )}
          />
          <span>{meta.label}</span>
        </span>
      </div>

      {/* Inline Blocked Approval Bar if blocked */}
      {isBlocked && pendingApproval && (
        <div className="my-2 p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-1.5 text-xs animate-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3" />
              <span>待批执行 · {pendingApproval.tool}</span>
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
      )}

      {/* Stalled Banner if stalled */}
      {isStalled && (
        <div className="my-2 p-2 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-1 text-xs text-rose-600 dark:text-rose-400">
          <div className="flex items-center gap-1 font-medium text-[11px]">
            <Clock className="size-3 shrink-0" />
            <span>停滞已超 {stalledMs ? `${Math.round(stalledMs / 1000)}s` : '30s'}</span>
          </div>
          <button
            type="button"
            onClick={() => activeThread && onOpenThread(activeThread.sessionId)}
            className="text-[10.5px] underline cursor-pointer hover:opacity-80"
          >
            检查状态
          </button>
        </div>
      )}

      {/* Stats & Current Activity Row */}
      {!isBlocked && (
        <div className="my-2 space-y-1.5">
          {/* Micro Metrics Grid */}
          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-surface2/60 border border-border/40 text-[10.5px]">
            <div className="flex flex-col min-w-0 px-1">
              <span className="text-[9.5px] uppercase font-mono text-muted-foreground truncate">Tokens</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {fmtTokens(tokenCount || 0)}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 border-l border-border/40">
              <span className="text-[9.5px] uppercase font-mono text-muted-foreground truncate">Channels</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {threads.length}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 border-l border-border/40">
              <span className="text-[9.5px] uppercase font-mono text-muted-foreground truncate">Skills</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {skillCount}
              </span>
            </div>
          </div>

          {/* Status / Activity Snippet */}
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground px-1 truncate">
            {isWorking ? (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium truncate animate-pulse">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate">{stripMarkdown(activity?.content || '正在执行任务...')}</span>
              </span>
            ) : activeThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(activeThread.sessionId)}
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors truncate cursor-pointer text-left"
              >
                <span className="text-primary font-medium">#{activeThread.title || '新频道'}</span>
                {activeThread.lastEventAt && (
                  <span className="text-[10px] text-muted-foreground/70 font-mono">
                    · {timeAgo(new Date(activeThread.lastEventAt).toISOString())}
                  </span>
                )}
              </button>
            ) : (
              <span className="text-muted-foreground/60 italic">
                {status === 'offline' ? '未连接' : '就绪等待指令'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Footer Controls */}
      <div className="flex items-center gap-1.5 pt-2 border-t border-border/40">
        {!isCustomPlaceholder && (
          <button
            type="button"
            onClick={onOpenAgent}
            className="flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg bg-surface2 hover:bg-surface3 border border-border/60 text-xs font-medium text-foreground transition-colors cursor-pointer shadow-2xs"
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
          disabled={status !== 'offline'}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg text-xs font-medium transition-all shadow-2xs',
            status === 'offline'
              ? 'bg-primary text-primary-foreground hover:opacity-90 cursor-pointer'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 cursor-default'
          )}
        >
          {status !== 'offline' ? (
            <span>已连接</span>
          ) : isCustomPlaceholder ? (
            <span>配置</span>
          ) : (
            <>
              <Plug className="size-3" />
              <span>连接</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
