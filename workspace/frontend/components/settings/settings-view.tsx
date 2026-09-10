'use client';

import { Hint } from '@/components/ui/hint';
import React, { useState, useEffect } from 'react';
import { 
  Settings, 
  Copy, 
  Check, 
  Globe, 
  Bot, 
  Loader2, 
  Users, 
  ShieldCheck, 
  Monitor, 
  Terminal, 
  Save, 
  RefreshCw, 
  Key, 
  Folder, 
  Sparkles,
  ArrowLeft,
  ToggleLeft,
  ToggleRight,
  BookOpen,
  CalendarClock,
  ChevronRight,
  Shield,
  PanelRight,
  Share2,
  Download,
  ExternalLink,
  Plus,
  Crown,
  FileText,
  ListTodo,
  Layers,
  Radio,
  Plug,
  MonitorPlay,
  Power,
  Palette,
  Activity,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout, type SettingsTab } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { SignalMark } from '@/components/brand/signal-mark';
import { useMarkColor } from '@/hooks/use-mark-color';
import { MARK_COLOR_PRESETS, DEFAULT_MARK_COLOR } from '@/lib/mark-color-store';
import { SkillsView } from '@/components/skills/skills-view';
import { KnowledgeView } from '@/components/knowledge/knowledge-view';
import { RoutineList } from '@/components/routines/routine-list';
import { ConnectAgentView } from '@/components/connect/connect-agent-view';
import { conversationFilename, downloadTextFile, messagesToMarkdown } from '@/lib/export-markdown';
import { eventToMessage } from '@/lib/types';
import type { RightPanelTab } from '@/components/layout/layout-context';

export function SettingsView() {
  const { workspace, token, refreshWorkspace, agents, currentSessionId, setSessionMaster, addParticipant, removeParticipant, sessions } = useWorkspace();
  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const { setViewMode, settingsTab, setSettingsTab, activeRightTab, setActiveRightTab, splitBrowser, setSplitBrowser, setSelectedAgentName } = useLayout();
  const [name, setName] = useState(workspace?.name || '52hz');
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [collaborators, setCollaborators] = useState<Array<{ email: string; role: string }>>([]);
  const [newCollabEmail, setNewCollabEmail] = useState('');
  const [loadingCollabs, setLoadingCollabs] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showConnectAgent, setShowConnectAgent] = useState(false);
  const [markColor, setMarkColor] = useMarkColor();

  const { isCopied: urlCopied, copyToClipboard: copyUrl } = useCopyToClipboard();
  const { isCopied: tokenCopied, copyToClipboard: copyToken } = useCopyToClipboard();

  const SETTINGS_NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
    { id: 'general', label: 'General & Desktop', icon: Settings },
    { id: 'agents', label: 'Manage Agents', icon: Users },
    { id: 'panels', label: 'Panels & Display', icon: PanelRight },
    { id: 'export', label: 'Export & Share', icon: Download },
    { id: 'skills', label: 'Skills Hub', icon: Sparkles },
    { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
    { id: 'routines', label: 'Scheduled Tasks', icon: CalendarClock },
  ];

  useEffect(() => {
    if (workspace?.name) setName(workspace.name);
  }, [workspace?.name]);

  // Check desktop bridge for autostart status
  useEffect(() => {
    const bridge = (window as unknown as { electronBridge?: { isDesktop: boolean; getAutostart: () => Promise<boolean>; setAutostart: (enabled: boolean) => Promise<boolean> } }).electronBridge;
    if (bridge?.isDesktop) {
      setIsDesktop(true);
      bridge.getAutostart().then((enabled) => setAutostart(enabled)).catch(() => {});
    }
  }, []);

  // Load collaborators
  useEffect(() => {
    if (workspace?.workspaceId) {
      setLoadingCollabs(true);
      workspaceApi.listCollaborators()
        .then((res) => {
          if (res && res.collaborators) {
            setCollaborators(res.collaborators);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingCollabs(false));
    }
  }, [workspace?.workspaceId]);

  const handleToggleAutostart = async () => {
    const bridge = (window as unknown as { electronBridge?: { setAutostart: (enabled: boolean) => Promise<boolean> } }).electronBridge;
    if (bridge) {
      const next = !autostart;
      const res = await bridge.setAutostart(next);
      setAutostart(res);
      toast.success(res ? 'Autostart on login enabled' : 'Autostart on login disabled');
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updates: Record<string, unknown> = { name: name.trim() };
      await workspaceApi.updateWorkspace(updates);
      await refreshWorkspace();
      toast.success('Workspace settings updated successfully');
    } catch {
      toast.error('Failed to save workspace settings');
    } finally {
      setSaving(false);
    }
  };

  const handleAddCollaborator = async () => {
    if (!newCollabEmail.trim() || !workspace?.workspaceId) return;
    try {
      await workspaceApi.addCollaborator(newCollabEmail.trim(), 'editor');
      setCollaborators([...collaborators, { email: newCollabEmail.trim(), role: 'editor' }]);
      setNewCollabEmail('');
      toast.success('Collaborator added');
    } catch {
      toast.error('Failed to add collaborator');
    }
  };

  const handleRemoveCollaborator = async (email: string) => {
    if (!workspace?.workspaceId) return;
    try {
      await workspaceApi.removeCollaborator(email);
      setCollaborators(collaborators.filter((c) => c.email !== email));
      toast.success('Collaborator removed');
    } catch {
      toast.error('Failed to remove collaborator');
    }
  };

  const handleToggleAgentAutostart = async (agentName: string, currentAutostart: boolean) => {
    try {
      await workspaceApi.updateMember(agentName, { autostart: !currentAutostart });
      await refreshWorkspace();
      toast.success(!currentAutostart ? `@${agentName} will connect on launch` : `@${agentName} will not connect on launch`);
    } catch {
      toast.error('Could not update autostart');
    }
  };

  // Export current session as markdown
  const handleExportCurrentMarkdown = async () => {
    const sessionId = currentSessionId || (sessions[0]?.sessionId);
    if (!sessionId || exporting) {
      toast.error('No conversation to export');
      return;
    }
    setExporting(true);
    try {
      const res = await workspaceApi.loadMessageHistory(sessionId, { limit: 100 });
      const msgs = res.events.map(eventToMessage).filter((m) => m.sessionId === sessionId);
      const title = currentSession?.title || sessionId;
      const md = messagesToMarkdown(msgs.reverse(), {
        title,
        channelName: sessionId,
        participants: currentSession?.participants,
      });
      downloadTextFile(conversationFilename(title), md);
      toast.success('Conversation exported as Markdown');
    } catch (err) {
      toast.error('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
    }
  };

  const { isCopied: shareCopied, copyToClipboard: copyShare } = useCopyToClipboard();
  const workspaceShareUrl = typeof window !== 'undefined' && workspace
    ? `${window.location.origin}/share/${workspace.workspaceId || 'default'}`
    : '';

  const PANELS_LIST: { id: RightPanelTab; name: string; icon: typeof Globe; desc: string }[] = [
    {
      id: 'browser',
      name: 'Browser Sandbox Preview',
      icon: Globe,
      desc: 'A live view of the headless browser the agents drive — pages, DOM changes, and full-page interaction.',
    },
    {
      id: 'preview',
      name: 'Local Dev Server Preview',
      icon: MonitorPlay,
      desc: 'Connects straight to a dev server on this machine, any localhost port, with hot reload and viewport switching. The desktop app adds DevTools and console-error capture.',
    },
    {
      id: 'file',
      name: 'File Artifacts & Preview',
      icon: FileText,
      desc: 'Browse and download the project code and Markdown the agents write.',
    },
    {
      id: 'tasks',
      name: 'Task Matrix & Todos',
      icon: ListTodo,
      desc: 'One place for the task breakdown, progress, and status of a multi-agent run.',
    },
    {
      id: 'radar',
      name: 'Agent Radar Topology',
      icon: Radio,
      desc: 'The collaboration network, how the agents are connected, and their live heartbeats.',
    },
    {
      id: 'terminal',
      name: 'Agent Terminal Logs',
      icon: Terminal,
      desc: 'Raw stdout and logs from an external agent’s CLI process.',
    },
    {
      id: 'trace',
      name: 'Execution Trace & Reasoning',
      icon: Activity,
      desc: 'Multi-step reasoning, tool calls, subagent dispatch, and the live execution tree for this thread.',
    },
  ];

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground overflow-hidden">
      {/* Header Bar */}
      <div className="app-header justify-between px-6">
        <div className="flex items-center gap-3">
          <Hint label="Back to chat">
            <button
              onClick={() => setViewMode('threads')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 text-foreground text-xs font-medium transition-colors cursor-pointer shadow-2xs"
            >
              <ArrowLeft className="size-3.5" />
              <span>Back to chat</span>
            </button>
          </Hint>
          <div className="h-4 w-px bg-border/50" />
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Settings className="size-4 text-primary" />
              <span>{workspace?.name || '52hzAgents'} · Settings</span>
            </h1>
          </div>
        </div>

        {settingsTab === 'general' && (
          <div className="flex items-center gap-2">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs px-3.5 h-8 shadow-xs cursor-pointer"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Save className="size-3.5 mr-1.5" />}
              Save changes
            </Button>
          </div>
        )}
      </div>

      {/* Main Split: Settings Sidebar + Content Panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Settings Navigation Sidebar */}
        <div className="w-56 lg:w-60 shrink-0 border-r border-border/60 bg-surface1/30 p-3 flex flex-col gap-1 select-none overflow-y-auto">
          <div className="px-2.5 py-1.5 text-2xs font-medium text-foreground-extra-muted uppercase tracking-wider">
            Settings
          </div>

          {SETTINGS_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = settingsTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setShowConnectAgent(false);
                  setSettingsTab(item.id);
                }}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all cursor-pointer',
                  active
                    ? 'bg-surface2 text-foreground font-medium shadow-2xs'
                    : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
                )}
              >
                <div className={cn(
                  'size-7 rounded-lg flex items-center justify-center shrink-0 transition-colors',
                  active ? 'bg-primary text-primary-foreground' : 'bg-surface3/60 text-foreground-muted'
                )}>
                  <Icon className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  {/* One line. `sublabel` used to hold the English half of a
                      bilingual pair; with the label itself in English the second
                      line only restated the first. */}
                  <div className="text-xs truncate">{item.label}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Settings Content Area */}
        <div className="flex-1 min-w-0 h-full overflow-y-auto bg-surface0">
          {settingsTab === 'skills' && <SkillsView />}
          {settingsTab === 'knowledge' && <KnowledgeView />}
          {settingsTab === 'routines' && <RoutineList />}

          {/* Tab 1: General Settings */}
          {settingsTab === 'general' && (
            <div className="max-w-4xl w-full mx-auto px-8 py-8 space-y-8 animate-[fadeIn_0.15s_ease-out]">
              {/* Section 1: General Workspace Profile */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/60 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/60 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Folder className="size-4 text-primary" />
                    Workspace
                  </h2>
                </div>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-foreground-muted">Workspace name</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="52hz"
                      className="bg-surface0 border-border/60 text-sm h-9 max-w-lg"
                    />
                    <p className="text-2xs text-foreground-extra-muted">The name shown in the interface and at the top of the sidebar.</p>
                  </div>

                  {/* Collapsible Advanced / Developer Options for Workspace ID & Token */}
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground font-medium transition-colors cursor-pointer select-none py-1"
                    >
                      <ChevronRight className={cn('size-3.5 transition-transform duration-200', showAdvanced && 'rotate-90 text-primary')} />
                      <span>Developer options (workspace ID and token)</span>
                    </button>

                    {showAdvanced && (
                      <div className="mt-3 p-4 rounded-xl bg-surface0/70 border border-border/60 grid grid-cols-1 md:grid-cols-2 gap-4 animate-[fadeIn_0.15s_ease-out]">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-foreground-muted">Workspace ID</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              readOnly
                              value={workspace?.workspaceId || '52hz'}
                              className="bg-surface0 border-border/60 font-mono text-xs text-foreground-muted h-9 select-all"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => copyUrl(workspace?.workspaceId || '52hz')}
                              className="h-9 px-3 shrink-0 cursor-pointer"
                            >
                              {urlCopied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
                            </Button>
                          </div>
                          <p className="text-3xs text-foreground-extra-muted">The routing identifier a CLI, the API, or an external agent connects with.</p>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-foreground-muted">Admin token</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              readOnly
                              type="password"
                              value={token || ''}
                              className="bg-surface0 border-border/60 font-mono text-xs text-foreground-muted h-9 select-all"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                if (token) {
                                  copyToken(token);
                                  toast.success('Token copied');
                                }
                              }}
                              className="h-9 px-3 shrink-0 cursor-pointer"
                            >
                              {tokenCopied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
                            </Button>
                          </div>
                          <p className="text-3xs text-foreground-extra-muted">A high-privilege key that guards workspace administration. Treat it like a password.</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Section 2: Brand Mark Colour */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/60 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/60 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Palette className="size-4 text-primary" />
                    Brand mark
                  </h2>
                  {markColor !== DEFAULT_MARK_COLOR && (
                    <button
                      type="button"
                      onClick={() => setMarkColor(DEFAULT_MARK_COLOR)}
                      className="text-2xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <RefreshCw className="size-3" />
                      Reset
                    </button>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-5">
                  {/* Live preview. The mark reads the same CSS variable the
                      swatches write, so this needs no props to stay in sync. */}
                  <div className="shrink-0 size-24 rounded-xl bg-surface0 border border-border/60 flex items-center justify-center">
                    <SignalMark size={56} title="Mark preview" />
                  </div>

                  <div className="min-w-0 flex-1 space-y-3">
                    <p className="text-xs text-foreground-muted">
                      The mark's body colour. The sidebar, empty states, share pages, and message avatars all follow it; the face stays a fixed near-black so it reads on every choice.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {MARK_COLOR_PRESETS.map((preset) => {
                        const active = markColor === preset.value;
                        return (
                          <Hint key={preset.value} label={preset.label}>
                            <button
                              type="button"
                              onClick={() => setMarkColor(preset.value)}
                              aria-label={preset.label}
                              aria-pressed={active}
                              className={cn(
                                'relative size-9 rounded-full cursor-pointer transition-all duration-150',
                                // The ring sits OUTSIDE the swatch so selecting one
                                // does not change its apparent colour area — with
                                // an inset ring the active chip reads as a
                                // different shade than the colour it applies.
                                'ring-offset-2 ring-offset-surface1',
                                active
                                  ? 'ring-2 ring-foreground scale-105'
                                  : 'ring-1 ring-border/60 hover:ring-foreground-muted hover:scale-105',
                              )}
                              style={{ backgroundColor: preset.value }}
                            >
                              {active && (
                                <Check className="absolute inset-0 m-auto size-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" />
                              )}
                            </button>
                          </Hint>
                        );
                      })}
                    </div>
                    <p className="text-3xs text-foreground-extra-muted font-mono">
                      {MARK_COLOR_PRESETS.find((p) => p.value === markColor)?.label ?? 'Custom'} · {markColor.toUpperCase()}
                    </p>
                  </div>
                </div>
              </div>

              {/* Section 3: Desktop & System Integration */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/60 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/60 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Monitor className="size-4 text-primary" />
                    Desktop & shortcuts
                  </h2>
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                    {isDesktop ? 'Desktop app' : 'Browser'}
                  </span>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-surface0 border border-border/60">
                    <div>
                      <p className="text-sm font-medium text-foreground">Launch at login</p>
                      <p className="text-xs text-foreground-muted mt-0.5">Start 52hzAgents in the system tray when the computer boots.</p>
                    </div>
                    <button
                      onClick={handleToggleAutostart}
                      disabled={!isDesktop}
                      className="text-primary hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-30"
                    >
                      {autostart ? <ToggleRight className="size-7 text-primary" /> : <ToggleLeft className="size-7 text-foreground-muted" />}
                    </button>
                  </div>

                  <div className="p-3.5 rounded-xl bg-surface0 border border-border/60 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">Quick Bar shortcut</p>
                      <p className="text-xs text-foreground-muted mt-0.5">Summon the command bar from anywhere in the system.</p>
                    </div>
                    <kbd className="px-2.5 py-1 rounded bg-surface2 border border-border text-xs font-mono font-medium text-foreground">
                      Alt + Space
                    </kbd>
                  </div>
                </div>
              </div>

              {/* Section 4: Team Collaborators */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/60 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/60 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Users className="size-4 text-primary" />
                    Members
                  </h2>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Input
                      type="email"
                      value={newCollabEmail}
                      onChange={(e) => setNewCollabEmail(e.target.value)}
                      placeholder="colleague@example.com"
                      className="bg-surface0 border-border/60 text-sm h-9"
                    />
                    <Button
                      size="sm"
                      onClick={handleAddCollaborator}
                      disabled={!newCollabEmail.trim()}
                      className="h-9 px-4 text-xs shrink-0 cursor-pointer"
                    >
                      Add member
                    </Button>
                  </div>

                  <div className="divide-y divide-border/60 rounded-xl bg-surface0 border border-border/60 overflow-hidden">
                    {collaborators.length === 0 ? (
                      <div className="p-4 text-center text-xs text-foreground-muted">
                        No other members yet
                      </div>
                    ) : (
                      collaborators.map((c) => (
                        <div key={c.email} className="flex items-center justify-between px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <div className="size-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                              {c.email[0].toUpperCase()}
                            </div>
                            <span className="text-xs font-medium text-foreground">{c.email}</span>
                            <span className="text-3xs px-2 py-0.5 rounded bg-surface2 text-foreground-muted uppercase font-mono">
                              {c.role}
                            </span>
                          </div>
                          <button
                            onClick={() => handleRemoveCollaborator(c.email)}
                            className="text-xs text-status-danger hover:text-status-danger transition-colors cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Manage Agents & Runtimes */}
          {settingsTab === 'agents' && (
            <div className="max-w-4xl w-full mx-auto px-8 py-8 space-y-6 animate-[fadeIn_0.15s_ease-out]">
              {showConnectAgent ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setShowConnectAgent(false)}
                      className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground cursor-pointer font-medium"
                    >
                      <ArrowLeft className="size-3.5" />
                      <span>Back to agents</span>
                    </button>
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-surface1 p-6">
                    <ConnectAgentView />
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between p-6 rounded-2xl bg-surface1 border border-border/60 shadow-sm">
                    <div>
                      <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                        <Users className="size-5 text-primary" />
                        Agents & roles
                      </h2>
                      <p className="text-xs text-foreground-muted mt-1">
                        {agents.filter(a => a.status === 'online').length} of {agents.length} agents online. Name a thread leader, give an agent a role, or connect a new one.
                      </p>
                    </div>

                    <Button
                      onClick={() => setShowConnectAgent(true)}
                      className="bg-primary text-primary-foreground text-xs h-8.5 px-3.5 flex items-center gap-1.5 shadow-xs cursor-pointer"
                    >
                      <Plug className="size-3.5" />
                      <span>Connect agent</span>
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {agents.length === 0 ? (
                      <div className="col-span-2 p-10 rounded-2xl bg-surface1 border border-border/60 text-center space-y-3">
                        <div className="size-12 rounded-2xl bg-surface2 mx-auto flex items-center justify-center text-foreground-muted">
                          <Bot className="size-6" />
                        </div>
                        <h3 className="text-sm font-semibold text-foreground">No agents online</h3>
                        <p className="text-xs text-foreground-muted max-w-sm mx-auto">
                          No agent is connected yet. Use Connect agent, top right, to hook up Claude CLI, Antigravity, OpenClaw, or a custom agent.
                        </p>
                        <Button
                          onClick={() => setShowConnectAgent(true)}
                          size="sm"
                          className="text-xs mt-2"
                        >
                          Connect an agent
                        </Button>
                      </div>
                    ) : (
                      agents.map((agent) => {
                        const isOnline = agent.status === 'online';
                        const isMaster = currentSession?.master === agent.agentName;
                        const inCurrentSession = currentSession?.participants?.includes(agent.agentName);

                        return (
                          <div
                            key={agent.agentName}
                            className="p-4 rounded-2xl bg-surface1 border border-border/60 shadow-xs flex flex-col justify-between space-y-3 hover:border-border transition-colors"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="relative">
                                  <AgentAvatar name={agent.agentName} size={36} />
                                  <span className={cn(
                                    'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface1',
                                    isOnline ? 'bg-status-success' : 'bg-foreground-extra-muted'
                                  )} />
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-foreground truncate">{agent.agentName}</span>
                                    {isMaster && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-3xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/20">
                                        <Crown className="size-2.5" /> Leader
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-2xs text-foreground-extra-muted uppercase font-mono">
                                    {agent.agentType || 'Local Agent'}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                <Hint label={agent.autostart ? 'Connects on launch — click to turn off' : 'Does not connect on launch — click to turn on'}>
                                  <button
                                    type="button"
                                    onClick={() => handleToggleAgentAutostart(agent.agentName, !!agent.autostart)}
                                    className={cn(
                                      'inline-flex items-center gap-1 text-3xs px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer border',
                                      agent.autostart
                                        ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                                        : 'bg-surface2/60 border-border/60 text-foreground-extra-muted hover:text-foreground-muted'
                                    )}
                                  >
                                    <Power className="size-2.5" />
                                    <span>{agent.autostart ? 'Auto' : 'Manual'}</span>
                                  </button>
                                </Hint>

                                <span className={cn(
                                  'text-3xs px-2 py-0.5 rounded-full font-medium',
                                  isOnline ? 'bg-status-success/10 text-status-success' : 'bg-surface2 text-foreground-muted'
                                )}>
                                  {isOnline ? 'Online' : 'Offline'}
                                </span>
                              </div>
                            </div>

                            <p className="text-xs text-foreground-muted line-clamp-2 leading-relaxed">
                              {agent.description || 'No description. Use the role settings below to give this agent a prompt and a remit.'}
                            </p>

                            <div className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                {currentSessionId && (
                                  <Hint label="Make this the leader of the thread">
                                    <button
                                      onClick={() => setSessionMaster(currentSessionId, agent.agentName)}
                                      className={cn(
                                        'px-2 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer inline-flex items-center gap-1',
                                        isMaster ? 'bg-status-warning/15 text-status-warning font-medium' : 'bg-surface2 text-foreground-muted hover:text-foreground'
                                      )}
                                    >
                                      <Crown className="size-3" />
                                      <span>{isMaster ? 'Leader' : 'Make leader'}</span>
                                    </button>
                                  </Hint>
                                )}

                                {currentSessionId && (
                                  inCurrentSession ? (
                                    <button
                                      onClick={() => removeParticipant(currentSessionId, agent.agentName)}
                                      className="px-2 py-1 rounded-lg text-xs font-medium bg-surface2 text-status-danger hover:bg-status-danger/10 transition-colors cursor-pointer"
                                    >
                                      Remove from thread
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => addParticipant(currentSessionId, agent.agentName)}
                                      className="px-2 py-1 rounded-lg text-xs font-medium bg-surface2 text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                                    >
                                      Add to thread
                                    </button>
                                  )
                                )}
                              </div>

                              <button
                                onClick={() => setSelectedAgentName(agent.agentName)}
                                className="text-xs text-foreground-muted hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
                              >
                                <span>Role</span>
                                <ChevronRight className="size-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tab 3: Panels & Display Configuration */}
          {settingsTab === 'panels' && (
            <div className="max-w-4xl w-full mx-auto px-8 py-8 space-y-6 animate-[fadeIn_0.15s_ease-out]">
              <div className="p-6 rounded-2xl bg-surface1 border border-border/60 shadow-sm space-y-2">
                <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <PanelRight className="size-5 text-primary" />
                  Side panels
                </h2>
                <p className="text-xs text-foreground-muted leading-relaxed">
                  Panels that open beside the thread: browser, file artifacts, task board, agent topology, and terminal logs.
                </p>
              </div>

              {/* Split Browser Toggle */}
              <div className="p-5 rounded-2xl bg-surface1 border border-border/60 shadow-xs flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Globe className="size-4 text-primary" />
                    Split browser
                  </h3>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    Show the browser side by side with the thread — for web work, debugging automation, and watching a run.
                  </p>
                </div>
                <button
                  onClick={() => {
                    const next = !splitBrowser;
                    setSplitBrowser(next);
                    toast.success(next ? 'Split browser on' : 'Split browser off');
                  }}
                  className="text-primary hover:opacity-80 transition-opacity cursor-pointer"
                >
                  {splitBrowser ? <ToggleRight className="size-7 text-primary" /> : <ToggleLeft className="size-7 text-foreground-muted" />}
                </button>
              </div>

              {/* Side Panels List */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {PANELS_LIST.map((panel) => {
                  const Icon = panel.icon;
                  const isActive = activeRightTab === panel.id;

                  return (
                    <div
                      key={panel.id}
                      className={cn(
                        'p-5 rounded-2xl border transition-all flex flex-col justify-between space-y-4 shadow-xs',
                        isActive
                          ? 'bg-surface2/60 border-primary/40 ring-1 ring-primary/20'
                          : 'bg-surface1 border-border/60 hover:border-border'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            'size-9 rounded-xl flex items-center justify-center shrink-0 transition-colors',
                            isActive ? 'bg-primary text-primary-foreground' : 'bg-surface2 text-foreground-muted'
                          )}>
                            <Icon className="size-4.5" />
                          </div>
                          <div>
                            <h4 className="text-sm font-semibold text-foreground">{panel.name}</h4>
                          </div>
                        </div>

                        <span className={cn(
                          'text-3xs px-2 py-0.5 rounded-full font-medium',
                          isActive ? 'bg-primary/15 text-primary' : 'bg-surface2 text-foreground-extra-muted'
                        )}>
                          {isActive ? 'Open' : 'Closed'}
                        </span>
                      </div>

                      <p className="text-xs text-foreground-muted leading-relaxed">
                        {panel.desc}
                      </p>

                      <div className="pt-2 border-t border-border/60 flex items-center justify-between">
                        <span className="text-2xs text-foreground-extra-muted">Side panel</span>
                        <Button
                          variant={isActive ? 'primary' : 'outline'}
                          size="sm"
                          onClick={() => {
                            setActiveRightTab(isActive ? null : panel.id);
                            toast.success(isActive ? `${panel.name} closed` : `${panel.name} opened`);
                          }}
                          className="h-7.5 px-3 text-xs cursor-pointer"
                        >
                          {isActive ? 'Close' : 'Open'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tab 4: Export & Share */}
          {settingsTab === 'export' && (
            <div className="max-w-4xl w-full mx-auto px-8 py-8 space-y-6 animate-[fadeIn_0.15s_ease-out]">
              <div className="p-6 rounded-2xl bg-surface1 border border-border/60 shadow-sm space-y-2">
                <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <Download className="size-5 text-primary" />
                  Export & share
                </h2>
                <p className="text-xs text-foreground-muted leading-relaxed">
                  Export the thread — discussion, code, and results — as Markdown, or create a read-only share link.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Export Markdown */}
                <div className="p-5 rounded-2xl bg-surface1 border border-border/60 shadow-xs space-y-4 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                      <FileText className="size-5" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">Export this thread as Markdown</h3>
                    <p className="text-xs text-foreground-muted leading-relaxed">
                      Saves the history, the agents’ reasoning, and every code block into one `.md` file, ready for Notion or Obsidian.
                    </p>
                  </div>

                  <Button
                    onClick={handleExportCurrentMarkdown}
                    disabled={exporting}
                    className="w-full bg-primary text-primary-foreground text-xs h-9 flex items-center justify-center gap-2 cursor-pointer shadow-xs"
                  >
                    {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    <span>{exporting ? 'Exporting…' : 'Export Markdown (.md)'}</span>
                  </Button>
                </div>

                {/* Public Share Link */}
                <div className="p-5 rounded-2xl bg-surface1 border border-border/60 shadow-xs space-y-4 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="size-10 rounded-xl bg-status-success/10 text-status-success flex items-center justify-center">
                      <Share2 className="size-5" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">Read-only share link</h3>
                    <p className="text-xs text-foreground-muted leading-relaxed">
                      Creates a link that shows this workspace’s live threads and artifacts without a login. Read-only.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={workspaceShareUrl}
                        className="bg-surface0 border-border/60 font-mono text-xs text-foreground-muted h-9 select-all"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          copyShare(workspaceShareUrl);
                          toast.success('Share link copied');
                        }}
                        className="h-9 px-3 shrink-0 cursor-pointer"
                      >
                        {shareCopied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
