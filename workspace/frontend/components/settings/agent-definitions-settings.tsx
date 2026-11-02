'use client';

import * as React from 'react';
import {
  Bot,
  Plus,
  RefreshCw,
  Edit2,
  Trash2,
  Power,
  Shield,
  FileCode,
  Terminal,
  Database,
  Cpu,
  Layers,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Check,
  MessageSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { workspaceApi, type AgentDefinition, type AgentIdentityInput } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ConnectionItem } from './router-provider-settings';

interface AgentDefinitionsSettingsProps {
  onManageConnections?: () => void;
  onSelectAgentForChat?: (agentId: string) => void;
}

export function AgentDefinitionsSettings({
  onManageConnections,
  onSelectAgentForChat,
}: AgentDefinitionsSettingsProps) {
  const [agents, setAgents] = React.useState<AgentDefinition[]>([]);
  const [connections, setConnections] = React.useState<ConnectionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  // Edit / Create Dialog State
  const [isEditing, setIsEditing] = React.useState(false);
  const [editingAgent, setEditingAgent] = React.useState<AgentDefinition | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Form Fields
  const [formName, setFormName] = React.useState('');
  const [formRole, setFormRole] = React.useState('assistant');
  const [formDescription, setFormDescription] = React.useState('');
  const [formInstructions, setFormInstructions] = React.useState('');
  const [formDefaultMode, setFormDefaultMode] = React.useState<'chat' | 'plan' | 'agent'>('chat');
  const [formMaxMode, setFormMaxMode] = React.useState<'chat' | 'plan' | 'agent'>('agent');
  const [formStatus, setFormStatus] = React.useState<'active' | 'disabled'>('active');

  // Permissions (conservative defaults)
  const [permReadFiles, setPermReadFiles] = React.useState(true);
  const [permWriteFiles, setPermWriteFiles] = React.useState(false);
  const [permExecuteCommands, setPermExecuteCommands] = React.useState(false);
  const [permKnowledge, setPermKnowledge] = React.useState(true);
  const [permMcp, setPermMcp] = React.useState(false);
  const [permDelegate, setPermDelegate] = React.useState(false);

  // Resource
  const [hasCustomResource, setHasCustomResource] = React.useState(false);
  const [formConnectionId, setFormConnectionId] = React.useState('');
  const [formModelId, setFormModelId] = React.useState('');
  const [formMaxOutputTokens, setFormMaxOutputTokens] = React.useState('');

  // Limits (optional accordion)
  const [showLimits, setShowLimits] = React.useState(false);
  const [limitTokens, setLimitTokens] = React.useState('');
  const [limitSteps, setLimitSteps] = React.useState('');
  const [limitDuration, setLimitDuration] = React.useState('');
  const [limitCost, setLimitCost] = React.useState('');

  // Conflict / Draft retention
  const [conflictDraft, setConflictDraft] = React.useState<string | null>(null);

  const loadData = React.useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const [agentsRes, connRes] = await Promise.all([
        workspaceApi.listAgentDefinitions(true),
        workspaceApi.request<{ connections: ConnectionItem[] }>('/v1/settings/connections').catch(() => ({ connections: [] })),
      ]);
      setAgents(agentsRes?.agents || []);
      setConnections(connRes?.connections || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载 Agent 列表失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const openCreate = () => {
    setEditingAgent(null);
    setFormName('');
    setFormRole('assistant');
    setFormDescription('');
    setFormInstructions('');
    setFormDefaultMode('chat');
    setFormMaxMode('agent');
    setFormStatus('active');
    // Conservative defaults
    setPermReadFiles(true);
    setPermWriteFiles(false);
    setPermExecuteCommands(false);
    setPermKnowledge(true);
    setPermMcp(false);
    setPermDelegate(false);

    // Default resource if any connection exists
    if (connections.length > 0) {
      const first = connections.find((c) => c.hasCredential || c.protocol === 'ollama') || connections[0];
      setHasCustomResource(true);
      setFormConnectionId(first.id);
      setFormModelId(first.defaultModel || '');
    } else {
      setHasCustomResource(false);
      setFormConnectionId('');
      setFormModelId('');
    }
    setFormMaxOutputTokens('');

    setShowLimits(false);
    setLimitTokens('');
    setLimitSteps('');
    setLimitDuration('');
    setLimitCost('');
    setConflictDraft(null);
    setIsEditing(true);
  };

  const openEdit = (agent: AgentDefinition) => {
    setEditingAgent(agent);
    setFormName(agent.name);
    setFormRole(agent.role || 'assistant');
    setFormDescription(agent.description || '');
    setFormInstructions(agent.instructions || '');
    setFormDefaultMode(agent.defaultMode || 'chat');
    setFormMaxMode(agent.maxMode || 'agent');
    setFormStatus(agent.status || 'active');

    // Permissions
    setPermReadFiles(agent.permissions?.readFiles ?? true);
    setPermWriteFiles(agent.permissions?.writeFiles ?? false);
    setPermExecuteCommands(agent.permissions?.executeCommands ?? false);
    setPermKnowledge(agent.permissions?.knowledge ?? true);
    setPermMcp(agent.permissions?.mcp ?? false);
    setPermDelegate(agent.permissions?.delegate ?? false);

    // Resource
    if (agent.modelResource) {
      setHasCustomResource(true);
      setFormConnectionId(agent.modelResource.connectionId);
      setFormModelId(agent.modelResource.modelId);
      setFormMaxOutputTokens(agent.modelResource.maxOutputTokens ? String(agent.modelResource.maxOutputTokens) : '');
    } else {
      setHasCustomResource(false);
      if (connections.length > 0) {
        setFormConnectionId(connections[0].id);
        setFormModelId(connections[0].defaultModel || '');
      } else {
        setFormConnectionId('');
        setFormModelId('');
      }
      setFormMaxOutputTokens('');
    }

    // Limits
    const lim = agent.limits || {};
    const hasAnyLimit = Boolean(lim.maxTokensPerRun || lim.maxStepsPerRun || lim.maxDurationSeconds || lim.maxCostPerRun);
    setShowLimits(hasAnyLimit);
    setLimitTokens(lim.maxTokensPerRun ? String(lim.maxTokensPerRun) : '');
    setLimitSteps(lim.maxStepsPerRun ? String(lim.maxStepsPerRun) : '');
    setLimitDuration(lim.maxDurationSeconds ? String(lim.maxDurationSeconds) : '');
    setLimitCost(lim.maxCostPerRun ? String(lim.maxCostPerRun) : '');
    setConflictDraft(null);
    setIsEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = formName.trim();
    if (!trimmedName) {
      toast.error('请输入 Agent 名称');
      return;
    }

    const payload: AgentIdentityInput = {
      name: trimmedName,
      role: formRole.trim() || 'assistant',
      description: formDescription.trim(),
      instructions: formInstructions,
      defaultMode: formDefaultMode,
      maxMode: formMaxMode,
      status: formStatus,
      permissions: {
        readFiles: permReadFiles,
        writeFiles: permWriteFiles,
        executeCommands: permExecuteCommands,
        knowledge: permKnowledge,
        mcp: permMcp,
        delegate: permDelegate,
      },
      modelResource: hasCustomResource && formConnectionId && formModelId.trim()
        ? {
            connectionId: formConnectionId,
            modelId: formModelId.trim(),
            ...(formMaxOutputTokens.trim() && !isNaN(Number(formMaxOutputTokens))
              ? { maxOutputTokens: parseInt(formMaxOutputTokens, 10) }
              : {}),
          }
        : null,
      limits: {
        maxTokensPerRun: limitTokens ? parseInt(limitTokens, 10) : null,
        maxStepsPerRun: limitSteps ? parseInt(limitSteps, 10) : null,
        maxDurationSeconds: limitDuration ? parseInt(limitDuration, 10) : null,
        maxCostPerRun: limitCost ? parseFloat(limitCost) : null,
      },
    };

    setSaving(true);
    try {
      if (editingAgent) {
        await workspaceApi.updateAgentDefinition(editingAgent.id, {
          ...payload,
          expectedRevision: editingAgent.revision,
        });
        toast.success(`Agent "${trimmedName}" 已更新`);
      } else {
        await workspaceApi.createAgentDefinition(payload);
        toast.success(`Agent "${trimmedName}" 已创建`);
      }
      setIsEditing(false);
      setEditingAgent(null);
      await loadData(true);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('409') || errorMsg.includes('revision') || errorMsg.includes('modified')) {
        setConflictDraft(JSON.stringify(payload, null, 2));
        toast.error('版本冲突：该 Agent 已被其他操作修改，请重新加载后核对。当前草稿已保留。');
      } else {
        toast.error(`保存失败: ${errorMsg}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (agent: AgentDefinition) => {
    const nextStatus = agent.status === 'active' ? 'disabled' : 'active';
    try {
      await workspaceApi.updateAgentDefinition(agent.id, {
        status: nextStatus,
        expectedRevision: agent.revision,
      });
      toast.success(nextStatus === 'active' ? `已启用 ${agent.name}` : `已停用 ${agent.name}`);
      await loadData(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新状态失败');
    }
  };

  const handleDelete = async (agent: AgentDefinition) => {
    if (agent.builtIn) {
      toast.error('内置 Agent 无法删除');
      return;
    }
    if (!window.confirm(`确定要删除 Agent "${agent.name}" 吗？此操作不可逆。`)) {
      return;
    }
    try {
      await workspaceApi.deleteAgentDefinition(agent.id, agent.revision);
      toast.success(`已删除 Agent "${agent.name}"`);
      await loadData(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const checkReadiness = (agent: AgentDefinition) => {
    if (!agent.modelResource) {
      return {
        ready: false,
        label: '未绑定模型资源',
        reason: '该 Agent 未配置独立的执行资源，将继承系统默认连接。',
        warning: false,
      };
    }
    const conn = connections.find((c) => c.id === agent.modelResource?.connectionId);
    if (!conn) {
      return {
        ready: false,
        label: '连接不存在',
        reason: `引用的连接 "${agent.modelResource.connectionId}" 未在系统中注册。`,
        warning: true,
      };
    }
    if (conn.protocol !== 'ollama' && !conn.hasCredential) {
      return {
        ready: false,
        label: '缺少凭据',
        reason: `连接 "${conn.name || conn.id}" 尚未配置 API Key。`,
        warning: true,
      };
    }
    return {
      ready: true,
      label: '就绪',
      reason: `${conn.name || conn.id} · ${agent.modelResource.modelId}`,
      warning: false,
    };
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/60">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            <span>Agent 智能体管理</span>
          </h2>
          <p className="text-2xs text-foreground-muted mt-0.5">
            Agent 是具备独立职责、指令与工具权限的执行主体。模型连接作为其底层执行资源按需配置。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onManageConnections && (
            <Button
              variant="outline"
              size="sm"
              onClick={onManageConnections}
              className="text-xs h-8 gap-1.5"
            >
              <Cpu className="size-3.5 text-foreground-muted" />
              <span>资源连接配置</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadData(true)}
            disabled={loading || refreshing}
            className="text-xs h-8 gap-1.5"
            title="刷新列表"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            <span>刷新</span>
          </Button>
          <Button
            size="sm"
            onClick={openCreate}
            className="text-xs h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-3.5" />
            <span>新建 Agent</span>
          </Button>
        </div>
      </div>

      {/* Main List */}
      {loading ? (
        <div className="p-12 text-center text-xs text-foreground-muted flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span>正在加载 Agent 列表...</span>
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 p-10 text-center">
          <Bot className="size-8 mx-auto text-foreground-muted/40 mb-3" />
          <h3 className="text-xs font-medium text-foreground">暂无自定义 Agent</h3>
          <p className="text-2xs text-foreground-muted mt-1 max-w-sm mx-auto">
            创建具有特定职责和工具权限的 Agent，协同完成复杂的编码与分析任务。
          </p>
          <Button size="sm" onClick={openCreate} className="mt-4 text-xs h-8 gap-1.5">
            <Plus className="size-3.5" />
            <span>创建第一个 Agent</span>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5">
          {agents.map((agent) => {
            const readiness = checkReadiness(agent);
            const isBuiltIn = agent.builtIn;
            const isDisabled = agent.status === 'disabled';

            return (
              <div
                key={agent.id}
                className={cn(
                  'rounded-xl border border-border/70 bg-surface1/60 p-4 transition-all duration-150 hover:border-border hover:shadow-xs',
                  isDisabled && 'opacity-65 bg-surface1/30'
                )}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="size-9 rounded-lg bg-surface2 border border-border/60 flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">
                      <Bot className={cn('size-4', isBuiltIn ? 'text-primary' : 'text-foreground')} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-xs sm:text-sm text-foreground truncate">
                          {agent.name}
                        </span>
                        {isBuiltIn && (
                          <Badge variant="outline" size="sm" className="text-3xs text-foreground-muted">
                            内置
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          size="sm"
                          className="text-3xs uppercase tracking-wider text-foreground-muted"
                        >
                          {agent.role}
                        </Badge>
                        {isDisabled && (
                          <Badge variant="warning" size="sm" className="text-3xs">
                            已停用
                          </Badge>
                        )}
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 text-3xs font-medium px-1.5 py-0.5 rounded-md border',
                            readiness.ready
                              ? 'border-status-success/30 bg-status-success/10 text-status-success'
                              : readiness.warning
                              ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
                              : 'border-border/60 bg-surface2 text-foreground-muted'
                          )}
                          title={readiness.reason}
                        >
                          {readiness.ready ? (
                            <CheckCircle2 className="size-2.5" />
                          ) : (
                            <AlertTriangle className="size-2.5" />
                          )}
                          <span>{readiness.label}</span>
                        </span>
                      </div>

                      {agent.description ? (
                        <p className="text-2xs text-foreground-muted mt-1 line-clamp-2">
                          {agent.description}
                        </p>
                      ) : (
                        <p className="text-2xs text-foreground-extra-muted mt-1 italic">
                          暂无描述
                        </p>
                      )}

                      {/* Capabilities pill tags */}
                      <div className="flex items-center gap-2 mt-2.5 flex-wrap text-3xs text-foreground-extra-muted">
                        <span className="flex items-center gap-1" title="默认与最高模式">
                          <Layers className="size-3 text-foreground-muted" />
                          <span>
                            {agent.defaultMode} → {agent.maxMode}
                          </span>
                        </span>
                        <span className="text-border/70">·</span>
                        <span className="flex items-center gap-1">
                          <FileCode
                            className={cn(
                              'size-3',
                              agent.permissions.writeFiles ? 'text-primary' : 'text-foreground-extra-muted'
                            )}
                          />
                          <span>
                            {agent.permissions.writeFiles ? '写文件' : '只读'}
                          </span>
                        </span>
                        <span className="text-border/70">·</span>
                        <span className="flex items-center gap-1">
                          <Terminal
                            className={cn(
                              'size-3',
                              agent.permissions.executeCommands ? 'text-status-warning' : 'text-foreground-extra-muted'
                            )}
                          />
                          <span>
                            {agent.permissions.executeCommands ? '终端命令' : '无终端'}
                          </span>
                        </span>
                        {agent.modelResource && (
                          <>
                            <span className="text-border/70">·</span>
                            <span className="font-mono text-foreground-muted truncate max-w-xs">
                              {agent.modelResource.connectionId} / {agent.modelResource.modelId}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Row Operations */}
                  <div className="flex items-center gap-1 self-end sm:self-center shrink-0">
                    {onSelectAgentForChat && !isDisabled && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSelectAgentForChat(agent.id)}
                        className="h-7 px-2 text-2xs gap-1 text-primary hover:text-primary hover:bg-primary/10"
                        title="以此 Agent 新建会话"
                      >
                        <MessageSquare className="size-3" />
                        <span>对话</span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(agent)}
                      className="h-7 px-2 text-2xs gap-1 text-foreground-muted hover:text-foreground"
                      title="编辑配置"
                    >
                      <Edit2 className="size-3" />
                      <span>编辑</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleToggleStatus(agent)}
                      className={cn(
                        'h-7 px-2 text-2xs gap-1',
                        isDisabled
                          ? 'text-status-success hover:text-status-success hover:bg-status-success/10'
                          : 'text-foreground-muted hover:text-status-warning'
                      )}
                      title={isDisabled ? '启用此 Agent' : '停用此 Agent'}
                    >
                      <Power className="size-3" />
                      <span>{isDisabled ? '启用' : '停用'}</span>
                    </Button>
                    {!isBuiltIn && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDelete(agent)}
                        className="h-7 px-2 text-2xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                        title="删除 Agent"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Create Form Modal */}
      {isEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-2xl border border-border/80 bg-surface1 p-6 shadow-xl space-y-6 my-auto">
            <div className="flex items-center justify-between pb-3 border-b border-border/60">
              <div className="flex items-center gap-2">
                <Bot className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">
                  {editingAgent ? `编辑 Agent · ${editingAgent.name}` : '新建 Agent'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="text-xs text-foreground-muted hover:text-foreground"
              >
                取消
              </button>
            </div>

            {conflictDraft && (
              <div className="rounded-xl border border-status-warning/40 bg-status-warning/10 p-3 text-2xs text-status-warning space-y-2">
                <p className="font-semibold">检测到配置冲突：已被其他进程更新。请核对下方草稿。</p>
                <textarea
                  readOnly
                  rows={4}
                  value={conflictDraft}
                  className="w-full rounded bg-surface0 p-2 font-mono text-3xs border border-border"
                />
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-5 text-xs">
              {/* Group 1: 身份与职责 */}
              <div className="space-y-3">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                  <Bot className="size-3 text-primary" />
                  <span>身份与职责</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2 space-y-1">
                    <Label className="text-2xs text-foreground-muted">Agent 名称 *</Label>
                    <Input
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="例如：系统架构师、代码重构助手"
                      required
                      className="h-8 text-xs bg-surface0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-2xs text-foreground-muted">角色类型</Label>
                    <Input
                      value={formRole}
                      onChange={(e) => setFormRole(e.target.value)}
                      placeholder="assistant"
                      className="h-8 text-xs bg-surface0"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-2xs text-foreground-muted">职责描述</Label>
                  <Input
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="简述此 Agent 的专长与职责..."
                    className="h-8 text-xs bg-surface0"
                  />
                </div>
              </div>

              {/* Group 2: 工作指令 */}
              <div className="space-y-2">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                  <Info className="size-3 text-primary" />
                  <span>工作指令 (System Instructions)</span>
                </h4>
                <Textarea
                  value={formInstructions}
                  onChange={(e) => setFormInstructions(e.target.value)}
                  placeholder="为该 Agent 设定专有的行为准则、思维框架与输出偏好..."
                  rows={4}
                  className="text-xs bg-surface0 resize-y"
                />
              </div>

              {/* Group 3: 能力与权限 (Conservative Defaults) */}
              <div className="space-y-2.5">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                  <Shield className="size-3 text-primary" />
                  <span>工具与能力权限</span>
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 p-3 rounded-xl bg-surface2/40 border border-border/50">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={permReadFiles}
                      onChange={(e) => setPermReadFiles(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>读取项目文件</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={permWriteFiles}
                      onChange={(e) => setPermWriteFiles(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>修改项目文件</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={permExecuteCommands}
                      onChange={(e) => setPermExecuteCommands(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>执行终端命令</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={permKnowledge}
                      onChange={(e) => setPermKnowledge(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>访问知识库</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={permMcp}
                      onChange={(e) => setPermMcp(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>调用 MCP 扩展</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={permDelegate}
                      onChange={(e) => setPermDelegate(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>委派子任务</span>
                  </label>
                </div>
              </div>

              {/* Group 4: 默认工作方式 */}
              <div className="space-y-2.5">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                  <Layers className="size-3 text-primary" />
                  <span>工作方式限制</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-2xs text-foreground-muted">默认工作模式</Label>
                    <select
                      value={formDefaultMode}
                      onChange={(e) => setFormDefaultMode(e.target.value as 'chat' | 'plan' | 'agent')}
                      className="w-full h-8 rounded-lg border border-border bg-surface0 px-2 text-xs text-foreground"
                    >
                      <option value="chat">对话 (Chat)</option>
                      <option value="plan">只读分析 (Plan)</option>
                      <option value="agent">实施修改 (Agent)</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-2xs text-foreground-muted">允许最高模式</Label>
                    <select
                      value={formMaxMode}
                      onChange={(e) => setFormMaxMode(e.target.value as 'chat' | 'plan' | 'agent')}
                      className="w-full h-8 rounded-lg border border-border bg-surface0 px-2 text-xs text-foreground"
                    >
                      <option value="chat">对话 (Chat)</option>
                      <option value="plan">只读分析 (Plan)</option>
                      <option value="agent">实施修改 (Agent)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Group 5: 执行资源 (高级) */}
              <div className="space-y-2.5 pt-2 border-t border-border/50">
                <div className="flex items-center justify-between">
                  <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                    <Cpu className="size-3 text-primary" />
                    <span>执行资源 (模型与连接引用)</span>
                  </h4>
                  <label className="flex items-center gap-1.5 text-2xs cursor-pointer text-foreground-muted">
                    <input
                      type="checkbox"
                      checked={hasCustomResource}
                      onChange={(e) => setHasCustomResource(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>自定义独立模型资源</span>
                  </label>
                </div>

                {hasCustomResource ? (
                  <div className="space-y-3 p-3 rounded-xl bg-surface2/30 border border-border/50">
                    <p className="text-2xs text-foreground-muted">
                      指定此 Agent 专用的模型连接。不配置则自动继承系统默认连接。
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-2xs text-foreground-muted">模型连接</Label>
                        <select
                          value={formConnectionId}
                          onChange={(e) => {
                            setFormConnectionId(e.target.value);
                            const conn = connections.find((c) => c.id === e.target.value);
                            if (conn?.defaultModel) setFormModelId(conn.defaultModel);
                          }}
                          className="w-full h-8 rounded-lg border border-border bg-surface0 px-2 text-xs text-foreground"
                        >
                          {connections.length === 0 ? (
                            <option value="">暂无可用连接</option>
                          ) : (
                            connections.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name || c.id} ({c.protocol}) {c.hasCredential ? '· 已配置' : '· 未配密钥'}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-2xs text-foreground-muted">模型 ID</Label>
                        <Input
                          value={formModelId}
                          onChange={(e) => setFormModelId(e.target.value)}
                          placeholder="例如：claude-3-7-sonnet-20250219"
                          className="h-8 text-xs bg-surface0"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-2xs text-foreground-muted">最大输出 Token (选填)</Label>
                      <Input
                        type="number"
                        value={formMaxOutputTokens}
                        onChange={(e) => setFormMaxOutputTokens(e.target.value)}
                        placeholder="留空使用连接默认"
                        className="h-8 text-xs bg-surface0 w-48"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-2xs text-foreground-extra-muted italic">
                    未配置独立资源，将继承全局连接。
                  </p>
                )}
              </div>

              {/* Group 6: 执行限制 (折叠) */}
              <div className="border-t border-border/50 pt-2">
                <button
                  type="button"
                  onClick={() => setShowLimits(!showLimits)}
                  className="flex items-center gap-1 text-2xs text-foreground-muted hover:text-foreground font-medium"
                >
                  {showLimits ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  <span>高级执行限制 (Token、费用、时长上限)</span>
                </button>
                {showLimits && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-3 p-3 rounded-xl bg-surface2/30 border border-border/50">
                    <div className="space-y-1">
                      <Label className="text-3xs text-foreground-muted">Token 上限/次</Label>
                      <Input
                        type="number"
                        value={limitTokens}
                        onChange={(e) => setLimitTokens(e.target.value)}
                        placeholder="不限"
                        className="h-7 text-xs bg-surface0"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-3xs text-foreground-muted">最大步骤/次</Label>
                      <Input
                        type="number"
                        value={limitSteps}
                        onChange={(e) => setLimitSteps(e.target.value)}
                        placeholder="不限"
                        className="h-7 text-xs bg-surface0"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-3xs text-foreground-muted">最长秒数/次</Label>
                      <Input
                        type="number"
                        value={limitDuration}
                        onChange={(e) => setLimitDuration(e.target.value)}
                        placeholder="不限"
                        className="h-7 text-xs bg-surface0"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-3xs text-foreground-muted">费用上限 USD/次</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={limitCost}
                        onChange={(e) => setLimitCost(e.target.value)}
                        placeholder="不限"
                        className="h-7 text-xs bg-surface0"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Submit Buttons */}
              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-border/60">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                  className="h-8 text-xs"
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={saving}
                  className="h-8 text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving && <Loader2 className="size-3 animate-spin" />}
                  <span>{editingAgent ? '保存修改' : '创建 Agent'}</span>
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
