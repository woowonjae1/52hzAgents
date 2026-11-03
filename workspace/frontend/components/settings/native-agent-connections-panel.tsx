'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  workspaceApi,
  type AgentConnection,
  type AgentConnectionCandidate,
  type AgentConnectionKind,
  type NativeConfigInspection,
  type NativeResourcesResponse,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  CheckCircle2,
  Cpu,
  RefreshCw,
  Plus,
  Settings2,
  RotateCcw,
  FileCode2,
  ShieldCheck,
  Users,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface NativeAgentConnectionsPanelProps {
  onMemberCreated?: () => void;
  selectedConnectionId?: string | null;
  onSelectAgentDetail?: (connectionId: string) => void;
}

export function NativeAgentConnectionsPanel({
  onMemberCreated,
  selectedConnectionId = null,
  onSelectAgentDetail,
}: NativeAgentConnectionsPanelProps) {
  const [candidates, setCandidates] = useState<AgentConnectionCandidate[]>([]);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingKind, setAddingKind] = useState<AgentConnectionKind | null>(null);
  const [customMemberName, setCustomMemberName] = useState('');
  const [customConfigDir, setCustomConfigDir] = useState('');
  const [submittingAdd, setSubmittingAdd] = useState(false);

  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(selectedConnectionId);
  const [inspection, setInspection] = useState<NativeConfigInspection | null>(null);
  const [resources, setResources] = useState<NativeResourcesResponse | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);

  // Editable form state for Pi / Codex native config
  const [piProvider, setPiProvider] = useState('');
  const [piModel, setPiModel] = useState('');
  const [piThinking, setPiThinking] = useState('');
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState('');
  const [previewDiff, setPreviewDiff] = useState<Array<{ sourceKey: string; fieldPath: string; before: unknown; after: unknown }> | null>(null);
  const [lastSaveNotice, setLastSaveNotice] = useState<{
    saveStatus: string;
    applicationStatus: string;
    applicationNote: string;
  } | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  const loadCandidatesAndConnections = useCallback(async () => {
    setLoading(true);
    try {
      const [candRes, connRes] = await Promise.all([
        workspaceApi.listAgentConnectionCandidates(false),
        workspaceApi.listAgentConnections(true),
      ]);
      setCandidates(candRes.candidates || []);
      setConnections(connRes.connections || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载本机客户端探测状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCandidatesAndConnections();
  }, [loadCandidatesAndConnections]);

  useEffect(() => {
    if (selectedConnectionId) {
      setActiveConnectionId(selectedConnectionId);
    }
  }, [selectedConnectionId]);

  const loadConnectionDetail = useCallback(async (connId: string) => {
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
        setPiProvider(cfg.view?.settings?.defaultProvider || '');
        setPiModel(cfg.view?.settings?.defaultModel || '');
        setPiThinking(cfg.view?.settings?.defaultThinkingLevel || '');
      } else if (cfg.connection.kind === 'native-codex') {
        setCodexModel(cfg.view?.config?.model || '');
        setCodexEffort(cfg.view?.config?.model_reasoning_effort || '');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取原生配置失败');
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    if (activeConnectionId) {
      void loadConnectionDetail(activeConnectionId);
    } else {
      setInspection(null);
      setResources(null);
    }
  }, [activeConnectionId, loadConnectionDetail]);

  const handleRegister = async (cand: AgentConnectionCandidate) => {
    if (!cand.candidateKind) return;
    setSubmittingAdd(true);
    try {
      const created = await workspaceApi.registerAgentConnection({
        kind: cand.candidateKind,
        displayName: cand.name,
        memberName: customMemberName.trim() || cand.name,
        configDir: customConfigDir.trim() || undefined,
        createMember: true,
      });
      toast.success(`已添加本机 Agent "${created.member?.name || created.connection.displayName}"，无需额外配置工作台供应商`);
      setAddingKind(null);
      setCustomMemberName('');
      setCustomConfigDir('');
      await loadCandidatesAndConnections();
      setActiveConnectionId(created.connection.id);
      onMemberCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '注册本机 Agent 连接失败');
    } finally {
      setSubmittingAdd(false);
    }
  };

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
      toast.success(`原生配置已写入（状态：${applied.applicationStatus}）`);
      await loadConnectionDetail(inspection.connection.id);
      onMemberCreated?.();
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
      await loadConnectionDetail(inspection.connection.id);
      onMemberCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复原生配置备份失败');
    } finally {
      setRollingBackId(null);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface1/40 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <Cpu className="size-3.5 text-primary" />
            <span>添加与连接真实 Agent (Native Agents)</span>
          </h3>
          <p className="text-2xs text-foreground-muted mt-0.5">
            探测并连接本机已安装的真实客户端（Pi、Codex 等），直接复用本地配置与认证凭据，作为工作台真实原生 Agent 接入。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadCandidatesAndConnections()}
          disabled={loading}
          className="h-7 px-2.5 text-2xs gap-1"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          <span>重新探测</span>
        </Button>
      </div>

      {/* Candidate grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {candidates.map((cand) => {
          const sb = cand.statusBreakdown;
          const isAddingThis = addingKind === cand.candidateKind;
          return (
            <div
              key={cand.probeKind}
              className="rounded-md border border-border/70 bg-background p-3 flex flex-col justify-between gap-2.5"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{cand.name}</span>
                    <Badge variant="outline" size="sm" className="text-3xs text-foreground-muted">
                      {cand.stage}
                    </Badge>
                  </div>
                  {cand.canRegister && sb.installationDetected && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-2xs gap-1"
                      onClick={() => {
                        setAddingKind(isAddingThis ? null : cand.candidateKind);
                        setCustomMemberName(cand.name);
                        setCustomConfigDir(cand.defaultConfigDir || '');
                      }}
                    >
                      <Plus className="size-3" />
                      <span>连接此 Agent</span>
                    </Button>
                  )}
                </div>

                <p className="text-2xs text-foreground-muted leading-relaxed">{cand.stageNote}</p>

                {/* Distinct 4-stage readiness breakdown (§3.2: never merge into a single "Connected") */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded border',
                      sb.installationDetected
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'border-border text-foreground-muted'
                    )}
                  >
                    {sb.installationDetected ? <CheckCircle2 className="size-2.5" /> : null}
                    安装: {sb.installationDetected ? '已检测' : '未检测到'}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded border',
                      sb.configReadable
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'border-border text-foreground-muted'
                    )}
                  >
                    配置: {sb.configReadable ? '可读' : '未就绪'}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded border',
                      sb.authConfigured
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    )}
                  >
                    凭据: {sb.authConfigured ? '已检测' : '未检测'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded border border-border text-foreground-muted">
                    执行: 待任务验证
                  </span>
                </div>

                {cand.installation.path && (
                  <p className="text-3xs font-mono text-foreground-muted truncate" title={cand.installation.path}>
                    路径: {cand.installation.path}
                  </p>
                )}
              </div>

              {isAddingThis && (
                <div className="border-t border-border/60 pt-2.5 space-y-2">
                  <div className="grid grid-cols-1 gap-2">
                    <div>
                      <label className="text-3xs text-foreground-muted block mb-0.5">工作台成员名称</label>
                      <Input
                        value={customMemberName}
                        onChange={(e) => setCustomMemberName(e.target.value)}
                        placeholder={cand.name}
                        className="h-7 text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-3xs text-foreground-muted block mb-0.5">
                        原生配置目录（默认自动识别）
                      </label>
                      <Input
                        value={customConfigDir}
                        onChange={(e) => setCustomConfigDir(e.target.value)}
                        placeholder={cand.defaultConfigDir || ''}
                        className="h-7 text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-2xs" onClick={() => setAddingKind(null)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-2xs"
                      disabled={submittingAdd}
                      onClick={() => void handleRegister(cand)}
                    >
                      {submittingAdd ? '正在关联...' : '确认关联并添加'}
                    </Button>
                  </div>
                </div>
              )}

              {cand.registeredConnections.length > 0 && (
                <div className="border-t border-border/50 pt-2 flex flex-wrap items-center justify-between gap-1.5">
                  <span className="text-3xs text-foreground-muted">
                    已注册 {cand.registeredConnections.length} 个连接
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {cand.registeredConnections.map((rc) => (
                      <Button
                        key={rc.id}
                        variant={activeConnectionId === rc.id ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-6 px-2 text-3xs gap-1"
                        onClick={() =>
                          { setActiveConnectionId(activeConnectionId === rc.id ? null : rc.id); onSelectAgentDetail?.(rc.id); }
                        }
                      >
                        <Settings2 className="size-3" />
                        <span>配置与模型 ({rc.displayName})</span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Registered connections selector bar */}
      {connections.length > 0 && (
        <div className="pt-2 border-t border-border/60 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-medium text-foreground-secondary">
              已注册的原生连接（点击查看或修改原生配置文件）
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {connections.map((conn) => {
              const isSelected = activeConnectionId === conn.id;
              return (
                <button
                  key={conn.id}
                  type="button"
                  onClick={() => setActiveConnectionId(isSelected ? null : conn.id)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/10 text-foreground font-medium'
                      : 'border-border bg-background hover:bg-surface2 text-foreground-secondary'
                  )}
                >
                  {isSelected ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  <span>{conn.displayName}</span>
                  <Badge variant="outline" size="sm" className="text-3xs">
                    {conn.kind}
                  </Badge>
                  {conn.sharedMembers.length > 0 && (
                    <span className="text-3xs text-foreground-muted">
                      ({conn.sharedMembers.length} 个成员)
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Active connection native config inspector & editor */}
      {activeConnectionId && (
        <div className="rounded-md border border-border bg-background p-3.5 space-y-3">
          {loadingConfig || !inspection ? (
            <p className="text-xs text-foreground-muted">正在读取原生配置来源与版本摘要...</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-2.5">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-semibold text-foreground">
                      {inspection.connection.displayName} · 原生配置与模型
                    </h4>
                    <Badge variant="outline" size="sm" className="text-3xs font-mono">
                      {inspection.connection.kind}
                    </Badge>
                  </div>
                  <p className="text-3xs font-mono text-foreground-muted mt-0.5">
                    配置目录: {inspection.connection.configDir || '默认'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-2xs gap-1"
                  onClick={() => void loadConnectionDetail(inspection.connection.id)}
                >
                  <RefreshCw className="size-3" />
                  <span>刷新版本</span>
                </Button>
              </div>

              {/* Shared members disclosure (§5.4 / A07) */}
              {inspection.connection.sharedMembers.length > 0 && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 flex items-start gap-2">
                  <Users className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div className="text-2xs space-y-0.5">
                    <p className="font-medium text-foreground">
                      共享关系：当前有 {inspection.connection.sharedMembers.length} 个工作台成员关联此原生连接
                    </p>
                    <p className="text-foreground-muted">
                      成员：{inspection.connection.sharedMembers.map((m) => m.name).join('、')}。
                      {inspection.scopeWarning}
                    </p>
                  </div>
                </div>
              )}

              {inspection.brokenChangeState && (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-2.5 py-2 flex items-center justify-between gap-2">
                  <div className="text-2xs text-destructive">
                    检测到未恢复的多文件配置写入故障 ({inspection.brokenChangeState.id})，已阻止在此连接上启动新任务。
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-2xs"
                    onClick={() => void handleRollback(inspection.brokenChangeState!.id)}
                  >
                    立即恢复备份
                  </Button>
                </div>
              )}

              {/* Config sources & SHA-256 versions */}
              <div className="space-y-1">
                <span className="text-3xs font-semibold uppercase tracking-wider text-foreground-muted">
                  原生配置来源文件与 SHA-256 摘要
                </span>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {inspection.sources.map((src) => (
                    <div
                      key={src.sourceKey}
                      className="rounded border border-border/70 bg-surface1/40 p-2 text-2xs space-y-0.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground flex items-center gap-1">
                          <FileCode2 className="size-3 text-foreground-muted" />
                          {src.sourceKey}
                        </span>
                        <Badge variant="outline" size="sm" className="text-3xs">
                          {src.scope} · {src.format}
                        </Badge>
                      </div>
                      <p className="text-3xs font-mono text-foreground-muted truncate" title={src.canonicalPath}>
                        {src.canonicalPath}
                      </p>
                      <p className="text-3xs font-mono text-foreground-muted">
                        状态: {src.exists ? `SHA256 ${src.sha256?.slice(0, 12)}…` : '文件尚未创建'}
                        {src.holdsSecret ? ' · 含脱敏凭据' : ''}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Editor for native-pi */}
              {inspection.connection.kind === 'native-pi' && (
                <div className="space-y-2.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      Pi 全局默认模型设置（写回 settings.json，保留注释与未知字段）
                    </span>
                    <span className="text-2xs text-foreground-muted">
                      当前生效: {inspection.effective.defaultProvider || '未设置'} /{' '}
                      {inspection.effective.defaultModel || '未设置'}（作用范围：{inspection.effective.sourceScope}）
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    <div>
                      <label className="text-2xs text-foreground-secondary block mb-1">
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
                        className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                      >
                        <option value="">-- 选择或保持未指定 --</option>
                        {resources?.providers?.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.id}) {p.authenticated ? '· 已配置凭据' : '· 未检测凭据'} [{p.source}]
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-2xs text-foreground-secondary block mb-1">
                        默认模型 (defaultModel)
                      </label>
                      <Input
                        value={piModel}
                        onChange={(e) => setPiModel(e.target.value)}
                        list={`pi-models-${inspection.connection.id}`}
                        placeholder="输入或选择模型 ID"
                        className="h-8 text-xs font-mono"
                      />
                      <datalist id={`pi-models-${inspection.connection.id}`}>
                        {resources?.models
                          ?.filter((m) => !piProvider || m.providerId === piProvider)
                          .map((m) => (
                            <option key={`${m.providerId}/${m.id}`} value={m.id}>
                              {m.name} [{m.verificationStatus === 'verified' ? '已验证' : m.verificationStatus === 'cached' ? '本地缓存' : m.verificationStatus === 'configured' ? '已配置' : '声明目录'}] ({m.providerName})
                            </option>
                          ))}
                      </datalist>
                    </div>

                    <div>
                      <label className="text-2xs text-foreground-secondary block mb-1">
                        默认思考深度 (defaultThinkingLevel)
                      </label>
                      <select
                        value={piThinking}
                        onChange={(e) => setPiThinking(e.target.value)}
                        className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
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

              {/* Editor for native-codex */}
              {inspection.connection.kind === 'native-codex' && (
                <div className="space-y-2.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      Codex 本机全局默认设置（写回 config.toml，保留注释与表段落）
                    </span>
                    <span className="text-2xs text-foreground-muted">
                      当前全局默认: {inspection.effective.defaultModel || '未设置'} / 推理:{' '}
                      {inspection.effective.defaultReasoningEffort || '默认'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-2xs text-foreground-secondary block mb-1">
                        全局默认模型 (config.toml: model)
                      </label>
                      <Input
                        value={codexModel}
                        onChange={(e) => setCodexModel(e.target.value)}
                        list={`codex-models-${inspection.connection.id}`}
                        placeholder="如 gpt-5.3-codex"
                        className="h-8 text-xs font-mono"
                      />
                      <datalist id={`codex-models-${inspection.connection.id}`}>
                        {resources?.models?.map((m) => {
                          const statusLabel =
                            m.verificationStatus === 'verified'
                              ? '已验证'
                              : m.verificationStatus === 'cached'
                              ? '本地缓存'
                              : m.verificationStatus === 'configured'
                              ? '已配置'
                              : m.verificationStatus === 'declared'
                              ? '声明目录'
                              : m.source === 'cached'
                              ? '本地缓存'
                              : m.source === 'configured'
                              ? '已配置'
                              : m.source || '声明目录';
                          return (
                            <option key={m.id} value={m.id}>
                              {m.name} [{statusLabel}]
                            </option>
                          );
                        })}
                      </datalist>
                    </div>

                    <div>
                      <label className="text-2xs text-foreground-secondary block mb-1">
                        全局默认推理深度 (model_reasoning_effort)
                      </label>
                      <select
                        value={codexEffort}
                        onChange={(e) => setCodexEffort(e.target.value)}
                        className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
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

              {/* Preview diff & Save actions */}
              {(inspection.connection.kind === 'native-pi' ||
                inspection.connection.kind === 'native-codex') && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="text-3xs text-foreground-muted">
                    保存时将校验原文件 SHA-256、创建受保护备份并验证写后生效值。
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-7 px-2.5 text-2xs" onClick={() => void handlePreviewConfig()}>
                      预览变更差异
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-3 text-2xs"
                      disabled={savingConfig}
                      onClick={() => void handleApplyConfig()}
                    >
                      {savingConfig ? '正在写入并核对...' : '保存到原生配置'}
                    </Button>
                  </div>
                </div>
              )}

              {previewDiff && (
                <div className="rounded border border-border bg-surface1/40 p-2.5 space-y-1 text-2xs">
                  <p className="font-medium text-foreground">即将写入的字段级变更（脱敏预览）：</p>
                  {previewDiff.map((d, i) => (
                    <div key={i} className="font-mono text-3xs flex items-center gap-1.5">
                      <span className="text-foreground-muted">[{d.sourceKey}]</span>
                      <span className="text-foreground">{d.fieldPath}:</span>
                      <span className="text-destructive line-through">{JSON.stringify(d.before)}</span>
                      <span>→</span>
                      <span className="text-emerald-600 dark:text-emerald-400">{JSON.stringify(d.after)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Distinct Save vs Application result banner (§6.5) */}
              {lastSaveNotice && (
                <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-2xs space-y-0.5">
                  <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    <span>保存结果：{lastSaveNotice.saveStatus}</span>
                    <span>·</span>
                    <span>应用状态：{lastSaveNotice.applicationStatus}</span>
                  </div>
                  <p className="text-foreground-secondary">{lastSaveNotice.applicationNote}</p>
                </div>
              )}

              {/* Change journal & rollback */}
              {inspection.recentChanges.length > 0 && (
                <div className="pt-2 border-t border-border/50 space-y-1.5">
                  <span className="text-3xs font-semibold uppercase tracking-wider text-foreground-muted">
                    原生配置变更记录与备份恢复
                  </span>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {inspection.recentChanges.map((chg) => (
                      <div
                        key={chg.id}
                        className="flex items-center justify-between gap-2 rounded border border-border/60 px-2.5 py-1.5 text-2xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" size="sm" className="text-3xs font-mono">
                              {chg.state}
                            </Badge>
                            <span className="font-mono text-3xs text-foreground-muted truncate">
                              {chg.redactedPatch.map((p) => p.fieldPath).join(', ')}
                            </span>
                          </div>
                          {chg.applyResult?.applicationNote && (
                            <p className="text-3xs text-foreground-muted truncate mt-0.5">
                              {chg.applyResult.applicationNote}
                            </p>
                          )}
                        </div>
                        {['applied', 'apply_failed'].includes(chg.state) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-3xs gap-1"
                            disabled={rollingBackId === chg.id}
                            onClick={() => void handleRollback(chg.id)}
                          >
                            <RotateCcw className="size-3" />
                            <span>{rollingBackId === chg.id ? '恢复中...' : '恢复此版本'}</span>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
