'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Plus, MessageSquare, FileText, Globe, PlusSquare, Sparkles, BookOpen,
  Settings, Copy, Check, ListTodo, CalendarClock, Timer, Inbox,
  LogIn, LogOut, Shield, Moon, Sun, KeyRound, X, Crown, Users, Radar,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
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
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { user, isOpenAgentsDomain, signIn, signOut } = useOpenAgentsAuth();
  const { token, refreshWorkspace, workspace } = useWorkspace();
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const isDark = mounted && theme === 'dark';
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
      {/* Category Switcher Row */}
      <div className="px-3 py-2.5 border-b border-border/40 dark:border-border/40 flex items-center gap-1.5 overflow-x-auto shrink-0 scrollbar-none bg-surface1/50">
        <CategoryTab active={viewMode === 'mission' || viewMode === 'connect'} label="Agents" onClick={() => setViewMode('mission')} />
        <CategoryTab active={viewMode === 'threads'} label="Chats" onClick={() => setViewMode('threads')} />
        <CategoryTab active={viewMode === 'files'} label="Files" onClick={() => setViewMode('files')} />
        <CategoryTab active={viewMode === 'tasks'} label="Tasks" onClick={() => setViewMode('tasks')} />
        <CategoryTab active={viewMode === 'knowledge'} label="Docs" onClick={() => setViewMode('knowledge')} />
      </div>

      {/* Explorer List Area */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {viewMode === 'threads' && <ThreadList />}
        {viewMode === 'files' && <FileList />}
        {viewMode === 'tasks' && <TasksView />}
        {viewMode === 'knowledge' && <KnowledgeView sidebarOnly />}
        {viewMode === 'routines' && <RoutineList />}
        {viewMode === 'skills' && <SkillsView />}
      </div>

      {/* Bottom control row */}
      <div className="shrink-0 border-t border-border/40 dark:border-border/40 px-3.5 py-3 space-y-2.5 bg-surface1/80 backdrop-blur-md">
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

        {/* Paseo theme picker — light plus the five dark tints. Its own row so it
            doesn't compete with the icon buttons for width; move it into the
            settings dialog if the footer gets busier. */}
        <ThemeSwitcher className="mb-2" />

        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="size-8 flex items-center justify-center rounded-lg text-foreground-muted hover:text-foreground dark:text-foreground-extra-muted dark:hover:text-foreground-extra-muted hover:bg-surface2 transition-colors cursor-pointer"
            title={isDark ? 'Light Mode' : 'Dark Mode'}
          >
            {isDark ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
          </button>
          {token && (
            <button
              onClick={handleCopyToken}
              className="size-8 flex items-center justify-center rounded-lg text-foreground-muted hover:text-foreground dark:text-foreground-extra-muted dark:hover:text-foreground-extra-muted hover:bg-surface2 transition-colors cursor-pointer"
              title={tokenCopied ? 'Copied!' : 'Copy workspace token'}
            >
              {tokenCopied ? <Check className="size-4.5" /> : <KeyRound className="size-4.5" />}
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="size-8 flex items-center justify-center rounded-lg text-foreground-muted hover:text-foreground dark:text-foreground-extra-muted dark:hover:text-foreground-extra-muted hover:bg-surface2 transition-colors cursor-pointer"
            title="Settings"
          >
            <Settings className="size-4.5" />
          </button>

          <div className="flex-grow" />

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

      <SettingsDialogPortal open={settingsOpen} onOpenChange={setSettingsOpen} workspace={workspace} refreshWorkspace={refreshWorkspace} />
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Workspace Settings</DialogTitle></DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label>Workspace Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Workspace" />
          </div>
          <div className="space-y-2">
            <Label variant="secondary">Workspace URL</Label>
            <div className="flex items-center gap-2">
              <Input value={workspaceUrl} readOnly className="text-xs font-mono" />
              <Button variant="outline" size="icon" onClick={() => copyUrl(workspaceUrl)}>
                {urlCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label variant="secondary">Workspace ID</Label>
            <div className="flex items-center gap-2">
              <Input value={workspaceSlug} readOnly className="text-xs font-mono" />
              <Button variant="outline" size="icon" onClick={() => copyToken(workspaceSlug)}>
                {tokenCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>

          {/* Experimental */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label>Monitor Mode</Label>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface3 text-foreground font-medium">
                  Experimental
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Show a 2x3 grid overview of recent threads instead of the thread list.
              </p>
            </div>
            <Switch checked={monitorMode} onCheckedChange={setMonitorMode} size="sm" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <Label>Notification Sound</Label>
              <p className="text-xs text-muted-foreground">
                Play a sound when an agent completes a task.
              </p>
            </div>
            <Switch checked={notificationSound} onCheckedChange={setNotificationSound} size="sm" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label>Split Browser View</Label>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface3 text-foreground font-medium">
                  Experimental
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Show browser tab side-by-side with chat when viewing threads.
              </p>
            </div>
            <Switch checked={splitBrowser} onCheckedChange={setSplitBrowser} size="sm" />
          </div>

          {/* Collaborators */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-muted-foreground" />
              <Label>Collaborators</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Add people by email. They can access this workspace by signing in.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={collabEmail}
                onChange={(e) => setCollabEmail(e.target.value)}
                placeholder="colleague@example.com"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && collabEmail.trim()) {
                    setCollabAdding(true);
                    workspaceApi.addCollaborator(collabEmail.trim().toLowerCase(), 'editor')
                      .then(() => {
                        toast.success(`Added ${collabEmail.trim()}`);
                        setCollabEmail('');
                        return workspaceApi.listCollaborators();
                      })
                      .then((d) => setCollaborators(d.collaborators))
                      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                      .finally(() => setCollabAdding(false));
                  }
                }}
                className="flex-1"
              />
              <Button
                onClick={() => {
                  if (!collabEmail.trim()) return;
                  setCollabAdding(true);
                  workspaceApi.addCollaborator(collabEmail.trim().toLowerCase(), 'editor')
                    .then(() => {
                      toast.success(`Added ${collabEmail.trim()}`);
                      setCollabEmail('');
                      return workspaceApi.listCollaborators();
                    })
                    .then((d) => setCollaborators(d.collaborators))
                    .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                    .finally(() => setCollabAdding(false));
                }}
                disabled={collabAdding || !collabEmail.trim()}
                size="sm"
              >
                {collabAdding ? '...' : 'Add'}
              </Button>
            </div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {collabOwner && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/30 text-sm">
                  <Crown className="size-3.5 text-status-warning shrink-0" />
                  <span className="truncate flex-1">{collabOwner}</span>
                  <span className="text-xs text-muted-foreground">Owner</span>
                </div>
              )}
              {collaborators.map((c) => (
                <div key={c.email} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/30 text-sm">
                  <span className="truncate flex-1">{c.email}</span>
                  <button
                    onClick={() => {
                      workspaceApi.removeCollaborator(c.email)
                        .then(() => setCollaborators((prev) => prev.filter((x) => x.email !== c.email)))
                        .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'));
                    }}
                    className="size-5 flex items-center justify-center rounded hover:bg-surface3 text-muted-foreground hover:text-status-danger transition-colors shrink-0"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Browser Fabric API Key */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" />
              <Label>Browser Fabric API Key</Label>
            </div>
            {workspace?.browserfabricApiKey && (
              <p className="text-xs text-muted-foreground font-mono">
                Current: {workspace.browserfabricApiKey}
              </p>
            )}
            <Input
              value={bfApiKey}
              onChange={(e) => setBfApiKey(e.target.value)}
              placeholder={workspace?.browserfabricApiKey ? 'Enter new key to replace' : 'bf_... (optional — auto-provisioned if empty)'}
              className="text-xs font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Each workspace gets a free-tier key automatically. Set a custom key to use your own BrowserFabric account.
            </p>
          </div>

        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>{saving ? 'Saving...' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}