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
  Cpu,
  Gauge,
  ChevronDown,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { parseReportedModels, type AgentModelOption } from '@/components/chat/agent-model-switcher';
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
    .replace(/```[\s\S]*?```/g, '[code block]')
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
  // Model and effort are pushed to a running adapter over the control channel.
  // An offline agent has nothing polling for that event, so the change would be
  // accepted by the UI and quietly go nowhere - the controls are disabled
  // instead of failing after the fact.
  const canConfigure = status !== 'offline' && !isCatalogPlaceholder;
  const offlineHint = 'Agent 未连接 - 连接后才能切换';
  const activeThread = threads[0];
  const [busy, setBusy] = React.useState(false);
  const [modelInfo, setModelInfo] = React.useState<{ current: string | null; models: AgentModelOption[] }>({
    current: null,
    models: [],
  });
  // Reasoning effort is a separate axis from the model and only some runtimes
  // have one, so it renders only when the adapter actually reported levels.
  const [effortInfo, setEffortInfo] = React.useState<{ current: string | null; levels: AgentModelOption[] }>({
    current: null,
    levels: [],
  });
  const [customModelInput, setCustomModelInput] = React.useState('');
  const [isEnteringCustom, setIsEnteringCustom] = React.useState(false);

  React.useEffect(() => {
    if (isCatalogPlaceholder) return;
    let mounted = true;
    const fetchUsage = async () => {
      try {
        const usage = await workspaceApi.getAgentUsage(agent.agentName);
        if (!mounted) return;
        const parsed = parseReportedModels(usage?.available_models);
        setModelInfo({
          current: usage?.current_model || null,
          models: parsed,
        });
        setEffortInfo({
          current: usage?.current_effort || null,
          levels: parseReportedModels(usage?.available_efforts),
        });
      } catch {}
    };
    fetchUsage();
    const interval = setInterval(fetchUsage, 25_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [agent.agentName, isCatalogPlaceholder]);

  const handleSwitchEffort = async (level: string) => {
    if (!canConfigure) return;
    try {
      await workspaceApi.sendAgentControl(agent.agentName, 'set_effort', { effort: level });
      setEffortInfo((prev) => ({ ...prev, current: level }));
      toast.success(`@${agent.agentName} 推理强度已设为 ${level}`);
    } catch (e) {
      toast.error(`切换推理强度失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleSwitchModel = async (newModelId: string, modelLabel: string) => {
    if (!canConfigure) return;
    try {
      await workspaceApi.sendAgentControl(agent.agentName, 'set_model', { model: newModelId });
      setModelInfo((prev) => ({ ...prev, current: newModelId }));
      toast.success(`@${agent.agentName} 已切换为 ${modelLabel}`);
    } catch (e) {
      toast.error(`切换模型失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
        label: 'Awaiting approval',
        dot: 'bg-status-warning',
        ring: 'ring-status-warning/25',
        badge: 'bg-status-warning/15 text-status-warning font-medium',
      };
    }
    if (isStalled) {
      const sec = stalledMs ? Math.round(stalledMs / 1000) : 30;
      return {
        label: `Stalled · ${sec}s`,
        dot: 'bg-status-danger',
        ring: 'ring-status-danger/25',
        badge: 'bg-status-danger/10 text-status-danger font-medium',
      };
    }
    if (isHeartbeatTimeout) {
      const hbTime = typeof lastHeartbeatAt === 'string' ? lastHeartbeatAt : new Date(lastHeartbeatAt!).toISOString();
      return {
        label: `Heartbeat lost · ${timeAgo(hbTime)}`,
        dot: 'bg-status-warning',
        ring: 'ring-status-warning/25',
        badge: 'bg-status-warning/10 text-status-warning font-medium',
      };
    }
    if (isWorking) {
      return {
        label: 'Running',
        dot: 'bg-status-warning',
        ring: 'ring-status-warning/25',
        badge: 'bg-status-warning/10 text-status-warning font-medium',
      };
    }
    if (status === 'ready') {
      return {
        label: 'Ready',
        dot: 'bg-status-success',
        ring: 'ring-status-success/25',
        badge: 'bg-status-success/10 text-status-success font-medium',
      };
    }
    if (isCatalogPlaceholder) {
      return {
        label: 'Not connected',
        dot: 'bg-muted-foreground/40',
        ring: 'ring-muted-foreground/10',
        badge: 'bg-surface2/60 text-muted-foreground font-medium',
      };
    }
    return {
      label: 'Offline',
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
      toast.success(`Approved @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('Approval failed');
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
      toast.info(`Denied @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('Could not submit the denial');
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
        isBlocked && 'ring-2 ring-status-warning/20 bg-status-warning/[0.02]',
        isStalled && 'ring-2 ring-status-danger/20 bg-status-danger/[0.02]',
        isHeartbeatTimeout && 'border-status-warning/30',
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
                <span className="text-3xs px-1 rounded bg-surface3 text-foreground font-mono font-medium">
                  Master
                </span>
              )}
            </div>
            <div className="text-3xs text-muted-foreground truncate font-mono mt-0.5">
              {agent.agentType || 'agent'}
            </div>
          </div>
        </button>

        {/* Unified Status Badge */}
        <span
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs shrink-0',
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
        <div className="my-2 p-2 rounded-xl bg-status-warning/10 space-y-1.5 text-xs animate-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between text-3xs font-medium text-status-warning">
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3" />
              <span>Awaiting approval · {pendingApproval.tool}</span>
            </span>
          </div>
          {pendingApproval.command && (
            <div className="font-mono text-3xs text-foreground font-medium truncate p-1 bg-surface1 rounded">
              $ {pendingApproval.command}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={handleDeny}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-2xs font-medium text-status-danger hover:bg-status-danger/10 cursor-pointer"
            >
              <X className="size-2.5" />
              <span>Deny</span>
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-2xs font-medium bg-primary text-primary-foreground hover:opacity-90 cursor-pointer shadow-xs"
            >
              <Check className="size-2.5" />
              <span>Approve</span>
            </button>
          </div>
        </div>
      ) : !isCatalogPlaceholder ? (
        /* Configured Agent: 3 Micro Metrics Grid + Activity */
        <div className="my-2 space-y-1.5">
          <div className="grid grid-cols-3 gap-1 p-1.5 rounded-xl bg-surface2/50 text-3xs">
            <div className="flex flex-col min-w-0 px-1 text-center">
              <span className="text-3xs uppercase font-mono text-muted-foreground truncate">Tokens</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {fmtTokens(tokenCount)}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 text-center">
              <span className="text-3xs uppercase font-mono text-muted-foreground truncate">Channel</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {threads.length}
              </span>
            </div>

            <div className="flex flex-col min-w-0 px-1 text-center">
              <span className="text-3xs uppercase font-mono text-muted-foreground truncate">Skills</span>
              <span className="font-semibold font-mono text-foreground truncate">
                {skillCount}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 text-2xs text-muted-foreground px-1 truncate">
            {isWorking ? (
              <span className="inline-flex items-center gap-1 text-status-warning font-medium truncate animate-pulse">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate">{stripMarkdown(activity?.content || 'Working…')}</span>
              </span>
            ) : activeThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(activeThread.sessionId)}
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors truncate cursor-pointer text-left text-3xs"
              >
                <span className="text-primary font-medium">#{activeThread.title || 'New channel'}</span>
                {activeThread.lastEventAt && (
                  <span className="text-muted-foreground/70">
                    · {timeAgo(new Date(activeThread.lastEventAt).toISOString())}
                  </span>
                )}
              </button>
            ) : (
              <span className="text-muted-foreground/60 italic text-3xs">
                {isHeartbeatTimeout ? 'Heartbeat lost' : status === 'offline' ? 'Process not running' : 'Standing by'}
              </span>
            )}
          </div>

          {/* Model indicator & fast switcher */}
          <div className="flex items-center justify-between px-1 text-3xs text-muted-foreground border-t border-border/20 pt-1.5">
            <span className="flex items-center gap-1">
              <Cpu className="size-3 text-muted-foreground/70" />
              <span>Model</span>
            </span>

            <DropdownMenu onOpenChange={(open) => { if (!open) { setIsEnteringCustom(false); setCustomModelInput(''); } }}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!canConfigure}
                  className={cn(
                    'inline-flex items-center gap-1 font-mono font-medium px-1.5 py-0.5 rounded transition-colors',
                    canConfigure
                      ? 'text-foreground hover:text-primary cursor-pointer bg-surface2/60 hover:bg-surface2'
                      : 'text-muted-foreground/60 bg-surface2/30 cursor-not-allowed'
                  )}
                  title={canConfigure ? '点击切换模型' : offlineHint}
                >
                  <span className="truncate max-w-[120px]">
                    {modelInfo.models.find((m) => m.id === modelInfo.current)?.shortName || modelInfo.current || '未配置模型'}
                  </span>
                  <ChevronDown className={cn('size-2.5 shrink-0', canConfigure ? 'opacity-60' : 'opacity-30')} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 p-1 bg-surface1/95 backdrop-blur-xl max-h-[320px] overflow-y-auto">
                {modelInfo.models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onClick={() => handleSwitchModel(m.id, m.name)}
                    className={cn(
                      'flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer',
                      modelInfo.current === m.id && 'font-bold text-primary bg-surface3'
                    )}
                  >
                    <span className="truncate">{m.name}</span>
                    {modelInfo.current === m.id && <Check className="size-3 text-primary ml-1" />}
                  </DropdownMenuItem>
                ))}

                {isEnteringCustom ? (
                  <div
                    className="p-1.5 space-y-1.5 border-t border-border/30 mt-1"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <input
                      type="text"
                      value={customModelInput}
                      onChange={(e) => setCustomModelInput(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' && customModelInput.trim()) {
                          handleSwitchModel(customModelInput.trim(), customModelInput.trim());
                          setIsEnteringCustom(false);
                          setCustomModelInput('');
                        } else if (e.key === 'Escape') {
                          setIsEnteringCustom(false);
                          setCustomModelInput('');
                        }
                      }}
                      placeholder="输入模型 ID (如 gpt-4o)..."
                      className="w-full px-2 py-1 text-2xs font-mono rounded border bg-surface2 outline-none focus:ring-1 focus:ring-primary/40 text-foreground"
                      autoFocus
                    />
                    <div className="flex gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => { setIsEnteringCustom(false); setCustomModelInput(''); }}
                        className="px-2 py-0.5 text-3xs rounded border hover:bg-surface2 text-muted-foreground"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={!customModelInput.trim()}
                        onClick={() => {
                          if (customModelInput.trim()) {
                            handleSwitchModel(customModelInput.trim(), customModelInput.trim());
                            setIsEnteringCustom(false);
                            setCustomModelInput('');
                          }
                        }}
                        className="px-2 py-0.5 text-3xs rounded bg-primary text-primary-foreground font-medium disabled:opacity-50"
                      >
                        确定
                      </button>
                    </div>
                  </div>
                ) : (
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      setIsEnteringCustom(true);
                      setCustomModelInput(modelInfo.current || '');
                    }}
                    className="flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer text-muted-foreground hover:text-foreground border-t border-border/30 mt-1"
                  >
                    <span>输入自定义模型…</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Reasoning effort - rendered only when this runtime reported levels
              of its own, so a runtime without the concept shows nothing. */}
          {effortInfo.levels.length > 0 && (
            <div className="flex items-center justify-between px-1 text-3xs text-muted-foreground pt-1">
              <span className="flex items-center gap-1">
                <Gauge className="size-3 text-muted-foreground/70" />
                <span>Effort</span>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={!canConfigure}
                    className={cn(
                      'inline-flex items-center gap-1 font-mono font-medium px-1.5 py-0.5 rounded transition-colors',
                      canConfigure
                        ? 'text-foreground hover:text-primary cursor-pointer bg-surface2/60 hover:bg-surface2'
                        : 'text-muted-foreground/60 bg-surface2/30 cursor-not-allowed'
                    )}
                    title={canConfigure ? '点击切换推理强度' : offlineHint}
                  >
                    <span className="truncate max-w-[120px]">{effortInfo.current || '未配置'}</span>
                    <ChevronDown className={cn('size-2.5 shrink-0', canConfigure ? 'opacity-60' : 'opacity-30')} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40 p-1 bg-surface1/95 backdrop-blur-xl">
                  {effortInfo.levels.map((lv) => (
                    <DropdownMenuItem
                      key={lv.id}
                      onClick={() => handleSwitchEffort(lv.id)}
                      className={cn(
                        'flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer',
                        effortInfo.current === lv.id && 'font-bold text-primary bg-surface3'
                      )}
                    >
                      <span className="truncate">{lv.name}</span>
                      {effortInfo.current === lv.id && <Check className="size-3 text-primary ml-1" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      ) : (
        /* Unconnected Template Agent */
        <div className="my-2 px-1 py-1 text-2xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[38px]">
          {agent.description || 'Workspace adapter for ACP / MCP capable agents.'}
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
            <span>Chat</span>
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
              ? 'bg-status-success/10 text-status-success cursor-default'
              : isHeartbeatTimeout
              ? 'bg-status-warning/15 text-status-warning hover:bg-status-warning/25 cursor-pointer font-semibold'
              : 'bg-surface2/80 hover:bg-surface3 text-foreground cursor-pointer'
          )}
        >
          {status === 'ready' && !isHeartbeatTimeout ? (
            <span>Connected</span>
          ) : isHeartbeatTimeout ? (
            <>
              <RotateCw className="size-3" />
              <span>Reconnect</span>
            </>
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
