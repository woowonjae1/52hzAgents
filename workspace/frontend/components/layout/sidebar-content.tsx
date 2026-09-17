'use client';

import { Hint } from '@/components/ui/hint';
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
  CheckCircle2,
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
  const { token, agents, todos } = useWorkspace();
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


  return (
    <div className="flex flex-col h-full min-h-0 bg-surface0">
      {/* Explorer List Area (Defaults to Threads/Chats) */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {viewMode === 'files' ? <FileList /> : viewMode === 'routines' ? <RoutineList /> : <ThreadList />}
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

        {/* Right group: Tasks, Agents, Token, Theme */}
        <div className="flex items-center gap-0.5">
          {/* Tasks & Issues */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setViewMode(viewMode === 'tasks' ? 'threads' : 'tasks')}
                aria-label="Tasks & Issues"
                className={cn(
                  'size-7 rounded-lg flex items-center justify-center transition-colors relative',
                  viewMode === 'tasks'
                    ? 'bg-surface2 text-foreground'
                    : 'text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60'
                )}
              >
                <CheckCircle2 className="size-3.5" />
                {todos && todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length > 0 && (
                  <span className="absolute 1 top-1 right-1 size-1.5 rounded-full bg-status-success" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Tasks & Issues</TooltipContent>
          </Tooltip>

          {/* Agents Dashboard */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setViewMode(viewMode === 'mission' ? 'threads' : 'mission')}
                aria-label="Agents Dashboard"
                className={cn(
                  'size-7 rounded-lg flex items-center justify-center transition-colors',
                  viewMode === 'mission'
                    ? 'bg-surface2 text-foreground'
                    : 'text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60'
                )}
              >
                <Users className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Agents Dashboard</TooltipContent>
          </Tooltip>

          {token && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyToken}
                  aria-label="Copy management token"
                  className="size-7 rounded-lg flex items-center justify-center text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60 transition-colors"
                >
                  {tokenCopied ? <Check className="size-3.5 text-status-success" /> : <KeyRound className="size-3.5" />}
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
                className="size-7 rounded-lg flex items-center justify-center text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60 transition-colors"
              >
                {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}