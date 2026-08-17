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

export interface ClaudeModelOption {
  id: string;
  name: string;
  shortName: string;
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
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
    name: 'Claude 4.5 Haiku',
    shortName: 'Haiku 4.5',
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
  const [selectedModelId, setSelectedModelId] = React.useState<string>('sonnet');

  // Check if Claude is connected / online
  const isClaudeConnected = React.useMemo(() => {
    if (!agentName) return false;
    const isClaudeName = agentName.toLowerCase().includes('claude');
    const hasOnlineClaude = agents.some(
      (a) => a.agentName.toLowerCase().includes('claude') && a.status === 'online'
    );
    return isClaudeName && hasOnlineClaude;
  }, [agentName, agents]);

  // Load saved preference
  React.useEffect(() => {
    if (!sessionId) return;
    try {
      const saved = localStorage.getItem(`52hz_model_${sessionId}_${agentName}`);
      if (saved && CLAUDE_MODELS.some((m) => m.id === saved)) {
        setSelectedModelId(saved);
      }
    } catch {}
  }, [sessionId, agentName]);

  if (!isClaudeConnected) return null;

  const currentModel = CLAUDE_MODELS.find((m) => m.id === selectedModelId) || CLAUDE_MODELS[0];

  const handleSelectModelId = async (modelId: string, modelName: string) => {
    setSelectedModelId(modelId);
    if (sessionId) {
      try {
        localStorage.setItem(`52hz_model_${sessionId}_${agentName}`, modelId);
      } catch {}
    }

    try {
      if (workspaceId) {
        workspaceApi.setWorkspaceId(workspaceId);
      }
      await workspaceApi.sendAgentControl(agentName, 'set_model', {
        model: modelId,
        channel: sessionId || undefined,
      });
      toast.success(`已切换至 ${modelName}`);
    } catch {
      toast.success(`已切换至 ${modelName}`);
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
          title={`当前模型：${currentModel.name} · 点击切换`}
        >
          <span className="font-semibold text-foreground truncate">
            {currentModel.shortName}
          </span>
          <ChevronDown className="size-3 text-foreground-extra-muted shrink-0" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-44 p-1 shadow-lg border-border/80 bg-surface1/95 backdrop-blur-xl">
        {CLAUDE_MODELS.map((m) => {
          const isSelected = m.id === currentModel.id;
          return (
            <DropdownMenuItem
              key={m.id}
              onClick={() => handleSelectModelId(m.id, m.name)}
              className={cn(
                'flex items-center justify-between px-2.5 py-1.5 rounded-md cursor-pointer text-xs font-medium transition-colors',
                isSelected
                  ? 'bg-surface3 text-foreground font-semibold'
                  : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
              )}
            >
              <span>{m.name}</span>
              {isSelected && <Check className="size-3.5 text-primary shrink-0 ml-2" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
