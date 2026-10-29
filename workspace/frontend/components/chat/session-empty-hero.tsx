'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonTitle,
  DescriptiveButtonDescription,
} from '@/components/ui/descriptive-button';
import { FileDiff, Search, Terminal, Layers, type LucideIcon } from 'lucide-react';

export interface EmptyHeroSuggestion {
  icon: LucideIcon;
  title: string;
  description: string;
  prompt: string;
}

export const HERO_SUGGESTIONS: EmptyHeroSuggestion[] = [
  {
    icon: FileDiff,
    title: 'Refactor & review',
    description: 'Discuss a code snippet or diff and identify possible regressions.',
    prompt:
      'Review the core architecture and code changes in this workspace. Inspect logic, types, and potential regressions, and provide proofreading recommendations.',
  },
  {
    icon: Terminal,
    title: 'Plan tests & checks',
    description: 'Identify edge cases, useful checks, and commands to run.',
    prompt:
      'Help me plan the tests and diagnostics for this project. Explain the edge cases and suggest commands I can run.',
  },
  {
    icon: Layers,
    title: 'Architecture & refactor',
    description: 'Draft modular boundaries, clean up dead code, and decouple modules.',
    prompt:
      'Draft an architectural plan for this workspace, proposing clear module boundaries, data flow, and a scalable file layout.',
  },
  {
    icon: Search,
    title: 'Research & compare',
    description: 'Compare approaches and trade-offs using the context you provide.',
    prompt:
      'Research current approaches and best practices for local multi-agent orchestration, then compare their trade-offs.',
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
        {/* Subtle status pill with quick link to agent team */}
        <button
          type="button"
          onClick={onConnectAgent}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border/70 dark:border-white/[0.08] bg-surface1/80 dark:bg-white/[0.03] hover:bg-surface2 text-2xs font-medium text-muted-foreground hover:text-foreground shadow-xs transition-all cursor-pointer select-none active:scale-95"
          title="Click to view and configure agent team"
        >
          <span
            className={cn(
              'size-1.5 rounded-full shrink-0',
              hasOnlineAgents ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/40'
            )}
          />
          <span>
            {hasOnlineAgents
              ? `${onlineAgentCount} endpoints configured`
              : 'Connect an agent'}
          </span>
          <span className="text-foreground-extra-muted">/</span>
          <span className="text-foreground-muted">Workspace</span>
        </button>

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
