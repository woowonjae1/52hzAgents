'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { SignalMark } from '@/components/brand/signal-mark';
import { Zap, Search, Terminal, Layers, type LucideIcon } from 'lucide-react';

export interface PromptSuggestion {
  icon: LucideIcon;
  title: string;
  desc: string;
  prompt: string;
}

export const PROMPT_SUGGESTIONS: PromptSuggestion[] = [
  {
    icon: Zap,
    title: 'Refactor & review',
    desc: 'Review the code in this workspace, flag risks, suggest refactors',
    prompt:
      'Review the core architecture and implementation of this workspace. Point out logic or performance risks and suggest concrete improvements.',
  },
  {
    icon: Search,
    title: 'Research & compare',
    desc: 'Search the web for approaches and write a comparison',
    prompt:
      'Research current approaches and best practices for local multi-agent orchestration, then compare their trade-offs.',
  },
  {
    icon: Terminal,
    title: 'Diagnose environment',
    desc: 'Check installed runtimes, tools, and local servers',
    prompt:
      'Diagnose the local environment: check Node, Python, and Go runtimes, running background tasks, and active ports.',
  },
  {
    icon: Layers,
    title: 'Design architecture',
    desc: 'Propose module boundaries, data flow, and file layout',
    prompt:
      'Draft an architectural plan for this workspace, proposing clear module boundaries, data flow, and a scalable file layout.',
  },
];

interface ChatWelcomeScreenProps {
  hasOnlineAgents: boolean;
  onlineAgentCount: number;
  onConnectAgent: () => void;
  onSelectPrompt: (prompt: string) => void;
}

export function ChatWelcomeScreen({
  hasOnlineAgents,
  onlineAgentCount,
  onConnectAgent,
  onSelectPrompt,
}: ChatWelcomeScreenProps) {
  const greeting = React.useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  return (
    <div className="relative flex-1 flex flex-col items-center justify-center p-6 select-none overflow-y-auto">
      <div className="relative z-10 w-full max-w-2xl flex flex-col items-center text-center space-y-6 my-auto py-6">
        {/* Refined subtle status pill */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border/70 dark:border-white/[0.08] bg-surface1/80 dark:bg-white/[0.03] text-2xs font-medium text-muted-foreground shadow-xs">
          <span
            className={cn(
              'size-1.5 rounded-full shrink-0',
              hasOnlineAgents ? 'bg-emerald-500' : 'bg-muted-foreground/40'
            )}
          />
          <span>
            {hasOnlineAgents
              ? `${onlineAgentCount} ${onlineAgentCount === 1 ? 'agent' : 'agents'} online`
              : 'Autonomous Workspace Ready'}
          </span>
          {!hasOnlineAgents && (
            <button
              type="button"
              onClick={onConnectAgent}
              className="text-foreground-extra-muted hover:text-foreground transition-colors ml-0.5 underline underline-offset-2"
            >
              Connect agent
            </button>
          )}
        </div>

        {/* Brand SignalMark with subtle ambient scale */}
        <div className="relative flex items-center justify-center">
          <SignalMark size={72} />
        </div>

        {/* Dynamic OpenAI/Claude Greeting Header */}
        <div className="space-y-1.5 max-w-lg">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
            {greeting}, what can I help you build?
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Select a prompt below, or start typing to collaborate with your agents.
          </p>
        </div>

        {/* Compact Prompt Inspiration Pills */}
        <div className="flex flex-wrap items-center justify-center gap-2 max-w-xl pt-1">
          {PROMPT_SUGGESTIONS.map((item, idx) => {
            const SuggestionIcon = item.icon;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => onSelectPrompt(item.prompt)}
                className={cn(
                  'inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-left cursor-pointer select-none',
                  'bg-surface1/80 hover:bg-surface2 border border-border/70 hover:border-border-accent',
                  'transition-all duration-150 active:scale-[0.98]'
                )}
              >
                <SuggestionIcon className="size-3.5 text-foreground-muted shrink-0" />
                <span className="text-xs font-medium text-foreground">{item.title}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
