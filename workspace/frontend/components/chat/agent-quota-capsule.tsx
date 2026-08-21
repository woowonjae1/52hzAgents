'use client';

import * as React from 'react';
import { Gauge, RefreshCw, Zap, Clock, Calendar, Sparkles, AlertCircle, FileText } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import type { AgentUsage } from '@/lib/types';
import { cn } from '@/lib/utils';

interface AgentQuotaCapsuleProps {
  /** 外部建议展示的 agent（通常是当前选中模型所属的），用户可在面板内切换到其他 agent。 */
  agentName?: string;
  className?: string;
}

type QuotaKind = 'claude';

interface QuotaAgent {
  name: string;
  kind: QuotaKind;
  online: boolean;
}

/** 判断某个 agent 是否有可展示的用量面板，以及属于哪一类。 */
function quotaKindOf(name?: string | null, agentType?: string | null): QuotaKind | null {
  const lower = (name || '').toLowerCase();
  const typeLower = (agentType || '').toLowerCase();
  if (lower.includes('claude') || typeLower === 'claude') return 'claude';
  return null;
}

export function AgentQuotaCapsule({ agentName, className }: AgentQuotaCapsuleProps) {
  const { workspaceId, agents } = useWorkspace();
  // 按 agent 名缓存用量，切换时不会闪回空白。
  const [usageByAgent, setUsageByAgent] = React.useState<Record<string, AgentUsage>>({});
  const [loadingAgent, setLoadingAgent] = React.useState<string | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  // 用户在面板里手动选择的 agent；为空时跟随外部传入的当前模型。
  const [manualAgent, setManualAgent] = React.useState<string | null>(null);

  const quotaAgents = React.useMemo<QuotaAgent[]>(
    () =>
      agents
        .map((a) => {
          const kind = quotaKindOf(a.agentName, a.agentType);
          return kind ? { name: a.agentName, kind, online: a.status === 'online' } : null;
        })
        .filter((a): a is QuotaAgent => a !== null),
    [agents]
  );

  const onlineAgents = React.useMemo(() => quotaAgents.filter((a) => a.online), [quotaAgents]);

  // 选中优先级：手动切换 > 外部传入的当前模型（若支持配额） > 若未指定外部模型则取第一个在线配额 Agent
  const selected = React.useMemo<QuotaAgent | null>(() => {
    if (manualAgent) {
      const match = onlineAgents.find((a) => a.name.toLowerCase() === manualAgent.toLowerCase());
      if (match) return match;
    }

    if (agentName) {
      const targetAgentObj = agents.find((a) => a.agentName.toLowerCase() === agentName.toLowerCase());
      const kind = quotaKindOf(agentName, targetAgentObj?.agentType);
      if (!kind) {
        // Explicitly targeted an agent without quota (e.g. OpenClaw / Antigravity) — do not pollute with other agent's quota
        return null;
      }
      return onlineAgents.find((a) => a.name.toLowerCase() === agentName.toLowerCase()) ||
             onlineAgents.find((a) => a.kind === kind) ||
             null;
    }

    return onlineAgents[0] ?? null;
  }, [manualAgent, agentName, onlineAgents, agents]);

  const selectedName = selected?.name;

  const fetchUsage = React.useCallback(
    async (target?: string) => {
      const name = target ?? selectedName;
      if (!name) return;
      try {
        setLoadingAgent(name);
        if (workspaceId) {
          workspaceApi.setWorkspaceId(workspaceId);
        }
        const data = await workspaceApi.getAgentUsage(name);
        if (data && (data.session_used_percent !== undefined || data.week_used_percent !== undefined || data.raw_text)) {
          setUsageByAgent((prev) => ({ ...prev, [name]: data }));
        }
      } catch {
        // silently ignore
      } finally {
        setLoadingAgent((cur) => (cur === name ? null : cur));
      }
    },
    [workspaceId, selectedName]
  );

  React.useEffect(() => {
    if (!selectedName) return;
    fetchUsage(selectedName);
    const interval = setInterval(() => fetchUsage(selectedName), 30_000);
    return () => clearInterval(interval);
  }, [fetchUsage, selectedName]);

  // 只有在没有任何可展示用量的 agent 在线时才完全隐藏。
  if (!selected) return null;

  const usage = usageByAgent[selected.name] ?? null;
  const loading = loadingAgent === selected.name;

  const sessionPercent = usage?.session_used_percent ?? 0;
  const weekPercent = usage?.week_used_percent ?? 0;
  const isUnparsed = (usage as any)?.parse_status === 'unparsed';
  const isEstimated = Boolean((usage as any)?.is_estimated);

  const getBarColor = (pct: number) => {
    if (pct >= 85) return 'bg-rose-500';
    if (pct >= 60) return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  const agentLabel = 'Claude';
  const badgeLabel = isUnparsed ? 'Parse failed' : 'Pro / Max';

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) fetchUsage();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border transition-all duration-200 cursor-pointer select-none',
            'bg-surface2/80 hover:bg-surface3/90 border-border/70 hover:border-border text-foreground shadow-2xs',
            isUnparsed && 'border-amber-500/50 bg-amber-500/10 text-amber-500',
            className
          )}
          title={`View ${agentLabel} usage and refresh state`}
        >
          <span className="relative flex size-2 shrink-0 items-center justify-center">
            <span
              className={cn(
                'absolute inline-flex size-full rounded-full opacity-75 animate-ping',
                isUnparsed
                  ? 'bg-amber-400'
                  : sessionPercent >= 85
                  ? 'bg-rose-400'
                  : sessionPercent >= 60
                  ? 'bg-amber-400'
                  : 'bg-emerald-400'
              )}
            />
            <span
              className={cn(
                'relative inline-flex size-1.5 rounded-full',
                isUnparsed
                  ? 'bg-amber-500'
                  : sessionPercent >= 85
                  ? 'bg-rose-500'
                  : sessionPercent >= 60
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
              )}
            />
          </span>
          <span className="text-foreground-muted font-normal">5h</span>
          <span
            className={cn(
              'font-semibold tabular-nums',
              isUnparsed ? 'text-amber-500' : sessionPercent >= 85 ? 'text-rose-500' : sessionPercent >= 60 ? 'text-amber-500' : 'text-foreground'
            )}
          >
            {sessionPercent}%
          </span>
          <span className="text-foreground-extra-muted">·</span>
          <span className="text-foreground-muted font-normal">Week</span>
          <span className="font-semibold tabular-nums text-foreground">{weekPercent}%</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-88 p-4 space-y-4 shadow-xl border-border/80 bg-surface1/95 backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Gauge className="size-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                {agentLabel} usage
                <span className={cn(
                  'text-3xs font-normal px-1.5 py-0.2 rounded border',
                  isUnparsed ? 'bg-amber-500/10 border-amber-500/30 text-amber-500' : 'bg-surface3 border-border/60 text-foreground-muted'
                )}>
                  {badgeLabel}
                </span>
              </div>
              <p className="text-3xs text-foreground-muted">
                {isEstimated ? 'Estimated activity — not a live quota' : 'Live quota and reset window'}
              </p>
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              fetchUsage();
            }}
            disabled={loading}
            className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer disabled:opacity-50"
            title="Refresh usage"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        {/* Agent 切换器：有多个可展示用量的 Agent 时出现，离线项保留但不可选 */}
        {quotaAgents.length > 1 && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface2/70 border border-border/50">
            {quotaAgents.map((a) => {
              const active = a.name === selected.name;
              return (
                <button
                  key={a.name}
                  type="button"
                  disabled={!a.online}
                  onClick={(e) => {
                    e.stopPropagation();
                    setManualAgent(a.name);
                    fetchUsage(a.name);
                  }}
                  className={cn(
                    'flex-1 min-w-0 px-2 py-1 rounded-md text-2xs font-medium transition-colors truncate border',
                    active
                      ? 'bg-surface1 text-foreground border-border/60 shadow-2xs'
                      : 'text-foreground-muted hover:text-foreground border-transparent',
                    !a.online && 'opacity-40 cursor-not-allowed hover:text-foreground-muted'
                  )}
                  title={a.online ? `View ${a.name} usage` : `${a.name} is offline — usage shows once it connects`}
                >
                  <span className="inline-flex items-center gap-1 max-w-full">
                    <span
                      className={cn(
                        'size-1.5 rounded-full shrink-0',
                        a.online ? 'bg-emerald-500' : 'bg-foreground-extra-muted'
                      )}
                    />
                    <span className="truncate">{a.name}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Unparsed warning alert */}
        {isUnparsed && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-2xs">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-medium">Could not parse a percentage from the CLI output</div>
              <div className="text-3xs text-amber-500/80">Raw /usage output below — expand to check.</div>
            </div>
          </div>
        )}

        {/* 5-Hour / Session Limit */}
        <div className="space-y-2 bg-surface2/50 border border-border/50 rounded-xl p-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Clock className="size-3.5 text-primary" />
              <span>5-hour session limit</span>
            </div>
            <span className={cn('font-semibold tabular-nums text-xs', sessionPercent >= 85 ? 'text-rose-500' : sessionPercent >= 60 ? 'text-amber-500' : 'text-emerald-500')}>
              {sessionPercent}% {isEstimated ? 'active' : 'used'}
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-2 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
            <div
              className={cn('h-full rounded-full transition-all duration-500', getBarColor(sessionPercent))}
              style={{ width: `${Math.min(Math.max(sessionPercent, 2), 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-2xs text-foreground-muted pt-0.5">
            <span>{isEstimated ? 'Method' : 'Resets'}</span>
            <span className="font-medium text-foreground/90">
              {usage?.session_resets_at || (loading ? 'Loading…' : '--')}
            </span>
          </div>
        </div>

        {/* Weekly Quota / 7-Day Activity */}
        <div className="space-y-2 bg-surface2/50 border border-border/50 rounded-xl p-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Calendar className="size-3.5 text-primary" />
              <span>Weekly limit (all models)</span>
            </div>
            <span className="font-semibold tabular-nums text-xs text-foreground">
              {weekPercent}% {isEstimated ? 'active' : 'used'}
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-2 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
            <div
              className={cn('h-full rounded-full transition-all duration-500', getBarColor(weekPercent))}
              style={{ width: `${Math.min(Math.max(weekPercent, 2), 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-2xs text-foreground-muted pt-0.5">
            <span>{isEstimated ? 'Scope' : 'Resets'}</span>
            <span className="font-medium text-foreground/90">
              {usage?.week_resets_at || (loading ? 'Loading…' : '--')}
            </span>
          </div>
        </div>

        {/* Breakdown / Insights */}
        {(usage?.last_24h_summary || usage?.last_7d_summary) && (
          <div className="space-y-1.5 pt-1 text-2xs text-foreground-muted border-t border-border/50">
            {usage.last_24h_summary && (
              <div className="flex items-start gap-1.5">
                <Sparkles className="size-3 text-primary shrink-0 mt-0.5" />
                <span>Last 24h: {usage.last_24h_summary}</span>
              </div>
            )}
            {usage.last_7d_summary && (
              <div className="flex items-start gap-1.5">
                <Zap className="size-3 text-muted-foreground shrink-0 mt-0.5" />
                <span>Engine: {usage.last_7d_summary}</span>
              </div>
            )}
          </div>
        )}

        {/* Raw output preview if unparsed or requested */}
        {isUnparsed && usage?.raw_text && (
          <details className="pt-1 text-3xs text-foreground-muted border-t border-border/50">
            <summary className="cursor-pointer hover:text-foreground flex items-center gap-1 font-medium select-none">
              <FileText className="size-3 text-muted-foreground" />
              Raw CLI output
            </summary>
            <pre className="mt-1.5 p-2 rounded-md bg-surface2 text-3xs text-foreground-muted overflow-x-auto whitespace-pre-wrap max-h-32 font-mono">
              {usage.raw_text}
            </pre>
          </details>
        )}

        {/* Tip */}
        <div className="text-3xs text-foreground-extra-muted leading-relaxed pt-1">
          Usage syncs on the 30s background heartbeat and whenever you send a message.
        </div>
      </PopoverContent>
    </Popover>
  );
}
