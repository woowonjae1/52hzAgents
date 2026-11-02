"use client";

import * as React from "react";
import {
  ChevronDown,
  Loader2,
  Bot,
  Users,
  Check,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import { workspaceApi } from "@/lib/api";
import { isDraftSessionId } from "@/lib/workspace-context";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "@/lib/toast";
import { useVisibilityPolling } from "@/lib/use-visibility-polling";
import type { AgentDefinition } from "@/lib/api/agent-definitions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Config {
  provider: string;
  model: string;
  mode: "chat" | "plan" | "agent";
  autoCompact?: boolean;
}
interface Runtime {
  agent?: AgentDefinition;
  configSource?: "agent" | "session";
  config: Config;
  providers: {
    id: string;
    label: string;
    configured: boolean;
    model: string;
  }[];
  running: boolean;
  queued: number;
}
export const runtimeDraftKey = (id: string) => `52hz_runtime_${id}`;
const modes = ["chat", "plan", "agent"] as const;
const modeLabels = { chat: "对话", plan: "只读分析", agent: "实施" };

export function SessionRuntimeControls({
  sessionId,
  running,
  fallback,
  onAvailabilityChange,
}: {
  sessionId?: string;
  running?: boolean;
  fallback: React.ReactNode;
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [runtime, setRuntime] = React.useState<Runtime | null>(null);
  const [form, setForm] = React.useState<Config | null>(null);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Agent selector view mode inside popover
  const [selectingAgent, setSelectingAgent] = React.useState(false);
  const [agentList, setAgentList] = React.useState<AgentDefinition[]>([]);
  const [loadingAgents, setLoadingAgents] = React.useState(false);
  const [pendingAgentSwitch, setPendingAgentSwitch] = React.useState<AgentDefinition | null>(null);

  const activeSession = React.useRef(sessionId);
  activeSession.current = sessionId;

  React.useEffect(() => {
    onAvailabilityChange?.(false);
    setRuntime(null);
    setForm(null);
    setOpen(false);
    setSaving(false);
    setSelectingAgent(false);
    setPendingAgentSwitch(null);
    if (!sessionId) return;
    const controller = new AbortController();
    void workspaceApi
      .request<Runtime>(
        `/v1/runtime/session?channel=${encodeURIComponent(sessionId)}`,
        { signal: controller.signal },
      )
      .then((next) => {
        if (!next?.config || !Array.isArray(next.providers)) return;
        if (isDraftSessionId(sessionId)) {
          try {
            const saved = JSON.parse(
              localStorage.getItem(runtimeDraftKey(sessionId)) || "null",
            );
            if (saved?.inheritAgent === true) {
              next.config = {
                ...next.config,
                ...(modes.includes(saved.mode) ? { mode: saved.mode } : {}),
                ...(typeof saved.autoCompact === "boolean"
                  ? { autoCompact: saved.autoCompact }
                  : {}),
              };
              next.configSource = "agent";
            } else if (
              typeof saved?.provider === "string" &&
              typeof saved?.model === "string" &&
              modes.includes(saved.mode)
            ) {
              next.config = saved;
              next.configSource = "session";
            }
            const ceiling = modes.indexOf(next.agent?.maxMode || "agent");
            if (modes.indexOf(next.config.mode) > ceiling)
              next.config.mode = modes[ceiling];
          } catch {}
        }
        if (!controller.signal.aborted) {
          onAvailabilityChange?.(true);
          setRuntime(next);
          setForm(next.config);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [sessionId, onAvailabilityChange]);

  const refresh = React.useCallback(async () => {
    if (!sessionId || isDraftSessionId(sessionId)) return;
    try {
      const next = await workspaceApi.request<Runtime>(
        `/v1/runtime/session?channel=${encodeURIComponent(sessionId)}`,
      );
      if (next?.config && activeSession.current === sessionId) setRuntime(next);
    } catch {}
  }, [sessionId]);

  React.useEffect(() => {
    void refresh();
  }, [running, refresh]);
  useVisibilityPolling(refresh, 3000, { enabled: !!runtime && !!running });

  const loadAgents = async () => {
    setLoadingAgents(true);
    try {
      const res = await workspaceApi.listAgentDefinitions(false);
      setAgentList(res?.agents || []);
    } catch {
      toast.error("加载 Agent 列表失败");
    } finally {
      setLoadingAgents(false);
    }
  };

  if (!runtime || !form) return <>{fallback}</>;
  const busy = Boolean(running || runtime.running || saving);
  const agentName = runtime.agent?.name || "52hz Agent";
  const maxMode = runtime.agent?.maxMode || "agent";
  const hasCustomOverride = runtime.configSource === "session";

  const applyModeChange = async (targetMode: "chat" | "plan" | "agent") => {
    if (!sessionId || busy) return;
    const ceiling = modes.indexOf(maxMode);
    if (modes.indexOf(targetMode) > ceiling) {
      toast.error("超出当前 Agent 允许的最高工作模式");
      return;
    }
    const targetSession = sessionId;
    const inherit = runtime.configSource === "agent";
    const payload = inherit
      ? { inheritAgent: true, mode: targetMode, autoCompact: form.autoCompact !== false }
      : { ...form, mode: targetMode };

    setSaving(true);
    try {
      if (isDraftSessionId(sessionId)) {
        localStorage.setItem(runtimeDraftKey(sessionId), JSON.stringify(payload));
        setRuntime({
          ...runtime,
          config: { ...runtime.config, mode: targetMode },
        });
        setForm({ ...form, mode: targetMode });
      } else {
        const saved = await workspaceApi.request<Runtime>(
          `/v1/runtime/session?channel=${encodeURIComponent(sessionId)}`,
          { method: "PATCH", body: JSON.stringify(payload) },
        );
        if (activeSession.current !== targetSession) return;
        setRuntime(saved);
        setForm(saved.config);
      }
      toast.success(`已切换为【${modeLabels[targetMode]}】模式`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法更新工作模式");
    } finally {
      if (activeSession.current === targetSession) setSaving(false);
    }
  };

  const handleSelectAgent = (agent: AgentDefinition) => {
    if (!sessionId || busy) return;
    const currentId = runtime.agent?.id || "agent-local";
    if (agent.id === currentId) {
      setSelectingAgent(false);
      setPendingAgentSwitch(null);
      return;
    }
    setPendingAgentSwitch(agent);
  };

  const executeAgentSwitch = async (agent: AgentDefinition) => {
    if (!sessionId || busy) return;
    const targetSession = sessionId;
    setSaving(true);
    try {
      if (isDraftSessionId(sessionId)) {
        setRuntime({
          ...runtime,
          agent,
          configSource: "agent",
          config: {
            ...runtime.config,
            mode: agent.defaultMode || "chat",
          },
        });
        localStorage.setItem(
          runtimeDraftKey(sessionId),
          JSON.stringify({ inheritAgent: true, mode: agent.defaultMode || "chat" }),
        );
        toast.success(`执行主体已切换为：${agent.name}`);
      } else {
        const res = await workspaceApi.assignSessionAgent(sessionId, agent.id, false);
        if (activeSession.current !== targetSession) return;
        setRuntime({
          ...runtime,
          agent: res.agent,
          configSource: "agent",
          config: res.config,
        });
        setForm(res.config);
        toast.success(`会话执行主体已切换为：${res.agent.name}`);
      }
      setSelectingAgent(false);
      setPendingAgentSwitch(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法绑定 Agent");
    } finally {
      if (activeSession.current === targetSession) setSaving(false);
    }
  };

  const handleClearOverride = async () => {
    if (!sessionId || busy) return;
    setSaving(true);
    try {
      if (isDraftSessionId(sessionId)) {
        const payload = { inheritAgent: true, mode: form.mode };
        localStorage.setItem(runtimeDraftKey(sessionId), JSON.stringify(payload));
        setRuntime({ ...runtime, configSource: "agent" });
      } else {
        const saved = await workspaceApi.request<Runtime>(
          `/v1/runtime/session?channel=${encodeURIComponent(sessionId)}`,
          { method: "PATCH", body: JSON.stringify({ inheritAgent: true, mode: form.mode }) },
        );
        setRuntime(saved);
        setForm(saved.config);
      }
      toast.success("已清除任务级模型覆盖，恢复继承 Agent 配置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复继承失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setForm(runtime.config);
          setSelectingAgent(false);
          setPendingAgentSwitch(null);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`当前 Agent：${agentName}，工作模式：${modeLabels[runtime.config.mode]}${busy ? '（执行中）' : ''}`}
          className="inline-flex h-8 min-w-0 max-w-72 items-center gap-1.5 rounded-lg px-2.5 text-xs text-foreground-muted transition-colors hover:bg-surface2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {busy ? (
            <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />
          ) : (
            <Bot className="size-3.5 text-primary shrink-0" />
          )}
          <span className="truncate font-medium text-foreground">{agentName}</span>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border/70 mx-0.5" />
          <span className={cn("shrink-0", busy ? "text-primary font-medium" : "text-foreground-muted")}>
            {busy ? '执行中' : modeLabels[runtime.config.mode]}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-foreground-extra-muted ml-0.5" />
          {runtime.queued > 0 && (
            <span className="shrink-0 text-3xs text-foreground-extra-muted">
              待处理 {runtime.queued}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-2rem)] max-h-[min(32rem,var(--radix-popover-content-available-height))] overflow-y-auto rounded-xl border-border/70 p-4 shadow-lg space-y-4"
      >
        {selectingAgent ? (
          /* Agent Selection View */
          <div className="space-y-3">
            {pendingAgentSwitch ? (
              <div className="space-y-3 py-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <Bot className="size-4 text-primary shrink-0" />
                  <span>确认切换执行 Agent</span>
                </div>
                <p className="text-2xs text-foreground-muted leading-relaxed">
                  后续任务将由 <span className="font-semibold text-foreground">{pendingAgentSwitch.name}</span> 执行。历史对话作者和执行记录保持不变，不会被覆盖改写。
                </p>
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
                  <button
                    type="button"
                    onClick={() => setPendingAgentSwitch(null)}
                    className="px-2.5 py-1 text-2xs rounded-md border border-border/70 hover:bg-surface2 text-foreground-muted"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void executeAgentSwitch(pendingAgentSwitch)}
                    className="px-2.5 py-1 text-2xs rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 flex items-center gap-1.5"
                  >
                    {saving && <Loader2 className="size-3 animate-spin" />}
                    <span>确认切换</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between pb-2 border-b border-border/50">
                  <button
                    type="button"
                    onClick={() => setSelectingAgent(false)}
                    className="inline-flex items-center gap-1 text-2xs text-foreground-muted hover:text-foreground"
                  >
                    <ArrowLeft className="size-3" />
                    <span>返回</span>
                  </button>
                  <span className="text-2xs font-semibold text-foreground">选择会话 Agent</span>
                </div>

            {loadingAgents ? (
              <div className="py-8 text-center text-2xs text-foreground-muted flex items-center justify-center gap-2">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                <span>加载 Agent 列表中...</span>
              </div>
            ) : agentList.length === 0 ? (
              <p className="text-2xs text-foreground-muted text-center py-4">暂无其他可用 Agent</p>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {agentList.map((ag) => {
                  const isCurrent = (runtime.agent?.id || "agent-local") === ag.id;
                  return (
                    <button
                      key={ag.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSelectAgent(ag)}
                      className={cn(
                        "w-full text-left rounded-lg p-2.5 transition-colors border text-xs flex items-start justify-between gap-2",
                        isCurrent
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border/60 hover:bg-surface2 text-foreground-muted hover:text-foreground"
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium truncate">{ag.name}</span>
                          {ag.builtIn && (
                            <Badge variant="outline" size="sm" className="text-3xs py-0 h-4">
                              内置
                            </Badge>
                          )}
                          <Badge variant="outline" size="sm" className="text-3xs uppercase py-0 h-4">
                            {ag.role}
                          </Badge>
                        </div>
                        {ag.description && (
                          <p className="text-3xs text-foreground-extra-muted line-clamp-1 mt-0.5">
                            {ag.description}
                          </p>
                        )}
                      </div>
                      {isCurrent && <Check className="size-3.5 text-primary shrink-0 mt-0.5" />}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-3xs text-foreground-extra-muted leading-4">
              更换 Agent 不会修改历史消息记录，仅对后续任务生效。
            </p>
              </>
            )}
          </div>
        ) : (
          /* Normal Popover View */
          <>
            {/* Agent Identity Card */}
            <div className="p-3 rounded-lg bg-surface2/40 border border-border/60 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-3xs uppercase tracking-wider text-foreground-extra-muted">当前 Agent 主体</p>
                  <h3 className="text-xs sm:text-sm font-semibold text-foreground flex items-center gap-1.5 mt-0.5">
                    <Bot className="size-3.5 text-primary shrink-0" />
                    <span className="truncate">{agentName}</span>
                  </h3>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setSelectingAgent(true);
                    void loadAgents();
                  }}
                  className="h-6 px-2 text-2xs gap-1 text-foreground-muted hover:text-foreground shrink-0"
                >
                  <Users className="size-3" />
                  <span>更换</span>
                </Button>
              </div>

              {runtime.agent?.description && (
                <p className="text-2xs text-foreground-muted line-clamp-2 leading-relaxed">
                  {runtime.agent.description}
                </p>
              )}
            </div>

            {/* Mode Segmented Controls */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-2xs text-foreground-muted">
                <span>工作方式</span>
                <span className="text-foreground-extra-muted text-3xs">
                  上限：{modeLabels[maxMode]}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface2/60 p-1" role="group">
                {modes.map((mode) => {
                  const restricted = modes.indexOf(mode) > modes.indexOf(maxMode);
                  const active = form.mode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      disabled={busy || restricted}
                      aria-pressed={active}
                      title={restricted ? "超出此 Agent 允许的最高模式" : undefined}
                      onClick={() => void applyModeChange(mode)}
                      className={cn(
                        "rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35",
                        active
                          ? "bg-background font-medium text-foreground shadow-xs"
                          : "text-foreground-muted hover:text-foreground"
                      )}
                    >
                      {modeLabels[mode]}
                    </button>
                  );
                })}
              </div>

              <p className="text-2xs leading-relaxed text-foreground-extra-muted min-h-8">
                {busy && !saving
                  ? "任务正在执行中，结束后可调整设置。"
                  : form.mode === "chat"
                  ? "纯对话交流，不调用任何项目读写或终端工具。"
                  : form.mode === "plan"
                  ? runtime.agent?.permissions.readFiles === false
                    ? "仅分析已提供的上下文材料，不读取文件。"
                    : "只读分析并提供方案，不修改任何项目代码。"
                  : runtime.agent?.permissions.executeCommands === false
                  ? "可实施修改代码，不执行外部命令。"
                  : "可实施修改代码；终端命令仍受白名单与审批保护。"}
              </p>
            </div>

            {/* Model Resource / Override Section */}
            <div className="pt-2 border-t border-border/50 space-y-2">
              <div className="flex items-center justify-between text-2xs">
                <span className="text-foreground-extra-muted">底层执行资源</span>
                {hasCustomOverride ? (
                  <span className="text-status-warning font-medium">任务级独立覆盖</span>
                ) : (
                  <span className="text-status-success font-medium">已继承 Agent 默认</span>
                )}
              </div>

              {hasCustomOverride ? (
                <div className="p-2.5 rounded-lg bg-status-warning/10 border border-status-warning/30 space-y-2 text-2xs">
                  <div className="flex items-start gap-1.5 text-status-warning">
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">当前会话存在自定义模型配置</p>
                      <p className="font-mono text-3xs mt-0.5 opacity-85">
                        {form.provider} · {form.model}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || saving}
                    onClick={() => void handleClearOverride()}
                    className="w-full h-7 text-xs gap-1.5 text-foreground hover:bg-surface2"
                  >
                    <RotateCcw className="size-3 text-primary" />
                    <span>恢复继承 Agent 默认配置</span>
                  </Button>
                </div>
              ) : (
                <div className="px-1 text-2xs text-foreground-extra-muted flex items-center justify-between">
                  <span className="truncate font-mono">
                    {runtime.agent?.modelResource
                      ? `${runtime.agent.modelResource.connectionId} / ${runtime.agent.modelResource.modelId}`
                      : `${form.provider} / ${form.model}`}
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
