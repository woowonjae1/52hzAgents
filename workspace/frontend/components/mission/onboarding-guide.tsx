'use client';

import * as React from 'react';
import { Sparkles, ArrowRight, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_AGENT_CATALOG } from '@/lib/agent-catalog';

interface OnboardingGuideProps {
  onQuickConnect: (agentName: string) => void;
  className?: string;
}

export function OnboardingGuide({ onQuickConnect, className }: OnboardingGuideProps) {
  return (
    <div
      className={cn(
        'rounded-3xl border border-primary/20 bg-surface1/95 p-6 space-y-5 shadow-xs',
        className
      )}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </span>
          <h2 className="text-base font-bold text-foreground tracking-tight">
            添加你的第一个智能体
          </h2>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
          选择内置智能体模板或配置自定义 ACP / MCP 适配器，开启多智能体协同：
        </p>
      </div>

      {/* Preset Agent Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {DEFAULT_AGENT_CATALOG.slice(0, 6).map((cat) => (
          <button
            key={cat.name}
            type="button"
            onClick={() => onQuickConnect(cat.name)}
            className="flex items-center justify-between p-3.5 rounded-2xl bg-surface2/60 hover:bg-surface3 border border-border/50 text-left transition-all cursor-pointer shadow-2xs group hover:border-primary/40"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="size-8 rounded-xl bg-surface1 flex items-center justify-center text-primary shrink-0 group-hover:scale-105 transition-transform">
                <Plug className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="font-semibold text-xs text-foreground group-hover:text-primary transition-colors truncate">
                  {cat.name}
                </div>
                <div className="text-[10.5px] text-muted-foreground line-clamp-1 truncate mt-0.5">
                  {cat.description || '智能体集成适配器'}
                </div>
              </div>
            </div>
            <ArrowRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
          </button>
        ))}
      </div>
    </div>
  );
}
