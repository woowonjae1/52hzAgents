'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Copy, Check, Plus, Globe, Folder, Monitor, UserRoundCog, Cloud, Trash2, KeyRound, RefreshCw, Sparkles, ExternalLink, Terminal, ShieldCheck, ShieldX, Activity, Power, ToggleLeft, ToggleRight, Cpu, ChevronDown } from 'lucide-react';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { parseReportedModels, type AgentModelOption } from '@/components/chat/agent-model-switcher';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { AgentApproval, AgentLogEntry, AgentRuntime, CloudAgentConfig, AgentUsage } from '@/lib/types';

export function AgentProfilePanel() {
  const { selectedAgentName, setSelectedAgentName, isMobile, setViewMode } = useLayout();
  const { agents, refreshWorkspace, createSession } = useWorkspace();
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const agent = agents.find((a) => a.agentName === selectedAgentName);

  const isCloud = agent?.agentType?.startsWith('cloud:') ?? false;
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<AgentModelOption[]>([]);
  // Separate axis from the model; only runtimes that reported levels get a control.
  const [currentEffort, setCurrentEffort] = useState<string | null>(null);
  const [availableEfforts, setAvailableEfforts] = useState<AgentModelOption[]>([]);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [isEnteringCustom, setIsEnteringCustom] = useState(false);

  const refreshDiagnostics = useCallback(async () => {
    if (!agent) return;
    setLoadingDiagnostics(true);
    try {
      const [nextRuntime, nextLogs, nextApprovals, nextUsage] = await Promise.all([
        workspaceApi.getAgentRuntime(agent.agentName),
        workspaceApi.listAgentLogs(agent.agentName, 20),
        workspaceApi.listAgentApprovals('pending'),
        workspaceApi.getAgentUsage(agent.agentName).catch(() => null),
      ]);
      setRuntime(nextRuntime);
      setLogs(nextLogs);
      setApprovals(nextApprovals.filter((approval) => approval.agentName === agent.agentName));
      if (nextUsage) {
        setCurrentModel(nextUsage.current_model || null);
        setAvailableModels(parseReportedModels(nextUsage.available_models));
        setCurrentEffort(nextUsage.current_effort || null);
        setAvailableEfforts(parseReportedModels(nextUsage.available_efforts));
      }
    } catch {
      // A local/cloud agent may not expose bridge diagnostics.
    } finally {
      setLoadingDiagnostics(false);
    }
  }, [agent]);

  // set_model / set_effort reach the adapter over the control channel, which an
  // offline agent is not polling - the change would look accepted and go
  // nowhere, so the controls are disabled rather than failing silently.
  const canConfigure = !!agent && agent.status === 'online';
  const offlineHint = 'Agent 未连接 - 连接后才能切换';

  const handleSwitchEffort = async (level: string) => {
    if (!agent || !canConfigure) return;
    try {
      await workspaceApi.sendAgentControl(agent.agentName, 'set_effort', { effort: level });
      setCurrentEffort(level);
      toast.success(`@${agent.agentName} 推理强度已设为 ${level}`);
    } catch (e) {
      toast.error(`切换推理强度失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleSwitchModel = async (newModelId: string) => {
    if (!agent || switchingModel || !canConfigure) return;
    setSwitchingModel(true);
    try {
      await workspaceApi.sendAgentControl(agent.agentName, 'set_model', { model: newModelId });
      setCurrentModel(newModelId);
      toast.success(`@${agent.agentName} 模型已切换为 ${newModelId}`);
    } catch (e) {
      toast.error(`切换模型失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitchingModel(false);
    }
  };

  useEffect(() => { void refreshDiagnostics(); }, [refreshDiagnostics]);

  const resolveApproval = useCallback(async (approval: AgentApproval, status: 'approved' | 'rejected') => {
    try {
      await workspaceApi.resolveAgentApproval(approval.id, status);
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
      toast.success(status === 'approved' ? 'Approval granted' : 'Approval rejected');
    } catch {
      toast.error('Failed to resolve approval');
    }
  }, []);

  // Cloud agent config
  const [cloudConfig, setCloudConfig] = useState<CloudAgentConfig | null>(null);
  useEffect(() => {
    if (!isCloud || !agent) { setCloudConfig(null); return; }
    workspaceApi.listCloudAgents().then((configs) => {
      setCloudConfig(configs.find((c) => c.agentName === agent.agentName) || null);
    }).catch((error) => {
      // An empty cloud panel used to be indistinguishable from a failed request.
      // eslint-disable-next-line no-console
      console.error('[agent-profile] could not load cloud agent config:', error);
    });
  }, [isCloud, agent?.agentName]);

  const handleRemoveCloudAgent = useCallback(async () => {
    if (!agent) return;
    try {
      await workspaceApi.removeCloudAgent(agent.agentName);
      toast.success(`Removed cloud agent "${agent.agentName}"`);
      setSelectedAgentName(null);
      refreshWorkspace();
    } catch {
      toast.error('Failed to remove cloud agent');
    }
  }, [agent, setSelectedAgentName, refreshWorkspace]);

  // Inline API key update
  const [editingKey, setEditingKey] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  const handleUpdateApiKey = useCallback(async () => {
    if (!agent || !newApiKey) return;
    setSavingKey(true);
    try {
      await workspaceApi.updateCloudAgent(agent.agentName, { apiKey: newApiKey });
      toast.success('API key updated');
      setEditingKey(false);
      setNewApiKey('');
      workspaceApi.listCloudAgents().then((configs) => {
        setCloudConfig(configs.find((c) => c.agentName === agent.agentName) || null);
      }).catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[agent-profile] could not refresh cloud agent config:', error);
      });
    } catch {
      toast.error('Failed to update API key');
    } finally {
      setSavingKey(false);
    }
  }, [agent, newApiKey]);

  useEffect(() => { setEditingKey(false); setNewApiKey(''); }, [agent?.agentName]);

  // Description state — local draft + save
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [descDirty, setDescDirty] = useState(false);
  const [generatingDesc, setGeneratingDesc] = useState(false);

  // Sync description when agent changes
  useEffect(() => {
    if (agent) {
      setDescription(agent.description || '');
      setDescDirty(false);
    }
  }, [agent?.agentName, agent?.description]);

  const handleSaveDescription = useCallback(async () => {
    if (!agent || !descDirty) return;
    setSaving(true);
    try {
      await workspaceApi.updateMember(agent.agentName, { description });
      await refreshWorkspace();
      setDescDirty(false);
      toast.success('Description saved');
    } catch {
      toast.error('Failed to save description');
    } finally {
      setSaving(false);
    }
  }, [agent, description, descDirty, refreshWorkspace]);

  const handleGenerateDescription = useCallback(async () => {
    if (!agent) return;
    setGeneratingDesc(true);
    try {
      const suggestion = await workspaceApi.generateMemberDescription(agent.agentName);
      if (suggestion) {
        setDescription(suggestion);
        setDescDirty(true);
        toast.success('Draft generated — review and save');
      } else {
        toast.error('Could not generate a description');
      }
    } catch {
      toast.error('Failed to generate description');
    } finally {
      setGeneratingDesc(false);
    }
  }, [agent]);

  const [togglingAutostart, setTogglingAutostart] = useState(false);

  const handleToggleAutostart = useCallback(async () => {
    if (!agent) return;
    const nextAutostart = !agent.autostart;
    setTogglingAutostart(true);
    try {
      await workspaceApi.updateMember(agent.agentName, { autostart: nextAutostart });
      await refreshWorkspace();
      toast.success(nextAutostart ? `已开启 @${agent.agentName} 启动自连` : `已关闭 @${agent.agentName} 启动自连`);
    } catch {
      toast.error('更新自启动配置失败');
    } finally {
      setTogglingAutostart(false);
    }
  }, [agent, refreshWorkspace]);

  const handleStartThread = useCallback(async () => {
    if (!agent) return;
    await createSession({ master: agent.agentName, participants: [agent.agentName] });
    setSelectedAgentName(null);
    setViewMode('threads');
  }, [agent, createSession, setSelectedAgentName, setViewMode]);

  if (!agent) return null;

  const isOnline = agent.status === 'online';

  // Capitalize agent type for display (e.g. "claude" → "Claude", "cloud:openai" → "Cloud: OpenAI")
  const displayType = isCloud
    ? `Cloud: ${(agent.agentType || '').replace('cloud:', '').charAt(0).toUpperCase()}${(agent.agentType || '').replace('cloud:', '').slice(1)}`
    : agent.agentType
      ? agent.agentType.charAt(0).toUpperCase() + agent.agentType.slice(1)
      : 'Unknown';

  const infoItems = isCloud
    ? [
        { icon: <Cloud className="size-3.5" />, label: 'Type', value: displayType },
        { icon: <Monitor className="size-3.5" />, label: 'Model', value: cloudConfig?.model || '—' },
        { icon: <Globe className="size-3.5" />, label: 'API Key', value: cloudConfig?.apiKeyMasked || '—' },
        { icon: <UserRoundCog className="size-3.5" />, label: 'Agent ID', value: `openagents:${agent.agentName}`, copyable: true },
      ]
    : [
        { icon: <Monitor className="size-3.5" />, label: 'Type', value: displayType },
        { icon: <Globe className="size-3.5" />, label: 'Server', value: agent.serverHost || '—' },
        { icon: <Folder className="size-3.5" />, label: 'Folder', value: agent.workingDir || '—' },
        { icon: <UserRoundCog className="size-3.5" />, label: 'Agent ID', value: `openagents:${agent.agentName}`, copyable: true },
      ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/10 z-10"
        onClick={() => setSelectedAgentName(null)}
      />

      {/* Panel — full-width on mobile, 320px sidebar on desktop */}
      <div className={cn(
        'absolute top-0 right-0 bottom-0 bg-background border-l shadow-xl z-20 flex flex-col animate-in slide-in-from-right duration-200',
        isMobile ? 'left-0 w-full' : 'w-[320px]'
      )}>
        {/* Close button */}
        <div className="flex items-center justify-end px-3 pt-3">
          <button
            onClick={() => setSelectedAgentName(null)}
            className="size-7 flex items-center justify-center rounded-md hover:bg-surface3/60 dark:hover:bg-primary text-muted-foreground transition-colors"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Profile header */}
        <div className="px-5 pb-4">
          <div className="flex items-center gap-3">
            <AgentAvatar name={agent.agentName} size={40} status={agent.status} showStatus />
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold leading-tight truncate">{agent.agentName}</h3>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={cn(
                  'inline-flex items-center gap-1 text-2xs px-1.5 py-px rounded font-medium',
                  isOnline ? 'bg-status-success/10 text-status-success' : 'bg-surface2 text-foreground-muted dark:text-foreground-extra-muted'
                )}>
                  <span className={cn('size-1.5 rounded-full', isOnline ? 'bg-status-success' : 'bg-foreground-extra-muted')} />
                  {agent.status}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-3.5 space-y-3">
          {/* Description */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-3.5 py-2.5 border-b flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Description</span>
              <button
                onClick={handleGenerateDescription}
                disabled={generatingDesc}
                className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors shrink-0"
                title="Auto-generate a description from this agent's activity and skills"
              >
                {generatingDesc
                  ? <RefreshCw className="size-3 animate-spin" />
                  : <Sparkles className="size-3 text-status-warning" />}
                {generatingDesc ? 'Generating…' : 'Auto-generate'}
              </button>
            </div>
            <div className="p-3">
              <textarea
                className="w-full text-sm leading-relaxed bg-transparent resize-none outline-none placeholder:text-muted-foreground/50 min-h-[60px]"
                placeholder={`Describe what ${agent.agentName} does so other agents know when to delegate work...`}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDescDirty(true);
                }}
                onBlur={handleSaveDescription}
                rows={3}
              />
              {descDirty && (
                <div className="flex justify-end mt-1.5">
                  <button
                    onClick={handleSaveDescription}
                    disabled={saving}
                    className="text-2xs px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-medium transition-colors"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Connection Details */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-3.5 py-2.5 border-b">
              <span className="text-xs font-medium">Connection Details</span>
            </div>
            <div className="divide-y">
              {infoItems.map((item) => (
                <div key={item.label} className="flex items-start gap-3 px-3.5 py-3">
                  <div className="flex items-center gap-1.5 shrink-0 w-[80px] pt-px">
                    <span className="text-muted-foreground">{item.icon}</span>
                    <span className="text-xs text-muted-foreground">{item.label}</span>
                  </div>
                  <div className="flex-1 min-w-0 flex items-start gap-1">
                    <span className={cn(
                      'text-sm break-all leading-snug',
                      item.label !== 'Type' ? 'font-mono' : 'font-medium capitalize'
                    )}>
                      {item.value}
                    </span>
                    {item.copyable && (
                      <button
                        className="size-6 shrink-0 flex items-center justify-center rounded hover:bg-surface2 text-muted-foreground transition-colors mt-px"
                        title={`Copy ${item.label}`}
                        onClick={() => copyToClipboard(item.value)}
                      >
                        {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Autostart on Launch Toggle */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-3.5 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Power className={cn('size-4 shrink-0', agent.autostart ? 'text-primary' : 'text-muted-foreground')} />
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">应用启动时自动连接</div>
                  <div className="text-3xs text-muted-foreground mt-0.5">软件打开时自动拉起并连接此 Agent</div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggleAutostart}
                disabled={togglingAutostart}
                className="text-primary hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-50 shrink-0"
                title={agent.autostart ? '点击关闭自启动' : '点击开启自启动'}
              >
                {agent.autostart ? (
                  <ToggleRight className="size-6 text-primary" />
                ) : (
                  <ToggleLeft className="size-6 text-foreground-muted" />
                )}
              </button>
            </div>
          </div>

          {/* Model Configuration Card */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-3.5 py-2.5 border-b flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Cpu className="size-3 text-primary" />
                <span className="text-xs font-medium">Model Configuration</span>
              </div>
              {switchingModel && <RefreshCw className="size-3 animate-spin text-muted-foreground" />}
            </div>
            <div className="p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-muted-foreground">当前运行模型</span>
                <span className="text-xs font-mono font-medium text-foreground truncate max-w-[180px]">
                  {currentModel || '默认环境配置'}
                </span>
              </div>

              <div className="pt-1">
                <DropdownMenu onOpenChange={(open) => { if (!open) { setIsEnteringCustom(false); setCustomModelInput(''); } }}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={switchingModel || !canConfigure}
                      title={canConfigure ? undefined : offlineHint}
                      className={cn(
                        'w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors',
                        canConfigure
                          ? 'bg-surface2/60 hover:bg-surface2 text-foreground cursor-pointer'
                          : 'bg-surface2/30 text-muted-foreground/60 cursor-not-allowed',
                        'disabled:opacity-50'
                      )}
                    >
                      <span className="truncate">
                        {availableModels.find((m) => m.id === currentModel)?.name || currentModel || '选择或修改模型…'}
                      </span>
                      <ChevronDown className="size-3 text-muted-foreground ml-1 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64 p-1 bg-surface1/95 backdrop-blur-xl max-h-[320px] overflow-y-auto">
                    {availableModels.map((m) => (
                      <DropdownMenuItem
                        key={m.id}
                        onClick={() => handleSwitchModel(m.id)}
                        className={cn(
                          'flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer',
                          currentModel === m.id && 'font-bold text-primary bg-surface3'
                        )}
                      >
                        <span className="truncate">{m.name}</span>
                        {currentModel === m.id && <Check className="size-3 text-primary ml-1" />}
                      </DropdownMenuItem>
                    ))}

                    {isEnteringCustom ? (
                      <div
                        className="p-1.5 space-y-1.5 border-t border-border/30 mt-1"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={customModelInput}
                          onChange={(e) => setCustomModelInput(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter' && customModelInput.trim()) {
                              handleSwitchModel(customModelInput.trim());
                              setIsEnteringCustom(false);
                              setCustomModelInput('');
                            } else if (e.key === 'Escape') {
                              setIsEnteringCustom(false);
                              setCustomModelInput('');
                            }
                          }}
                          placeholder="输入模型 ID (如 gpt-4o)..."
                          className="w-full px-2 py-1 text-2xs font-mono rounded border bg-surface2 outline-none focus:ring-1 focus:ring-primary/40 text-foreground"
                          autoFocus
                        />
                        <div className="flex gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => { setIsEnteringCustom(false); setCustomModelInput(''); }}
                            className="px-2 py-0.5 text-3xs rounded border hover:bg-surface2 text-muted-foreground"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={!customModelInput.trim()}
                            onClick={() => {
                              if (customModelInput.trim()) {
                                handleSwitchModel(customModelInput.trim());
                                setIsEnteringCustom(false);
                                setCustomModelInput('');
                              }
                            }}
                            className="px-2 py-0.5 text-3xs rounded bg-primary text-primary-foreground font-medium disabled:opacity-50"
                          >
                            确定
                          </button>
                        </div>
                      </div>
                    ) : (
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault();
                          setIsEnteringCustom(true);
                          setCustomModelInput(currentModel || '');
                        }}
                        className="flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer text-muted-foreground hover:text-foreground border-t border-border/30 mt-1"
                      >
                        <span>输入自定义模型…</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Reasoning effort - only for runtimes that reported their own
                  levels, so nothing is invented for the ones without the concept. */}
              {availableEfforts.length > 0 && (
                <div className="pt-2 border-t">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-2xs text-muted-foreground">推理强度</span>
                    <span className="text-xs font-mono font-medium text-foreground">
                      {currentEffort || '未配置'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {availableEfforts.map((lv) => (
                      <button
                        key={lv.id}
                        type="button"
                        disabled={!canConfigure}
                        title={canConfigure ? undefined : offlineHint}
                        onClick={() => handleSwitchEffort(lv.id)}
                        className={cn(
                          'px-2 py-0.5 text-2xs rounded border font-mono transition-colors',
                          !canConfigure
                            ? 'bg-surface2/30 text-muted-foreground/60 cursor-not-allowed'
                            : currentEffort === lv.id
                              ? 'bg-primary text-primary-foreground border-primary font-semibold cursor-pointer'
                              : 'bg-surface2/60 hover:bg-surface2 text-muted-foreground hover:text-foreground cursor-pointer'
                        )}
                      >
                        {lv.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Cloud config management */}
          {isCloud && cloudConfig && (
            <div className="rounded-lg border overflow-hidden">
              <div className="px-3.5 py-2.5 border-b">
                <span className="text-xs font-medium">Cloud Configuration</span>
              </div>
              <div className="p-3 space-y-3">
                {/* API Key */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-2xs text-muted-foreground">API Key</span>
                    {!editingKey && (
                      <button
                        onClick={() => setEditingKey(true)}
                        className="flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <KeyRound className="size-2.5" />
                        Update
                      </button>
                    )}
                  </div>
                  {editingKey ? (
                    <div className="flex gap-1.5">
                      <input
                        type="password"
                        value={newApiKey}
                        onChange={(e) => setNewApiKey(e.target.value)}
                        placeholder="New API key..."
                        className="flex-1 min-w-0 px-2 py-1.5 text-xs font-mono rounded border bg-transparent outline-none focus:ring-1 focus:ring-foreground/20"
                        autoFocus
                      />
                      <button
                        onClick={handleUpdateApiKey}
                        disabled={savingKey || !newApiKey}
                        className="px-2 py-1.5 text-3xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {savingKey ? <RefreshCw className="size-2.5 animate-spin" /> : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingKey(false); setNewApiKey(''); }}
                        className="px-2 py-1.5 text-3xs font-medium rounded border hover:bg-surface2 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs font-mono text-muted-foreground">{cloudConfig.apiKeyMasked}</span>
                  )}
                </div>

                {/* System prompt (if set) */}
                {cloudConfig.systemPrompt && (
                  <div>
                    <span className="text-2xs text-muted-foreground">System Prompt</span>
                    <p className="text-xs text-foreground mt-1 whitespace-pre-wrap line-clamp-3">{cloudConfig.systemPrompt}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Runtime, approvals, and bridge diagnostics */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-3.5 py-2.5 border-b flex items-center gap-1.5">
              <Activity className="size-3 text-foreground-muted" />
              <span className="text-xs font-medium">Runtime & approvals</span>
              <button onClick={() => void refreshDiagnostics()} className="ml-auto text-muted-foreground hover:text-foreground" title="Refresh diagnostics">
                <RefreshCw className={cn('size-3', loadingDiagnostics && 'animate-spin')} />
              </button>
            </div>
            <div className="divide-y">
              <div className="px-3.5 py-2.5 text-xs flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Bridge health</span>
                {runtime ? (
                  <span className={cn('font-medium capitalize', runtime.healthStatus === 'healthy' ? 'text-status-success' : runtime.healthStatus === 'unhealthy' ? 'text-status-danger' : 'text-status-warning')}>
                    {runtime.processStatus} · {runtime.healthStatus}
                  </span>
                ) : <span className="text-muted-foreground">No runtime report</span>}
              </div>
              {runtime?.lastError && <p className="px-3.5 py-2 text-2xs text-status-danger bg-surface2 break-words">{runtime.lastError}</p>}
              {approvals.map((approval) => (
                <div key={approval.id} className="px-3.5 py-2.5">
                  <div className="text-xs font-medium break-words">Approval: {approval.action}</div>
                  <div className="mt-2 flex gap-1.5">
                    <button onClick={() => void resolveApproval(approval, 'approved')} className="inline-flex items-center gap-1 px-2 py-1 text-3xs rounded bg-status-success text-white hover:bg-status-success/85"><ShieldCheck className="size-3" />Approve</button>
                    <button onClick={() => void resolveApproval(approval, 'rejected')} className="inline-flex items-center gap-1 px-2 py-1 text-3xs rounded border text-status-danger hover:bg-surface3"><ShieldX className="size-3" />Reject</button>
                  </div>
                </div>
              ))}
              {logs.slice(0, 5).map((entry) => (
                <div key={entry.id} className="px-3.5 py-2 text-2xs font-mono flex gap-1.5">
                  <Terminal className={cn('size-3 shrink-0 mt-0.5', entry.level === 'error' ? 'text-status-danger' : 'text-muted-foreground')} />
                  <span className="break-all">{entry.message}</span>
                </div>
              ))}
              {!runtime && approvals.length === 0 && logs.length === 0 && <p className="px-3.5 py-3 text-xs text-muted-foreground">No bridge diagnostics yet.</p>}
            </div>
          </div>

          {/* Installed Skills */}
          {(() => {
            const installed: string[] = (agent.enabledSkills as Record<string, unknown>)?.installed as string[] || [];
            if (installed.length === 0) return null;
            const SI = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons';
            const SKILL_LOGOS: Record<string, { name: string; logo: string }> = {
              'claude-api': { name: 'Claude API', logo: `${SI}/anthropic.svg` },
              'openai-sdk': { name: 'OpenAI SDK', logo: `${SI}/openai.svg` },
              'langchain': { name: 'LangChain', logo: `${SI}/langchain.svg` },
              'mcp-builder': { name: 'MCP Builder', logo: `${SI}/anthropic.svg` },
              'skill-creator': { name: 'Skill Creator', logo: `${SI}/anthropic.svg` },
              'ai-sdk': { name: 'Vercel AI SDK', logo: `${SI}/vercel.svg` },
              'nextjs': { name: 'Next.js', logo: `${SI}/nextdotjs.svg` },
              'angular': { name: 'Angular', logo: `${SI}/angular.svg` },
              'vue': { name: 'Vue.js', logo: `${SI}/vuedotjs.svg` },
              'svelte': { name: 'Svelte', logo: `${SI}/svelte.svg` },
              'tailwindcss': { name: 'Tailwind CSS', logo: `${SI}/tailwindcss.svg` },
              'frontend-design': { name: 'Frontend Design', logo: `${SI}/anthropic.svg` },
              'fastapi': { name: 'FastAPI', logo: `${SI}/fastapi.svg` },
              'django': { name: 'Django', logo: `${SI}/django.svg` },
              'graphql': { name: 'GraphQL', logo: `${SI}/graphql.svg` },
              'postgresql': { name: 'PostgreSQL', logo: `${SI}/postgresql.svg` },
              'mongodb': { name: 'MongoDB', logo: `${SI}/mongodb.svg` },
              'redis': { name: 'Redis', logo: `${SI}/redis.svg` },
              'prisma': { name: 'Prisma', logo: `${SI}/prisma.svg` },
              'supabase': { name: 'Supabase', logo: `${SI}/supabase.svg` },
              'firebase': { name: 'Firebase', logo: `${SI}/firebase.svg` },
              'github-actions': { name: 'GitHub Actions', logo: `${SI}/githubactions.svg` },
              'sentry': { name: 'Sentry', logo: `${SI}/sentry.svg` },
              'jest': { name: 'Jest', logo: `${SI}/jest.svg` },
              'pytest': { name: 'pytest', logo: `${SI}/pytest.svg` },
              'cypress': { name: 'Cypress', logo: `${SI}/cypress.svg` },
              'stripe': { name: 'Stripe', logo: `${SI}/stripe.svg` },
              'notion': { name: 'Notion', logo: `${SI}/notion.svg` },
              'jira': { name: 'Jira', logo: `${SI}/jira.svg` },
              'shopify': { name: 'Shopify', logo: `${SI}/shopify.svg` },
              'zapier': { name: 'Zapier', logo: `${SI}/zapier.svg` },
              'docx': { name: 'Word Documents', logo: `${SI}/microsoftword.svg` },
              'xlsx': { name: 'Spreadsheets', logo: `${SI}/microsoftexcel.svg` },
              'pptx': { name: 'Presentations', logo: `${SI}/microsoftpowerpoint.svg` },
              'pdf': { name: 'PDF Processing', logo: `${SI}/adobeacrobatreader.svg` },
              'sn-deep-research': { name: 'SenseNova Deep Research', logo: 'https://avatars.githubusercontent.com/u/215225587' },
              'sn-infographic': { name: 'SenseNova Infographic', logo: 'https://avatars.githubusercontent.com/u/215225587' },
              'sn-ppt-entry': { name: 'SenseNova PPT', logo: 'https://avatars.githubusercontent.com/u/215225587' },
              'sn-da-excel-workflow': { name: 'SenseNova Excel Analysis', logo: 'https://avatars.githubusercontent.com/u/215225587' },
              'sn-image-base': { name: 'SenseNova Image Gen', logo: 'https://avatars.githubusercontent.com/u/215225587' },
              'sn-md-to-html-report': { name: 'SenseNova HTML Report', logo: 'https://avatars.githubusercontent.com/u/215225587' },
            };
            return (
              <div className="rounded-lg border overflow-hidden">
                <div className="px-3.5 py-2.5 border-b flex items-center gap-1.5">
                  <Sparkles className="size-3 text-status-warning" />
                  <span className="text-xs font-medium">Installed Skills</span>
                  <span className="text-3xs text-muted-foreground ml-auto">{installed.length}</span>
                </div>
                <div className="divide-y">
                  {installed.map(skillId => {
                    const info = SKILL_LOGOS[skillId];
                    return (
                      <div key={skillId} className="flex items-center gap-2.5 px-3.5 py-2.5">
                        <div className="size-6 rounded bg-muted/60 flex items-center justify-center shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {info ? <img src={info.logo} alt="" className="h-3.5 w-3.5 object-contain dark:invert" /> : <Sparkles className="size-3 text-muted-foreground" />}
                        </div>
                        <span className="text-sm font-medium flex-1 truncate">{info?.name || skillId}</span>
                        <a
                          href={`https://github.com/${skillId.includes('-') ? 'TerminalSkills/skills/tree/main/skills/' : 'anthropics/skills/tree/main/skills/'}${skillId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ExternalLink className="size-3" />
                        </a>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        </div>

        {/* Footer actions */}
        <div className="px-3.5 py-3 border-t">
          <div className="flex gap-2">
            <button
              onClick={handleStartThread}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border bg-background hover:bg-surface1 dark:hover:bg-primary transition-colors"
            >
              <Plus className="size-3" />
              Start a Channel
            </button>
            {isCloud && (
              <button
                onClick={handleRemoveCloudAgent}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-border-accent text-status-danger hover:bg-surface3 transition-colors"
                title="Remove cloud agent"
              >
                <Trash2 className="size-3" />
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
