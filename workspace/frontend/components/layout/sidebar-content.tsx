'use client';

import { Hint } from '@/components/ui/hint';
import { useState, useEffect } from 'react';
import {
  Settings,
  LogOut,
  LogIn,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { ThemeToggle } from '@/components/motion/theme-toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLayout } from './layout-context';
import { cn } from '@/lib/utils';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import { ThreadSidebar } from '@/components/threads/thread-sidebar';

export function SidebarContent() {
  const { viewMode, openSettings } = useLayout();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { user, isOpenAgentsDomain, signIn, signOut } = useOpenAgentsAuth();

  useEffect(() => { setMounted(true); }, []);

  const isDark = mounted && resolvedTheme === 'dark';


  return (
    <div className="flex flex-col h-full min-h-0 bg-surface0">
      {/* Explorer List Area (Defaults to Threads/Chats) */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <ThreadSidebar />
      </div>

      {/* Account row if on openagents domain */}
      {isOpenAgentsDomain && user && (
        <div className="shrink-0 px-3.5 py-1.5 bg-surface1/60 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <div className="size-5 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-3xs font-medium shrink-0">
              {user.email[0].toUpperCase()}
            </div>
            <span className="text-2xs text-muted-foreground truncate flex-1">{user.email}</span>
            <Hint label="Sign out">
            <button onClick={signOut} className="text-muted-foreground hover:text-foreground transition-colors">
                <LogOut className="size-3" />
              </button>
            </Hint>
          </div>
        </div>
      )}

      {isOpenAgentsDomain && !user && (
        <div className="shrink-0 px-3.5 py-1.5 bg-surface1/60 backdrop-blur-md">
          <button
            onClick={signIn}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <LogIn className="size-3" />
            <span>Sign in</span>
          </button>
        </div>
      )}

      {/* Bottom Horizontal Actions Bar (Settings on left like Figure 2, Tasks/Agents/Theme on right) */}
      <div // `--border` at full strength. This was `/40`, the only hairline
        // in the shell drawn at a fraction of the token — so the one rule the
        // eye meets at the bottom-left of the window was fainter than every
        // other internal rule for no reason anyone recorded.
        className="shrink-0 px-2.5 py-1.5 bg-transparent flex items-center justify-between gap-1 select-none border-t border-border">
        {/* Left: Settings button (Figure 2 reference) */}
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