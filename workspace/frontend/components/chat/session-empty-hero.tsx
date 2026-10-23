'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonTitle,
  DescriptiveButtonDescription,
} from '@/components/ui/descriptive-button';
import { Zap, Search, Terminal, Layers, type LucideIcon } from 'lucide-react';

export interface EmptyHeroSuggestion {
  icon: LucideIcon;
  title: string;
  description: string;
  prompt: string;
}

export const HERO_SUGGESTIONS: EmptyHeroSuggestion[] = [
  {
    icon: Zap,
    title: 'Refactor & review',
    description: 'Review the code in this workspace, flag risks, and suggest refactors.',
    prompt:
      'Review the core architecture and implementation of this workspace. Point out logic or performance risks and suggest concrete improvements.',
  },
  {
    icon: Search,
    title: 'Research & compare',
    description: 'Search the web for approaches and write an objective comparison.',
    prompt:
      'Research current approaches and best practices for local multi-agent orchestration, then compare their trade-offs.',
  },
  {
    icon: Terminal,
    title: 'Diagnose environment',
    description: 'Check installed runtimes, tools, background daemons, and ports.',
    prompt:
      'Diagnose the local environment: check Node, Python, and Go runtimes, running background tasks, and active ports.',
  },
  {
    icon: Layers,
    title: 'Design architecture',
    description: 'Draft an architectural plan for modular boundaries and file layout.',
    prompt:
      'Draft an architectural plan for this workspace, proposing clear module boundaries, data flow, and a scalable file layout.',
  },
];

interface SessionEmptyHeroProps {
  hasOnlineAgents: boolean;
  onlineAgentCount: number;
  onConnectAgent?: () => void;
  onSelectPrompt: (prompt: string) => void;
  children?: React.ReactNode;
}

/**
 * OpenWork / Claude Desktop-style Session Empty Hero:
 * Positions the actual Prompt Composer front and center, with clean
 * greeting above and 2x2 descriptive suggestion cards below.
 */
export function SessionEmptyHero({
  hasOnlineAgents,
  onlineAgentCount,
  onConnectAgent,
  onSelectPrompt,
  children,
}: SessionEmptyHeroProps) {
  const greeting = React.useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  return (
    <div
      data-chat-empty-hero
      className="mx-auto flex w-full max-w-(--chat-column) flex-col items-center justify-center gap-6 px-4 py-8 sm:px-6 my-auto select-none overflow-y-auto"
    >
      {/* Top Header */}
      <div className="flex flex-col items-center text-center space-y-3">
        {/* Subtle status pill */}
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
          {!hasOnlineAgents && onConnectAgent && (
            <button
              type="button"
              onClick={onConnectAgent}
              className="text-foreground-extra-muted hover:text-foreground transition-colors ml-0.5 underline underline-offset-2 cursor-pointer"
            >
              Connect agent
            </button>
          )}
        </div>

        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
          {greeting}, what can I help you build?
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground max-w-md">
          Collaborate with your local agent team. Select a task below or write instructions.
        </p>
      </div>

      {/* The Centered Composer Dock (OpenWork style) */}
      {children && (
        <div data-empty-composer-dock className="w-full">
          {children}
        </div>
      )}

      {/* 2x2 Suggestion Cards Grid (OpenWork style) */}
      <div data-empty-suggestions className="grid w-full gap-2.5 sm:grid-cols-2">
        {HERO_SUGGESTIONS.map((item) => (
          <DescriptiveButton
            key={item.title}
            onClick={() => onSelectPrompt(item.prompt)}
            className="hover:border-primary/40 group/btn"
          >
            <DescriptiveButtonContent>
              <div className="flex items-center gap-2">
                <item.icon className="size-3.5 text-primary shrink-0 opacity-80 group-hover/btn:opacity-100 transition-opacity" />
                <DescriptiveButtonTitle>{item.title}</DescriptiveButtonTitle>
              </div>
              <DescriptiveButtonDescription className="line-clamp-2">
                {item.description}
              </DescriptiveButtonDescription>
            </DescriptiveButtonContent>
          </DescriptiveButton>
        ))}
      </div>
    </div>
  );
}
