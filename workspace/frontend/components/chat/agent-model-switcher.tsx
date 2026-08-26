'use client';

import * as React from 'react';
import { Check, ChevronDown, Bot, Sparkles } from 'lucide-react';
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
  /** OpenClaw only: the provider half of a `<provider>/<modelId>` id. */
  provider?: string;
}

export const CLAUDE_MODELS: AgentModelOption[] = [
  {
    id: 'sonnet',
    name: 'Claude Sonnet 5',
    shortName: 'Sonnet 5',
  },
  {
    id: 'opus',
    name: 'Claude Opus 5',
    shortName: 'Opus 5',
  },
  {
    id: 'haiku',
    name: 'Claude Haiku 4.5',
    shortName: 'Haiku 4.5',
  },
];

export const ANTIGRAVITY_MODELS: AgentModelOption[] = [
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    shortName: 'Gemini 3.7 Flash',
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    shortName: 'Gemini 3.6 Flash',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    shortName: 'Gemini 3.5 Flash',
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    shortName: 'Gemini 3.1 Pro',
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    shortName: 'Sonnet 4.6',
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6 (Thinking)',
    shortName: 'Opus 4.6',
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B (Medium)',
    shortName: 'GPT-OSS 120B',
  },
];

/**
 * OpenClaw has no fixed model roster — its models come from whatever
 * `~/.openclaw/openclaw.json` declares for this install. The adapter publishes
 * that list via the agent-usage endpoint (`available_models` as a JSON array of
 * `{ id, name }`, ids being the `<provider>/<modelId>` strings OpenClaw wants),
 * so the menu offers only models the account can actually reach.
 */
function parseReportedModels(raw?: string | null): AgentModelOption[] {
  if (!raw) return [];
  const toOption = (id: string, name?: string): AgentModelOption => {
    const trimmed = id.trim();
    const slash = trimmed.indexOf('/');
    // `custom-customda/qwen3.6-flash` → provider `custom-customda`, bare id
    // `qwen3.6-flash`. The bare id is what fits the chip; the provider is shown
    // as a separate tag, because the same model id can appear under two
    // providers with near-identical declared names.
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
        .map((m) => (typeof m === 'string' ? toOption(m) : toOption(String(m?.id ?? ''), m?.name)))
        .filter((m) => m.id.length > 0);
    }
  } catch {
    // Malformed JSON, not a different format — comma-splitting it would yield
    // junk options like `{`.
    if (/^\s*[[{]/.test(raw)) return [];
  }
  // The comma-separated form the Claude adapter scrapes out of `/model`.
  return raw
    .split(',')
    .map((s) => toOption(s))
    .filter((m) => m.id.length > 0);
}

export type AgentKind = 'antigravity' | 'claude' | 'openclaw' | 'generic';

export function getAgentKind(agentName?: string | null, agentType?: string | null): AgentKind {
  const n = (agentName || '').toLowerCase();
  const t = (agentType || '').toLowerCase();
  if (n.includes('antigravity') || n.includes('agy') || t === 'antigravity' || t === 'agy') return 'antigravity';
  if (n.includes('claude') || t === 'claude') return 'claude';
  if (n.includes('openclaw') || n.includes('easyclaw') || n.includes('nanoclaw') || t === 'openclaw' || t === 'nanoclaw') return 'openclaw';
  return 'generic';
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
    }
    return onlineAgents[0] || null;
  }, [agentName, onlineAgents]);

  const activeTargetName = activeAgent?.agentName || agentName || 'agent';
  const activeKind = getAgentKind(activeTargetName, activeAgent?.agentType);

  // Model states per agent kind
  const [antigravityModelId, setAntigravityModelId] = React.useState<string>('gemini-3.5-flash');
  const [claudeModelId, setClaudeModelId] = React.useState<string>('sonnet');
  const [openclawModelId, setOpenclawModelId] = React.useState<string | null>(null);

  // OpenClaw's roster is per-install, so it has to be fetched rather than
  // hardcoded. Keyed by agent name, since two OpenClaw agents can point at
  // different configs.
  const [reportedModels, setReportedModels] = React.useState<Record<string, AgentModelOption[]>>({});

  const openclawAgentNames = React.useMemo(
    () =>
      onlineAgents
        .filter((a) => getAgentKind(a.agentName, a.agentType) === 'openclaw')
        .map((a) => a.agentName)
        .sort()
        .join(','),
    [onlineAgents]
  );

  React.useEffect(() => {
    if (!openclawAgentNames) return;
    const names = openclawAgentNames.split(',');
    let cancelled = false;

    const load = async () => {
      if (workspaceId) {
        workspaceApi.setWorkspaceId(workspaceId);
      }
      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            const usage = await workspaceApi.getAgentUsage(name);
            return [name, parseReportedModels(usage?.available_models)] as const;
          } catch {
            // 404 until the agent's first heartbeat lands — leave it empty and
            // let the poll below pick it up.
            return [name, [] as AgentModelOption[]] as const;
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
    };

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [openclawAgentNames, workspaceId]);

  const modelsForAgent = React.useCallback(
    (name: string, kind: AgentKind): AgentModelOption[] => {
      switch (kind) {
        case 'antigravity':
          return ANTIGRAVITY_MODELS;
        case 'claude':
          return CLAUDE_MODELS;
        case 'openclaw':
          return reportedModels[name] || [];
        default:
          return [];
      }
    },
    [reportedModels]
  );

  // Load saved preferences
  React.useEffect(() => {
    if (!sessionId) return;
    try {
      onlineAgents.forEach((a) => {
        const kind = getAgentKind(a.agentName, a.agentType);
        const saved = localStorage.getItem(`52hz_model_${sessionId}_${a.agentName}`);
        if (!saved) return;
        const known = modelsForAgent(a.agentName, kind);
        if (!known.some((m) => m.id === saved)) return;
        if (kind === 'antigravity') {
          setAntigravityModelId(saved);
        } else if (kind === 'claude') {
          setClaudeModelId(saved);
        } else if (kind === 'openclaw') {
          setOpenclawModelId(saved);
        }
      });
    } catch {}
  }, [sessionId, onlineAgents, modelsForAgent]);

  if (!activeAgent && !agentName) return null;

  const genericOption: AgentModelOption = {
    id: 'default',
    name: `${activeTargetName} (Default)`,
    shortName: activeTargetName,
  };

  // Compute current display model option
  const currentModelOption: AgentModelOption = (() => {
    switch (activeKind) {
      case 'antigravity':
        return ANTIGRAVITY_MODELS.find((m) => m.id === antigravityModelId) || ANTIGRAVITY_MODELS[2];
      case 'claude':
        return CLAUDE_MODELS.find((m) => m.id === claudeModelId) || CLAUDE_MODELS[0];
      case 'openclaw': {
        const known = modelsForAgent(activeTargetName, 'openclaw');
        return (
          known.find((m) => m.id === openclawModelId) ||
          known[0] ||
          genericOption
        );
      }
      default:
        return genericOption;
    }
  })();

  const handleSelectModel = async (
    targetAgentName: string,
    modelId: string,
    modelName: string,
    kind: AgentKind
  ) => {
    const previousId =
      kind === 'antigravity' ? antigravityModelId
      : kind === 'claude' ? claudeModelId
      : kind === 'openclaw' ? openclawModelId
      : null;

    // Optimistic, then reverted if the agent never confirms — a switch that
    // silently failed used to look identical to one that worked.
    if (kind === 'antigravity') {
      setAntigravityModelId(modelId);
    } else if (kind === 'claude') {
      setClaudeModelId(modelId);
    } else if (kind === 'openclaw') {
      setOpenclawModelId(modelId);
    }

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
      if (kind === 'antigravity') {
        setAntigravityModelId(previousId || antigravityModelId);
      } else if (kind === 'claude') {
        setClaudeModelId(previousId || claudeModelId);
      } else if (kind === 'openclaw') {
        setOpenclawModelId(previousId);
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
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border transition-all duration-200 cursor-pointer select-none',
            'bg-surface2/80 hover:bg-surface3/90 border-border/70 hover:border-border text-foreground shadow-2xs',
            className
          )}
          title={`当前模型: ${currentModelOption.name} (@${activeTargetName})`}
        >
          {/* No weight of its own — the chip is already `font-medium`, and the
              600 that used to sit here rendered at the chip's 11px, where the
              weight axis stops separating and only thickens. */}
          <span className="text-foreground truncate max-w-[140px]">
            {currentModelOption.shortName}
          </span>
          <ChevronDown className="size-3 text-foreground-extra-muted shrink-0" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-60 p-1.5 shadow-xl border-border/80 bg-surface1/95 backdrop-blur-xl max-h-[420px] overflow-y-auto">
        {onlineAgents.map((agentItem, idx) => {
          const kind = getAgentKind(agentItem.agentName, agentItem.agentType);
          const models = modelsForAgent(agentItem.agentName, kind);

          const currentSelectedId =
            kind === 'antigravity'
              ? antigravityModelId
              : kind === 'claude'
              ? claudeModelId
              : kind === 'openclaw'
              ? openclawModelId
              : null;

          return (
            <div key={agentItem.agentName} className={cn('space-y-0.5', idx > 0 && 'pt-2 border-t border-border/40 mt-1.5')}>
              <div className="px-2 py-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase flex items-center justify-between">
                <span>@{agentItem.agentName}</span>
                <span className="text-3xs font-normal text-muted-foreground/80 font-mono">
                  {agentItem.agentType || 'agent'}
                </span>
              </div>

              {models.length > 0 ? (
                models.map((m) => {
                  const isSelected =
                    currentSelectedId === m.id &&
                    activeTargetName.toLowerCase() === agentItem.agentName.toLowerCase();

                  return (
                    <DropdownMenuItem
                      key={m.id}
                      onClick={() => handleSelectModel(agentItem.agentName, m.id, m.name, kind)}
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
              ) : kind === 'openclaw' ? (
                <div className="px-2.5 py-1 text-xs text-muted-foreground italic leading-relaxed">
                  openclaw.json 中没有可选模型
                  <span className="block not-italic text-3xs text-muted-foreground/70">
                    在 models.providers 里配置后会自动出现
                  </span>
                </div>
              ) : (
                <div className="px-2.5 py-1 text-xs text-muted-foreground italic">
                  默认环境模型 (Default)
                </div>
              )}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
