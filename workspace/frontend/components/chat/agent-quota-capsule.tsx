'use client';

import * as React from 'react';
import { Gauge, RefreshCw, Zap, Clock, Calendar, Sparkles, AlertCircle, FileText, Cpu, Coins, ChevronRight } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import type { AgentUsage, AgentTokenStat, WorkspaceTokenStats } from '@/lib/types';
import { cn } from '@/lib/utils';

interface AgentQuotaCapsuleProps {
  /** 建议展示的 agent 名（通常为当前选中模型所属），面板内可切换到其他 agent */
  agentName?: string;
  className?: string;
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtContextLimit(window?: number | null): string {
  if (!window || window <= 0) return 'unknown';
  if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(1)}M`;
  return `${Math.round(window / 1024)}k`;
}

export function AgentQuotaCapsule({ agentName, className }: AgentQuotaCapsuleProps) {
  const { workspaceId, agents } = useWorkspace();
  const { setActiveRightTab } = useLayout();
  const [tokenStats, setTokenStats] = React.useState<WorkspaceTokenStats | null>(null);
  const [usageByAgent, setUsageByAgent] = React.useState<Record<string, AgentUsage>>({});
  const [loadingAgent, setLoadingAgent] = React.useState<string | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const [manualAgent, setManualAgent] = React.useState<string | null>(null);

  // Available agent candidates
  const candidateAgents = React.useMemo(() => {
    return agents.map((a) => ({
      name: a.agentName,
      online: a.status === 'online',
    }));
  }, [agents]);

  // Selected agent resolution: manualAgent > agentName > first candidate
  const selectedAgent = React.useMemo(() => {
    if (manualAgent) {
      const match = candidateAgents.find((a) => a.name.toLowerCase() === manualAgent.toLowerCase());
      if (match) return match;
    }
    if (agentName) {
      const match = candidateAgents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
      if (match) return match;
    }
    return candidateAgents[0] ?? null;
  }, [manualAgent, agentName, candidateAgents]);

  const selectedName = selectedAgent?.name;

  const fetchUsageAndStats = React.useCallback(async (target?: string) => {
    const name = target ?? selectedName;
    if (!workspaceId) return;

    try {
      if (name) setLoadingAgent(name);
      workspaceApi.setWorkspaceId(workspaceId);

      const [statsRes, usageRes] = await Promise.all([
        workspaceApi.getWorkspaceTokenStats(),
        name ? workspaceApi.getAgentUsage(name) : Promise.resolve(null),
      ]);

      if (statsRes) {
        setTokenStats(statsRes);
      }
      if (name && usageRes) {
        setUsageByAgent((prev) => ({ ...prev, [name]: usageRes }));
      }
    } catch {
      // ignore
    } finally {
      if (name) setLoadingAgent((cur) => (cur === name ? null : cur));
    }
  }, [workspaceId, selectedName]);

  React.useEffect(() => {
    fetchUsageAndStats(selectedName);
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden) {
        fetchUsageAndStats(selectedName);
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchUsageAndStats, selectedName]);

  if (!selectedAgent) return null;

  const usage = selectedName ? usageByAgent[selectedName] ?? null : null;
  const agentStat = React.useMemo<AgentTokenStat | null>(() => {
    if (!tokenStats?.agents || !selectedName) return null;
    return tokenStats.agents.find((a) => a.agent_name.toLowerCase() === selectedName.toLowerCase()) || null;
  }, [tokenStats, selectedName]);

  const loading = loadingAgent === selectedName;

  // Determine if this agent has Claude-style subscription quotas
  const isClaudeQuota = Boolean(
    (usage && (usage.session_used_percent > 0 || usage.week_used_percent > 0 || usage.raw_text)) ||
    (agentStat && (agentStat.session_used_percent > 0 || agentStat.week_used_percent > 0)) ||
    selectedName.toLowerCase().includes('claude')
  );

  const sessionPercent = usage?.session_used_percent ?? agentStat?.session_used_percent ?? 0;
  const weekPercent = usage?.week_used_percent ?? agentStat?.week_used_percent ?? 0;
  const isUnparsed = (usage as any)?.parse_status === 'unparsed';

  const totalTokens = agentStat?.total_tokens ?? usage?.total_tokens ?? 0;
  const promptTokens = agentStat?.total_prompt_tokens ?? usage?.total_prompt_tokens ?? 0;
  const completionTokens = agentStat?.total_completion_tokens ?? usage?.total_completion_tokens ?? 0;
  const contextWindow = agentStat?.context_window_size ?? usage?.context_window_size ?? 0;
  const activeModel = agentStat?.current_model ?? usage?.current_model ?? selectedName;

  const getBarColor = (pct: number) => {
    if (pct >= 85) return 'bg-status-danger';
    if (pct >= 60) return 'bg-status-warning';
    return 'bg-status-success';
  };

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) fetchUsageAndStats(selectedName);
      }}
    >
      <PopoverTrigger asChild>
        <Hint label={`View ${selectedName} token governance & usage`}>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border transition-all duration-200 cursor-pointer select-none',
              'bg-surface2/80 hover:bg-surface3/90 border-border/70 hover:border-border text-foreground shadow-2xs',
              isUnparsed && 'border-status-warning/40 bg-status-muted-warning text-status-warning',
              className
            )}
          >
            {/* Status Dot */}
            <span className="relative flex size-2 shrink-0 items-center justify-center">
              <span
                className={cn(
                  'relative inline-flex size-1.5 rounded-full',
                  isUnparsed
                    ? 'bg-status-warning'
                    : sessionPercent >= 85
                    ? 'bg-status-danger'
                    : sessionPercent >= 60
                    ? 'bg-status-warning'
                    : 'bg-status-success'
                )}
              />
            </span>

            {/* Display: Claude 5h/week or Cumulative Tokens */}
            {isClaudeQuota && (sessionPercent > 0 || weekPercent > 0) ? (
              <>
                <span className="text-foreground-muted font-normal">5h</span>
                <span
                  className={cn(
                    'font-mono font-semibold tabular-nums',
                    sessionPercent >= 85
                      ? 'text-status-danger'
                      : sessionPercent >= 60
                      ? 'text-status-warning'
                      : 'text-foreground'
                  )}
                >
                  {sessionPercent}%
                </span>
                <span className="text-foreground-extra-muted">·</span>
                <span className="text-foreground-muted font-normal">Wk</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">{weekPercent}%</span>
              </>
            ) : (
              <>
                <span className="text-foreground-muted font-normal">{selectedName}</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {fmtTokens(totalTokens)} tok
                </span>
              </>
            )}
          </button>
        </Hint>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-88 p-4 space-y-4 shadow-xl border-border/70 bg-surface1/95 backdrop-blur-xl rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-surface2 border border-border/60 flex items-center justify-center text-foreground">
              <Gauge className="size-3.5" />
            </div>
            <div>
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                {selectedName}
                <span className="text-3xs font-mono font-normal px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 text-foreground-muted">
                  {activeModel}
                </span>
              </div>
              <p className="text-3xs text-foreground-muted">Token governance & context health</p>
            </div>
          </div>
          <Hint label="Refresh usage">
            <button
              onClick={(e) => {
                e.stopPropagation();
                fetchUsageAndStats(selectedName);
              }}
              disabled={loading}
              className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </button>
          </Hint>
        </div>

        {/* Multi-Agent Switcher */}
        {candidateAgents.length > 1 && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface2/70 border border-border/40">
            {candidateAgents.map((a) => {
              const active = a.name === selectedName;
              return (
                <button
                  key={a.name}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setManualAgent(a.name);
                    fetchUsageAndStats(a.name);
                  }}
                  className={cn(
                    'flex-1 min-w-0 px-2 py-1 rounded-md text-2xs font-medium transition-all truncate border cursor-pointer',
                    active
                      ? 'bg-surface1 text-foreground border-border/60 shadow-2xs'
                      : 'text-foreground-muted hover:text-foreground border-transparent'
                  )}
                >
                  <span className="inline-flex items-center gap-1 max-w-full">
                    <span
                      className={cn(
                        'size-1.5 rounded-full shrink-0',
                        a.online ? 'bg-status-success' : 'bg-foreground-extra-muted'
                      )}
                    />
                    <span className="truncate">{a.name}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Token Metrics Cards */}
        <div className="grid grid-cols-3 gap-2 text-2xs">
          <div className="p-2.5 rounded-xl bg-surface2/40 border border-border/40">
            <div className="text-3xs text-foreground-muted mb-0.5">Total Tokens</div>
            <div className="font-semibold font-mono tabular-nums text-foreground">
              {totalTokens > 0 ? fmtTokens(totalTokens) : '—'}
            </div>
          </div>
          <div className="p-2.5 rounded-xl bg-surface2/40 border border-border/40">
            <div className="text-3xs text-foreground-muted mb-0.5">Context Limit</div>
            <div className="font-semibold font-mono tabular-nums text-foreground">
              {fmtContextLimit(contextWindow)}
            </div>
          </div>
          <div className="p-2.5 rounded-xl bg-surface2/40 border border-border/40">
            <div className="text-3xs text-foreground-muted mb-0.5">Prompt / Comp</div>
            <div className="font-mono text-3xs tabular-nums text-foreground-muted truncate">
              {promptTokens > 0 || completionTokens > 0 ? `${fmtTokens(promptTokens)} / ${fmtTokens(completionTokens)}` : '—'}
            </div>
          </div>
        </div>

        {/* Claude Subscription Progress Bars (if available) */}
        {isClaudeQuota && (
          <div className="space-y-2.5">
            {/* 5-Hour Session */}
            <div className="space-y-1.5 bg-surface2/50 border border-border/40 rounded-xl p-2.5">
              <div className="flex items-center justify-between text-2xs">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Clock className="size-3 text-primary" />
                  <span>5-hour session limit</span>
                </div>
                <span
                  className={cn(
                    'font-semibold font-mono tabular-nums text-2xs',
                    sessionPercent >= 85
                      ? 'text-status-danger'
                      : sessionPercent >= 60
                      ? 'text-status-warning'
                      : 'text-status-success'
                  )}
                >
                  {sessionPercent}%
                </span>
              </div>

              <div className="h-1.5 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
                <div
                  className={cn('h-full rounded-full transition-all duration-500', getBarColor(sessionPercent))}
                  style={{ width: `${Math.min(Math.max(sessionPercent, 2), 100)}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-3xs text-foreground-muted">
                <span>Resets</span>
                <span className="font-medium text-foreground/80">
                  {usage?.session_resets_at || agentStat?.session_resets_at || '--'}
                </span>
              </div>
            </div>

            {/* Weekly Limit */}
            <div className="space-y-1.5 bg-surface2/50 border border-border/40 rounded-xl p-2.5">
              <div className="flex items-center justify-between text-2xs">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Calendar className="size-3 text-primary" />
                  <span>Weekly limit</span>
                </div>
                <span className="font-semibold font-mono tabular-nums text-2xs text-foreground">
                  {weekPercent}%
                </span>
              </div>

              <div className="h-1.5 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
                <div
                  className={cn('h-full rounded-full transition-all duration-500', getBarColor(weekPercent))}
                  style={{ width: `${Math.min(Math.max(weekPercent, 2), 100)}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-3xs text-foreground-muted">
                <span>Resets</span>
                <span className="font-medium text-foreground/80">
                  {usage?.week_resets_at || agentStat?.week_resets_at || '--'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Unparsed warning alert */}
        {isUnparsed && (
          <div className="flex items-start gap-2 p-2.5 rounded-xl bg-status-muted-warning border border-status-warning/30 text-status-warning text-2xs">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-medium">Raw CLI output returned</div>
              <div className="text-3xs text-status-warning/80">Check expandable details below.</div>
            </div>
          </div>
        )}

        {/* Raw output preview if unparsed */}
        {isUnparsed && usage?.raw_text && (
          <details className="pt-1 text-3xs text-foreground-muted">
            <summary className="cursor-pointer hover:text-foreground flex items-center gap-1 font-medium select-none">
              <FileText className="size-3 text-muted-foreground" />
              Raw CLI output
            </summary>
            <pre className="mt-1.5 p-2 rounded-md bg-surface2 text-3xs text-foreground-muted overflow-x-auto whitespace-pre-wrap max-h-32 font-mono">
              {usage.raw_text}
            </pre>
          </details>
        )}

        {/* Footer Note and Link */}
        <div className="pt-2 border-t border-border/40 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setActiveRightTab('tokens');
            }}
            className="text-3xs text-primary hover:underline flex items-center gap-1 cursor-pointer font-medium"
          >
            <Coins className="size-3" />
            <span>Open Token Governance Dashboard</span>
            <ChevronRight className="size-2.5" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
