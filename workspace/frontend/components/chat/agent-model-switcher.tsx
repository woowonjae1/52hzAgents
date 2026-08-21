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

export const OPENCLAW_MODELS: AgentModelOption[] = [
  {
    id: 'gpt-4o',
    name: 'OpenAI GPT-4o',
    shortName: 'GPT-4o',
  },
  {
    id: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    shortName: 'Sonnet 3.7',
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    shortName: 'Sonnet 3.5',
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3 (Chat)',
    shortName: 'DeepSeek V3',
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1 (Reasoner)',
    shortName: 'DeepSeek R1',
  },
  {
    id: 'qwen-2.5-coder-32b',
    name: 'Qwen 2.5 Coder 32B',
    shortName: 'Qwen 2.5 Coder',
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    shortName: 'Gemini 2.0 Flash',
  },
];

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
  const [openclawModelId, setOpenclawModelId] = React.useState<string>('gpt-4o');

  // Load saved preferences
  React.useEffect(() => {
    if (!sessionId) return;
    try {
      onlineAgents.forEach((a) => {
        const kind = getAgentKind(a.agentName, a.agentType);
        const saved = localStorage.getItem(`52hz_model_${sessionId}_${a.agentName}`);
        if (saved) {
          if (kind === 'antigravity' && ANTIGRAVITY_MODELS.some((m) => m.id === saved)) {
            setAntigravityModelId(saved);
          } else if (kind === 'claude' && CLAUDE_MODELS.some((m) => m.id === saved)) {
            setClaudeModelId(saved);
          } else if (kind === 'openclaw' && OPENCLAW_MODELS.some((m) => m.id === saved)) {
            setOpenclawModelId(saved);
          }
        }
      });
    } catch {}
  }, [sessionId, onlineAgents]);

  if (!activeAgent && !agentName) return null;

  // Compute current display model option
  const currentModelOption: AgentModelOption = (() => {
    switch (activeKind) {
      case 'antigravity':
        return ANTIGRAVITY_MODELS.find((m) => m.id === antigravityModelId) || ANTIGRAVITY_MODELS[2];
      case 'claude':
        return CLAUDE_MODELS.find((m) => m.id === claudeModelId) || CLAUDE_MODELS[0];
      case 'openclaw':
        return OPENCLAW_MODELS.find((m) => m.id === openclawModelId) || OPENCLAW_MODELS[0];
      default:
        return {
          id: 'default',
          name: `${activeTargetName} (Default)`,
          shortName: activeTargetName,
        };
    }
  })();

  const handleSelectModel = async (
    targetAgentName: string,
    modelId: string,
    modelName: string,
    kind: AgentKind
  ) => {
    if (kind === 'antigravity') {
      setAntigravityModelId(modelId);
    } else if (kind === 'claude') {
      setClaudeModelId(modelId);
    } else if (kind === 'openclaw') {
      setOpenclawModelId(modelId);
    }

    if (sessionId) {
      try {
        localStorage.setItem(`52hz_model_${sessionId}_${targetAgentName}`, modelId);
      } catch {}
    }

    try {
      if (workspaceId) {
        workspaceApi.setWorkspaceId(workspaceId);
      }
      await workspaceApi.sendAgentControl(targetAgentName, 'set_model', {
        model: modelId,
        channel: sessionId || undefined,
      });
      toast.success(`${targetAgentName} 已切换为 ${modelName}`);
    } catch {
      toast.success(`${targetAgentName} 已切换为 ${modelName}`);
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
          const models =
            kind === 'antigravity'
              ? ANTIGRAVITY_MODELS
              : kind === 'claude'
              ? CLAUDE_MODELS
              : kind === 'openclaw'
              ? OPENCLAW_MODELS
              : [];

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
                      {isSelected && <Check className="size-3.5 text-primary shrink-0 ml-2" />}
                    </DropdownMenuItem>
                  );
                })
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
