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

interface AgentModelSwitcherProps {
  agentName?: string;
  sessionId?: string | null;
  className?: string;
}

export function AgentModelSwitcher({
  agentName = 'claude',
  sessionId,
  className,
}: AgentModelSwitcherProps) {
  const { workspaceId, agents } = useWorkspace();

  // Find online agents that support model selection
  const onlineAgents = React.useMemo(() => {
    return agents.filter((a) => a.status === 'online');
  }, [agents]);

  const antigravityAgent = React.useMemo(() => {
    return onlineAgents.find(
      (a) => a.agentName.toLowerCase().includes('antigravity') || a.agentName.toLowerCase().includes('agy')
    );
  }, [onlineAgents]);

  const claudeAgent = React.useMemo(() => {
    return onlineAgents.find((a) => a.agentName.toLowerCase().includes('claude'));
  }, [onlineAgents]);

  // Current active agent to display on trigger
  const [activeTargetAgent, setActiveTargetAgent] = React.useState<string>(agentName);

  React.useEffect(() => {
    if (agentName) {
      setActiveTargetAgent(agentName);
    }
  }, [agentName]);

  const isAntigravity = React.useMemo(() => {
    const lower = (activeTargetAgent || '').toLowerCase();
    return lower.includes('antigravity') || lower.includes('agy');
  }, [activeTargetAgent]);

  // Model states per agent
  const [antigravityModelId, setAntigravityModelId] = React.useState<string>('gemini-3.5-flash');
  const [claudeModelId, setClaudeModelId] = React.useState<string>('sonnet');

  // Load saved preferences
  React.useEffect(() => {
    if (!sessionId) return;
    try {
      if (antigravityAgent) {
        const savedAgy = localStorage.getItem(`52hz_model_${sessionId}_${antigravityAgent.agentName}`);
        if (savedAgy && ANTIGRAVITY_MODELS.some((m) => m.id === savedAgy)) {
          setAntigravityModelId(savedAgy);
        }
      }
      if (claudeAgent) {
        const savedClaude = localStorage.getItem(`52hz_model_${sessionId}_${claudeAgent.agentName}`);
        if (savedClaude && CLAUDE_MODELS.some((m) => m.id === savedClaude)) {
          setClaudeModelId(savedClaude);
        }
      }
    } catch {}
  }, [sessionId, antigravityAgent, claudeAgent]);

  const hasAnyModelAgent = !!antigravityAgent || !!claudeAgent;
  if (!hasAnyModelAgent) return null;

  const currentModelOption = isAntigravity
    ? ANTIGRAVITY_MODELS.find((m) => m.id === antigravityModelId) || ANTIGRAVITY_MODELS[2]
    : CLAUDE_MODELS.find((m) => m.id === claudeModelId) || CLAUDE_MODELS[0];

  const handleSelectModel = async (targetAgentName: string, modelId: string, modelName: string, isAgy: boolean) => {
    if (isAgy) {
      setAntigravityModelId(modelId);
    } else {
      setClaudeModelId(modelId);
    }
    setActiveTargetAgent(targetAgentName);

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
      toast.success(`${targetAgentName} 已切换至 ${modelName}`);
    } catch {
      toast.success(`${targetAgentName} 已切换至 ${modelName}`);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-all duration-200 cursor-pointer select-none',
            'bg-surface2/80 hover:bg-surface3/90 border-border/70 hover:border-border text-foreground shadow-2xs',
            className
          )}
          title={`当前模型：${currentModelOption.name} · 点击切换`}
        >
          <span className="font-semibold text-foreground truncate">
            {currentModelOption.shortName}
          </span>
          <ChevronDown className="size-3 text-foreground-extra-muted shrink-0" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56 p-1.5 shadow-xl border-border/80 bg-surface1/95 backdrop-blur-xl max-h-[400px] overflow-y-auto">
        {antigravityAgent && (
          <div className="space-y-0.5">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              {antigravityAgent.agentName} 模型
            </div>
            {ANTIGRAVITY_MODELS.map((m) => {
              const isSelected = antigravityModelId === m.id && isAntigravity;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => handleSelectModel(antigravityAgent.agentName, m.id, m.name, true)}
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
            })}
          </div>
        )}

        {antigravityAgent && claudeAgent && (
          <div className="my-1.5 border-t border-border/40" />
        )}

        {claudeAgent && (
          <div className="space-y-0.5">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              {claudeAgent.agentName} 模型
            </div>
            {CLAUDE_MODELS.map((m) => {
              const isSelected = claudeModelId === m.id && !isAntigravity;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => handleSelectModel(claudeAgent.agentName, m.id, m.name, false)}
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
            })}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
