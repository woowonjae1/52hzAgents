'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
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
  ChevronUp,
  Sliders,
  ChevronRight,
  Info,
  Loader2,
  Check,
  FileEdit,
  MessageSquare,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { workspaceApi, type AgentDefinition, type AgentIdentityInput, type AgentRuntimeKind, type AgentRuntimeStatus } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ConnectionItem } from './router-provider-settings';
import { NativeAgentConnectionsPanel } from './native-agent-connections-panel';
import { AgentSecondaryDetail } from './agent-secondary-detail';

const agentStarters = [
  {
    name: '开发助手',
    role: 'developer',
    description: '分析实现方案，完成有权限执行的代码修改。',
    instructions: '先读取项目规范与相关代码，给出范围明确的实现方案。仅在已获文件修改权限时编辑，命令执行必须遵守审批。报告实际完成的修改、验证结果和未完成项。',
    permissions: { readFiles: true, writeFiles: true, executeCommands: true, knowledge: true, mcp: false, delegate: false },
  },
  {
    name: '代码审阅',
    role: 'reviewer',
    description: '检查变更、潜在缺陷与回归风险，不修改代码。',
    instructions: '检查项目与代码变更。优先报告有证据的缺陷、影响范围、文件位置及验证建议；区分确定的问题与待验证的推断，不声称执行未运行的检查。',
    permissions: { readFiles: true, writeFiles: false, executeCommands: false, knowledge: true, mcp: false, delegate: false },
  },
  {
    name: '测试验证',
    role: 'tester',
    description: '梳理测试场景，检查行为和交付证据。',
    instructions: '根据需求检查实现与测试覆盖，设计能发现实际缺陷的验证场景。未获命令权限和审批时只做分析；获准执行后记录实际结果，不把模拟结果当作真实环境验收。',
    permissions: { readFiles: true, writeFiles: false, executeCommands: true, knowledge: true, mcp: false, delegate: false },
  },
];

interface AgentDefinitionsSettingsProps {
  onManageConnections?: () => void;
  onSelectAgentForChat?: (agentId: string) => void;
}

export function AgentDefinitionsSettings({
  onManageConnections,
  onSelectAgentForChat,
}: AgentDefinitionsSettingsProps) {
  const [agents, setAgents] = React.useState<AgentDefinition[]>([]);
  const [runtimes, setRuntimes] = React.useState<AgentRuntimeStatus[]>([]);
  const [formRuntime, setFormRuntime] = React.useState<AgentRuntimeKind>('pi');
  const [formRuntimeModel, setFormRuntimeModel] = React.useState('');
  const [formNativeConnectionId, setFormNativeConnectionId] = React.useState<string | null>(null);
  const [focusedConnectionId, setFocusedConnectionId] = React.useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = React.useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedAgentId((prev) => (prev === id ? null : id));
  };

  React.useEffect(() => {
    if (focusedConnectionId) {
      const matched = agents.find((a) => a.connectionId === focusedConnectionId);
      if (matched) {
        setExpandedAgentId(matched.id);
      }
    }
  }, [focusedConnectionId, agents]);
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
  const DRAFT_KEY = '52hz_agent_definition_draft_v1';
  const [conflictDraft, setConflictDraft] = React.useState<string | null>(null);
  const [showConflictJson, setShowConflictJson] = React.useState(false);
  const [reloadingConflict, setReloadingConflict] = React.useState(false);
  const [overwritingConflict, setOverwritingConflict] = React.useState(false);
  const [hasSavedDraft, setHasSavedDraft] = React.useState(false);

  // Check draft on mount
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.formName) {
          setHasSavedDraft(true);
        }
      }
    } catch (_) {}
  }, []);

  const clearDraft = React.useCallback(() => {
    try {
      localStorage.removeItem(DRAFT_KEY);
      setHasSavedDraft(false);
    } catch (_) {}
  }, []);

  const saveDraft = React.useCallback(() => {
    if (!formName.trim() && !formRole.trim() && !formInstructions.trim()) return;
    const draft = {
      editingAgentId: editingAgent?.id || null,
      formName,
      formRuntime,
      formRuntimeModel,
      formRole,
      formDescription,
      formInstructions,
      formDefaultMode,
      formMaxMode,
      formStatus,
      permReadFiles,
      permWriteFiles,
      permExecuteCommands,
      permKnowledge,
      permMcp,
      permDelegate,
      hasCustomResource,
      formConnectionId,
      formModelId,
      formMaxOutputTokens,
      limitTokens,
      limitSteps,
      limitDuration,
      limitCost,
      savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      setHasSavedDraft(true);
    } catch (_) {}
  }, [
    editingAgent,
    formName,
    formRuntime,
    formRuntimeModel,
    formRole,
    formDescription,
    formInstructions,
    formDefaultMode,
    formMaxMode,
    formStatus,
    permReadFiles,
    permWriteFiles,
    permExecuteCommands,
    permKnowledge,
    permMcp,
    permDelegate,
    hasCustomResource,
    formConnectionId,
    formModelId,
    formMaxOutputTokens,
    limitTokens,
    limitSteps,
    limitDuration,
    limitCost,
  ]);

  // Auto-save draft when editing
  React.useEffect(() => {
    if (!isEditing) return;
    saveDraft();
  }, [isEditing, saveDraft]);

  const handleRestoreDraft = () => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (!saved) return;
      const d = JSON.parse(saved);
      if (d.editingAgentId) {
        const ag = agents.find((a) => a.id === d.editingAgentId) || null;
        setEditingAgent(ag);
      } else {
        setEditingAgent(null);
      }
      setFormName(d.formName || '');
      setFormRuntime(d.formRuntime || 'pi');
      setFormRuntimeModel(d.formRuntimeModel || '');
      setFormRole(d.formRole || 'assistant');
      setFormDescription(d.formDescription || '');
      setFormInstructions(d.formInstructions || '');
      setFormDefaultMode(d.formDefaultMode || 'chat');
      setFormMaxMode(d.formMaxMode || 'agent');
      setFormStatus(d.formStatus || 'active');
      setPermReadFiles(Boolean(d.permReadFiles));
      setPermWriteFiles(Boolean(d.permWriteFiles));
      setPermExecuteCommands(Boolean(d.permExecuteCommands));
      setPermKnowledge(Boolean(d.permKnowledge));
      setPermMcp(Boolean(d.permMcp));
      setPermDelegate(Boolean(d.permDelegate));
      setHasCustomResource(Boolean(d.hasCustomResource));
      setFormConnectionId(d.formConnectionId || '');
      setFormModelId(d.formModelId || '');
      setFormMaxOutputTokens(d.formMaxOutputTokens || '');
      setLimitTokens(d.limitTokens || '');
      setLimitSteps(d.limitSteps || '');
      setLimitDuration(d.limitDuration || '');
      setLimitCost(d.limitCost || '');
      setIsEditing(true);
      toast.success('已恢复上次未保存的草稿');
    } catch {
      toast.error('无法恢复草稿');
    }
  };

  const handleDiscardDraft = () => {
    clearDraft();
    toast.info('已清除草稿');
  };

  const loadData = React.useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const [agentsRes, connRes, runtimeRes] = await Promise.all([
        workspaceApi.listAgentDefinitions(true),
        workspaceApi.request<{ connections: ConnectionItem[] }>('/v1/settings/connections').catch(() => ({ connections: [] })),
        workspaceApi.listAgentRuntimes(),
      ]);
      setAgents(agentsRes?.agents || []);
      setRuntimes(runtimeRes.runtimes);
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

  const openCreate = (starter?: (typeof agentStarters)[number]) => {
    setFormRuntime('pi');
    setFormNativeConnectionId(null);
    setFormRuntimeModel('');
    setEditingAgent(null);
    setFormName(starter?.name || '');
    setFormRole(starter?.role || 'assistant');
    setFormDescription(starter?.description || '');
    setFormInstructions(starter?.instructions || '');
    setFormStatus('active');
    // Starter permissions or conservative defaults
    if (starter?.permissions) {
      setPermReadFiles(starter.permissions.readFiles);
      setPermWriteFiles(starter.permissions.writeFiles);
      setPermExecuteCommands(starter.permissions.executeCommands);
      setPermKnowledge(starter.permissions.knowledge);
      setPermMcp(starter.permissions.mcp);
      setPermDelegate(starter.permissions.delegate);
    } else {
      setPermReadFiles(true);
      setPermWriteFiles(false);
      setPermExecuteCommands(false);
      setPermKnowledge(true);
      setPermMcp(false);
      setPermDelegate(false);
    }

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

  const openDuplicate = (agent: AgentDefinition) => {
    setFormRuntime(agent.runtimeKind);
    setFormRuntimeModel(agent.runtimeModel || '');
    setEditingAgent(null);
    setFormName(`${agent.name} (副本)`);
    setFormNativeConnectionId(agent.connectionId || null);
    setFormRole(agent.role || 'assistant');
    setFormDescription(agent.description || '');
    setFormInstructions(agent.instructions || '');
    setFormDefaultMode(agent.defaultMode || 'chat');
    setFormMaxMode(agent.maxMode || 'agent');
    setFormStatus('active');

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

  const openEdit = (agent: AgentDefinition) => {
    setFormRuntime(agent.runtimeKind);
    setFormRuntimeModel(agent.runtimeModel || '');
    setEditingAgent(agent);
    setFormName(agent.name);
    setFormNativeConnectionId(agent.connectionId || null);
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

    const derivedMaxMode: 'chat' | 'plan' | 'agent' = (permWriteFiles || permExecuteCommands)
      ? 'agent'
      : (permReadFiles ? 'plan' : 'chat');
    const derivedDefaultMode: 'chat' | 'plan' | 'agent' = editingAgent?.defaultMode && ['chat', 'plan', 'agent'].indexOf(editingAgent.defaultMode) <= ['chat', 'plan', 'agent'].indexOf(derivedMaxMode)
      ? editingAgent.defaultMode
      : derivedMaxMode;

    const payload: AgentIdentityInput = {
      runtimeKind: formRuntime,
      connectionId: formNativeConnectionId,
      runtimeModel: (formRuntime !== 'pi' || formNativeConnectionId) ? formRuntimeModel.trim() || null : null,
      name: trimmedName,
      role: formRole.trim() || 'assistant',
      description: formDescription.trim(),
      instructions: formInstructions,
      defaultMode: derivedDefaultMode,
      maxMode: derivedMaxMode,
      status: formStatus,
      permissions: {
        readFiles: permReadFiles,
        writeFiles: permWriteFiles,
        executeCommands: permExecuteCommands,
        knowledge: permKnowledge,
        mcp: permMcp,
        delegate: permDelegate,
      },
      modelResource: formRuntime === 'pi' && !formNativeConnectionId && hasCustomResource && formConnectionId && formModelId.trim()
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
      clearDraft();
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
    if (agent.connectionId) {
      return {
        ready: false,
        label: '已关联原生配置 · 待任务验证',
        reason: agent.execution?.note || '复用本机客户端配置，无需工作台模型连接；实际可用性需通过任务执行确认。',
        warning: false,
      };
    }
    if (agent.runtimeKind !== 'pi') {
      const runtime = runtimes.find(item => item.kind === agent.runtimeKind);
      return { ready: false, label: runtime?.installed ? runtime.supported ? '客户端已检测 · 待任务验证' : '适配待完成' : '客户端未检测到',
        reason: runtime?.reason || '请刷新客户端检测状态。', warning: !runtime?.installed || !runtime.supported };
    }
    if (!agent.modelResource) {
      return {
        ready: false,
        label: '待配置执行资源',
        reason: '单人会话可使用默认连接；参加协作前需为此 Agent 绑定执行资源。',
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
      label: '已配置',
      reason: '执行资源已绑定；远端连接可用性需通过连接测试确认。',
      warning: false,
    };
  };


  const renderAgentCard = (agent: AgentDefinition, isNative: boolean) => {
    const readiness = checkReadiness(agent);
    const isBuiltIn = agent.builtIn;
    const isDisabled = agent.status === 'disabled';
    const isExpanded = expandedAgentId === agent.id;

    return (
      <div
        key={agent.id}
        className={cn(
          'rounded-xl border border-border/70 bg-surface1/60 p-4 transition-all duration-150 hover:border-border hover:shadow-xs',
          isDisabled && 'opacity-65 bg-surface1/30',
          isExpanded && 'border-primary/50 shadow-xs ring-1 ring-primary/20'
        )}
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="size-9 rounded-lg bg-surface2 border border-border/60 flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">
              {isNative ? (
                <Cpu className={cn('size-4', isBuiltIn ? 'text-primary' : 'text-foreground')} />
              ) : (
                <Bot className={cn('size-4', isBuiltIn ? 'text-primary' : 'text-foreground')} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-xs sm:text-sm text-foreground truncate">
                  {agent.name}
                </span>
                {isNative ? (
                  <Badge variant="outline" size="sm" className="text-3xs text-primary border-primary/40 gap-1">
                    <Cpu className="size-2.5" />
                    真实原生 Agent
                  </Badge>
                ) : (
                  <Badge variant="outline" size="sm" className="text-3xs text-foreground-muted gap-1">
                    <Bot className="size-2.5" />
                    兼容内置助手 (builtin-pi-sdk)
                  </Badge>
                )}
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
                <Badge variant="outline" size="sm" className="text-3xs text-foreground-muted">
                  {agent.execution?.label || runtimes.find((item) => item.kind === agent.runtimeKind)?.name || agent.runtimeKind}
                  {agent.execution?.compatibility === 'legacy-builtin' ? ' · 兼容' : ''}
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
                <span className="flex items-center gap-1">
                  <FileCode
                    className={cn(
                      'size-3',
                      agent.permissions.writeFiles ? 'text-primary' : 'text-foreground-extra-muted'
                    )}
                  />
                  <span>
                    {agent.permissions.writeFiles ? '可改写文件 (需审批)' : '禁止改写 (只读保护)'}
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
                    {agent.permissions.executeCommands ? '终端执行 (需审批)' : '禁用终端'}
                  </span>
                </span>
                {agent.connectionId ? (
                  <>
                    <span className="text-border/70">·</span>
                    <span className="text-foreground-muted">原生客户端</span>
                  </>
                ) : (
                  <>
                    <span className="text-border/70">·</span>
                    <span className="text-foreground-extra-muted">兼容内置</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Row Operations */}
          <div className="flex items-center gap-1 self-end sm:self-center shrink-0">
            <Button
              variant={isExpanded ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => toggleExpand(agent.id)}
              className="h-7 px-2 text-2xs gap-1 text-primary hover:text-primary hover:bg-primary/10"
              title="查看与修改当前 Agent 的配置文件路径、作用范围与模型配置"
            >
              <Sliders className="size-3" />
              <span>{isExpanded ? '收起配置' : '次级详情与模型'}</span>
              {isExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </Button>
            {onSelectAgentForChat && !isDisabled && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSelectAgentForChat(agent.id)}
                className="h-7 px-2 text-2xs gap-1 text-foreground-muted hover:text-foreground"
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
              onClick={() => openDuplicate(agent)}
              className="h-7 px-2 text-2xs gap-1 text-foreground-muted hover:text-foreground"
              title="复制为新 Agent"
            >
              <Copy className="size-3" />
              <span>复制</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleToggleStatus(agent)}
              disabled={isBuiltIn}
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

        {/* Secondary Detail Dropdown Panel */}
        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-border/60">
            <AgentSecondaryDetail
              agent={agent}
              connections={connections}
              runtimes={runtimes}
              onUpdated={() => void loadData(true)}
              onClose={() => setExpandedAgentId(null)}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/60">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-foreground flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            <span>Agent</span>
          </h2>
          <p className="text-2xs text-foreground-muted mt-0.5">
            管理协作成员、执行客户端与权限。选择 Agent 后，由工作台分派任务。
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            onClick={() => openCreate()}
            className="text-xs h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-3.5" />
            <span>新建 Agent</span>
          </Button>
        </div>
      </div>

      {!loading && (
        <NativeAgentConnectionsPanel
          onMemberCreated={() => void loadData(true)}
          selectedConnectionId={focusedConnectionId}
          onSelectAgentDetail={(connId) => {
            const matched = agents.find((a) => a.connectionId === connId);
            if (matched) {
              setExpandedAgentId(matched.id);
            }
          }}
        />
      )}

      {/* Draft Recovery Banner */}
      {hasSavedDraft && !isEditing && (
        <div className="p-3.5 rounded-xl border border-primary/40 bg-primary/10 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-foreground">
            <FileEdit className="size-4 text-primary shrink-0" />
            <span className="font-medium">发现未保存的 Agent 编辑草稿。</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDiscardDraft}
              className="h-7 px-2.5 text-2xs text-muted-foreground hover:text-foreground"
            >
              丢弃草稿
            </Button>
            <Button
              size="sm"
              onClick={handleRestoreDraft}
              className="h-7 px-3 text-2xs bg-primary text-primary-foreground hover:bg-primary/90"
            >
              恢复并继续编辑
            </Button>
          </div>
        </div>
      )}

      {/* Main List */}
      {loading ? (
        <div className="p-12 text-center text-xs text-foreground-muted flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span>正在加载 Agent 列表...</span>
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 p-10 text-center">
          <Bot className="size-8 mx-auto text-foreground-muted/40 mb-3" />
          <h3 className="text-xs font-medium text-foreground">暂无 Agent</h3>
          <p className="text-2xs text-foreground-muted mt-1 max-w-sm mx-auto">
            请在上方连接本机已安装的真实 Agent（Pi、Codex 等），或创建新的 Agent 成员。
          </p>
          <Button size="sm" onClick={() => openCreate()} className="mt-4 text-xs h-8 gap-1.5">
            <Plus className="size-3.5" />
            <span>创建第一个 Agent</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Section A: 真实原生 Agent (Native Agents) */}
          {(() => {
            const nativeAgents = agents.filter(
              (a) => Boolean(a.connectionId) || (a.execution?.connectionKind && a.execution.connectionKind !== 'builtin-pi-sdk') || a.runtimeKind !== 'pi'
            );
            if (nativeAgents.length === 0) return null;
            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-1.5 border-b border-border/50">
                  <div className="flex items-center gap-2">
                    <Cpu className="size-3.5 text-primary" />
                    <h3 className="text-xs font-semibold text-foreground">真实原生 Agent (Native Agents)</h3>
                    <Badge variant="outline" size="sm" className="text-3xs text-primary font-medium border-primary/40">
                      本机客户端 ({nativeAgents.length})
                    </Badge>
                  </div>
                  <span className="text-3xs text-foreground-muted">直接挂接本机客户端配置与凭据 · 独立进程运行</span>
                </div>

                <div className="grid grid-cols-1 gap-3.5">
                  {nativeAgents.map((agent) => renderAgentCard(agent, true))}
                </div>
              </div>
            );
          })()}

          {/* Section B: 兼容内置助手 (Compatibility Built-in Assistants) */}
          {(() => {
            const builtinAssistants = agents.filter(
              (a) => !a.connectionId && (a.runtimeKind === 'pi' || a.execution?.connectionKind === 'builtin-pi-sdk')
            );
            if (builtinAssistants.length === 0) return null;
            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-1.5 border-b border-border/50">
                  <div className="flex items-center gap-2">
                    <Bot className="size-3.5 text-foreground-muted" />
                    <h3 className="text-xs font-semibold text-foreground">兼容内置助手 (Compatibility Assistants)</h3>
                    <Badge variant="outline" size="sm" className="text-3xs text-foreground-muted">
                      内置兼容模式 · 非本机安装 ({builtinAssistants.length})
                    </Badge>
                  </div>
                  <span className="text-3xs text-foreground-muted">运行于工作台托管兼容沙箱 · 明确标识为内置兼容</span>
                </div>

                <div className="grid grid-cols-1 gap-3.5">
                  {builtinAssistants.map((agent) => renderAgentCard(agent, false))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Role Auxiliary Presets Section (Downgraded to auxiliary assistant) */}
      {!loading && (
        <section className="rounded-xl border border-border/70 bg-surface1/40 p-4 space-y-3" aria-label="职责辅助预设">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="size-3.5 text-primary" />
              <h3 className="text-xs font-semibold text-foreground">职责辅助预设 (辅助模板)</h3>
              <Badge variant="outline" size="sm" className="text-3xs text-foreground-muted">
                辅助填充，不新增真实客户端连接
              </Badge>
            </div>
          </div>
          <p className="text-2xs text-foreground-muted leading-relaxed">
            职责辅助预设仅用于为 Agent 快速填充工作指令与安全权限模板（如开发助手、代码审阅、测试验证），不创建新的底层客户端连接。创建后可自由指定底层运行客户端。
          </p>
          <div className="flex flex-wrap gap-2">
            {agentStarters.map((starter) => (
              <Button
                key={starter.role}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openCreate(starter)}
                className="text-2xs h-7 gap-1"
              >
                <Plus className="size-3" />
                <span>以「{starter.name}」预设新建</span>
              </Button>
            ))}
          </div>
          <p className="text-3xs text-foreground-extra-muted">以预设创建的 Agent 默认仅开放只读权限；修改项目文件与执行终端命令需在能力权限中单独开启并受执行前审批保护。</p>
        </section>
      )}

      {/* Edit / Create Form Modal */}
      {isEditing && (
        <DialogPrimitive.Root open={isEditing} onOpenChange={open => { if (!saving) setIsEditing(open); }}>
          <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <DialogPrimitive.Content aria-describedby={undefined} onEscapeKeyDown={event => { event.stopPropagation(); if (saving) event.preventDefault(); }} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface1 p-6 shadow-xl space-y-6 outline-none">
            <div className="flex items-center justify-between pb-3 border-b border-border/60">
              <div className="flex items-center gap-2">
                <Bot className="size-4 text-primary" />
                <DialogPrimitive.Title className="text-sm font-semibold text-foreground">
                  {editingAgent ? `编辑 Agent · ${editingAgent.name}` : '新建 Agent'}
                </DialogPrimitive.Title>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearDraft();
                  setIsEditing(false);
                  setEditingAgent(null);
                }}
                className="text-xs text-foreground-muted hover:text-foreground"
              >
                取消
              </button>
            </div>

            {conflictDraft && (
              <div className="rounded-xl border border-status-warning/40 bg-status-warning/10 p-3.5 text-2xs text-status-warning space-y-2.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold text-xs">
                    <AlertTriangle className="size-4 text-status-warning shrink-0" />
                    <span>检测到配置版本冲突：该 Agent 已在其他地方被更新</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={reloadingConflict}
                      onClick={async () => {
                        if (!editingAgent) return;
                        setReloadingConflict(true);
                        try {
                          const latest = await workspaceApi.getAgentDefinition(editingAgent.id);
                          setEditingAgent(latest);
                          setFormRuntime(latest.runtimeKind);
                          setFormRuntimeModel(latest.runtimeModel || '');
                          setFormName(latest.name);
                          setFormRole(latest.role);
                          setFormDescription(latest.description);
                          setFormInstructions(latest.instructions || '');
                          setFormDefaultMode(latest.defaultMode || 'chat');
                          setFormMaxMode(latest.maxMode || 'agent');
                          setFormStatus(latest.status);
                          setPermReadFiles(Boolean(latest.permissions?.readFiles));
                          setPermWriteFiles(Boolean(latest.permissions?.writeFiles));
                          setPermExecuteCommands(Boolean(latest.permissions?.executeCommands));
                          setPermKnowledge(Boolean(latest.permissions?.knowledge));
                          setPermMcp(Boolean(latest.permissions?.mcp));
                          setPermDelegate(Boolean(latest.permissions?.delegate));
                          if (latest.modelResource) {
                            setHasCustomResource(true);
                            setFormConnectionId(latest.modelResource.connectionId);
                            setFormModelId(latest.modelResource.modelId);
                            setFormMaxOutputTokens(latest.modelResource.maxOutputTokens ? String(latest.modelResource.maxOutputTokens) : '');
                          } else {
                            setHasCustomResource(false);
                          }
                          setLimitTokens(latest.limits?.maxTokensPerRun != null ? String(latest.limits.maxTokensPerRun) : '');
                          setLimitSteps(latest.limits?.maxStepsPerRun != null ? String(latest.limits.maxStepsPerRun) : '');
                          setLimitDuration(latest.limits?.maxDurationSeconds != null ? String(latest.limits.maxDurationSeconds) : '');
                          setLimitCost(latest.limits?.maxCostPerRun != null ? String(latest.limits.maxCostPerRun) : '');
                          setConflictDraft(null);
                          toast.success('已从服务端重新加载最新版本');
                        } catch {
                          toast.error('重新加载最新版本失败');
                        } finally {
                          setReloadingConflict(false);
                        }
                      }}
                      className="h-7 px-2.5 text-2xs border-status-warning/40 hover:bg-status-warning/20 text-foreground gap-1"
                    >
                      {reloadingConflict ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                      <span>加载最新版本</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={overwritingConflict}
                      onClick={async () => {
                        if (!editingAgent) return;
                        setOverwritingConflict(true);
                        try {
                          const latest = await workspaceApi.getAgentDefinition(editingAgent.id);
                          const trimmedName = formName.trim();
                          const derivedMaxMode: 'chat' | 'plan' | 'agent' = (permWriteFiles || permExecuteCommands)
                            ? 'agent'
                            : (permReadFiles ? 'plan' : 'chat');
                          const derivedDefaultMode: 'chat' | 'plan' | 'agent' = editingAgent?.defaultMode && ['chat', 'plan', 'agent'].indexOf(editingAgent.defaultMode) <= ['chat', 'plan', 'agent'].indexOf(derivedMaxMode)
                            ? editingAgent.defaultMode
                            : derivedMaxMode;

                          const payload: AgentIdentityInput = {
                            runtimeKind: formRuntime,
                            connectionId: formNativeConnectionId,
      runtimeModel: (formRuntime !== 'pi' || formNativeConnectionId) ? formRuntimeModel.trim() || null : null,
                            name: trimmedName,
                            role: formRole.trim(),
                            description: formDescription.trim(),
                            status: formStatus,
                            instructions: formInstructions.trim(),
                            defaultMode: derivedDefaultMode,
                            maxMode: derivedMaxMode,
                            permissions: {
                              readFiles: permReadFiles,
                              writeFiles: permWriteFiles,
                              executeCommands: permExecuteCommands,
                              knowledge: permKnowledge,
                              mcp: permMcp,
                              delegate: permDelegate,
                            },
                            modelResource: formRuntime === 'pi' && !formNativeConnectionId && hasCustomResource && formConnectionId && formModelId.trim()
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
                          await workspaceApi.updateAgentDefinition(editingAgent.id, {
                            ...payload,
                            expectedRevision: latest.revision,
                          });
                          toast.success(`已覆盖保存 Agent "${trimmedName}"`);
                          setConflictDraft(null);
                          clearDraft();
                          setIsEditing(false);
                          setEditingAgent(null);
                          await loadData(true);
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : '覆盖保存失败');
                        } finally {
                          setOverwritingConflict(false);
                        }
                      }}
                      className="h-7 px-2.5 text-2xs bg-status-warning text-black font-semibold hover:bg-status-warning/90 gap-1"
                    >
                      {overwritingConflict ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                      <span>强制以本地草稿覆盖</span>
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-3xs text-muted-foreground">
                    <span>保留的本地草稿 JSON：</span>
                    <button
                      type="button"
                      onClick={() => setShowConflictJson(!showConflictJson)}
                      className="text-primary hover:underline"
                    >
                      {showConflictJson ? '收起草稿' : '展开查看草稿'}
                    </button>
                  </div>
                  {showConflictJson && (
                    <textarea
                      readOnly
                      rows={5}
                      value={conflictDraft}
                      className="w-full rounded-lg bg-surface0 p-2 font-mono text-3xs border border-border text-foreground"
                    />
                  )}
                </div>
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-5 text-xs">
              <div className="space-y-2">
                <Label htmlFor="agent-execution-client">执行客户端</Label>
                <select id="agent-execution-client" value={formRuntime} disabled={Boolean(editingAgent?.builtIn)} className="w-full rounded-md border border-border bg-surface0 p-2" onChange={event => {
                  const kind = event.target.value as AgentRuntimeKind; setFormRuntime(kind);
                  if (kind !== 'pi') {
                    setFormDefaultMode('plan'); setFormMaxMode('plan'); setPermReadFiles(false); setPermWriteFiles(false); setPermExecuteCommands(true);
                    setPermKnowledge(false); setPermMcp(false); setPermDelegate(false);
                  }
                }}>
                  {runtimes.map(runtime => <option key={runtime.kind} value={runtime.kind} disabled={!runtime.installed || !runtime.supported}>{runtime.name}{!runtime.installed ? ' · 未安装' : !runtime.supported ? ' · 适配待完成' : ''}</option>)}
                </select>
                {formRuntime !== 'pi' && <p className="text-2xs text-foreground-muted">复用客户端现有登录与资源。当前版本可能读取项目外文件，需在下方明确开启读取权限后才能执行。暂不支持工作台 MCP、委派、知识工具及逐请求硬预算；不兼容的任务会被拦截。文件修改与终端命令须在下方权限中开启并在执行前经过审批。</p>}
              </div>
              {/* Group 1: 身份与职责 */}
              <div className="space-y-3">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                  <Bot className="size-3 text-primary" />
                  <span>身份与职责</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2 space-y-1">
                    <Label htmlFor="agent-editor-name" className="text-2xs text-foreground-muted">Agent 名称 *</Label>
                    <Input
                      id="agent-editor-name"
                      autoFocus
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="例如：系统架构师、代码重构助手"
                      required
                      className="h-8 text-xs bg-surface0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="agent-editor-role" className="text-2xs text-foreground-muted">角色类型</Label>
                    <Input
                      id="agent-editor-role"
                      value={formRole}
                      onChange={(e) => setFormRole(e.target.value)}
                      placeholder="assistant"
                      className="h-8 text-xs bg-surface0"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="agent-editor-description" className="text-2xs text-foreground-muted">职责描述</Label>
                  <Input
                    id="agent-editor-description"
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
                  aria-label="工作指令"
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
                    <span>{formRuntime === 'pi' ? '读取项目文件' : '允许客户端读取文件（可能超出项目）'}</span>
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
                <p className="text-3xs text-foreground-extra-muted">
                  文件修改与外部命令执行受逐项执行审批保护；未授权写文件权限时，Agent 处于只读安全环境。
                </p>
              </div>



              {/* Group 5: 执行资源 (高级) */}
              {(formRuntime !== 'pi' || Boolean(formNativeConnectionId)) && <details className="space-y-2.5 pt-2 border-t border-border/50">
                <summary className="cursor-pointer text-xs font-medium text-foreground-muted">高级：客户端资源</summary>
                <Label htmlFor="agent-native-resource">资源标识（可选）</Label>
                <Input id="agent-native-resource" value={formRuntimeModel} onChange={event => setFormRuntimeModel(event.target.value)} placeholder="留空使用客户端默认配置" />
                <p className="text-2xs text-foreground-muted">只覆盖此 Agent 的客户端资源，不更改本机客户端配置，不保存密钥。不可用时明确报错，不自动切换。</p>
              </details>}
              <details hidden={formRuntime !== 'pi' || Boolean(formNativeConnectionId)} className="space-y-2.5 pt-2 border-t border-border/50">
                <summary className="cursor-pointer text-xs font-medium text-foreground-muted">高级：执行资源{!hasCustomResource ? ' · 待配置' : ''}</summary>
                {onManageConnections && <button type="button" onClick={() => { saveDraft(); onManageConnections(); }} className="text-xs text-foreground-muted underline underline-offset-2">管理资源连接（保留当前草稿）</button>}
                <div className="flex items-center justify-between">
                  <h4 className="text-2xs font-semibold uppercase tracking-wider text-foreground-extra-muted flex items-center gap-1.5">
                    <Cpu className="size-3 text-primary" />
                    <span>执行资源</span>
                  </h4>
                  <label className="flex items-center gap-1.5 text-2xs cursor-pointer text-foreground-muted">
                    <input
                      type="checkbox"
                      checked={hasCustomResource}
                      onChange={(e) => setHasCustomResource(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>为此 Agent 绑定资源</span>
                  </label>
                </div>

                {hasCustomResource ? (
                  <div className="space-y-3 p-3 rounded-xl bg-surface2/30 border border-border/50">
                    <p className="text-2xs text-foreground-muted">
                      可复用现有连接，无需为每个 Agent 重复填写密钥。参加协作前需完成资源绑定。
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
                    单人会话可使用默认连接；参加协作前需绑定执行资源。
                  </p>
                )}
              </details>

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
          </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
    </div>
  );
}
