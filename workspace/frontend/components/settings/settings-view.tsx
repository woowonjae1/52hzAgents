'use client';

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

  const SETTINGS_NAV_ITEMS: { id: SettingsTab; label: string; sublabel: string; icon: typeof Settings }[] = [
    { id: 'general', label: '通用与桌面', sublabel: 'General & Desktop', icon: Settings },
    { id: 'agents', label: '智能体管理', sublabel: 'Manage Agents', icon: Users },
    { id: 'panels', label: '辅助面板', sublabel: 'Panels & Display', icon: PanelRight },
    { id: 'export', label: '数据与分享', sublabel: 'Export & Share', icon: Download },
    { id: 'skills', label: '技能扩展', sublabel: 'Skills Hub', icon: Sparkles },
    { id: 'knowledge', label: '知识库', sublabel: 'Knowledge Base', icon: BookOpen },
    { id: 'routines', label: '定时任务', sublabel: 'Scheduled Tasks', icon: CalendarClock },
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
      toast.success(!currentAutostart ? `已开启 @${agentName} 启动自连` : `已关闭 @${agentName} 启动自连`);
    } catch {
      toast.error('更新自启动配置失败');
    }
  };

  // Export current session as markdown
  const handleExportCurrentMarkdown = async () => {
    const sessionId = currentSessionId || (sessions[0]?.sessionId);
    if (!sessionId || exporting) {
      toast.error('暂无可导出的对话会话');
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
      toast.success('当前对话已成功导出为 Markdown 文件');
    } catch (err) {
      toast.error('导出失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
    }
  };

  const { isCopied: shareCopied, copyToClipboard: copyShare } = useCopyToClipboard();
  const workspaceShareUrl = typeof window !== 'undefined' && workspace
    ? `${window.location.origin}/share/${workspace.workspaceId || 'default'}`
    : '';

  const PANELS_LIST: { id: RightPanelTab; name: string; sublabel: string; icon: typeof Globe; desc: string }[] = [
    {
      id: 'browser',
      name: '云端浏览器沙箱',
      sublabel: 'Browser Sandbox Preview',
      icon: Globe,
      desc: '实时预览 Agent 操作的无头浏览器页面、DOM 变化与全景页面交互。',
    },
    {
      id: 'preview',
      name: '本地实时预览',
      sublabel: 'Local Dev Server Preview',
      icon: MonitorPlay,
      desc: '直连本机 dev server（localhost 任意端口），支持热重载、多端视口切换。桌面端额外提供 DevTools 与控制台错误捕获。',
    },
    {
      id: 'file',
      name: '文件产物预览器',
      sublabel: 'File Artifacts & Preview',
      icon: FileText,
      desc: '快速浏览与下载由智能体生成、编辑的项目代码与 Markdown 产物。',
    },
    {
      id: 'tasks',
      name: '任务矩阵看板',
      sublabel: 'Task Matrix & Todos',
      icon: ListTodo,
      desc: '集中管理多智能体协作的任务分解列表、执行进度与状态。',
    },
    {
      id: 'radar',
      name: '智能体雷达拓扑',
      sublabel: 'Agent Radar Topology',
      icon: Radio,
      desc: '可视化展示智能体协作网络、通信拓扑结构与实时心跳状态。',
    },
    {
      id: 'terminal',
      name: '智能体终端输出',
      sublabel: 'Agent Terminal Logs',
      icon: Terminal,
      desc: '查看外部 Agent 运行时的 CLI 进程标准输出流与原始日志。',
    },
  ];

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground overflow-hidden">
      {/* Header Bar */}
      <div className="shrink-0 flex items-center justify-between px-6 py-3.5 bg-surface0 border-b border-border/40">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode('threads')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 text-foreground text-xs font-medium transition-colors cursor-pointer shadow-2xs"
            title="返回对话"
          >
            <ArrowLeft className="size-3.5" />
            <span>返回对话</span>
          </button>
          <div className="h-4 w-px bg-border/50" />
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Settings className="size-4 text-primary" />
              <span>{workspace?.name || '52hzAgents'} · 设置中心</span>
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
              保存修改
            </Button>
          </div>
        )}
      </div>

      {/* Main Split: Settings Sidebar + Content Panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Settings Navigation Sidebar */}
        <div className="w-56 lg:w-60 shrink-0 border-r border-border/40 bg-surface1/30 p-3 flex flex-col gap-1 select-none overflow-y-auto">
          <div className="px-2.5 py-1.5 text-2xs font-medium text-foreground-extra-muted uppercase tracking-wider">
            设置选项
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
                  <div className="text-xs truncate">{item.label}</div>
                  <div className="text-3xs text-foreground-extra-muted truncate">{item.sublabel}</div>
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
              <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/30 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Folder className="size-4 text-primary" />
                    工作区基础配置
                  </h2>
                </div>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-foreground-muted">工作区名称</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="52hz"
                      className="bg-surface0 border-border/60 text-sm h-9 max-w-lg"
                    />
                    <p className="text-2xs text-foreground-extra-muted">自定义当前工作区在界面和侧边栏顶部显示的名称</p>
                  </div>

                  {/* Collapsible Advanced / Developer Options for Workspace ID & Token */}
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground font-medium transition-colors cursor-pointer select-none py-1"
                    >
                      <ChevronRight className={cn('size-3.5 transition-transform duration-200', showAdvanced && 'rotate-90 text-primary')} />
                      <span>高级开发者选项（工作区 ID 与鉴权 Token）</span>
                    </button>

                    {showAdvanced && (
                      <div className="mt-3 p-4 rounded-xl bg-surface0/70 border border-border/40 grid grid-cols-1 md:grid-cols-2 gap-4 animate-[fadeIn_0.15s_ease-out]">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-foreground-muted">工作区 ID (Workspace ID)</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              readOnly
                              value={workspace?.workspaceId || '52hz'}
                              className="bg-surface0 border-border/40 font-mono text-xs text-foreground-muted h-9 select-all"
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
                          <p className="text-3xs text-foreground-extra-muted">用于 CLI、API 或外部 Agent 连接时的路由标识</p>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-foreground-muted">管理 Token (Token)</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              readOnly
                              type="password"
                              value={token || ''}
                              className="bg-surface0 border-border/40 font-mono text-xs text-foreground-muted h-9 select-all"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                if (token) {
                                  copyToken(token);
                                  toast.success('Token 已复制到剪贴板');
                                }
                              }}
                              className="h-9 px-3 shrink-0 cursor-pointer"
                            >
                              {tokenCopied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
                            </Button>
                          </div>
                          <p className="text-3xs text-foreground-extra-muted">用于保护工作区管理权限的高权限安全密钥</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Section 2: Brand Mark Colour */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/30 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Palette className="size-4 text-primary" />
                    品牌标识
                  </h2>
                  {markColor !== DEFAULT_MARK_COLOR && (
                    <button
                      type="button"
                      onClick={() => setMarkColor(DEFAULT_MARK_COLOR)}
                      className="text-2xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <RefreshCw className="size-3" />
                      恢复默认
                    </button>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-5">
                  {/* Live preview. The mark reads the same CSS variable the
                      swatches write, so this needs no props to stay in sync. */}
                  <div className="shrink-0 size-24 rounded-xl bg-surface0 border border-border/40 flex items-center justify-center">
                    <SignalMark size={56} title="标识预览" />
                  </div>

                  <div className="min-w-0 flex-1 space-y-3">
                    <p className="text-xs text-foreground-muted">
                      选择 SignalMark 的主体颜色。侧边栏、空状态、分享页与消息头像会同时更新，五官保持固定深色以确保各配色下都清晰可辨。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {MARK_COLOR_PRESETS.map((preset) => {
                        const active = markColor === preset.value;
                        return (
                          <button
                            key={preset.value}
                            type="button"
                            onClick={() => setMarkColor(preset.value)}
                            title={`${preset.label} · ${preset.sublabel}`}
                            aria-label={`${preset.label} ${preset.sublabel}`}
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
                        );
                      })}
                    </div>
                    <p className="text-3xs text-foreground-extra-muted font-mono">
                      当前：{MARK_COLOR_PRESETS.find((p) => p.value === markColor)?.label ?? '自定义'} · {markColor.toUpperCase()}
                    </p>
                  </div>
                </div>
              </div>

              {/* Section 3: Desktop & System Integration */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/30 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Monitor className="size-4 text-primary" />
                    桌面端与快捷键
                  </h2>
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                    {isDesktop ? '桌面客户端已激活' : '网页端模式'}
                  </span>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-surface0 border border-border/40">
                    <div>
                      <p className="text-sm font-medium text-foreground">开机自动启动</p>
                      <p className="text-xs text-foreground-muted mt-0.5">电脑开机时自动在系统托盘静默启动 52hzAgents</p>
                    </div>
                    <button
                      onClick={handleToggleAutostart}
                      disabled={!isDesktop}
                      className="text-primary hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-30"
                    >
                      {autostart ? <ToggleRight className="size-7 text-primary" /> : <ToggleLeft className="size-7 text-foreground-muted" />}
                    </button>
                  </div>

                  <div className="p-3.5 rounded-xl bg-surface0 border border-border/40 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">Quick Bar 全局快捷键</p>
                      <p className="text-xs text-foreground-muted mt-0.5">在系统任意界面随时呼出 Raycast 风格 AI 快捷指令栏</p>
                    </div>
                    <kbd className="px-2.5 py-1 rounded bg-surface2 border border-border text-xs font-mono font-medium text-foreground">
                      Alt + Space
                    </kbd>
                  </div>
                </div>
              </div>

              {/* Section 4: Team Collaborators */}
              <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/30 pb-3">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <Users className="size-4 text-primary" />
                    工作区成员协作
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
                      添加成员
                    </Button>
                  </div>

                  <div className="divide-y divide-border/30 rounded-xl bg-surface0 border border-border/40 overflow-hidden">
                    {collaborators.length === 0 ? (
                      <div className="p-4 text-center text-xs text-foreground-muted">
                        当前工作区暂无其他协作成员
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
                            移除
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
                      <span>返回智能体列表</span>
                    </button>
                  </div>
                  <div className="rounded-2xl border border-border/40 bg-surface1 p-6">
                    <ConnectAgentView />
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between p-6 rounded-2xl bg-surface1 border border-border/40 shadow-sm">
                    <div>
                      <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                        <Users className="size-5 text-primary" />
                        智能体接入与角色管理
                      </h2>
                      <p className="text-xs text-foreground-muted mt-1">
                        共接入 {agents.length} 个智能体（{agents.filter(a => a.status === 'online').length} 个在线）。支持一键指定对话 Leader、配置专属角色或接入新 Agent。
                      </p>
                    </div>

                    <Button
                      onClick={() => setShowConnectAgent(true)}
                      className="bg-primary text-primary-foreground text-xs h-8.5 px-3.5 flex items-center gap-1.5 shadow-xs cursor-pointer"
                    >
                      <Plug className="size-3.5" />
                      <span>接入新智能体</span>
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {agents.length === 0 ? (
                      <div className="col-span-2 p-10 rounded-2xl bg-surface1 border border-border/40 text-center space-y-3">
                        <div className="size-12 rounded-2xl bg-surface2 mx-auto flex items-center justify-center text-foreground-muted">
                          <Bot className="size-6" />
                        </div>
                        <h3 className="text-sm font-semibold text-foreground">暂无在线智能体</h3>
                        <p className="text-xs text-foreground-muted max-w-sm mx-auto">
                          当前工作区尚未连接 Agent。点击右上角「接入新智能体」快速接入 Claude CLI、Antigravity、OpenClaw 或自定义智能体。
                        </p>
                        <Button
                          onClick={() => setShowConnectAgent(true)}
                          size="sm"
                          className="text-xs mt-2"
                        >
                          立即接入 Agent
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
                            className="p-4 rounded-2xl bg-surface1 border border-border/40 shadow-xs flex flex-col justify-between space-y-3 hover:border-border/80 transition-colors"
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
                                <button
                                  type="button"
                                  onClick={() => handleToggleAgentAutostart(agent.agentName, !!agent.autostart)}
                                  className={cn(
                                    'inline-flex items-center gap-1 text-3xs px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer border',
                                    agent.autostart
                                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                                      : 'bg-surface2/60 border-border/40 text-foreground-extra-muted hover:text-foreground-muted'
                                  )}
                                  title={agent.autostart ? '已开启应用启动时自动连接（点击关闭）' : '未开启应用启动时自动连接（点击开启）'}
                                >
                                  <Power className="size-2.5" />
                                  <span>{agent.autostart ? '自启动' : '手动'}</span>
                                </button>

                                <span className={cn(
                                  'text-3xs px-2 py-0.5 rounded-full font-medium',
                                  isOnline ? 'bg-status-success/10 text-status-success' : 'bg-surface2 text-foreground-muted'
                                )}>
                                  {isOnline ? '在线' : '离线'}
                                </span>
                              </div>
                            </div>

                            <p className="text-xs text-foreground-muted line-clamp-2 leading-relaxed">
                              {agent.description || '暂无详细描述。点击下方配置可自定义此 Agent 的提示词与能力职责。'}
                            </p>

                            <div className="pt-2 border-t border-border/30 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                {currentSessionId && (
                                  <button
                                    onClick={() => setSessionMaster(currentSessionId, agent.agentName)}
                                    className={cn(
                                      'px-2 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer inline-flex items-center gap-1',
                                      isMaster ? 'bg-status-warning/15 text-status-warning font-medium' : 'bg-surface2 text-foreground-muted hover:text-foreground'
                                    )}
                                    title="设为此对话的 Leader 主导智能体"
                                  >
                                    <Crown className="size-3" />
                                    <span>{isMaster ? '主导者' : '设为 Leader'}</span>
                                  </button>
                                )}

                                {currentSessionId && (
                                  inCurrentSession ? (
                                    <button
                                      onClick={() => removeParticipant(currentSessionId, agent.agentName)}
                                      className="px-2 py-1 rounded-lg text-xs font-medium bg-surface2 text-status-danger hover:bg-status-danger/10 transition-colors cursor-pointer"
                                    >
                                      移出会话
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => addParticipant(currentSessionId, agent.agentName)}
                                      className="px-2 py-1 rounded-lg text-xs font-medium bg-surface2 text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                                    >
                                      加入会话
                                    </button>
                                  )
                                )}
                              </div>

                              <button
                                onClick={() => setSelectedAgentName(agent.agentName)}
                                className="text-xs text-foreground-muted hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
                              >
                                <span>角色配置</span>
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
              <div className="p-6 rounded-2xl bg-surface1 border border-border/40 shadow-sm space-y-2">
                <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <PanelRight className="size-5 text-primary" />
                  辅助侧边面板与预览配置
                </h2>
                <p className="text-xs text-foreground-muted leading-relaxed">
                  在对话主界面右侧提供沉浸式的多模态协同面板（浏览器、代码产物、任务看板、雷达拓扑与终端日志）。
                </p>
              </div>

              {/* Split Browser Toggle */}
              <div className="p-5 rounded-2xl bg-surface1 border border-border/40 shadow-xs flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Globe className="size-4 text-primary" />
                    分屏浏览器模式 (Split Browser)
                  </h3>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    在主界面将浏览器与对话窗口并排分屏显示，适合网页开发、自动化调试与实时巡检。
                  </p>
                </div>
                <button
                  onClick={() => {
                    const next = !splitBrowser;
                    setSplitBrowser(next);
                    toast.success(next ? '已开启分屏浏览器模式' : '已关闭分屏浏览器模式');
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
                          : 'bg-surface1 border-border/40 hover:border-border/80'
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
                            <span className="text-3xs text-foreground-extra-muted font-mono">{panel.sublabel}</span>
                          </div>
                        </div>

                        <span className={cn(
                          'text-3xs px-2 py-0.5 rounded-full font-medium',
                          isActive ? 'bg-primary/15 text-primary' : 'bg-surface2 text-foreground-extra-muted'
                        )}>
                          {isActive ? '已激活' : '未开启'}
                        </span>
                      </div>

                      <p className="text-xs text-foreground-muted leading-relaxed">
                        {panel.desc}
                      </p>

                      <div className="pt-2 border-t border-border/30 flex items-center justify-between">
                        <span className="text-2xs text-foreground-extra-muted">右侧快捷面板</span>
                        <Button
                          variant={isActive ? 'primary' : 'outline'}
                          size="sm"
                          onClick={() => {
                            setActiveRightTab(isActive ? null : panel.id);
                            toast.success(isActive ? `已关闭 ${panel.name}` : `已打开 ${panel.name}`);
                          }}
                          className="h-7.5 px-3 text-xs cursor-pointer"
                        >
                          {isActive ? '关闭面板' : '打开预览'}
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
              <div className="p-6 rounded-2xl bg-surface1 border border-border/40 shadow-sm space-y-2">
                <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <Download className="size-5 text-primary" />
                  会话数据导出与公开分享
                </h2>
                <p className="text-xs text-foreground-muted leading-relaxed">
                  将多智能体协作讨论记录、执行代码与关键成果导出为标准 Markdown，或生成只读安全分享链接。
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Export Markdown */}
                <div className="p-5 rounded-2xl bg-surface1 border border-border/40 shadow-xs space-y-4 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                      <FileText className="size-5" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">导出当前会话为 Markdown</h3>
                    <p className="text-xs text-foreground-muted leading-relaxed">
                      将当前正在进行的对话历史、智能体思考推理与产出的代码块完整保存为单文件 `.md` 格式，方便导入 Notion 或 Obsidian 归档。
                    </p>
                  </div>

                  <Button
                    onClick={handleExportCurrentMarkdown}
                    disabled={exporting}
                    className="w-full bg-primary text-primary-foreground text-xs h-9 flex items-center justify-center gap-2 cursor-pointer shadow-xs"
                  >
                    {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    <span>{exporting ? '正在导出...' : '一键导出 Markdown (.md)'}</span>
                  </Button>
                </div>

                {/* Public Share Link */}
                <div className="p-5 rounded-2xl bg-surface1 border border-border/40 shadow-xs space-y-4 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="size-10 rounded-xl bg-status-success/10 text-status-success flex items-center justify-center">
                      <Share2 className="size-5" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">工作区公开只读分享</h3>
                    <p className="text-xs text-foreground-muted leading-relaxed">
                      生成安全只读只看链接，允许团队成员或外部访客无需登录即可浏览当前工作区的实时对话与产物。
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={workspaceShareUrl}
                        className="bg-surface0 border-border/40 font-mono text-xs text-foreground-muted h-9 select-all"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          copyShare(workspaceShareUrl);
                          toast.success('分享链接已复制到剪贴板');
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
