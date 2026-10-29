"use client";

import * as React from "react";
import {
  Bot,
  ChevronDown,
  MessageSquare,
  ClipboardList,
  Loader2,
} from "lucide-react";
import { workspaceApi } from "@/lib/api";
import { isDraftSessionId } from "@/lib/workspace-context";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "@/lib/toast";
import { useVisibilityPolling } from '@/lib/use-visibility-polling';

interface Config {
  provider: string;
  model: string;
  mode: "chat" | "plan" | "agent";
}
interface Runtime {
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
  const activeSession = React.useRef(sessionId);
  activeSession.current = sessionId;
  React.useEffect(() => {
    onAvailabilityChange?.(false);
    setRuntime(null);
    setForm(null);
    setOpen(false);
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
            if (saved) next.config = saved;
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
    try { const next = await workspaceApi.request<Runtime>(`/v1/runtime/session?channel=${encodeURIComponent(sessionId)}`); if (next?.config && activeSession.current === sessionId) setRuntime(next); } catch {}
  }, [sessionId]);
  React.useEffect(() => { void refresh(); }, [running, refresh]);
  useVisibilityPolling(refresh, 3000, { enabled: !!runtime && !!running });
  if (!runtime || !form) return <>{fallback}</>;
  const provider = runtime.providers.find((p) => p.id === form.provider);
  const apply = async () => {
    if (!sessionId || !form.model.trim() || saving) return;
    setSaving(true);
    try {
      if (isDraftSessionId(sessionId)) {
        localStorage.setItem(runtimeDraftKey(sessionId), JSON.stringify(form));
        setRuntime({ ...runtime, config: form });
      } else {
        const saved = await workspaceApi.request<Runtime>(
          `/v1/runtime/session?channel=${encodeURIComponent(sessionId)}`,
          { method: "PATCH", body: JSON.stringify(form) },
        );
        setRuntime(saved);
      }
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save the session model.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(runtime.config);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Session model and mode"
          className="inline-flex h-7 max-w-72 items-center gap-1.5 rounded-lg px-2 text-[11px] text-foreground-muted hover:bg-surface2 hover:text-foreground"
        >
          {runtime.config.mode === "plan" ? (
            <ClipboardList className="size-3 shrink-0" />
          ) : (
            <Bot className="size-3 shrink-0" />
          )}
          <span className="truncate">{runtime.config.model}</span>
          <span className="text-foreground-extra-muted">
            · {runtime.config.mode === "plan" ? "Plan" : runtime.config.mode === "agent" ? "Agent" : "Chat"}
          </span>
          <ChevronDown className="size-3 shrink-0" />
          {runtime.queued > 0 && <span className="shrink-0 text-foreground-extra-muted">{runtime.queued} queued</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 rounded-xl p-4 space-y-4"
      >
        <div>
          <h3 className="text-xs font-semibold">Session model & mode</h3>
          <p className="mt-1 text-[11px] leading-5 text-foreground-muted">
            Saved for this conversation. Other sessions keep their own settings.
          </p>
        </div>
        <label className="block text-[11px] text-foreground-muted">
          Provider
          <select
            aria-label="Session provider"
            value={form.provider}
            disabled={running || saving}
            onChange={(e) =>
              setForm({
                ...form,
                provider: e.target.value,
                model:
                  runtime.providers.find((p) => p.id === e.target.value)
                    ?.model || "",
              })
            }
            className="mt-1.5 w-full rounded-lg border border-border bg-surface1 p-2 text-xs text-foreground"
          >
            {runtime.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.id === "ollama"
                  ? " · local endpoint"
                  : p.configured
                    ? " · key configured"
                    : " · key missing"}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[11px] text-foreground-muted">
          Model ID
          <input
            aria-label="Session model ID"
            value={form.model}
            maxLength={200}
            disabled={running || saving}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface1 p-2 font-mono text-xs text-foreground"
          />
        </label>
        <div
          className="grid grid-cols-3 gap-2"
          role="group"
          aria-label="Session mode"
        >
          {(["chat", "plan", "agent"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={running || saving}
              aria-pressed={form.mode === mode}
              onClick={() => setForm({ ...form, mode })}
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs ${form.mode === mode ? "border-foreground-muted bg-surface2" : "border-border text-foreground-muted"}`}
            >
              {mode === "plan" ? (
                <ClipboardList className="size-3" />
              ) : (
                <MessageSquare className="size-3" />
              )}
              {mode === "plan" ? "Plan" : mode === "agent" ? "Agent" : "Chat"}
            </button>
          ))}
        </div>
        <p className="text-[10px] leading-5 text-foreground-extra-muted">
          {running
            ? "Stop the current response to change these settings."
            : form.mode === "plan"
              ? "Pi reads and searches the selected project to build a plan. No edits or commands."
              : form.mode === "agent"
                ? "Pi can edit project files. Every command pauses for your approval and runs with your system permissions."
                : "A conversation without project tools. Choose Plan to inspect files or Agent to implement changes."}
          {provider &&
            !provider.configured &&
            " Set the provider API key in the desktop environment before sending."}
        </p>
        <button
          type="button"
          disabled={running || saving || !form.model.trim()}
          onClick={() => void apply()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-foreground py-2 text-xs font-medium text-background disabled:opacity-40"
        >
          {saving && <Loader2 className="size-3 animate-spin" />}Apply to
          session
        </button>
      </PopoverContent>
    </Popover>
  );
}
