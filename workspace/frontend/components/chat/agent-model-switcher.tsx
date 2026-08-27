'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export interface AgentModelOption {
  id: string;
  name: string;
  shortName: string;
  provider?: string;
}

export function getAgentKind(agentName?: string | null, agentType?: string | null): string {
  return (agentType || agentName || '').toLowerCase();
}


/**
 * Dynamic Model Switcher:
 * For OpenCode, KiloCode, OpenClaw, models are dynamically fetched from the
 * CLI (`<cli> models` or config) via `usage.available_models`.
 * For Antigravity and Claude, their dedicated model lists are preserved.
 */
export function parseReportedModels(raw?: string | null): AgentModelOption[] {
  if (!raw) return [];
  const toOption = (id: string, name?: string): AgentModelOption => {
    const trimmed = id.trim();
    const slash = trimmed.indexOf('/');
    const provider = slash > 0 ? trimmed.slice(0, slash) : undefined;
    const bare = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
    return {
      id: trimmed,
      name: (name || '').trim() || bare,
      shortName: bare,
      provider,
    };
  };

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((m) => (typeof m === 'string' ? toOption(m) : toOption(String(m?.id ?? m?.name ?? ''), m?.name || m?.label)))
        .filter((m) => m.id.length > 0);
    }
  } catch {
    if (/^\s*[[{]/.test(raw)) return [];
  }
  return raw
    .split(',')
    .map((s) => toOption(s))
    .filter((m) => m.id.length > 0);
}

interface AgentModelSwitcherProps {
  agentName?: string;
  sessionId?: string | null;
  className?: string;
}

export function AgentModelSwitcher({
  agentName,
  sessionId,
  className,
}: AgentModelSwitcherProps) {
  const { workspaceId, agents } = useWorkspace();

  // Find online agents
  const onlineAgents = React.useMemo(() => {
    return agents.filter((a) => a.status === 'online');
  }, [agents]);

  // Determine active agent target
  const activeAgent = React.useMemo(() => {
    if (agentName) {
      const match = onlineAgents.find((a) => a.agentName.toLowerCase() === agentName.toLowerCase());
      if (match) return match;
      // Named but not online: fall through to null rather than retargeting onto
      // whichever agent happens to be up - silently switching a different
      // agent's model is worse than doing nothing.
      return null;
    }
    return onlineAgents[0] || null;
  }, [agentName, onlineAgents]);

  const activeTargetName = activeAgent?.agentName || agentName || 'agent';
  // set_model reaches the adapter over the control channel, which only a
  // connected agent polls. With nothing online the chip stays visible (so the
  // composer's layout does not jump) but is inert.
  const canConfigure = !!activeAgent;
  const offlineHint = 'Agent 未连接 - 连接后才能切换模型';

  // Dynamic model selections per agent name
  const [agentSelectedModels, setAgentSelectedModels] = React.useState<Record<string, string>>({});

  // Dynamic reported models per agent name (populated from CLI / adapter heartbeat)
  const [reportedModels, setReportedModels] = React.useState<Record<string, AgentModelOption[]>>({});

  const agentNamesKey = React.useMemo(
    () => onlineAgents.map((a) => a.agentName).sort().join(','),
    [onlineAgents]
  );

  React.useEffect(() => {
    if (!agentNamesKey) return;
    const names = agentNamesKey.split(',');
    let cancelled = false;

    const load = async () => {
      if (workspaceId) {
        workspaceApi.setWorkspaceId(workspaceId);
      }
      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            const usage = await workspaceApi.getAgentUsage(name);
            const parsed = parseReportedModels(usage?.available_models);
            return [name, parsed, usage?.current_model] as const;
          } catch {
            return [name, [] as AgentModelOption[], null] as const;
          }
        })
      );
      if (cancelled) return;
      setReportedModels((prev) => {
        const next = { ...prev };
        for (const [name, models] of entries) {
          if (models.length > 0 || !next[name]) next[name] = models;
        }
        return next;
      });
      setAgentSelectedModels((prev) => {
        const next = { ...prev };
        for (const [name, , currentModel] of entries) {
          if (currentModel && !next[name]) {
            next[name] = currentModel;
          }
        }
        return next;
      });
    };

    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agentNamesKey, workspaceId]);

  /**
   * Only what the agent's own adapter reported. There is deliberately no
   * per-agent fallback table here: a list the frontend made up would show
   * models the CLI may not have, and picking one would fail at run time. An
   * agent that reports nothing shows as unconfigured, with free-text entry.
   */
  const modelsForAgent = React.useCallback(
    (name: string): AgentModelOption[] => reportedModels[name] || [],
    [reportedModels]
  );

  // Load saved preferences from localStorage
  React.useEffect(() => {
    if (!sessionId) return;
    try {
      onlineAgents.forEach((a) => {
        const saved = localStorage.getItem(`52hz_model_${sessionId}_${a.agentName}`);
        if (!saved) return;
        setAgentSelectedModels((prev) => ({
          ...prev,
          [a.agentName]: saved,
        }));
      });
    } catch {}
  }, [sessionId, onlineAgents]);

  if (!activeAgent && !agentName) return null;

  const genericOption: AgentModelOption = {
    id: 'default',
    name: `${activeTargetName} (Default)`,
    shortName: activeTargetName,
  };

  const selectedForActive = agentSelectedModels[activeTargetName];
  const activeAvailableModels = modelsForAgent(activeTargetName);

  // Compute current display model option purely from actual state / reported models
  const currentModelOption: AgentModelOption = (() => {
    if (selectedForActive) {
      const match = activeAvailableModels.find((m) => m.id === selectedForActive || m.shortName === selectedForActive);
      if (match) return match;
      return {
        id: selectedForActive,
        name: selectedForActive,
        shortName: selectedForActive.includes('/') ? selectedForActive.split('/')[1] : selectedForActive,
      };
    }
    return genericOption;
  })();

  const handleSelectModel = async (
    targetAgentName: string,
    modelId: string,
    modelName: string
  ) => {
    if (!canConfigure) return;
    const previousId = agentSelectedModels[targetAgentName];

    setAgentSelectedModels((prev) => ({
      ...prev,
      [targetAgentName]: modelId,
    }));

    try {
      if (workspaceId) {
        workspaceApi.setWorkspaceId(workspaceId);
      }
      await workspaceApi.sendAgentControl(targetAgentName, 'set_model', {
        model: modelId,
        channel: sessionId || undefined,
      });
      if (sessionId) {
        try {
          localStorage.setItem(`52hz_model_${sessionId}_${targetAgentName}`, modelId);
        } catch {}
      }
      toast.success(`${targetAgentName} 已切换为 ${modelName}`);
    } catch (e) {
      if (previousId) {
        setAgentSelectedModels((prev) => ({
          ...prev,
          [targetAgentName]: previousId,
        }));
      }
      const detail = e instanceof Error && e.message ? `：${e.message}` : '';
      toast.error(`${targetAgentName} 切换到 ${modelName} 失败${detail}`);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!canConfigure}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border transition-all duration-200 select-none shadow-2xs',
            canConfigure
              ? 'bg-surface2/80 hover:bg-surface3/90 border-border/70 hover:border-border text-foreground cursor-pointer'
              : 'bg-surface2/40 border-border/40 text-muted-foreground/60 cursor-not-allowed',
            className
          )}
          title={canConfigure ? `当前模型: ${currentModelOption.name} (@${activeTargetName})` : offlineHint}
        >
          {/* No weight of its own — the chip is already `font-medium`, and the
              600 that used to sit here rendered at the chip's 11px, where the
              weight axis stops separating and only thickens. */}
          <span className="truncate max-w-[140px]">
            {canConfigure ? currentModelOption.shortName : '未连接'}
          </span>
          <ChevronDown className={cn('size-3 shrink-0', canConfigure ? 'text-foreground-extra-muted' : 'text-muted-foreground/40')} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64 p-1.5 shadow-xl border-border/80 bg-surface1/95 backdrop-blur-xl max-h-[420px] overflow-y-auto">
        {/* Sort to put active target agent at the top */}
        {[...onlineAgents]
          .sort((a, b) => (a.agentName.toLowerCase() === activeTargetName.toLowerCase() ? -1 : b.agentName.toLowerCase() === activeTargetName.toLowerCase() ? 1 : 0))
          .map((agentItem, idx) => {
          const models = modelsForAgent(agentItem.agentName);
          const currentSelectedId = agentSelectedModels[agentItem.agentName];
          const isCurrentActiveAgent = agentItem.agentName.toLowerCase() === activeTargetName.toLowerCase();

          return (
            <div key={agentItem.agentName} className={cn('space-y-0.5', idx > 0 && 'pt-2 border-t border-border/40 mt-1.5')}>
              <div className="px-2 py-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase flex items-center justify-between">
                <span className={cn(isCurrentActiveAgent && 'text-primary font-bold')}>@{agentItem.agentName}</span>
                <span className="text-3xs font-normal text-muted-foreground/80 font-mono">
                  {agentItem.agentType || 'agent'}
                </span>
              </div>

              {models.length > 0 ? (
                models.map((m) => {
                  const isSelected =
                    !!currentSelectedId &&
                    (currentSelectedId === m.id || currentSelectedId === m.shortName);

                  return (
                    <DropdownMenuItem
                      key={m.id}
                      onClick={() => handleSelectModel(agentItem.agentName, m.id, m.name)}
                      className={cn(
                        'flex items-center justify-between px-2.5 py-1.5 rounded-md cursor-pointer text-xs font-medium transition-colors',
                        isSelected
                          ? 'bg-surface3 text-foreground font-semibold'
                          : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                      )}
                    >
                      <span className="truncate">{m.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0 ml-2">
                        {m.provider && (
                          <span className="text-3xs font-normal font-mono text-muted-foreground/80">
                            {m.provider}
                          </span>
                        )}
                        {isSelected && <Check className="size-3.5 text-primary" />}
                      </span>
                    </DropdownMenuItem>
                  );
                })
              ) : (
                <div className="px-2.5 py-1 text-xs text-muted-foreground italic flex items-center justify-between">
                  <span>{currentSelectedId || '默认环境模型 (Default)'}</span>
                </div>
              )}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
