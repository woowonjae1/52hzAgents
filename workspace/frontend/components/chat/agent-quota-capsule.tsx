'use client';

import * as React from 'react';
import { Gauge, RefreshCw, Zap, Clock, Calendar, Sparkles } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import type { AgentUsage } from '@/lib/types';
import { cn } from '@/lib/utils';

interface AgentQuotaCapsuleProps {
  agentName?: string;
  className?: string;
}

export function AgentQuotaCapsule({ agentName = 'claude', className }: AgentQuotaCapsuleProps) {
  const { workspaceId, agents } = useWorkspace();
  const [usage, setUsage] = React.useState<AgentUsage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [isOpen, setIsOpen] = React.useState(false);

  const isClaudeConnected = React.useMemo(() => {
    if (!agentName) return false;
    const isClaudeName = agentName.toLowerCase().includes('claude');
    const hasOnlineClaude = agents.some(
      (a) => a.agentName.toLowerCase().includes('claude') && a.status === 'online'
    );
    return isClaudeName && hasOnlineClaude;
  }, [agentName, agents]);

  const fetchUsage = React.useCallback(async () => {
    if (!agentName || !isClaudeConnected) return;
    try {
      setLoading(true);
      if (workspaceId) {
        workspaceApi.setWorkspaceId(workspaceId);
      }
      const data = await workspaceApi.getAgentUsage(agentName);
      if (data && (data.session_used_percent !== undefined || data.week_used_percent !== undefined)) {
        setUsage(data);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [workspaceId, agentName, isClaudeConnected]);

  React.useEffect(() => {
    if (!isClaudeConnected) return;
    fetchUsage();
    const interval = setInterval(fetchUsage, 45_000);
    return () => clearInterval(interval);
  }, [fetchUsage, isClaudeConnected]);

  if (!isClaudeConnected) return null;

  const sessionPercent = usage?.session_used_percent ?? 12;
  const weekPercent = usage?.week_used_percent ?? 5;

  const getStatusColor = (pct: number) => {
    if (pct >= 85) return 'text-rose-500 bg-rose-500/10 border-rose-500/30';
    if (pct >= 60) return 'text-amber-500 bg-amber-500/10 border-amber-500/30';
    return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30';
  };

  const getBarColor = (pct: number) => {
    if (pct >= 85) return 'bg-rose-500';
    if (pct >= 60) return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-all duration-200 cursor-pointer select-none',
            'bg-surface2/80 hover:bg-surface3/90 border-border/70 hover:border-border text-foreground shadow-2xs',
            className
          )}
          title="点击查看 Claude 5小时与周配额刷新状态"
        >
          <span className="relative flex size-2 shrink-0 items-center justify-center">
            <span
              className={cn(
                'absolute inline-flex size-full rounded-full opacity-75 animate-ping',
                sessionPercent >= 85 ? 'bg-rose-400' : sessionPercent >= 60 ? 'bg-amber-400' : 'bg-emerald-400'
              )}
            />
            <span
              className={cn(
                'relative inline-flex size-1.5 rounded-full',
                sessionPercent >= 85 ? 'bg-rose-500' : sessionPercent >= 60 ? 'bg-amber-500' : 'bg-emerald-500'
              )}
            />
          </span>
          <span className="text-foreground-muted font-normal">5h</span>
          <span className={cn('font-semibold tabular-nums', sessionPercent >= 85 ? 'text-rose-500' : sessionPercent >= 60 ? 'text-amber-500' : 'text-foreground')}>
            {sessionPercent}%
          </span>
          <span className="text-foreground-extra-muted">·</span>
          <span className="text-foreground-muted font-normal">周</span>
          <span className="font-semibold tabular-nums text-foreground">{weekPercent}%</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-84 p-4 space-y-4 shadow-xl border-border/80 bg-surface1/95 backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Gauge className="size-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                Claude 配额监控
                <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-surface3 text-foreground-muted">
                  Pro / Max
                </span>
              </div>
              <p className="text-[10.5px] text-foreground-muted">本地 CLI 实时用量与刷新周期</p>
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              fetchUsage();
            }}
            disabled={loading}
            className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer disabled:opacity-50"
            title="刷新配额"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        {/* 5-Hour Session Limit */}
        <div className="space-y-2 bg-surface2/50 border border-border/50 rounded-xl p-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Clock className="size-3.5 text-primary" />
              <span>5 小时会话限额</span>
            </div>
            <span className={cn('font-semibold tabular-nums text-xs', sessionPercent >= 85 ? 'text-rose-500' : sessionPercent >= 60 ? 'text-amber-500' : 'text-emerald-500')}>
              {sessionPercent}% used
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-2 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
            <div
              className={cn('h-full rounded-full transition-all duration-500', getBarColor(sessionPercent))}
              style={{ width: `${Math.min(Math.max(sessionPercent, 2), 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-foreground-muted pt-0.5">
            <span>重置时间</span>
            <span className="font-medium text-foreground/90">
              {usage?.session_resets_at || '今天 19:09 (Asia/Shanghai)'}
            </span>
          </div>
        </div>

        {/* Weekly Quota */}
        <div className="space-y-2 bg-surface2/50 border border-border/50 rounded-xl p-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Calendar className="size-3.5 text-primary" />
              <span>周使用限额 (All Models)</span>
            </div>
            <span className="font-semibold tabular-nums text-xs text-foreground">
              {weekPercent}% used
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-2 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
            <div
              className={cn('h-full rounded-full transition-all duration-500', getBarColor(weekPercent))}
              style={{ width: `${Math.min(Math.max(weekPercent, 2), 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-foreground-muted pt-0.5">
            <span>重置时间</span>
            <span className="font-medium text-foreground/90">
              {usage?.week_resets_at || '8月22日 12:59am (Asia/Shanghai)'}
            </span>
          </div>
        </div>

        {/* Breakdown / Insights */}
        {(usage?.last_24h_summary || usage?.last_7d_summary) && (
          <div className="space-y-1.5 pt-1 text-[11px] text-foreground-muted border-t border-border/50">
            {usage.last_24h_summary && (
              <div className="flex items-start gap-1.5">
                <Sparkles className="size-3 text-primary shrink-0 mt-0.5" />
                <span>近 24h：{usage.last_24h_summary}</span>
              </div>
            )}
            {usage.last_7d_summary && (
              <div className="flex items-start gap-1.5">
                <Zap className="size-3 text-muted-foreground shrink-0 mt-0.5" />
                <span>近 7d：{usage.last_7d_summary}</span>
              </div>
            )}
          </div>
        )}

        {/* Tip */}
        <div className="text-[10px] text-foreground-extra-muted leading-relaxed pt-1">
          💡 提示：额度由 Anthropic 动态计算。若 5 小时额度紧张，可切换为 Haiku 或轻量模型节省消耗。
        </div>
      </PopoverContent>
    </Popover>
  );
}
