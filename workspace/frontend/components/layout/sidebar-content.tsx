'use client';

import { useState, useEffect } from 'react';
import { Settings } from 'lucide-react';
import { useTheme } from 'next-themes';
import { ThemeToggle } from '@/components/motion/theme-toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLayout } from './layout-context';
import { cn } from '@/lib/utils';
import { ThreadSidebar } from '@/components/threads/thread-sidebar';

export function SidebarContent() {
  const { viewMode, openSettings } = useLayout();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface0">
      {/* Explorer List Area (Defaults to Threads/Chats) */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <ThreadSidebar />
      </div>

      {/* Bottom Horizontal Actions Bar (Settings on left, Theme on right) */}
      <div
        className="shrink-0 px-2.5 py-1.5 bg-transparent flex items-center justify-between gap-1 select-none border-t border-border"
      >
        {/* Left: Settings button */}
        <button
          type="button"
          onClick={() => openSettings('general')}
          className={cn(
            'flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors',
            viewMode === 'settings'
              ? 'bg-surface2 text-foreground font-semibold'
              : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
          )}
        >
          <Settings className="size-3.5 text-foreground-muted" />
          <span>Settings</span>
        </button>

        {/* Right group: theme */}
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <ThemeToggle
                variant="circle-blur"
                start="bottom-right"
                className="size-7 rounded-lg text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60 transition-colors"
                iconClassName="size-3.5"
              />
            </TooltipTrigger>
            <TooltipContent side="top">{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
