"use client";

import * as React from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Database,
  Gauge,
  Sliders,
} from "lucide-react";
import { workspaceApi } from "@/lib/api";
import { useVisibilityPolling } from "@/lib/use-visibility-polling";
import {
  useAgentContexts,
  contextPercent,
  fmtTokens,
} from "@/lib/use-agent-contexts";
import { ContextRing } from "./context-ring";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { WorkspaceMessage } from "@/lib/types";
import { toast } from '@/lib/toast';
import { RunRecoveryPanel } from './run-recovery-panel';
import { AgentInteractionsPanel } from './agent-interactions-panel';
import { NativeQuotaControls } from './native-quota-controls';
import { WorktreeControls } from './worktree-controls';

interface RuntimeStatus {
  running: boolean;
  run?: {
    channel: string;
    phase: string;
    outcome?: string;
    context?: {
      estimated_tokens: number;
      context_window: number | null;
      reserved_tokens: number;
      compactions: number;
      phase: string;
    };
  };
}

interface SessionUsage {
  channel_name: string;
  measured_turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_measured_turns: number;
  last: { model: string; prompt_tokens: number } | null;
}

interface ModelUsageBreakdown {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  hasUnknownCost: boolean;
  callCount: number;
}

interface UsageSummary {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  hasUnknownCost: boolean;
  hasUnknownUsage?: boolean;
  recordCount: number;
  byModel: ModelUsageBreakdown[];
}

interface BudgetLimits {
  sessionId: string | null;
  maxTokensPerRun: number | null;
  maxStepsPerRun: number | null;
  maxDurationSeconds: number | null;
  maxCostPerSession: number | null;
  currency: string;
}

export function SessionUsageBar({
  channelName,
  messages,
  running,
}: {
  channelName: string | null;
  messages: WorkspaceMessage[];
  running: boolean;
}) {
  const [snapshot, setSnapshot] = React.useState<SessionUsage | null>(null);
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [budgets, setBudgets] = React.useState<BudgetLimits | null>(null);
  const [runtime, setRuntime] = React.useState<RuntimeStatus | null>(null);
  const [compacting, setCompacting] = React.useState(false);
  const activeChannel = React.useRef(channelName);
  activeChannel.current = channelName;
  const { rows } = useAgentContexts();

  const refresh = React.useCallback(async () => {
    if (!channelName || channelName.startsWith("draft:")) return;
    try {
      const [nextRes, liveRes, sumRes, budRes] = await Promise.allSettled([
        workspaceApi.request<SessionUsage>(
          `/v1/workspaces/${workspaceApi.requireWorkspace()}/session-usage?channel=${encodeURIComponent(channelName)}`,
        ),
        workspaceApi.request<RuntimeStatus>(
          `/v1/runtime/session?channel=${encodeURIComponent(channelName)}`,
        ),
        workspaceApi.request<UsageSummary>(
          `/v1/usage/summary?channel=${encodeURIComponent(channelName)}`,
        ),
        workspaceApi.request<{ budgets: BudgetLimits | null }>(
          `/v1/settings/budgets?sessionId=${encodeURIComponent(channelName)}`,
        ),
      ]);

      if (activeChannel.current === channelName) {
        if (nextRes.status === "fulfilled" && nextRes.value?.channel_name === channelName && typeof nextRes.value.measured_turns === "number") {
          setSnapshot(nextRes.value);
        }
        if (liveRes.status === "fulfilled") {
          setRuntime(liveRes.value);
        }
        if (sumRes.status === "fulfilled" && sumRes.value?.sessionId === channelName) {
          setSummary(sumRes.value);
        }
        if (budRes.status === "fulfilled" && budRes.value?.budgets) {
          setBudgets(budRes.value.budgets);
        }
      }
    } catch {
      /* Other backends can still report usage in message metadata. */
    }
  }, [channelName]);

  useVisibilityPolling(refresh, running || compacting ? 2000 : 10000);
  const lastId = messages.at(-1)?.messageId;
  React.useEffect(() => {
    void refresh();
  }, [refresh, lastId]);

  const measured = messages.filter(
    (m) =>
      m.metadata?.usage &&
      typeof m.metadata.usage.prompt_tokens === "number" &&
      typeof m.metadata.usage.completion_tokens === "number",
  );
  const local: SessionUsage = {
    channel_name: channelName || "",
    measured_turns: measured.length,
    prompt_tokens: measured.reduce(
      (sum, m) => sum + (m.metadata.usage?.prompt_tokens || 0),
      0,
    ),
    completion_tokens: measured.reduce(
      (sum, m) => sum + (m.metadata.usage?.completion_tokens || 0),
      0,
    ),
    cache_read_tokens: 0,
    cache_measured_turns: 0,
    last: measured.length
      ? {
          model: String(measured.at(-1)?.metadata.model || ""),
          prompt_tokens: measured.at(-1)?.metadata.usage?.prompt_tokens || 0,
        }
      : null,
  };

  const usage = snapshot?.channel_name === channelName ? snapshot : local;
  const context = rows
    .filter((r) => r.channelName === channelName)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const live = runtime?.run?.channel === channelName ? runtime.run : null;
  const budget = live?.context;
  const percent = budget
    ? budget.context_window
      ? Math.min(100, Math.round((budget.estimated_tokens / budget.context_window) * 100))
      : null
    : context
      ? contextPercent(context)
      : null;

  const compact = async () => {
    setCompacting(true);
    try {
      await workspaceApi.request('/v1/runtime/compact', {
        method: 'POST',
        body: JSON.stringify({ channel: channelName }),
      });
      toast.success('已开始压缩，结果会显示在会话中。');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法压缩会话');
    } finally {
      setCompacting(false);
    }
  };

  const effectivePromptTokens = summary && summary.totalTokens > 0 ? summary.promptTokens : usage.prompt_tokens;
  const effectiveCompletionTokens = summary && summary.totalTokens > 0 ? summary.completionTokens : usage.completion_tokens;
  const effectiveCacheReadTokens = summary && summary.totalTokens > 0 ? summary.cacheReadTokens : usage.cache_read_tokens;
  const known = usage.measured_turns > 0 || (summary && summary.totalTokens > 0);

  const costDisplay = React.useMemo(() => {
    if (!summary || (summary.totalTokens === 0 && !summary.hasUnknownCost)) return null;
    if (summary.hasUnknownCost || summary.estimatedCost === null) {
      return {
        label: "待核算",
        title: "部分或全部模型未在单价目录中配置，已避免虚假显示为零",
        isUnknown: true,
      };
    }
    const costStr = summary.estimatedCost < 0.01
      ? summary.estimatedCost.toFixed(4)
      : summary.estimatedCost.toFixed(3);
    return {
      label: `$${costStr}`,
      title: `基于模型单价目录核算的预估费用：$${summary.estimatedCost.toFixed(4)} USD`,
      isUnknown: false,
    };
  }, [summary]);

  return (
    <>
      <WorktreeControls channel={channelName} running={running} />
      <RunRecoveryPanel channel={channelName} running={running} />
      <AgentInteractionsPanel channel={channelName} running={running} />
      <NativeQuotaControls channel={channelName} running={running} />
      <div
        className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[10px] text-foreground-extra-muted"
        data-testid="session-usage-bar"
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${running ? "bg-status-success animate-pulse" : "bg-foreground-extra-muted/50"}`}
          />
          {runtime?.running || running
            ? live?.phase === 'waiting_approval'
              ? '等待审批'
              : live?.phase === 'waiting_input'
                ? '等待你的回答'
              : live?.phase === 'compacting'
                ? '正在压缩'
                : '运行中'
            : '空闲'}
          {summary?.hasUnknownUsage && <span className="text-foreground-muted">· 部分用量未知</span>}
          {usage.last?.model && (
            <span className="hidden sm:inline max-w-48 truncate font-mono">
              · {usage.last.model}
            </span>
          )}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Session token usage"
              className="inline-flex items-center gap-3 rounded-md py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="inline-flex items-center gap-1 font-mono">
                <ArrowUpRight className="size-3" />
                {known ? fmtTokens(effectivePromptTokens) : "—"} in
              </span>
              <span className="inline-flex items-center gap-1 font-mono">
                <ArrowDownLeft className="size-3" />
                {known ? fmtTokens(effectiveCompletionTokens) : "—"} out
              </span>
              {costDisplay && (
                <span
                  className={`inline-flex items-center gap-0.5 font-mono ${
                    costDisplay.isUnknown ? "text-amber-500/90" : "text-emerald-500/90 font-medium"
                  }`}
                  title={costDisplay.title}
                >
                  <Coins className="size-3" />
                  {costDisplay.label}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <ContextRing pct={percent} size={13} />
                {percent === null ? "Context —" : `${percent}% ${budget ? '预估' : '上下文'}`}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Activity className="size-3.5" />
              会话用量与预算
            </div>
            <p className="mt-2 text-[11px] leading-5 text-foreground-muted">
              基于数据层与供应商上报的实际 Token 与核算费用。未收录单价的模型不会虚假计为 0 元。
            </p>
            <dl className="mt-4 space-y-3 text-xs">
              {[
                [
                  ArrowUpRight,
                  "输入 Token",
                  known ? fmtTokens(effectivePromptTokens) : "未上报",
                ],
                [
                  ArrowDownLeft,
                  "输出 Token",
                  known ? fmtTokens(effectiveCompletionTokens) : "未上报",
                ],
                [
                  Database,
                  "缓存读取",
                  effectiveCacheReadTokens > 0
                    ? fmtTokens(effectiveCacheReadTokens)
                    : "0 或未上报",
                ],
                [
                  Coins,
                  "预估总费用",
                  summary && summary.totalTokens > 0
                    ? summary.hasUnknownCost || summary.estimatedCost === null
                      ? "费用待核算（未配置单价）"
                      : `$${summary.estimatedCost.toFixed(4)} USD`
                    : "暂无计费",
                ],
                [
                  Gauge,
                  "最近一次 Prompt",
                  known && usage.last
                    ? fmtTokens(usage.last.prompt_tokens)
                    : "未上报",
                ],
              ].map(([Icon, label, value]) => {
                const Glyph = Icon as typeof Activity;
                return (
                  <div
                    key={String(label)}
                    className="flex items-center justify-between gap-3"
                  >
                    <dt className="flex items-center gap-2 text-foreground-muted">
                      <Glyph className="size-3.5" />
                      {String(label)}
                    </dt>
                    <dd className="font-mono text-[11px]">{String(value)}</dd>
                  </div>
                );
              })}
            </dl>

            {/* Model Breakdown */}
            {summary?.byModel && summary.byModel.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="text-[11px] font-medium text-foreground-muted mb-2">
                  模型调用明细 ({summary.byModel.length})
                </div>
                <div className="max-h-28 overflow-y-auto space-y-1.5 pr-1">
                  {summary.byModel.map((m) => (
                    <div
                      key={m.model}
                      className="flex items-center justify-between rounded bg-surface2/60 px-2 py-1 text-[10px] font-mono"
                    >
                      <span className="truncate max-w-[120px] text-foreground" title={m.model}>
                        {m.model}
                      </span>
                      <span className="text-foreground-muted">{fmtTokens(m.totalTokens)} tok</span>
                      <span
                        className={
                          m.hasUnknownCost || m.estimatedCost === null
                            ? "text-amber-500/90"
                            : "text-emerald-500/90 font-medium"
                        }
                      >
                        {m.hasUnknownCost || m.estimatedCost === null
                          ? "待核算"
                          : `$${m.estimatedCost.toFixed(4)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Budget Limits */}
            {budgets && (budgets.maxTokensPerRun || budgets.maxStepsPerRun || budgets.maxCostPerSession) && (
              <div className="mt-3 rounded-lg border border-border/80 bg-surface2/40 p-2.5 text-[11px] space-y-1">
                <div className="font-medium text-foreground flex items-center gap-1.5">
                  <Sliders className="size-3 text-primary" />
                  预算与上限控制
                </div>
                {budgets.maxStepsPerRun && (
                  <div className="text-foreground-muted flex justify-between">
                    <span>单次任务步骤上限:</span>
                    <span className="font-mono text-foreground">{budgets.maxStepsPerRun} 步</span>
                  </div>
                )}
                {budgets.maxTokensPerRun && (
                  <div className="text-foreground-muted flex justify-between">
                    <span>单次任务 Token 上限:</span>
                    <span className="font-mono text-foreground">{fmtTokens(budgets.maxTokensPerRun)}</span>
                  </div>
                )}
                {budgets.maxCostPerSession && (
                  <div className="text-foreground-muted flex justify-between">
                    <span>会话费用上限:</span>
                    <span className="font-mono text-foreground">${budgets.maxCostPerSession}</span>
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 border-t border-border pt-3 text-[10px] leading-5 text-foreground-extra-muted">
              {budget && (
                <p className="mb-2">
                  下次请求预计 {fmtTokens(budget.estimated_tokens)} tokens · 窗口{" "}
                  {budget.context_window ? fmtTokens(budget.context_window) : "未知"} · 输出及安全余量{" "}
                  {fmtTokens(budget.reserved_tokens)}。估算与实际计费用量分开统计。
                </p>
              )}
              {usage.measured_turns} 次已测调用 · 上下文容量{" "}
              {context?.contextWindow ? fmtTokens(context.contextWindow) : "未声明"}。
            </div>
            <button
              onClick={() => void compact()}
              disabled={
                Boolean(runtime?.running) ||
                running ||
                compacting ||
                !channelName ||
                channelName.startsWith("draft:")
              }
              className="mt-3 w-full rounded-md border border-border p-2 text-xs hover:bg-surface2 transition-colors disabled:opacity-40"
            >
              压缩会话历史
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}
