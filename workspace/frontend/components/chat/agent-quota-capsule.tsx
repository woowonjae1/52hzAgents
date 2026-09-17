'use client';

import * as React from 'react';
import { Gauge, RefreshCw, ChevronRight, AlertCircle, FileText } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import type { AgentUsage, AgentTokenStat, WorkspaceTokenStats } from '@/lib/types';
import { cn } from '@/lib/utils';
import { headerChipClass } from '@/components/headers/header-chip';

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
  if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(0)}M`;
  if (window >= 1_000) return `${Math.round(window / 1000)}k`;
  return String(window);
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseClaudeDate(raw: string): Date | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s*\([^)]*\)/g, '').trim();
  const direct = new Date(cleaned);
  if (!isNaN(direct.getTime())) return direct;

  // Pattern: "Sep 9, 7:39pm" or "Sep 13, 1:00pm"
  const m = cleaned.match(/([A-Za-z]{3,})\s+(\d+),?\s*(\d+):(\d+)\s*(am|pm)/i);
  if (m) {
    const monthStr = m[1].slice(0, 3).toLowerCase();
    const month = MONTH_MAP[monthStr];
    if (month !== undefined) {
      const day = parseInt(m[2], 10);
      let hour = parseInt(m[3], 10);
      const min = parseInt(m[4], 10);
      const ampm = m[5].toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      const now = new Date();
      const candidate = new Date(now.getFullYear(), month, day, hour, min, 0);
      if (!isNaN(candidate.getTime())) return candidate;
    }
  }
  return null;
}

function formatResetCountdown(raw?: string | null): string {
  if (!raw || raw === '--') return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('Resets in ') || trimmed.startsWith('Resets Sat') || trimmed.startsWith('Resets Sun')) {
    return trimmed;
  }
  if (trimmed.startsWith('in ')) {
    return `Resets ${trimmed}`;
  }

  const target = parseClaudeDate(trimmed);
  if (target) {
    const diffMs = target.getTime() - Date.now();
    if (diffMs <= 0) return 'Reset completed';
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);

    if (hours < 1) {
      return mins <= 1 ? 'Resets in < 1 min' : `Resets in ${mins} min`;
    }
    if (hours < 24) {
      const remMins = mins % 60;
      return remMins > 0 ? `Resets in ${hours} hr ${remMins} min` : `Resets in ${hours} hr`;
    }
    try {
      const weekday = target.toLocaleDateString('en-US', { weekday: 'short' });
      const timeStr = target.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `Resets ${weekday} ${timeStr}`;
    } catch {
      return `Resets ${trimmed}`;
    }
  }

  return trimmed.startsWith('Resets') ? trimmed : `Resets ${trimmed}`;
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
  const sessionResetsAt = usage?.session_resets_at || agentStat?.session_resets_at;
  const weekResetsAt = usage?.week_resets_at || agentStat?.week_resets_at;
  const isUnparsed = (usage as any)?.parse_status === 'unparsed';

  const totalTokens = agentStat?.total_tokens ?? usage?.total_tokens ?? 0;
  const promptTokens = agentStat?.total_prompt_tokens ?? usage?.total_prompt_tokens ?? 0;
  const completionTokens = agentStat?.total_completion_tokens ?? usage?.total_completion_tokens ?? 0;

  const rawWindow = agentStat?.context_window_size ?? usage?.context_window_size ?? 0;
  const activeModel = agentStat?.current_model ?? usage?.current_model ?? selectedName ?? '';
  const isClaude = (selectedName && selectedName.toLowerCase().includes('claude')) || (activeModel && activeModel.toLowerCase().includes('claude'));
  const is1M = activeModel.toLowerCase().includes('[1m]') || activeModel.toLowerCase().includes('1m') || activeModel.toLowerCase().includes('fable');

  const contextWindow = rawWindow > 0
    ? rawWindow
    : isClaude
    ? (is1M ? 1_000_000 : 200_000)
    : 0;

  const contextTokens =
    agentStat?.last_prompt_tokens && agentStat.last_prompt_tokens > 0
      ? agentStat.last_prompt_tokens
      : usage?.last_prompt_tokens && usage.last_prompt_tokens > 0
      ? usage.last_prompt_tokens
      : tokenStats?.channels && tokenStats.channels.length > 0 && tokenStats.channels[0].context_tokens > 0
      ? tokenStats.channels[0].context_tokens
      : 0;

  const contextPct = contextWindow > 0 && contextTokens > 0
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : 0;

  const getBarColor = (pct: number) => {
    if (pct >= 85) return 'bg-status-danger';
    if (pct >= 60) return 'bg-status-warning';
    return 'bg-status-success';
  };

  /*
    THE CHIP APPEARS WHEN THERE IS A QUOTA TO WORRY ABOUT, AND NOT BEFORE.

    It used to sit in the chat header permanently. With no subscription data
    it fell through to a cumulative-token readout — `antigravity 2.4k tok` —
    and that one form caused most of the confusion on this header, because:

      * `2.4k tok` is total tokens SPENT, while the pill two inches to its
        right reads `6.1k` for tokens currently HELD in the window. Two
        monospace numbers, both labelled in tokens, measuring a flow and a
        level. Nothing on screen distinguished them.
      * the panel behind it then reported a third number, `1.4k / 1M`, against
        the model's own window — a denominator that is fiction in this channel,
        since @openclaw caps the whole thread at 64k.
      * with a fresh subscription every row in it reads 0%: 5-hour 0%, weekly
        0%. A permanent header control whose entire content is zeroes.

    Cumulative spend is a reporting number, not a live one; it belongs in the
    governance dashboard this panel already links to. What belongs in a header
    is the limit you are approaching, so the chip now renders only when the
    provider has reported actual usage — or when it reported something we could
    not parse, which is itself worth surfacing.
  */
  const hasQuotaSignal = isUnparsed || sessionPercent > 0 || weekPercent > 0;
  if (!hasQuotaSignal) return null;

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
              headerChipClass,
              // Semantic state stays local — the shape does not say "this
              // agent's quota could not be parsed", and the chip recipe should
              // not have to know that it might.
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

            {/* Percentages of a real limit, or an honest "unknown". The
                cumulative-token fallback is gone — see the note above. */}
            {sessionPercent > 0 || weekPercent > 0 ? (
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
                <span className="font-medium">quota unreadable</span>
              </>
            )}
          </button>
        </Hint>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-80 p-3.5 space-y-3.5 shadow-xl border-border bg-surface1/95 backdrop-blur-xl rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <div className="size-6 rounded-lg bg-surface2 border border-border/60 flex items-center justify-center text-foreground shrink-0">
              <Gauge className="size-3" />
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-foreground truncate">{selectedName}</span>
              <span className="text-3xs font-mono font-normal px-1.5 py-0.5 rounded-md bg-surface3 border border-border/60 text-foreground-muted truncate max-w-[140px]">
                {activeModel}
              </span>
            </div>
          </div>
          <Hint label="Refresh usage">
            <button
              onClick={(e) => {
                e.stopPropagation();
                fetchUsageAndStats(selectedName);
              }}
              disabled={loading}
              className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors disabled:opacity-50 shrink-0"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </button>
          </Hint>
        </div>

        {/* Multi-Agent Switcher (if workspace has multiple agents) */}
        {candidateAgents.length > 1 && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface2/70 border border-border/60">
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
                    'flex-1 min-w-0 px-2 py-1 rounded-md text-2xs font-medium ui-transition truncate border',
                    active
                      ? 'bg-surface1 text-foreground border-border/60'
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

        {/* Context Window Row & Sleek Progress Bar (Image 2 Top Section) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-foreground">Context window</span>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setActiveRightTab('tokens');
              }}
              className="inline-flex items-center gap-1 font-mono text-2xs text-foreground-muted hover:text-foreground transition-colors group"
            >
              {contextWindow > 0 ? (
                <>
                  <span>
                    {fmtTokens(contextTokens)} / {fmtContextLimit(contextWindow)}
                  </span>
                  <span className="text-foreground-extra-muted">({contextPct}%)</span>
                </>
              ) : (
                <span className="font-sans">Unknown capacity</span>
              )}
              <ChevronRight className="size-3 text-foreground-muted group-hover:text-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
          <div className="h-1.5 w-full bg-surface3/80 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full ui-transition duration-500',
                contextPct >= 85 ? 'bg-status-danger' : contextPct >= 60 ? 'bg-status-warning' : 'bg-primary'
              )}
              style={{ width: `${Math.min(Math.max(contextPct, contextTokens > 0 ? 3 : 0), 100)}%` }}
            />
          </div>
        </div>

        <div className="h-px bg-border/40" />

        {/* Middle Section: Usage Limits or Cumulative Tokens (Image 2 Middle Section) */}
        {isClaudeQuota ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold text-foreground">
              <div className="flex items-center gap-1.5">
                <span>Your usage limits</span>
                <span className="text-foreground-muted font-normal">·</span>
                <span className="text-foreground-muted font-normal">Subscription</span>
              </div>
            </div>

            {/* 5-Hour Session Limit */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">5-hour limit</span>
                <div className="flex items-center gap-2">
                  {sessionResetsAt && (
                    <span className="text-2xs text-foreground-muted">
                      {formatResetCountdown(sessionResetsAt)}
                    </span>
                  )}
                  <span
                    className={cn(
                      'font-semibold font-mono tabular-nums text-xs',
                      sessionPercent >= 85
                        ? 'text-status-danger'
                        : sessionPercent >= 60
                        ? 'text-status-warning'
                        : 'text-foreground'
                    )}
                  >
                    {sessionPercent}%
                  </span>
                </div>
              </div>
              <div className="h-1.5 w-full bg-surface3/80 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full ui-transition duration-500', getBarColor(sessionPercent))}
                  style={{ width: `${Math.min(Math.max(sessionPercent, sessionPercent > 0 ? 3 : 0), 100)}%` }}
                />
              </div>
            </div>

            {/* Weekly Limit */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">Weekly · all models</span>
                <div className="flex items-center gap-2">
                  {weekResetsAt && (
                    <span className="text-2xs text-foreground-muted">
                      {formatResetCountdown(weekResetsAt)}
                    </span>
                  )}
                  <span className="font-semibold font-mono tabular-nums text-xs text-foreground">
                    {weekPercent}%
                  </span>
                </div>
              </div>
              <div className="h-1.5 w-full bg-surface3/80 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full ui-transition duration-500', getBarColor(weekPercent))}
                  style={{ width: `${Math.min(Math.max(weekPercent, weekPercent > 0 ? 3 : 0), 100)}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          /* Non-Claude Pay-Per-Token cumulative metrics */
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-foreground">
              <div className="flex items-center gap-1.5">
                <span>Token usage</span>
                <span className="text-foreground-muted font-normal">·</span>
                <span className="text-foreground-muted font-normal">Cumulative</span>
              </div>
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-foreground-muted">Total tokens</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {fmtTokens(totalTokens)} tok
                </span>
              </div>
              <div className="flex items-center justify-between text-2xs">
                <span className="text-foreground-muted">Prompt / Completion</span>
                <span className="font-mono tabular-nums text-foreground-muted">
                  {fmtTokens(promptTokens)} / {fmtTokens(completionTokens)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Unparsed warning alert (if raw output returned) */}
        {isUnparsed && (
          <div className="flex items-start gap-2 p-2.5 rounded-xl bg-status-muted-warning border border-status-warning/30 text-status-warning text-2xs">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-medium">Raw CLI output returned</div>
              {usage?.raw_text && (
                <details className="pt-1 text-3xs text-foreground-muted">
                <summary className="hover:text-foreground flex items-center gap-1 font-medium select-none">
                    <FileText className="size-3 text-muted-foreground" />
                    Show output
                  </summary>
                  <pre className="mt-1.5 p-2 rounded-md bg-surface2 text-3xs text-foreground-muted overflow-x-auto whitespace-pre-wrap max-h-32 font-mono">
                    {usage.raw_text}
                  </pre>
                </details>
              )}
            </div>
          </div>
        )}

        <div className="h-px bg-border/40" />

        {/* Footer Link (Image 2 Bottom Section) */}
        <div>
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setActiveRightTab('tokens');
            }}
            className="w-full flex items-center justify-between text-xs font-medium text-foreground-muted hover:text-foreground transition-colors py-0.5 group"
          >
            <span>See detailed breakdown</span>
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5 text-foreground-muted group-hover:text-foreground" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
