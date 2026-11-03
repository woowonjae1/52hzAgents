'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  workspaceApi,
  type AgentDefinition,
  type AgentRuntimeStatus,
  type NativeConfigInspection,
  type NativeResourcesResponse,
} from '@/lib/api';
import type { ConnectionItem } from './router-provider-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  Bot,
  Cpu,
  Layers,
  FileCode2,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  RotateCcw,
  Terminal,
  FileText,
  Clock,
  Coins,
  ShieldAlert,
  Info,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Lock,
  Sliders,
  Check,
} from 'lucide-react';

interface AgentSecondaryDetailProps {
  agent: AgentDefinition;
  connections: ConnectionItem[];
  runtimes: AgentRuntimeStatus[];
  onUpdated?: () => void;
  onClose?: () => void;
}

export function AgentSecondaryDetail({
  agent,
  connections,
  runtimes,
  onUpdated,
  onClose,
}: AgentSecondaryDetailProps) {
  const isNative = Boolean(agent.connectionId) || (agent.execution?.connectionKind && agent.execution.connectionKind !== 'builtin-pi-sdk');
  const targetConnectionId = agent.connectionId || (agent.execution?.connectionId ?? null);

  // Native config state
  const [inspection, setInspection] = useState<NativeConfigInspection | null>(null);
  const [resources, setResources] = useState<NativeResourcesResponse | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);

  // Form states for Native Pi
  const [piProvider, setPiProvider] = useState('');
  const [piModel, setPiModel] = useState('');
  const [piThinking, setPiThinking] = useState('');

  // Form states for Native Codex
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState('');

  // Diff & save state
  const [previewDiff, setPreviewDiff] = useState<Array<{ sourceKey: string; fieldPath: string; before: unknown; after: unknown }> | null>(null);
  const [lastSaveNotice, setLastSaveNotice] = useState<{
    saveStatus: string;
    applicationStatus: string;
    applicationNote: string;
  } | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [showChangesJournal, setShowChangesJournal] = useState(false);

  // Built-in compatibility assistant model resource state
  const [builtinConnectionId, setBuiltinConnectionId] = useState(agent.modelResource?.connectionId || '');
  const [builtinModelId, setBuiltinModelId] = useState(agent.modelResource?.modelId || '');
  const [builtinMaxTokens, setBuiltinMaxTokens] = useState(agent.modelResource?.maxOutputTokens ? String(agent.modelResource.maxOutputTokens) : '');
  const [savingBuiltin, setSavingBuiltin] = useState(false);

  const loadNativeDetail = useCallback(async (connId: string) => {
    setLoadingConfig(true);
    setPreviewDiff(null);
    try {
      const [cfg, res] = await Promise.all([
        workspaceApi.inspectAgentConnectionConfig(connId),
        workspaceApi.listAgentConnectionResources(connId),
      ]);
      setInspection(cfg);
      setResources(res);
      if (cfg.connection.kind === 'native-pi') {
        setPiProvider(cfg.view?.settings?.defaultProvider || cfg.effective?.defaultProvider || '');
        setPiModel(cfg.view?.settings?.defaultModel || cfg.effective?.defaultModel || '');
        setPiThinking(cfg.view?.settings?.defaultThinkingLevel || cfg.effective?.defaultThinkingLevel || '');
      } else if (cfg.connection.kind === 'native-codex') {
        setCodexModel(cfg.view?.config?.model || cfg.effective?.defaultModel || '');
        setCodexEffort(cfg.view?.config?.model_reasoning_effort || cfg.effective?.defaultReasoningEffort || '');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取原生配置失败');
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    if (isNative && targetConnectionId) {
      void loadNativeDetail(targetConnectionId);
    } else {
      setInspection(null);
      setResources(null);
    }
  }, [isNative, targetConnectionId, loadNativeDetail]);

  const buildCurrentPatch = () => {
    if (!inspection) return null;
    if (inspection.connection.kind === 'native-pi') {
      return {
        settings: {
          defaultProvider: piProvider.trim() || null,
          defaultModel: piModel.trim() || null,
          defaultThinkingLevel: piThinking.trim() || null,
        },
      };
    }
    if (inspection.connection.kind === 'native-codex') {
      return {
        config: {
          model: codexModel.trim() || null,
          model_reasoning_effort: codexEffort.trim() || null,
        },
      };
    }
    return null;
  };

  const handlePreviewConfig = async () => {
    if (!inspection) return;
    const patch = buildCurrentPatch();
    if (!patch) return;
    try {
      const preview = await workspaceApi.previewAgentConnectionConfigChange(inspection.connection.id, {
        patch,
        expectedVersions: inspection.versions,
      });
      setPreviewDiff(preview.redactedChanges);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '预览配置变更失败');
    }
  };

  const handleApplyConfig = async () => {
    if (!inspection) return;
    const patch = buildCurrentPatch();
    if (!patch) return;
    setSavingConfig(true);
    setLastSaveNotice(null);
    try {
      const applied = await workspaceApi.applyAgentConnectionConfigChange(inspection.connection.id, {
        patch,
        expectedVersions: inspection.versions,
      });
      setLastSaveNotice({
        saveStatus: applied.saveStatus,
        applicationStatus: applied.applicationStatus,
        applicationNote: applied.applicationNote,
      });
      setPreviewDiff(null);
      toast.success(`原生配置已保存并生效（状态：${applied.applicationStatus}）`);
      await loadNativeDetail(inspection.connection.id);
      onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存原生配置失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleRollback = async (changeId: string) => {
    if (!inspection) return;
    setRollingBackId(changeId);
    try {
      await workspaceApi.rollbackAgentConnectionConfigChange(inspection.connection.id, { changeId });
      toast.success('已从受保护备份恢复原生配置版本');
      setLastSaveNotice(null);
      await loadNativeDetail(inspection.connection.id);
      onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复原生配置备份失败');
    } finally {
      setRollingBackId(null);
    }
  };

  const handleSaveBuiltinModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!builtinConnectionId || !builtinModelId.trim()) {
      toast.error('请选择有效的模型连接并填写模型 ID');
      return;
    }
    setSavingBuiltin(true);
    try {
      await workspaceApi.updateAgentDefinition(agent.id, {
        modelResource: {
          connectionId: builtinConnectionId,
          modelId: builtinModelId.trim(),
          ...(builtinMaxTokens.trim() && !isNaN(Number(builtinMaxTokens))
            ? { maxOutputTokens: parseInt(builtinMaxTokens, 10) }
            : {}),
        },
        expectedRevision: agent.revision,
      });
      toast.success(`已更新 Agent "${agent.name}" 的模型配置`);
      onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新模型配置失败');
    } finally {
      setSavingBuiltin(false);
    }
  };


  return (
    <div className="rounded-xl border border-border/80 bg-surface2/40 p-4 space-y-4 text-xs">
      {/* Detail Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-md bg-surface3 flex items-center justify-center text-primary">
            {isNative ? <Cpu className="size-3.5" /> : <Bot className="size-3.5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground text-xs sm:text-sm">
                {agent.name} · 次级配置与模型详情
              </span>
              <Badge variant="outline" size="sm" className="text-3xs font-mono">
                {isNative ? '真实原生 Agent' : '兼容内置助手 (builtin-pi-sdk)'}
              </Badge>
            </div>
            <p className="text-3xs text-foreground-muted mt-0.5">
              {isNative
                ? '直接读取并写回本机客户端配置文件，展示真实就绪状态、生效范围与能力约束。'
                : '使用工作台托管兼容环境运行，依赖工作台配置的模型供应商，并非本机独立安装客户端。'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {isNative && targetConnectionId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadNativeDetail(targetConnectionId)}
              disabled={loadingConfig}
              className="h-7 px-2.5 text-2xs gap-1"
              title="重新核对原生配置文件版本"
            >
              <RefreshCw className={cn('size-3', loadingConfig && 'animate-spin')} />
              <span>刷新文件状态</span>
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-2xs">
              收起详情
            </Button>
          )}
        </div>
      </div>

      {/* 1. NATIVE AGENT VIEW */}
      {isNative ? (
        loadingConfig ? (
          <div className="py-8 text-center text-foreground-muted space-y-2">
            <RefreshCw className="size-4 animate-spin mx-auto text-primary" />
            <p className="text-2xs">正在探测并读取原生客户端配置文件与生效模型...</p>
          </div>
        ) : !inspection ? (
          <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3.5 text-2xs text-status-warning space-y-1">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-4 shrink-0" />
              <span>暂未读取到关联的原生客户端连接配置</span>
            </div>
            <p className="text-foreground-muted">
              该 Agent 标记为原生执行模式，但尚未成功挂接原生连接（连接 ID: {targetConnectionId || '未分配'}）。请先在上方原生连接面板中完成关联。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Section 1.1: 真实原生就绪状态 (4阶段明确区分) */}
            <div className="space-y-2">
              <span className="text-3xs font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                <ShieldCheck className="size-3 text-primary" />
                <span>原生连接就绪状态 (严格 4 阶段拆解，不合并为虚假 Connected)</span>
              </span>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {/* 阶段 1: 安装检测 */}
                <div className="rounded-lg border border-border/70 bg-surface1 p-2.5 space-y-1">
                  <div className="flex items-center justify-between text-2xs">
                    <span className="text-foreground-muted">1. 本机安装</span>
                    {inspection.statusBreakdown?.installationDetected ? (
                      <span className="inline-flex items-center gap-1 text-3xs text-emerald-600 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="size-3" /> 已检测
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-3xs text-status-warning font-medium">
                        <AlertTriangle className="size-3" /> 未检测到
                      </span>
                    )}
                  </div>
                  <p className="text-3xs font-mono text-foreground-muted truncate" title={inspection.connection.installationRef}>
                    {inspection.connection.installationRef || '默认系统 PATH'}
                  </p>
                </div>

                {/* 阶段 2: 配置文件状态 */}
                <div className="rounded-lg border border-border/70 bg-surface1 p-2.5 space-y-1">
                  <div className="flex items-center justify-between text-2xs">
                    <span className="text-foreground-muted">2. 配置文件</span>
                    {inspection.statusBreakdown?.configReadable ? (
                      <span className="inline-flex items-center gap-1 text-3xs text-emerald-600 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="size-3" /> 正常可读
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-3xs text-status-warning font-medium">
                        <AlertTriangle className="size-3" /> 待创建
                      </span>
                    )}
                  </div>
                  <p className="text-3xs font-mono text-foreground-muted">
                    {inspection.sources?.length || 0} 个源文件配置
                  </p>
                </div>

                {/* 阶段 3: 认证凭据检测 */}
                <div className="rounded-lg border border-border/70 bg-surface1 p-2.5 space-y-1">
                  <div className="flex items-center justify-between text-2xs">
                    <span className="text-foreground-muted">3. 认证凭据</span>
                    {inspection.statusBreakdown?.authConfigured ? (
                      <span className="inline-flex items-center gap-1 text-3xs text-emerald-600 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="size-3" /> 已检测凭据
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-3xs text-amber-600 dark:text-amber-400 font-medium">
                        <AlertTriangle className="size-3" /> 未检测到
                      </span>
                    )}
                  </div>
                  <p className="text-3xs text-foreground-muted">脱敏检测，不保存明文</p>
                </div>

                {/* 阶段 4: 任务执行验证 */}
                <div className="rounded-lg border border-border/70 bg-surface1 p-2.5 space-y-1">
                  <div className="flex items-center justify-between text-2xs">
                    <span className="text-foreground-muted">4. 任务执行</span>
                    <span className="inline-flex items-center gap-1 text-3xs text-foreground-muted font-medium">
                      待任务验证
                    </span>
                  </div>
                  <p className="text-3xs text-foreground-muted">需真实任务交付检验</p>
                </div>
              </div>

              {/* Shared members disclosure */}
              {inspection.connection.sharedMembers.length > 1 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex items-start gap-2">
                  <ShieldAlert className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div className="text-2xs space-y-0.5">
                    <p className="font-medium text-foreground">
                      共享作用范围提示：当前有 {inspection.connection.sharedMembers.length} 个工作台成员共用此原生连接
                    </p>
                    <p className="text-foreground-muted">
                      共享成员包括：{inspection.connection.sharedMembers.map((m) => m.name).join('、')}。
                      {inspection.scopeWarning || '修改全局默认配置将对本机所有关联成员同时生效。'}
                    </p>
                  </div>
                </div>
              )}

              {/* Broken change state if multi-file crash happened */}
              {inspection.brokenChangeState && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 flex items-center justify-between gap-2">
                  <div className="text-2xs text-destructive">
                    检测到未恢复的原生配置写入故障 ({inspection.brokenChangeState.id})，已暂停在此连接上启动新任务。
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-2xs"
                    onClick={() => void handleRollback(inspection.brokenChangeState!.id)}
                  >
                    立即恢复受保护备份
                  </Button>
                </div>
              )}
            </div>

            {/* Section 1.2: 配置文件来源 (Canonical Paths) 与修改作用范围 */}
            <div className="space-y-2">
              <span className="text-3xs font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                <FileCode2 className="size-3 text-primary" />
                <span>配置文件来源与修改作用范围</span>
              </span>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {inspection.sources?.map((src) => (
                  <div
                    key={src.sourceKey}
                    className="rounded-lg border border-border/70 bg-surface1 p-2.5 space-y-1 text-2xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground flex items-center gap-1">
                        <FileCode2 className="size-3 text-primary" />
                        {src.sourceKey}
                      </span>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" size="sm" className="text-3xs uppercase">
                          {src.scope === 'global' ? '全局默认' : src.scope === 'project' ? '当前项目' : src.scope}
                        </Badge>
                        <Badge variant="outline" size="sm" className="text-3xs font-mono">
                          {src.format}
                        </Badge>
                      </div>
                    </div>

                    <div className="space-y-0.5">
                      <p className="text-3xs font-mono text-foreground-muted select-all break-all" title={src.canonicalPath}>
                        {src.canonicalPath}
                      </p>
                      <div className="flex items-center justify-between text-3xs text-foreground-extra-muted">
                        <span>
                          {src.exists ? `SHA256: ${src.sha256?.slice(0, 16)}…` : '文件待创建'}
                          {src.holdsSecret ? ' · 包含脱敏凭据' : ''}
                        </span>
                        <span>作用域: {src.scope}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Section 1.3: 次级模型与推理配置 (降级为次级详情) */}
            <div className="rounded-lg border border-border/80 bg-surface1 p-3.5 space-y-3">
              <div className="flex items-center justify-between border-b border-border/60 pb-2">
                <div className="flex items-center gap-2">
                  <Sliders className="size-3.5 text-primary" />
                  <span className="font-medium text-foreground text-xs">
                    原生模型与推理配置（次级参数管理）
                  </span>
                </div>
                <span className="text-3xs text-foreground-muted">
                  当前生效：{inspection.effective?.defaultProvider ? `${inspection.effective.defaultProvider} / ` : ''}
                  {inspection.effective?.defaultModel || '默认模型'}（范围：{inspection.effective?.sourceScope || 'global'}）
                </span>
              </div>

              {/* Pi Config Editor */}
              {inspection.connection.kind === 'native-pi' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="text-3xs text-foreground-muted block mb-1">
                        默认供应商 (defaultProvider)
                      </label>
                      <select
                        value={piProvider}
                        onChange={(e) => {
                          const nextProv = e.target.value;
                          setPiProvider(nextProv);
                          const provModels = resources?.providers?.find((p) => p.id === nextProv)?.models;
                          if (provModels && provModels.length > 0) {
                            setPiModel(provModels[0].id);
                          }
                        }}
                        className="w-full h-8 rounded-md border border-border bg-surface0 px-2 text-xs text-foreground"
                      >
                        <option value="">-- 选择或保持未指定 --</option>
                        {resources?.providers?.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.id}) {p.authenticated ? '· 已配置凭据' : '· 未检测凭据'}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-3xs text-foreground-muted block mb-1">
                        默认模型 (defaultModel)
                      </label>
                      <Input
                        value={piModel}
                        onChange={(e) => setPiModel(e.target.value)}
                        list={`pi-models-sub-${inspection.connection.id}`}
                        placeholder="输入或选择模型 ID"
                        className="h-8 text-xs font-mono bg-surface0"
                      />
                      <datalist id={`pi-models-sub-${inspection.connection.id}`}>
                        {resources?.models
                          ?.filter((m) => !piProvider || m.providerId === piProvider)
                          .map((m) => (
                            <option key={`${m.providerId}/${m.id}`} value={m.id}>
                              {m.name} [{m.verificationStatus === 'verified' ? '已验证' : '已配置'}] ({m.providerName})
                            </option>
                          ))}
                      </datalist>
                    </div>

                    <div>
                      <label className="text-3xs text-foreground-muted block mb-1">
                        思考深度 (defaultThinkingLevel)
                      </label>
                      <select
                        value={piThinking}
                        onChange={(e) => setPiThinking(e.target.value)}
                        className="w-full h-8 rounded-md border border-border bg-surface0 px-2 text-xs text-foreground"
                      >
                        <option value="">-- 默认 --</option>
                        {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((lv) => (
                          <option key={lv} value={lv}>
                            {lv}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Codex Config Editor */}
              {inspection.connection.kind === 'native-codex' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-3xs text-foreground-muted block mb-1">
                        全局默认模型 (config.toml: model)
                      </label>
                      <Input
                        value={codexModel}
                        onChange={(e) => setCodexModel(e.target.value)}
                        list={`codex-models-sub-${inspection.connection.id}`}
                        placeholder="例如：gpt-5.3-codex"
                        className="h-8 text-xs font-mono bg-surface0"
                      />
                      <datalist id={`codex-models-sub-${inspection.connection.id}`}>
                        {resources?.models?.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} [{m.verificationStatus || m.source || '可用'}]
                          </option>
                        ))}
                      </datalist>
                    </div>

                    <div>
                      <label className="text-3xs text-foreground-muted block mb-1">
                        推理深度 (model_reasoning_effort)
                      </label>
                      <select
                        value={codexEffort}
                        onChange={(e) => setCodexEffort(e.target.value)}
                        className="w-full h-8 rounded-md border border-border bg-surface0 px-2 text-xs text-foreground"
                      >
                        <option value="">-- 默认 --</option>
                        {(resources?.reasoningEfforts || ['minimal', 'low', 'medium', 'high']).map((lv) => (
                          <option key={lv} value={lv}>
                            {lv}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Preview Diff & Apply Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50">
                <span className="text-3xs text-foreground-muted">
                  保存时自动校验文件 SHA-256、保留非覆盖字段与注释，并生成受保护备份。
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-2xs"
                    onClick={() => void handlePreviewConfig()}
                  >
                    预览变更差异
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-3 text-2xs bg-primary text-primary-foreground hover:bg-primary/90"
                    disabled={savingConfig}
                    onClick={() => void handleApplyConfig()}
                  >
                    {savingConfig ? '正在校验与写入...' : '保存原生配置'}
                  </Button>
                </div>
              </div>

              {/* Redacted Diff Preview */}
              {previewDiff && (
                <div className="rounded-lg border border-border bg-surface0 p-2.5 space-y-1.5 font-mono text-3xs">
                  <p className="font-sans font-medium text-foreground text-2xs">待写入的原生字段级变更预览：</p>
                  {previewDiff.map((d, i) => (
                    <div key={i} className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-foreground-muted">[{d.sourceKey}]</span>
                      <span className="text-foreground font-semibold">{d.fieldPath}:</span>
                      <span className="text-destructive line-through">{JSON.stringify(d.before)}</span>
                      <span>→</span>
                      <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{JSON.stringify(d.after)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Save Notice Banner */}
              {lastSaveNotice && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-2xs space-y-0.5">
                  <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    <span>保存状态：{lastSaveNotice.saveStatus}</span>
                    <span>·</span>
                    <span>应用生效状态：{lastSaveNotice.applicationStatus}</span>
                  </div>
                  <p className="text-foreground-muted text-3xs">{lastSaveNotice.applicationNote}</p>
                </div>
              )}

              {/* Backup & Rollback Accordion */}
              {inspection.recentChanges?.length > 0 && (
                <div className="pt-1 border-t border-border/40">
                  <button
                    type="button"
                    onClick={() => setShowChangesJournal(!showChangesJournal)}
                    className="flex items-center gap-1 text-3xs text-foreground-muted hover:text-foreground font-medium"
                  >
                    {showChangesJournal ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    <span>历史配置变更与备份恢复 ({inspection.recentChanges.length} 条记录)</span>
                  </button>

                  {showChangesJournal && (
                    <div className="mt-2 space-y-1.5 max-h-36 overflow-y-auto">
                      {inspection.recentChanges.map((chg) => (
                        <div
                          key={chg.id}
                          className="flex items-center justify-between gap-2 rounded border border-border/60 bg-surface0 px-2 py-1 text-3xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="outline" size="sm" className="text-3xs font-mono">
                                {chg.state}
                              </Badge>
                              <span className="font-mono text-foreground-muted truncate">
                                {chg.redactedPatch?.map((p) => p.fieldPath).join(', ')}
                              </span>
                            </div>
                            {chg.applyResult?.applicationNote && (
                              <p className="text-foreground-extra-muted truncate mt-0.5">
                                {chg.applyResult.applicationNote}
                              </p>
                            )}
                          </div>
                          {['applied', 'apply_failed'].includes(chg.state) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-3xs gap-1"
                              disabled={rollingBackId === chg.id}
                              onClick={() => void handleRollback(chg.id)}
                            >
                              <RotateCcw className="size-2.5" />
                              <span>{rollingBackId === chg.id ? '恢复中...' : '回滚'}</span>
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        /* 2. BUILT-IN COMPATIBILITY ASSISTANT VIEW */
        <div className="space-y-4">
          {/* Section 2.1: 兼容架构说明 */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3.5 space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" size="sm" className="text-3xs text-primary font-medium border-primary/40">
                内置兼容助手 (builtin-pi-sdk)
              </Badge>
              <span className="text-3xs text-foreground-muted">运行于工作台托管兼容环境</span>
            </div>
            <p className="text-2xs text-foreground-muted leading-relaxed">
              此助手由工作台内置运行时托管，不占用或冒充本机已安装的客户端应用。它通过工作台绑定的模型连接发起推理，原生支持工作台的审批流、MCP 扩展与知识库体系。
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-3xs text-foreground-extra-muted">
              <div>配置来源：工作台存储 / 成员模型资源配置</div>
              <div>作用范围：当前 Agent 专属模型绑定</div>
            </div>
          </div>

          {/* Section 2.2: 内置助手模型配置 (次级详情) */}
          <form onSubmit={handleSaveBuiltinModel} className="rounded-lg border border-border/80 bg-surface1 p-3.5 space-y-3">
            <div className="flex items-center justify-between border-b border-border/60 pb-2">
              <span className="font-medium text-foreground text-xs flex items-center gap-1.5">
                <Sliders className="size-3.5 text-primary" />
                <span>工作台模型连接与参数配置</span>
              </span>
              <span className="text-3xs text-foreground-muted">次级详情设置</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <label className="text-3xs text-foreground-muted block mb-1">模型连接 (Connection)</label>
                <select
                  value={builtinConnectionId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setBuiltinConnectionId(nextId);
                    const conn = connections.find((c) => c.id === nextId);
                    if (conn?.defaultModel) setBuiltinModelId(conn.defaultModel);
                  }}
                  className="w-full h-8 rounded-md border border-border bg-surface0 px-2 text-xs text-foreground"
                >
                  <option value="">-- 选择模型连接 --</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.id} ({c.protocol}) {c.hasCredential ? '· 已配置凭据' : '· 未配密钥'}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-3xs text-foreground-muted block mb-1">模型 ID (Model ID)</label>
                <Input
                  value={builtinModelId}
                  onChange={(e) => setBuiltinModelId(e.target.value)}
                  placeholder="例如：claude-3-7-sonnet"
                  className="h-8 text-xs font-mono bg-surface0"
                />
              </div>

              <div>
                <label className="text-3xs text-foreground-muted block mb-1">最大输出 Token (选填)</label>
                <Input
                  type="number"
                  value={builtinMaxTokens}
                  onChange={(e) => setBuiltinMaxTokens(e.target.value)}
                  placeholder="留空使用连接默认"
                  className="h-8 text-xs bg-surface0"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/50">
              <Button
                type="submit"
                size="sm"
                disabled={savingBuiltin}
                className="h-7 px-3 text-2xs bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {savingBuiltin ? '正在保存...' : '保存模型配置'}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* 3. ACTUAL CAPABILITY & HARD LIMITS TAGS (实际能力限制标签) */}
      <div className="rounded-lg border border-border/80 bg-surface1 p-3.5 space-y-2.5">
        <span className="text-3xs font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
          <ShieldCheck className="size-3 text-primary" />
          <span>实际能力与安全边界限制标签</span>
        </span>

        {/* Permissions & Policy Tags */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            size="sm"
            className={cn(
              'text-3xs gap-1 bg-surface0',
              agent.permissions.writeFiles ? 'border-primary/40 text-primary' : 'text-foreground-muted'
            )}
          >
            <FileText className="size-2.5" />
            <span>{agent.permissions.writeFiles ? '文件改写需审批' : '禁止写文件 (只读保护)'}</span>
          </Badge>

          <Badge
            variant="outline"
            size="sm"
            className={cn(
              'text-3xs gap-1 bg-surface0',
              agent.permissions.executeCommands ? 'border-status-warning/40 text-status-warning' : 'text-foreground-muted'
            )}
          >
            <Terminal className="size-2.5" />
            <span>{agent.permissions.executeCommands ? '终端命令需审批' : '禁止终端执行'}</span>
          </Badge>

          <Badge
            variant="outline"
            size="sm"
            className={cn('text-3xs bg-surface0', agent.permissions.mcp ? 'text-primary' : 'text-foreground-muted')}
          >
            MCP 扩展: {agent.permissions.mcp ? '允许' : '禁用'}
          </Badge>

          <Badge
            variant="outline"
            size="sm"
            className={cn('text-3xs bg-surface0', agent.permissions.knowledge ? 'text-primary' : 'text-foreground-muted')}
          >
            知识库检索: {agent.permissions.knowledge ? '允许' : '禁用'}
          </Badge>

          <Badge
            variant="outline"
            size="sm"
            className={cn('text-3xs bg-surface0', agent.permissions.delegate ? 'text-primary' : 'text-foreground-muted')}
          >
            子任务委派: {agent.permissions.delegate ? '允许' : '禁用'}
          </Badge>
        </div>

        {/* Hard Budget / Limit Badges */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-border/50 text-3xs">
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <Coins className="size-3 text-foreground-extra-muted" />
            <span>Token 上限: {agent.limits?.maxTokensPerRun ? `${agent.limits.maxTokensPerRun} / 次` : '不限'}</span>
          </div>
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <Layers className="size-3 text-foreground-extra-muted" />
            <span>步骤上限: {agent.limits?.maxStepsPerRun ? `${agent.limits.maxStepsPerRun} 步` : '不限'}</span>
          </div>
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <Clock className="size-3 text-foreground-extra-muted" />
            <span>最长耗时: {agent.limits?.maxDurationSeconds ? `${agent.limits.maxDurationSeconds} 秒` : '不限'}</span>
          </div>
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <Lock className="size-3 text-foreground-extra-muted" />
            <span>费用上限: {agent.limits?.maxCostPerRun ? `$${agent.limits.maxCostPerRun}` : '不限'}</span>
          </div>
        </div>

        {/* Runtime Compatibility Notice */}
        {agent.runtimeKind === 'codex' && (
          <p className="text-3xs text-foreground-extra-muted pt-0.5">
            客户端能力限制：原生 Codex 客户端当前可能读取工作区外部文件；暂不支持工作台内置 MCP 与知识库工具；逐请求硬预算由系统调度层拦截执行。
          </p>
        )}
      </div>
    </div>
  );
}
