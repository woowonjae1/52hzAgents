"use client";

import * as React from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Database,
  Gauge,
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
interface RuntimeStatus { running: boolean; run?: { channel: string; phase: string; outcome?: string; context?: { estimated_tokens:number;context_window:number|null;reserved_tokens:number;compactions:number;phase:string } } }

interface SessionUsage {
  channel_name: string;
  measured_turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_measured_turns: number;
  last: { model: string; prompt_tokens: number } | null;
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
  const [runtime,setRuntime] = React.useState<RuntimeStatus|null>(null);
  const [compacting,setCompacting] = React.useState(false);
  const activeChannel = React.useRef(channelName);
  activeChannel.current = channelName;
  const { rows } = useAgentContexts();
  const refresh = React.useCallback(async () => {
    if (!channelName || channelName.startsWith("draft:")) return;
    try {
      const next = await workspaceApi.request<SessionUsage>(
        `/v1/workspaces/${workspaceApi.requireWorkspace()}/session-usage?channel=${encodeURIComponent(channelName)}`,
      );
      if (
        activeChannel.current === channelName &&
        next.channel_name === channelName &&
        typeof next.measured_turns === "number"
      )
        setSnapshot(next);
      const live=await workspaceApi.request<RuntimeStatus>(`/v1/runtime/session?channel=${encodeURIComponent(channelName)}`);
      if(activeChannel.current===channelName) setRuntime(live);
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
  // A response from a previously selected session never appears in the new one.
  const usage = snapshot?.channel_name === channelName ? snapshot : local;
  const context = rows
    .filter((r) => r.channelName === channelName)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const live=runtime?.run?.channel===channelName?runtime.run:null;
  const budget=live?.context;
  const percent = budget ? budget.context_window ? Math.min(100,Math.round(budget.estimated_tokens/budget.context_window*100)) : null : context ? contextPercent(context) : null;
  const compact=async()=>{
    setCompacting(true);
    try {await workspaceApi.request('/v1/runtime/compact',{method:'POST',body:JSON.stringify({channel:channelName})});toast.success('已开始压缩，结果会显示在会话中。');await refresh();}
    catch(error){toast.error(error instanceof Error?error.message:'无法压缩会话');}
    finally{setCompacting(false);}
  };
  const known = usage.measured_turns > 0;
  return (
    <div
      className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[10px] text-foreground-extra-muted"
      data-testid="session-usage-bar"
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${running ? "bg-status-success animate-pulse" : "bg-foreground-extra-muted/50"}`}
        />
        {(runtime?.running || running) ? live?.phase === 'waiting_approval' ? '等待审批' : live?.phase === 'compacting' ? '正在压缩' : 'Running' : 'Ready'}
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
              {known ? fmtTokens(usage.prompt_tokens) : "—"} in
            </span>
            <span className="inline-flex items-center gap-1 font-mono">
              <ArrowDownLeft className="size-3" />
              {known ? fmtTokens(usage.completion_tokens) : "—"} out
            </span>
            <span className="inline-flex items-center gap-1">
              <ContextRing pct={percent} size={13} />
              {percent === null ? "Context —" : `${percent}% ${budget?'estimated':'context'}`}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 rounded-xl p-4">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Activity className="size-3.5" />
            Session usage
          </div>
          <p className="mt-2 text-[11px] leading-5 text-foreground-muted">
            Provider-reported tokens in retained history. Missing measurements
            stay unknown.
          </p>
          <dl className="mt-4 space-y-3 text-xs">
            {[
              [
                ArrowUpRight,
                "Input tokens",
                known ? fmtTokens(usage.prompt_tokens) : "Not reported",
              ],
              [
                ArrowDownLeft,
                "Output tokens",
                known ? fmtTokens(usage.completion_tokens) : "Not reported",
              ],
              [
                Database,
                "Cache read",
                usage.cache_measured_turns > 0
                  ? fmtTokens(usage.cache_read_tokens)
                  : "Not reported",
              ],
              [
                Gauge,
                "Last prompt",
                known && usage.last
                  ? fmtTokens(usage.last.prompt_tokens)
                  : "Not reported",
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
          <div className="mt-4 border-t border-border pt-3 text-[10px] leading-5 text-foreground-extra-muted">
            {budget && <p className="mb-2">下次请求预计 {fmtTokens(budget.estimated_tokens)} tokens · 窗口 {budget.context_window?fmtTokens(budget.context_window):'未知'} · 输出及安全余量 {fmtTokens(budget.reserved_tokens)}。估算与实际计费用量分开统计。</p>}
            {usage.measured_turns} measured replies · Context capacity{" "}
            {context?.contextWindow
              ? fmtTokens(context.contextWindow)
              : "not reported"}
            . Cost is unavailable without verified model pricing.
          </div>
          <button onClick={()=>void compact()} disabled={!!runtime?.running || running || compacting || !channelName || channelName.startsWith('draft:')} className="mt-3 w-full rounded-md border border-border p-2 text-xs disabled:opacity-40">压缩会话历史</button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
