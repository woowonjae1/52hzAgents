'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Plus, MessageSquare, FileText, Globe, PlusSquare, Sparkles, BookOpen,
  Settings, Copy, Check, ListTodo, CalendarClock, Timer, Inbox,
  LogIn, LogOut, Shield, Moon, Sun, KeyRound, X, Crown, Users, Radar,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useLayout, type ViewMode } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { isRecentAgent, timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { Switch } from '@/components/ui/switch';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toast } from 'sonner';
import type { WorkspaceCollaborator } from '@/lib/types';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import { ThreadList } from '@/components/threads/thread-list';
import { FileList } from '@/components/files/file-list';
import { TasksView } from '@/components/tasks/tasks-view';
import { KnowledgeView } from '@/components/knowledge/knowledge-view';
import { RoutineList } from '@/components/routines/routine-list';
import { SkillsView } from '@/components/skills/skills-view';

// ── Navigation button helper ──

function NavButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-xs transition-all duration-150 cursor-pointer select-none',
        active
          ? 'bg-surface2 text-foreground font-medium border border-border/50 shadow-xs'
          : 'hover:bg-surface-sidebar-hover text-muted-foreground hover:text-foreground font-normal'
      )}
    >
      <span className={cn('size-4 flex items-center justify-center shrink-0 transition-opacity', active ? 'opacity-100 text-foreground' : 'opacity-60')}>{icon}</span>
      <span className="flex-1 text-left truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-surface3/80 text-muted-foreground border border-border/40 shrink-0">
          {count}
        </span>
      )}
    </button>
  );
}

// ── Main SidebarContent ──

export function SidebarContent() {
  const { viewMode, setViewMode } = useLayout();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { user, isOpenAgentsDomain, signIn, signOut } = useOpenAgentsAuth();
  const { token, refreshWorkspace, workspace } = useWorkspace();
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // `resolvedTheme`, not `theme` — `theme` can be the literal string 'system',
  // which would read as "not dark" and make the first toggle click a no-op.
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
        {(viewMode === 'threads' || viewMode === 'mission' || viewMode === 'connect' || viewMode === 'skills' || viewMode === 'knowledge' || viewMode === 'settings') && <ThreadList />}
        {viewMode === 'files' && <FileList />}
        {viewMode === 'tasks' && <TasksView />}
        {viewMode === 'routines' && <RoutineList />}
      </div>

      {/* Bottom control row with Agents, Chats, Knowledge Base, Theme & Settings */}
      <div className="shrink-0 border-t border-border/40 dark:border-border/40 px-3.5 py-2.5 space-y-2 bg-surface1/80 backdrop-blur-md">
        {isOpenAgentsDomain && user && (
          <div className="flex items-center gap-2">
            <div className="size-6 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-semibold shrink-0">
              {user.email[0].toUpperCase()}
            </div>
            <span className="text-[12px] text-muted-foreground truncate flex-1">{user.email}</span>
            <button onClick={signOut} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Sign out">
              <LogOut className="size-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          {/* Bottom Left: Settings Button (Direct Page Navigation) */}
          <button
            onClick={() => setViewMode(viewMode === 'settings' ? 'threads' : 'settings')}
            className={cn(
              "flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer",
              viewMode === 'settings'
                ? "bg-primary/15 text-primary font-semibold"
                : "text-foreground hover:bg-surface2"
            )}
            title="Settings"
          >
            <Settings className={cn("size-4", viewMode === 'settings' ? "text-primary" : "text-foreground-muted")} />
            <span>Settings</span>
          </button>

          <div className="flex items-center gap-1">
            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="size-8 flex items-center justify-center rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
              title={isDark ? 'Light Mode' : 'Dark Mode'}
            >
              {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>

            {/* Management Token Copy */}
            {token && (
              <button
                onClick={handleCopyToken}
                className="size-8 flex items-center justify-center rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
                title="Copy Management Token"
              >
                {tokenCopied ? <Check className="size-4 text-emerald-500" /> : <KeyRound className="size-4" />}
              </button>
            )}
            {isOpenAgentsDomain && !user && (
              <button
                onClick={signIn}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
              >
                <LogIn className="size-3.5" />
                <span>Sign in</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all cursor-pointer whitespace-nowrap outline-none border border-transparent',
        active
          ? 'bg-primary text-primary-foreground shadow-xs border-border/20 dark:border-border/20'
          : 'text-foreground-muted hover:text-foreground dark:text-foreground-extra-muted dark:hover:text-foreground-extra-muted hover:bg-surface2/50'
      )}
    >
      {label}
    </button>
  );
}


// ── Controlled Settings Dialog ──

function SettingsDialogPortal({ open, onOpenChange, workspace, refreshWorkspace }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: ReturnType<typeof useWorkspace>['workspace'];
  refreshWorkspace: () => Promise<void>;
}) {
  const [name, setName] = useState(workspace?.name || '');
  const [monitorMode, setMonitorMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const { isCopied: urlCopied, copyToClipboard: copyUrl } = useCopyToClipboard();
  const { isCopied: tokenCopied, copyToClipboard: copyToken } = useCopyToClipboard();
  const { notificationSound, setNotificationSound } = useWorkspace();
  const { splitBrowser, setSplitBrowser } = useLayout();
  const [collabEmail, setCollabEmail] = useState('');
  const [collabAdding, setCollabAdding] = useState(false);
  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [collabOwner, setCollabOwner] = useState<string | null>(null);
  const [bfApiKey, setBfApiKey] = useState('');

  useEffect(() => {
    if (open && workspace) {
      setName(workspace.name);
      setMonitorMode(!!(workspace.settings?.monitorMode));
      setBfApiKey('');
      workspaceApi.listCollaborators().then((d) => {
        setCollaborators(d.collaborators);
        setCollabOwner(d.owner);
      }).catch(() => {});
    }
  }, [open, workspace]);

  const workspaceSlug = workspace?.slug || 'workspace';
  const workspaceUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/${workspaceSlug}${window.location.search}`
    : '';

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const wsUpdates: Record<string, unknown> = { name: name.trim(), settings: { ...(workspace?.settings || {}), monitorMode } };
      if (bfApiKey.trim()) wsUpdates.browserfabric_api_key = bfApiKey.trim();
      await workspaceApi.updateWorkspace(wsUpdates);
      await refreshWorkspace();
      toast.success('Settings saved');
      onOpenChange(false);
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };
}