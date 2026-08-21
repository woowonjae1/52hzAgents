'use client';

import { useState, useEffect } from 'react';
import {
  Users,
  Settings,
  Moon,
  Sun,
  KeyRound,
  Check,
  LogOut,
  LogIn,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import { ThreadList } from '@/components/threads/thread-list';
import { FileList } from '@/components/files/file-list';
import { TasksView } from '@/components/tasks/tasks-view';
import { RoutineList } from '@/components/routines/routine-list';

export function SidebarContent() {
  const { viewMode, setViewMode, openSettings } = useLayout();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { user, isOpenAgentsDomain, signIn, signOut } = useOpenAgentsAuth();
  const { token, agents } = useWorkspace();
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const isDark = mounted && resolvedTheme === 'dark';
  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  const handleCopyToken = () => {
    if (!token) {
      toast.error('No management token available');
      return;
    }
    navigator.clipboard.writeText(token);
    setTokenCopied(true);
    toast.success('Management token copied');
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const activeAgentsCount = agents.length;

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface0">
      {/* Explorer List Area (Defaults to Threads/Chats) */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {(viewMode === 'threads' || viewMode === 'mission' || viewMode === 'connect' || viewMode === 'settings') && <ThreadList />}
        {viewMode === 'files' && <FileList />}
        {viewMode === 'tasks' && <TasksView />}
        {viewMode === 'routines' && <RoutineList />}
      </div>

      {/* Account row if on openagents domain */}
      {isOpenAgentsDomain && user && (
        <div className="shrink-0 px-3.5 py-1.5 bg-surface1/60 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <div className="size-5 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-3xs font-medium shrink-0">
              {user.email[0].toUpperCase()}
            </div>
            <span className="text-2xs text-muted-foreground truncate flex-1">{user.email}</span>
            <button onClick={signOut} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Sign out">
              <LogOut className="size-3" />
            </button>
          </div>
        </div>
      )}

      {isOpenAgentsDomain && !user && (
        <div className="shrink-0 px-3.5 py-1.5 bg-surface1/60 backdrop-blur-md">
          <button
            onClick={signIn}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <LogIn className="size-3" />
            <span>Sign in</span>
          </button>
        </div>
      )}

      {/* Bottom Horizontal Actions Bar (Agents, Settings, Theme Toggle) - Seamless, no border divider */}
      <div className="shrink-0 px-3 py-2 bg-transparent flex items-center justify-between gap-1.5 select-none">
        {/* Left: Agents button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'mission' ? 'threads' : 'mission')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                viewMode === 'mission'
                  ? 'bg-surface2 text-foreground font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
              )}
            >
              <Users className="size-3.5 text-primary" />
              <span>Agents</span>
              {activeAgentsCount > 0 && (
                <span className="text-3xs font-mono px-1.5 py-0.2 rounded-full bg-primary/10 text-primary shrink-0">
                  {activeAgentsCount}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Agent Management & Mission Control</TooltipContent>
        </Tooltip>

        {/* Right group: Token (if any), Theme Switcher, Settings */}
        <div className="flex items-center gap-1">
          {token && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyToken}
                  aria-label="Copy management token"
                  className="size-7 rounded-lg flex items-center justify-center text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60 transition-colors cursor-pointer"
                >
                  {tokenCopied ? <Check className="size-3.5 text-emerald-500" /> : <KeyRound className="size-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Copy management token</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={isDark ? 'Light mode' : 'Dark mode'}
                className="size-7 rounded-lg flex items-center justify-center text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60 transition-colors cursor-pointer"
              >
                {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => openSettings('general')}
                aria-label="Settings"
                className={cn(
                  'size-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer',
                  viewMode === 'settings'
                    ? 'bg-surface2 text-foreground'
                    : 'text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60'
                )}
              >
                <Settings className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}