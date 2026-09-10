'use client';

import * as React from 'react';
import {
  Coins,
  RefreshCw,
  Sparkles,
  Layers,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Info,
  SlidersHorizontal,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import type { WorkspaceTokenStats, ChannelContextHealth, AgentTokenStat } from '@/lib/types';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

function fmtTokens(n?: number | null): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtWindow(n?: number | null): string {
  if (!n || n <= 0) return 'unknown';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1024)}k`;
  return String(n);
}

export function TokenDashboardPanel() {
  const { workspaceId, currentSessionId } = useWorkspace();
  const [stats, setStats] = React.useState<WorkspaceTokenStats | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [compactingChannel, setCompactingChannel] = React.useState<string | null>(null);
  const [compactionResults, setCompactionResults] = React.useState<Record<string, string>>({});

  const fetchStats = React.useCallback(async () => {
    if (!workspaceId) return;
    try {
      setLoading(true);
      workspaceApi.setWorkspaceId(workspaceId);
      const res = await workspaceApi.getWorkspaceTokenStats();
      if (res) {
        setStats(res);
      }
    } catch (err) {
      console.error('[TokenDashboard] Failed to fetch token stats:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 20_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const handleCompact = async (channelName: string) => {
    if (!workspaceId || compactingChannel) return;
    const raw = channelName.replace(/^channel\//, '');
    try {
      setCompactingChannel(raw);
      setCompactionResults((prev) => ({ ...prev, [raw]: '' }));
      const res = await workspaceApi.request<{
        tokens_before?: number;
        tokens_after?: number;
        saved_tokens?: number;
        compacted_count?: number;
      }>(`/v1/workspaces/${workspaceId}/channels/${encodeURIComponent(raw)}/compact`, {
        method: 'POST',
      });
      if (res?.compacted_count) {
        const msg = `Compacted ${res.compacted_count} message${res.compacted_count === 1 ? '' : 's'} into summary`;
        setCompactionResults((prev) => ({ ...prev, [raw]: msg }));
        toast.success(`#${raw}: ${msg}`);
      } else {
        const msg = 'Nothing to compact yet';
        setCompactionResults((prev) => ({ ...prev, [raw]: msg }));
        toast.info(`#${raw}: ${msg}`);
      }
      await fetchStats();
    } catch (err: any) {
      const msg = err?.message || 'Compaction failed';
      setCompactionResults((prev) => ({ ...prev, [raw]: msg }));
      toast.error(`#${raw}: ${msg}`);
    } finally {
      setCompactingChannel(null);
    }
  };

  const currentRaw = (currentSessionId || '').replace(/^channel\//, '');

  const totalTokens = stats?.total_tokens ?? 0;
  const promptTokens = stats?.total_prompt_tokens ?? 0;
  const completionTokens = stats?.total_completion_tokens ?? 0;
  const compactionRuns = stats?.compaction_runs ?? 0;

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground overflow-hidden">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-4 bg-surface1/60 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <Coins className="size-4 text-primary shrink-0" />
          <h2 className="text-xs font-semibold tracking-tight text-foreground truncate">
            Token & Context Governance
          </h2>
          <span className="text-3xs px-1.5 py-0.5 rounded-full bg-surface2 text-foreground-muted font-mono font-medium shrink-0">
            Realtime
          </span>
        </div>
        <Hint label="Refresh token metrics">
          <button
            type="button"
            onClick={fetchStats}
            disabled={loading}
            className="size-7 rounded-md flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
        </Hint>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Workspace Summary Cards */}
        <div className="grid grid-cols-2 gap-2">
          <div className="p-3 rounded-xl bg-surface1/80 border border-border/60">
            <div className="text-3xs font-medium uppercase tracking-wider text-foreground-muted">Total Usage</div>
            <div className="mt-1 text-base font-bold font-mono tabular-nums text-foreground">
              {totalTokens > 0 ? fmtTokens(totalTokens) : '—'}
            </div>
            <div className="mt-0.5 text-3xs text-foreground-muted font-mono truncate">
              {promptTokens > 0 || completionTokens > 0 ? `${fmtTokens(promptTokens)} in / ${fmtTokens(completionTokens)} out` : '0 prompt / 0 completion'}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-surface1/80 border border-border/60">
            <div className="text-3xs font-medium uppercase tracking-wider text-foreground-muted">Compaction Checkpoints</div>
            <div className="mt-1 text-base font-bold font-mono tabular-nums text-foreground">
              {compactionRuns}
            </div>
            <div className="mt-0.5 text-3xs text-foreground-muted truncate">
              Safety preserved summaries
            </div>
          </div>
        </div>

        {/* Section: Channels & Context Health */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-1.5">
              <Layers className="size-3.5 text-primary" />
              <span className="text-xs font-semibold">Active Channels & Context Load</span>
            </div>
            <span className="text-3xs font-mono text-foreground-muted">
              {stats?.channels?.length || 0} active
            </span>
          </div>

          {(!stats?.channels || stats.channels.length === 0) ? (
            <div className="p-4 rounded-xl border border-border/60 bg-surface1/40 text-center text-xs text-foreground-muted">
              No active channels yet. Start chatting to inspect context health.
            </div>
          ) : (
            <div className="space-y-2">
              {stats.channels.map((ch) => {
                const isCurrent = ch.channel_name === currentRaw;
                const minWin = ch.min_context_window || 0;
                const known = minWin > 0;
                const pct = known ? Math.min(Math.round(ch.token_budget_percent || 0), 100) : 0;
                const isCompactingThis = compactingChannel === ch.channel_name;
                const resultMsg = compactionResults[ch.channel_name];

                return (
                  <div
                    key={ch.channel_name}
                    className={cn(
                      'p-3 rounded-xl border transition-all duration-150',
                      isCurrent
                        ? 'border-primary/40 bg-surface1 ring-1 ring-primary/20 shadow-xs'
                        : 'border-border/60 bg-surface1/60 hover:bg-surface1/90'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-xs text-foreground truncate">
                            #{ch.channel_name}
                          </span>
                          {isCurrent && (
                            <span className="text-3xs px-1.5 py-0.2 rounded bg-primary/10 text-primary font-medium">
                              Current
                            </span>
                          )}
                          <span
                            className={cn(
                              'text-3xs px-1.5 py-0.2 rounded-full font-medium',
                              ch.health_status === 'critical'
                                ? 'bg-status-danger/10 text-status-danger'
                                : ch.health_status === 'warning'
                                ? 'bg-status-warning/10 text-status-warning'
                                : ch.health_status === 'optimal'
                                ? 'bg-status-success/10 text-status-success'
                                : 'bg-surface2 text-foreground-muted'
                            )}
                          >
                            {ch.health_status}
                          </span>
                        </div>

                        <div className="mt-1 flex items-baseline gap-2 text-2xs">
                          <span className="font-medium text-foreground">
                            Load: <span className="font-mono tabular-nums">{fmtTokens(ch.context_tokens)}</span>
                          </span>
                          <span className="text-foreground-muted font-mono text-3xs">
                            / {known ? fmtWindow(minWin) : 'unknown window'}
                          </span>
                          {!ch.measured && (
                            <span className="text-3xs text-foreground-extra-muted italic">
                              (estimated)
                            </span>
                          )}
                          {known && (
                            <span
                              className={cn(
                                'font-mono text-3xs font-semibold tabular-nums ml-auto',
                                pct >= 75 ? 'text-status-danger' : pct >= 50 ? 'text-status-warning' : 'text-status-success'
                              )}
                            >
                              {pct}%
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    {known && (
                      <div className="mt-2 h-1.5 w-full bg-surface2 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-300',
                            pct >= 75 ? 'bg-status-danger' : pct >= 50 ? 'bg-status-warning' : 'bg-status-success'
                          )}
                          style={{ width: `${Math.min(Math.max(pct, 2), 100)}%` }}
                        />
                      </div>
                    )}

                    {/* Disparity & Bottleneck Notice */}
                    {ch.has_disparity && ch.bottleneck_agent && (
                      <div className="mt-2 flex items-start gap-1.5 p-2 rounded-lg bg-surface2/60 border border-border/60 text-3xs text-foreground-muted">
                        <Info className="size-3 text-status-warning shrink-0 mt-0.5" />
                        <span className="leading-snug">
                          Auto-compaction constrained by <span className="font-semibold text-foreground">@{ch.bottleneck_agent}</span> ({fmtWindow(minWin)}) to prevent context overflow. Extended archive remains available to larger models.
                        </span>
                      </div>
                    )}

                    {/* Compact Context Now Button */}
                    <div className="mt-2.5 flex items-center justify-between gap-2 pt-1 border-t border-border/60">
                      <span className="text-3xs text-foreground-muted">
                        {ch.compaction_count} compaction{ch.compaction_count === 1 ? '' : 's'} run
                      </span>

                      <button
                        type="button"
                        onClick={() => handleCompact(ch.channel_name)}
                        disabled={isCompactingThis}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-medium transition-all duration-150 cursor-pointer shadow-xs',
                          'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed'
                        )}
                      >
                        <Sparkles className={cn('size-3', isCompactingThis && 'animate-spin')} />
                        <span>{isCompactingThis ? 'Compacting…' : 'Compact Context Now'}</span>
                      </button>
                    </div>

                    {resultMsg && (
                      <div className="mt-1.5 text-right font-mono text-3xs text-foreground-muted truncate">
                        {resultMsg}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section: Agent Token Roster */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-1.5">
              <Cpu className="size-3.5 text-primary" />
              <span className="text-xs font-semibold">Agent Context Capacities & Usage</span>
            </div>
            <span className="text-3xs font-mono text-foreground-muted">
              {stats?.agents?.length || 0} agents
            </span>
          </div>

          {(!stats?.agents || stats.agents.length === 0) ? (
            <div className="p-4 rounded-xl border border-border/60 bg-surface1/40 text-center text-xs text-foreground-muted">
              No agent token usage recorded yet.
            </div>
          ) : (
            <div className="space-y-2">
              {stats.agents.map((agent) => {
                const win = agent.context_window_size || 0;
                const lastPrompt = agent.last_prompt_tokens || 0;
                const totTokens = agent.total_tokens || 0;
                const pTokens = agent.total_prompt_tokens || 0;
                const cTokens = agent.total_completion_tokens || 0;

                return (
                  <div
                    key={agent.agent_name}
                    className="p-3 rounded-xl border border-border/60 bg-surface1/60 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <AgentAvatar name={agent.agent_name} size={24} status={agent.status as any} />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-foreground truncate">
                            {agent.agent_name}
                          </div>
                          <div className="text-3xs font-mono text-foreground-muted truncate">
                            {agent.current_model || 'model unknown'}
                          </div>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-3xs text-foreground-muted">Window Limit</div>
                        <div className="text-xs font-bold font-mono tabular-nums text-foreground">
                          {fmtWindow(win)}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/60 text-3xs">
                      <div className="p-2 rounded-lg bg-surface2/40">
                        <div className="text-foreground-muted">Last Prompt</div>
                        <div className="font-semibold font-mono tabular-nums text-foreground mt-0.5">
                          {lastPrompt > 0 ? `${fmtTokens(lastPrompt)} tokens` : '—'}
                        </div>
                      </div>

                      <div className="p-2 rounded-lg bg-surface2/40">
                        <div className="text-foreground-muted">Total Billed</div>
                        <div className="font-semibold font-mono tabular-nums text-foreground mt-0.5">
                          {totTokens > 0 ? `${fmtTokens(totTokens)} tokens` : '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Informational Architecture Note */}
        <div className="p-3 rounded-xl bg-surface1/30 border border-border/60 text-3xs text-foreground-muted space-y-1.5">
          <div className="flex items-center gap-1 font-semibold text-foreground">
            <ShieldCheck className="size-3 text-status-success" />
            <span>Architecture: Per-Agent Window Isolation</span>
          </div>
          <p className="leading-relaxed">
            Shared channels dynamically adapt auto-compaction thresholds to the smallest model to prevent context overflow errors. Full raw message history is archived in the database, ensuring high-capacity models (e.g. Gemini 2M / Claude 3.7) retain access while protecting small-window agents.
          </p>
        </div>
      </div>
    </div>
  );
}
