'use client';

import { Hint } from '@/components/ui/hint';
import React, { useState, useEffect, useCallback } from 'react';
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
  Save,
  RefreshCw,
  Key,
  Folder,
  Sparkles,
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Shield,
  PanelRight,
  Share2,
  Download,
  ExternalLink,
  Plus,
  Crown,
  FileText,
  FileDiff,
  Layers,
  GitFork,
  Cpu,
  Plug,
  MonitorPlay,
  Power,
  Palette,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout, type SettingsTab } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { getBridge } from '@/lib/desktop';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { SignalMark } from '@/components/brand/signal-mark';
import { useMarkColor } from '@/hooks/use-mark-color';
import { MARK_COLOR_PRESETS, DEFAULT_MARK_COLOR } from '@/lib/mark-color-store';
import { RouterProviderSettings } from './router-provider-settings';
import { AgentDefinitionsSettings } from './agent-definitions-settings';
import { WorkProfilesSettings } from './work-profiles-settings';
import { SavedWorkflowsSettings } from './saved-workflows-settings';
import { BackupRecoverySettings } from './backup-recovery-settings';
import { LegacyMigrationModal } from './legacy-migration-modal';
import { conversationFilename, downloadTextFile, messagesToMarkdown } from '@/lib/export-markdown';
import { eventToMessage } from '@/lib/types';
import type { RightPanelTab } from '@/components/layout/layout-context';

export function SettingsView() {
  const { workspace, token, refreshWorkspace, agents, currentSessionId, setSessionMaster, addParticipant, removeParticipant, sessions, createSession } = useWorkspace();
  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const { setViewMode, canGoBack, goBack, settingsTab, setSettingsTab, activeRightTab, setActiveRightTab, splitBrowser, setSplitBrowser, setSelectedAgentName } = useLayout();
  const [name, setName] = useState(workspace?.name || '52hz');
  const [nameSaveState, setNameSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const handleBack = useCallback(() => {
    if (canGoBack) {
      goBack();
    } else {
      setViewMode('home');
    }
  }, [canGoBack, goBack, setViewMode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        handleBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleBack]);

  const handleAutoSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === (workspace?.name || '52hz')) return;
    setNameSaveState('saving');
    try {
      await workspaceApi.updateWorkspace({ name: trimmed });
      await refreshWorkspace();
      setNameSaveState('saved');
      setTimeout(() => setNameSaveState('idle'), 2500);
    } catch {
      setNameSaveState('idle');
      toast.error('Failed to update workspace name');
    }
  };
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [agentSubTab, setAgentSubTab] = useState<'agents' | 'profiles' | 'workflows' | 'connections'>('agents');
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationIssueCount, setMigrationIssueCount] = useState(0);

  const checkMigration = useCallback(async () => {
    try {
      const res = await workspaceApi.checkLegacyMigration();
      setMigrationIssueCount(res?.stats?.totalIssues || 0);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (settingsTab === 'agents') {
      void checkMigration();
    }
  }, [settingsTab, checkMigration]);
  const [markColor, setMarkColor] = useMarkColor();
  const [localRuntime,setLocalRuntime] = useState<boolean|null>(null);
  const embeddedRuntime = localRuntime === true || agents.some(agent => agent.agentType === 'embedded');
  useEffect(()=>{
    const controller=new AbortController();
    void workspaceApi.request<{config?:unknown}>('/v1/runtime/session',{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setLocalRuntime(Boolean(result.config));})
      .catch(()=>{if(!controller.signal.aborted)setLocalRuntime(false);});
    return ()=>controller.abort();
  },[]);

  const { isCopied: urlCopied, copyToClipboard: copyUrl } = useCopyToClipboard();
  const { isCopied: tokenCopied, copyToClipboard: copyToken } = useCopyToClipboard();

  const SETTINGS_NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
    { id: 'general', label: 'General & Desktop', icon: Settings },
    { id: 'agents', label: 'Agent', icon: Bot },
    { id: 'panels', label: 'Panels & Display', icon: PanelRight },
    { id: 'export', label: '导出', icon: Download },
  ];

  useEffect(() => {
    if (workspace?.name) setName(workspace.name);
  }, [workspace?.name]);

  // Check desktop bridge for autostart status
  useEffect(() => {
    const bridge = getBridge();
    if (bridge?.isDesktop) {
      setIsDesktop(true);
      bridge.getAutostart().then((enabled) => setAutostart(enabled)).catch(() => {});
    }
  }, []);

  const handleToggleAutostart = async () => {
    const bridge = getBridge();
    if (bridge) {
      const next = !autostart;
      const res = await bridge.setAutostart(next);
      setAutostart(res);
      toast.success(res ? 'Autostart on login enabled' : 'Autostart on login disabled');
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
      const res = await workspaceApi.loadMessageHistory(sessionId, { limit: 1000 });
      const msgs = res.events.map(eventToMessage).filter((m) => m.sessionId === sessionId);
      const title = currentSession?.title || sessionId;
      const md = messagesToMarkdown(msgs.reverse(), {
        title,
        channelName: sessionId,
        participants: currentSession?.participants,
      });
      downloadTextFile(conversationFilename(title), md);
      toast.success(`Exported ${msgs.length} messages as Markdown`);
    } catch (err) {
      toast.error('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
    }
  };

  const { isCopied: shareCopied, copyToClipboard: copyShare } = useCopyToClipboard();
  const workspaceShareUrl = typeof window !== 'undefined' && workspace
    ? `${window.location.origin}/${workspace.workspaceId || 'default'}`
    : '';

  const PANELS_LIST: { id: RightPanelTab; name: string; icon: typeof Globe; desc: string }[] = [
    /*
      "Browser Sandbox Preview" is gone from this list. It was described as a
      live view of the headless browser the agents drive, but its tab rendered
      the same <LocalPreview /> as the entry below — the dev-server viewer. Two
      entries promising two features, one component. The agents' browser is the
      Browser view in the sidebar, not a Studio tab.
    */
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
      id: 'diff',
      name: 'Code Diff Inspector',
      icon: FileDiff,
      desc: 'Review git modifications, additions, and deletions with unified diff viewer and instant file switcher.',
    },

  ];

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground overflow-hidden">
      {/* Header Bar */}
      <div className="app-header justify-between ps-4 sm:ps-6">
        <div className="flex items-center gap-3">
          <Hint label="Back (Esc)">
            <button
              type="button"
              onClick={handleBack}
              data-no-drag
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/80 bg-surface2/70 hover:bg-surface3 text-foreground text-xs font-medium transition-colors cursor-pointer shadow-xs active:scale-95"
            >
              <ArrowLeft className="size-3.5" />
              <span>Back</span>
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
      </div>

      {/* Main Split: Settings Sidebar + Content Panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Settings Navigation Sidebar */}
        <div className="w-56 lg:w-60 shrink-0 border-r border-border/60 bg-surface1/30 p-3 flex flex-col gap-1 select-none overflow-y-auto">
          <div className="px-2.5 py-1.5 text-2xs font-semibold text-foreground-extra-muted uppercase tracking-wider">
            Settings
          </div>

          {SETTINGS_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = settingsTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setSettingsTab(item.id);
                }}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-xl text-left ui-transition',
                  active
                    ? 'bg-surface2 text-foreground font-medium shadow-xs'
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
                  <div className="text-xs truncate">{item.label}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Settings Content Area */}
        <div className="flex-1 min-w-0 h-full overflow-y-auto bg-surface0">
          {/* "Scheduled Tasks" moved to Tasks › Schedules, which already listed
              every routine and timer — the same schedules were editable here
              too. Anything that asks for it lands there via resolveView. */}

          {/* Tab 1: General Settings */}
          {settingsTab === 'general' && (
            <div className="max-w-3xl w-full mx-auto px-6 py-8 space-y-8 animate-[fadeIn_0.15s_ease-out]">
              {/* Section 1: General Workspace Profile */}
              <section className="space-y-2.5">
                <div className="px-1 text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                  <Folder className="size-3.5 text-primary" />
                  <span>Workspace Profile</span>
                </div>

                <div className="rounded-xl bg-surface1 border border-border/60 divide-y divide-border/40 overflow-hidden shadow-xs">
                  {/* Workspace name row */}
                  <div className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 pr-4">
                      <div className="text-xs sm:text-sm font-medium text-foreground">Workspace Name</div>
                      <p className="text-2xs text-foreground-muted mt-0.5">
                        The display name shown in the sidebar header and application window.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 sm:w-64">
                      <div className="relative w-full">
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          onBlur={handleAutoSaveName}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                          placeholder="52hz"
                          className="bg-surface0 border-border/60 text-xs sm:text-sm h-8 pr-16"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                          {nameSaveState === 'saving' && (
                            <span className="flex items-center gap-1 text-3xs text-foreground-muted">
                              <Loader2 className="size-3 animate-spin text-primary" />
                              Saving…
                            </span>
                          )}
                          {nameSaveState === 'saved' && (
                            <span className="flex items-center gap-0.5 text-3xs text-status-success font-medium">
                              <Check className="size-3" />
                              Saved
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Developer options accordion row */}
                  <div className="px-4 py-2.5 bg-surface1/60">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground font-medium transition-colors select-none py-0.5"
                    >
                      <ChevronRight className={cn('size-3.5 transition-transform duration-200', showAdvanced && 'rotate-90 text-primary')} />
                      <span>Developer credentials (Workspace ID & Admin Token)</span>
                    </button>
                  </div>

                  {showAdvanced && (
                    <>
                      <div className="px-4 py-3 bg-surface0/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-[fadeIn_0.15s_ease-out]">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground">Workspace ID</div>
                          <p className="text-3xs text-foreground-muted mt-0.5">Unique identifier used by CLI tools and external agent bridges.</p>
                        </div>
                        <div className="flex items-center gap-1.5 sm:w-64 shrink-0">
                          <Input
                            readOnly
                            value={workspace?.workspaceId || '52hz'}
                            className="bg-surface0 border-border/60 font-mono text-xs text-foreground-muted h-8 select-all"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyUrl(workspace?.workspaceId || '52hz')}
                            className="h-8 px-2.5 shrink-0"
                            title="Copy Workspace ID"
                          >
                            {urlCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                          </Button>
                        </div>
                      </div>

                      <div className="px-4 py-3 bg-surface0/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-[fadeIn_0.15s_ease-out]">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground">Admin Token</div>
                          <p className="text-3xs text-foreground-muted mt-0.5">High-privilege security token. Keep strictly confidential.</p>
                        </div>
                        <div className="flex items-center gap-1.5 sm:w-64 shrink-0">
                          <Input
                            readOnly
                            type="password"
                            value={token || ''}
                            className="bg-surface0 border-border/60 font-mono text-xs text-foreground-muted h-8 select-all"
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
                            className="h-8 px-2.5 shrink-0"
                            title="Copy Admin Token"
                          >
                            {tokenCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>

              {/* Section 2: Brand Mark Colour */}
              <section className="space-y-2.5">
                <div className="px-1 text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Palette className="size-3.5 text-primary" />
                    <span>Appearance & Brand Accent</span>
                  </div>
                  {markColor !== DEFAULT_MARK_COLOR && (
                    <button
                      type="button"
                      onClick={() => setMarkColor(DEFAULT_MARK_COLOR)}
                      className="text-2xs text-foreground-muted hover:text-foreground transition-colors flex items-center gap-1 font-normal normal-case"
                    >
                      <RefreshCw className="size-3" />
                      Reset to default
                    </button>
                  )}
                </div>

                <div className="rounded-xl bg-surface1 border border-border/60 divide-y divide-border/40 overflow-hidden shadow-xs">
                  <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="shrink-0 size-14 rounded-xl bg-surface0 border border-border/60 flex items-center justify-center shadow-2xs">
                        <SignalMark size={36} title="Mark preview" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs sm:text-sm font-medium text-foreground">Signal Mark & Tone</div>
                        <p className="text-2xs text-foreground-muted mt-0.5 max-w-sm">
                          Accent tone applied to whale signal marks, message avatars, and workspace brand elements.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
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
                                'relative size-7 rounded-full ui-transition duration-150 ring-offset-2 ring-offset-surface1',
                                active ? 'ring-2 ring-foreground scale-105' : 'ring-1 ring-border/60 hover:ring-foreground-muted'
                              )}
                              style={{ backgroundColor: preset.value }}
                            >
                              {active && (
                                <Check className="absolute inset-0 m-auto size-3 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" />
                              )}
                            </button>
                          </Hint>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>

              {/* Section 3: Desktop & System Integration */}
              <section className="space-y-2.5">
                <div className="px-1 text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Monitor className="size-3.5 text-primary" />
                    <span>Desktop Integration</span>
                  </div>
                  {!isDesktop && (
                    <span className="text-3xs text-foreground-extra-muted font-normal lowercase">web browser mode</span>
                  )}
                </div>

                <div className="rounded-xl bg-surface1 border border-border/60 divide-y divide-border/40 overflow-hidden shadow-xs">
                  <div className="px-4 py-3.5 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-medium text-foreground">Launch at login</div>
                      <p className="text-2xs text-foreground-muted mt-0.5">
                        Start 52hzAgents silently in the background when your computer turns on.
                      </p>
                      {!isDesktop && (
                        <p className="text-3xs text-foreground-extra-muted mt-0.5">
                          Only available when running the desktop app.
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={autostart}
                      onCheckedChange={handleToggleAutostart}
                      disabled={!isDesktop}
                      aria-label="Launch at login"
                      className="shrink-0"
                    />
                  </div>

                  <div className="px-4 py-3.5 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-medium text-foreground">Quick Bar shortcut</div>
                      <p className="text-2xs text-foreground-muted mt-0.5">
                        Global system hotkey to summon the quick prompt bar anywhere.
                      </p>
                      {!isDesktop && (
                        <p className="text-3xs text-foreground-extra-muted mt-0.5">
                          Only available when running the desktop app.
                        </p>
                      )}
                    </div>
                    <kbd className={cn(
                      'px-2.5 py-1 rounded-md bg-surface2 border border-border/80 text-xs font-mono font-medium shrink-0 shadow-2xs',
                      isDesktop ? 'text-foreground' : 'text-foreground-extra-muted',
                    )}>
                      Alt + Space
                    </kbd>
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* Tab 2: Manage Agents & Runtimes */}
          {settingsTab === 'agents' && (
            <div className="max-w-4xl w-full mx-auto px-8 py-8 space-y-6 animate-[fadeIn_0.15s_ease-out]">
              {localRuntime === null ? (
                <p className="text-xs text-foreground-muted">正在加载 Agent 设置…</p>
              ) : (
                <div className="space-y-5">
                  {/* Secondary Sub-tab Navigation */}
                  <div className="flex items-center gap-1.5 p-1 bg-surface2/60 rounded-xl border border-border/60 select-none overflow-x-auto">
                    <button
                      type="button"
                      onClick={() => setAgentSubTab('agents')}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0",
                        agentSubTab === 'agents' ? "bg-surface0 text-foreground shadow-xs font-semibold" : "text-foreground-muted hover:text-foreground"
                      )}
                    >
                      <Bot className="size-3.5 text-primary" />
                      <span>Agent 管理</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentSubTab('profiles')}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0",
                        agentSubTab === 'profiles' ? "bg-surface0 text-foreground shadow-xs font-semibold" : "text-foreground-muted hover:text-foreground"
                      )}
                    >
                      <Layers className="size-3.5 text-primary" />
                      <span>协作工作配置</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentSubTab('workflows')}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0",
                        agentSubTab === 'workflows' ? "bg-surface0 text-foreground shadow-xs font-semibold" : "text-foreground-muted hover:text-foreground"
                      )}
                    >
                      <GitFork className="size-3.5 text-primary" />
                      <span>流水线工作流</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentSubTab('connections')}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0 sm:ml-auto",
                        agentSubTab === 'connections' ? "bg-surface0 text-foreground shadow-xs font-semibold" : "text-foreground-muted hover:text-foreground"
                      )}
                    >
                      <Cpu className="size-3.5 text-primary" />
                      <span>资源连接维护</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMigrationOpen(true)}
                      className={cn(
                        "px-2.5 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0",
                        migrationIssueCount > 0
                          ? "bg-status-warning/15 text-status-warning border border-status-warning/40 font-semibold"
                          : "text-foreground-muted hover:text-foreground"
                      )}
                      title="检查并迁移旧角色与非 Agent 配置引用"
                    >
                      <ShieldAlert className="size-3.5 text-status-warning" />
                      <span>旧配置迁移</span>
                      {migrationIssueCount > 0 && (
                        <span className="px-1.5 py-0.2 rounded-full text-3xs font-mono bg-status-warning text-black font-bold">
                          {migrationIssueCount}
                        </span>
                      )}
                    </button>
                  </div>

                  {/* Sub-tab Content Panels */}
                  {agentSubTab === 'agents' && (
                    <AgentDefinitionsSettings
                      onManageConnections={() => setAgentSubTab('connections')}
                      onSelectAgentForChat={async (agentId) => {
                        try {
                          await createSession({ agentId });
                          setViewMode('threads');
                        } catch {
                          toast.error('无法为该 Agent 开启新会话');
                        }
                      }}
                    />
                  )}

                  {agentSubTab === 'profiles' && (
                    <WorkProfilesSettings />
                  )}

                  {agentSubTab === 'workflows' && (
                    <SavedWorkflowsSettings />
                  )}

                  {agentSubTab === 'connections' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between pb-2 border-b border-border/60">
                        <button
                          onClick={() => setAgentSubTab('agents')}
                          className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground font-medium"
                        >
                          <ArrowLeft className="size-3.5" />
                          <span>返回 Agent 列表</span>
                        </button>
                        <h3 className="text-xs font-semibold text-foreground">执行资源连接</h3>
                      </div>
                      <p className="text-xs leading-5 text-foreground-muted">连接为 Agent 提供执行资源，可被多个成员复用。添加连接后，请返回 Agent 设置完成绑定。</p>
                      <RouterProviderSettings />
                    </div>
                  )}
                  <LegacyMigrationModal
                    isOpen={migrationOpen}
                    onClose={() => setMigrationOpen(false)}
                    onMigrated={() => { void checkMigration(); }}
                  />
                </div>
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
              <div className="p-5 rounded-2xl bg-surface1 border border-border/60 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Globe className="size-4 text-primary" />
                    Split browser
                  </h3>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    Show the browser side by side with the thread — for web work, debugging automation, and watching a run.
                  </p>
                </div>
                <Switch
                  checked={splitBrowser}
                  onCheckedChange={(next) => {
                    setSplitBrowser(next);
                    toast.success(next ? 'Split browser on' : 'Split browser off');
                  }}
                  aria-label="Split browser"
                  className="shrink-0"
                />
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
                        'p-5 rounded-2xl border ui-transition flex flex-col justify-between space-y-4 shadow-xs',
                        isActive
                          ? 'bg-surface2/60 border-primary/40 ring-1 ring-primary/20'
                          : 'bg-surface1 border-border/60 hover:border-border'
                      )}
                    >
                      {/*
                        One control, one statement of state. The card used to
                        say it three times — an Open/Closed pill top-right, a
                        static "Side panel" caption (true of all seven, so it
                        distinguished nothing), and the button — across seven
                        cards. The button alone carries it: "Close" can only
                        mean it is open, and the card's own selected fill, ring
                        and filled icon tile say so again visually. Dropping the
                        footer takes its `border-t` with it, which was drawing a
                        line beside padding that already did the separating.
                      */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn(
                            'size-9 rounded-xl flex items-center justify-center shrink-0 transition-colors',
                            isActive ? 'bg-primary text-primary-foreground' : 'bg-surface2 text-foreground-muted'
                          )}>
                            <Icon className="size-4.5" />
                          </div>
                          <h4 className="text-sm font-semibold text-foreground">{panel.name}</h4>
                        </div>

                        <Button
                          variant={isActive ? 'primary' : 'outline'}
                          size="sm"
                          onClick={() => {
                            setActiveRightTab(isActive ? null : panel.id);
                            toast.success(isActive ? `${panel.name} closed` : `${panel.name} opened`);
                          }}
                          className="h-7.5 px-3 text-xs shrink-0"
                        >
                          {isActive ? 'Close' : 'Open'}
                        </Button>
                      </div>

                      <p className="text-xs text-foreground-muted leading-relaxed">
                        {panel.desc}
                      </p>
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
                  导出会话
                </h2>
                <p className="text-xs text-foreground-muted leading-relaxed">
                  将会话中的讨论、代码与结果导出为 Markdown。当前版本不提供公开分享链接。
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Export Markdown */}
                <div className="p-5 rounded-2xl bg-surface1 border border-border/60 space-y-4 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="size-10 rounded-xl bg-surface2 text-foreground-muted flex items-center justify-center">
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
                    className="w-full bg-primary text-primary-foreground text-xs h-9 flex items-center justify-center gap-2 shadow-xs"
                  >
                    {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    <span>{exporting ? 'Exporting…' : 'Export Markdown (.md)'}</span>
                  </Button>
                </div>


              </div>

              {/* Database Backup & Disaster Recovery */}
              <BackupRecoverySettings />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
