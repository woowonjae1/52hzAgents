'use client';

import * as React from 'react';
import { Layers, RefreshCw, Sparkles, CheckCircle2, AlertTriangle, AlertCircle, Coins, ChevronRight, Info } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import type { ChannelContextHealth, WorkspaceTokenStats } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ContextHealthIndicatorProps {
  channelName?: string;
  className?: string;
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ContextHealthIndicator({ channelName, className }: ContextHealthIndicatorProps) {
  const { workspaceId } = useWorkspace();
  const { setActiveRightTab } = useLayout();
  const [stats, setStats] = React.useState<WorkspaceTokenStats | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [compacting, setCompacting] = React.useState(false);
  const [lastCompactedResult, setLastCompactedResult] = React.useState<string | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);

  const rawChannel = (channelName || 'general').replace(/^channel\//, '');

  const fetchStats = React.useCallback(async () => {
    if (!workspaceId) return;
    try {
      setLoading(true);
      workspaceApi.setWorkspaceId(workspaceId);
      const res = await workspaceApi.getWorkspaceTokenStats();
      if (res) {
        setStats(res);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const channelHealth = React.useMemo<ChannelContextHealth | null>(() => {
    if (!stats?.channels) return null;
    return stats.channels.find((c) => c.channel_name === rawChannel) || null;
  }, [stats, rawChannel]);

  const triggerCompact = async () => {
    if (!workspaceId || compacting) return;
    try {
      setCompacting(true);
      setLastCompactedResult(null);
      const res = await workspaceApi.request<{
        tokens_before?: number;
        tokens_after?: number;
        saved_tokens?: number;
        compacted_count?: number;
      }>(`/v1/workspaces/${workspaceId}/channels/${encodeURIComponent(rawChannel)}/compact`, {
        method: 'POST',
      });
      // Reports WHAT HAPPENED, not what was "saved". The compaction endpoint
      // still returns saved_tokens; the count of messages folded into the
      // summary is the fact the user can check, and it is the one that tells
      // them whether the action did anything at all.
      if (res?.compacted_count) {
        setLastCompactedResult(
          `Compacted ${res.compacted_count} message${res.compacted_count === 1 ? '' : 's'} into a summary`
        );
      } else {
        setLastCompactedResult('Nothing to compact yet');
      }
      await fetchStats();
    } catch (e: any) {
      setLastCompactedResult(e?.message || 'Compaction failed');
    } finally {
      setCompacting(false);
    }
  };

  /*
    NO INVENTED FALLBACKS IN HERE.

    `min_context_window || 64000` substituted a made-up window whenever the
    backend reported that it did not know one -- so a channel whose agents had
    never declared their capacity still showed a confident percentage, computed
    against a number the frontend picked. That is the same failure the backend
    had (its model table answered every unknown agent with 128k), and fixing it
    on one side only moves the fiction across the wire.

    Missing data now renders as 'unknown', which the badge has a real
    presentation for.
  */
  const minWindow = channelHealth?.min_context_window ?? 0;
  const knownWindow = minWindow > 0;
  const budgetPct = knownWindow
    ? Math.min(Math.round(channelHealth?.token_budget_percent || 0), 100)
    : 0;
  const estTokens = channelHealth?.context_tokens || 0;
  const measured = channelHealth?.measured ?? false;

  /*
    AMBER MEANS "THIS IS ABOUT TO OVERFLOW". NOTHING ELSE.

    The badge used to render `channelHealth.health_status` straight from the
    backend, whose thresholds are tuned to its own 25% compaction safety
    margin — so a thread holding 6.1k of a 64k window, ten percent full, came
    up amber and labelled "Warning". It was not warning about capacity. It was
    reporting the fact that a threshold had been configured at all, mostly
    because a low-window agent was in the channel.

    That is the expensive kind of wrong. A warning colour that fires at 10%
    teaches exactly one lesson — the yellow dot means nothing, ignore it — and
    the user who has learnt it will also ignore the one at 90%. A status colour
    is a promise about what happens next; spending it on a configuration fact
    leaves nothing to spend on the actual risk.

    So the colour is derived here, from the one number it claims to be about,
    and the bottleneck-agent fact is presented as a fact (see the popover) with
    no colour attached to it.
  */
  const status: 'unknown' | 'calm' | 'warning' | 'critical' = !knownWindow
    ? 'unknown'
    : budgetPct >= 85
    ? 'critical'
    : budgetPct >= 60
    ? 'warning'
    : 'calm';

  /** Below this the pill shows no number and no colour — see the chip. */
  const isCalm = status === 'calm';

  const statusBadge = {
    /*
      Healthy is not a green light, it is silence. A green dot reporting
      "optimal" every second of every session is a claim on attention that
      never pays it back; the chip below renders this state with no number and
      no colour at all.
    */
    calm: {
      dotClass: 'bg-foreground-extra-muted',
      textClass: 'text-foreground-muted',
      label: 'Healthy',
      pillClass: 'border-border/60 hover:border-border text-foreground-muted',
    },
    warning: {
      dotClass: 'bg-status-warning',
      textClass: 'text-status-warning',
      label: 'Warning',
      pillClass: 'border-status-warning/40 bg-status-muted-warning text-status-warning',
    },
    critical: {
      dotClass: 'bg-status-danger',
      textClass: 'text-status-danger',
      label: 'Critical',
      pillClass: 'border-status-danger/40 bg-status-muted-danger text-status-danger',
    },
    /*
      UNKNOWN IS UNCOLOURED, and that is the point.

      No participant has reported a context window, so there is no percentage
      to be optimal or critical about. Giving it green would claim health we
      cannot see; giving it amber would claim a problem that may not exist.
      The neutral treatment says exactly what is true -- we do not know yet --
      and it is the state a fresh channel legitimately sits in until its first
      turn reports a prompt size.
    */
    unknown: {
      dotClass: 'bg-foreground-extra-muted',
      textClass: 'text-foreground-muted',
      label: 'Unknown',
      pillClass: 'border-border/60 text-foreground-muted',
    },
  }[status];

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) fetchStats();
      }}
    >
      <PopoverTrigger asChild>
        {/*
          The hover text always carries the real numbers, which is what makes
          it safe for the chip itself to stop printing them.
        */}
        <Hint
          label={
            knownWindow
              ? `Context: ${fmtTokens(estTokens)} of ${fmtTokens(minWindow)} used (${budgetPct}%)`
              : 'Context window not reported by any participant yet'
          }
        >
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border ui-transition duration-200 select-none',
              'bg-surface2/80 hover:bg-surface3/90 shadow-xs',
              statusBadge.pillClass,
              className
            )}
          >
            <span className="relative flex size-2 shrink-0 items-center justify-center">
              <span className={cn('relative inline-flex size-1.5 rounded-full', statusBadge.dotClass)} />
            </span>
            <span className="text-foreground-muted font-normal">Ctx</span>
            {/*
              ONE NUMBER PAIR, AND ONLY WHEN IT MATTERS.

              This used to print `6.1k · 10%` permanently. Two problems at once:
              a percentage of a window nobody had looked up, and a reading that
              spent header space to say nothing was happening. Below 60% the
              chip is a label and a grey dot — still clickable, still the door
              to compaction — and the numbers live in the hover text and the
              panel.

              Above it, the two numbers that actually answer the question are
              used over available, together. `48k / 64k` is a sentence; `48k`
              beside `75%` is two facts the reader has to multiply.

              The `animate-ping` that used to fire at critical is gone. A
              pulsing dot in a chat header is a smoke alarm for a condition the
              user resolves with one click, and it kept pulsing until they did.
            */}
            {!isCalm && knownWindow && (
              <>
                <span className={cn('font-mono font-semibold tabular-nums', statusBadge.textClass)}>
                  {fmtTokens(estTokens)}
                </span>
                <span className="text-foreground-extra-muted">/</span>
                <span className="font-mono font-medium tabular-nums text-foreground-muted">
                  {fmtTokens(minWindow)}
                </span>
              </>
            )}
          </button>
        </Hint>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-4 space-y-3.5 shadow-xl border-border bg-surface1/95 backdrop-blur-xl rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b border-border/60">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-surface2 border border-border/60 flex items-center justify-center text-foreground">
              <Layers className="size-3.5" />
            </div>
            <div>
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                #{rawChannel}
                <span className={cn('text-3xs font-medium px-1.5 py-0.5 rounded-full border', statusBadge.pillClass)}>
                  {statusBadge.label}
                </span>
              </div>
              <p className="text-3xs text-foreground-muted">Context window health & governance</p>
            </div>
          </div>
          <Hint label="Refresh metrics">
            <button
              onClick={(e) => {
                e.stopPropagation();
                fetchStats();
              }}
              disabled={loading}
              className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </button>
          </Hint>
        </div>

        {/*
          THE MOST USEFUL SENTENCE ON THIS PANEL, FIRST.

          In a multi-agent thread the weakest participant's context window caps
          the whole channel — a 1M-window model in a room with a 64k one is a
          64k room. Nobody can infer that, no other surface says it, and it is
          the single thing on this panel that changes what a user does next
          (drop the agent, or compact sooner). It was the fourth block down,
          under two boxes of numbers.

          Styled as a statement, not a warning: it was wearing an amber
          triangle, which is how a permanent configuration fact ended up
          looking like an incident. The colour budget belongs to the capacity
          bar below, which is the thing that can actually go wrong.
        */}
        {channelHealth?.has_disparity && channelHealth?.bottleneck_agent && (
          <div className="p-2.5 rounded-lg bg-surface2/60 border border-border/60 text-3xs text-foreground-muted flex items-start gap-1.5">
            <Info className="size-3 text-foreground-muted shrink-0 mt-0.5" />
            <span className="leading-snug">
              This channel is capped at <span className="font-mono font-semibold text-foreground">{fmtTokens(minWindow)}</span> by{' '}
              <span className="font-semibold text-foreground">@{channelHealth.bottleneck_agent}</span>, the participant with the
              smallest context window.
            </span>
          </div>
        )}

        {/* Context Capacity Gauge */}
        <div className="space-y-2 bg-surface2/50 border border-border/60 rounded-xl p-3">
          <div className="flex items-center justify-between text-2xs">
            <span className="font-medium text-foreground">
              Active Context Window
              {/* Says which of the two numbers this is. The load is measured
                  from the agents' own reported prompt sizes when they have
                  reported any, and estimated from message text when they have
                  not -- those deserve different confidence, so they say so. */}
              {!measured && (
                <span className="ml-1 font-normal text-foreground-extra-muted">(estimated)</span>
              )}
            </span>
            <span className="font-mono tabular-nums text-foreground">
              {fmtTokens(estTokens)} / {knownWindow ? fmtTokens(minWindow) : 'unknown'}
            </span>
          </div>

          <div className="h-2 w-full bg-surface3 rounded-full overflow-hidden p-[1px]">
            <div
              className={cn(
                'h-full rounded-full ui-transition duration-500',
                // Same 60 / 85 boundaries as the chip. These were 25 / 50,
                // which is why a 10%-full channel showed an amber-adjacent bar
                // next to a badge that said Warning.
                budgetPct >= 85 ? 'bg-status-danger' : budgetPct >= 60 ? 'bg-status-warning' : 'bg-status-success'
              )}
              style={{ width: `${Math.min(Math.max(budgetPct, 2), 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-3xs text-foreground-muted">
            {/* Named for what it is: the point auto-compaction kicks in,
                which is a different number from the badge thresholds and was
                previously unlabelled enough to read as the same one. */}
            <span>Auto-compacts at 75%</span>
            <span>{channelHealth?.message_count || 0} messages in window</span>
          </div>
        </div>

        {/*
          Only once there is a history to show. A bordered card reading
          "Compactions — 0 runs" is a box built to hold a fact that does not
          exist yet; the button directly below it already says compaction is
          available, so the empty card was telling the user nothing twice.
        */}
        {(channelHealth?.compaction_count || 0) > 0 && (
          <div className="text-2xs">
            <div className="p-2.5 rounded-xl bg-surface2/40 border border-border/60">
              <div className="text-3xs text-foreground-muted mb-0.5">Compactions</div>
              <div className="font-semibold font-mono tabular-nums text-foreground">
                {channelHealth?.compaction_count} runs
              </div>
            </div>
          </div>
        )}

        {/* Compact Action */}
        <div className="pt-1 space-y-2">
          <button
            type="button"
            onClick={triggerCompact}
            disabled={compacting}
            className={cn(
              'w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-medium ui-transition duration-200 shadow-xs',
              'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            <Sparkles className={cn('size-3.5', compacting && 'animate-spin')} />
            <span>{compacting ? 'Compacting Channel…' : 'Compact Context Now'}</span>
          </button>

          {lastCompactedResult && (
            <p className="text-center text-3xs text-foreground-muted font-mono truncate">
              {lastCompactedResult}
            </p>
          )}

          <div className="pt-1.5 border-t border-border/60 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setActiveRightTab('tokens');
              }}
              className="text-3xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              <Coins className="size-3" />
              <span>Open Token Governance Dashboard</span>
              <ChevronRight className="size-2.5" />
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
