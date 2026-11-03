'use client';

import * as React from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Bot,
  GitBranch,
  Workflow,
  Archive,
  RefreshCw,
  Undo2,
  X,
  FileCheck2,
} from 'lucide-react';
import {
  workspaceApi,
  type LegacyMigrationCheckResult,
  type LegacyMigrationIssue,
  type MigrationResolution,
  type MigrationExecutionResult,
} from '@/lib/api';
import { toast } from '@/lib/toast';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onMigrated?: () => void;
}

export function LegacyMigrationModal({ isOpen, onClose, onMigrated }: Props) {
  const [loading, setLoading] = React.useState(true);
  const [checkData, setCheckData] = React.useState<LegacyMigrationCheckResult | null>(null);
  const [resolutions, setResolutions] = React.useState<Record<string, MigrationResolution>>({});
  const [executing, setExecuting] = React.useState(false);
  const [executionResult, setExecutionResult] = React.useState<MigrationExecutionResult | null>(null);
  const [rollingBack, setRollingBack] = React.useState(false);

  const loadCheck = React.useCallback(async () => {
    setLoading(true);
    setExecutionResult(null);
    try {
      const res = await workspaceApi.checkLegacyMigration();
      setCheckData(res);
      // Initialize default resolutions
      const initial: Record<string, MigrationResolution> = {};
      const defaultAgentId = res.availableAgents[0]?.id || 'agent-local';
      for (const issue of res.issues) {
        const key = `${issue.targetType}-${issue.id}-${issue.field}`;
        initial[key] = {
          id: issue.id,
          targetType: issue.targetType,
          action: 'bind_agent',
          targetAgentId: defaultAgentId,
          details: issue.details,
          newAgent: {
            name: `${issue.name || issue.currentValue} (Agent)`,
            role: issue.suggestedRole || 'assistant',
            instructions: '',
            defaultMode: 'agent',
          },
        };
      }
      setResolutions(initial);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '检查旧配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isOpen) {
      void loadCheck();
    }
  }, [isOpen, loadCheck]);

  if (!isOpen) return null;

  const handleResolutionChange = (key: string, patch: Partial<MigrationResolution>) => {
    setResolutions((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...patch },
    }));
  };

  const handleExecute = async () => {
    const list = Object.values(resolutions);
    if (list.length === 0) return;
    setExecuting(true);
    try {
      const res = await workspaceApi.executeLegacyMigration(list);
      setExecutionResult(res);
      toast.success(`迁移完成！已处理 ${res.migratedCount} 项旧引用，并创建热备份`);
      onMigrated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '迁移执行失败');
    } finally {
      setExecuting(false);
    }
  };

  const handleRollback = async (backupPath: string) => {
    if (!confirm('确定要从该热备份回滚数据库吗？所有未备份的最新更改将被覆盖。')) return;
    setRollingBack(true);
    try {
      await workspaceApi.rollbackLegacyMigration(backupPath);
      toast.success('已从热备份成功回滚！');
      onMigrated?.();
      void loadCheck();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '回滚失败');
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="flex flex-col w-full max-w-3xl max-h-[90vh] rounded-2xl border border-border bg-surface-raised shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface0">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="size-5 text-status-warning" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">旧配置与 Agent 体系兼容迁移</h3>
              <p className="text-2xs text-muted-foreground mt-0.5">
                将历史工作配置、流水线模板中引用的旧角色或旧模型，规范化绑定到独立的 Agent 实体
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs font-sans">
          {/* Safety Notice */}
          <div className="p-3.5 rounded-xl border border-border/80 bg-surface0/90 space-y-2">
            <div className="flex items-center gap-2 text-foreground font-medium text-2xs">
              <ShieldCheck className="size-4 text-status-success shrink-0" />
              <span>数据安全承诺与迁移保障</span>
            </div>
            <ul className="text-3xs text-muted-foreground space-y-1 pl-6 list-disc">
              <li>
                <strong>自动热备份</strong>：迁移执行前自动生成包含 SHA-256 校验的 SQLite 物理热备份。
              </li>
              <li>
                <strong>事务级回滚</strong>：所有绑定在单个数据库事务内完成，任何一步异常将自动撤销。
              </li>
              <li>
                <strong>历史只读隔离</strong>：仅调整待执行任务的引用关系，绝对不改写已结束批次、交付 commit 和审计日志。
              </li>
              <li>
                <strong>幂等重复执行</strong>：重复执行不会生成重复的同名 Agent。
              </li>
            </ul>
          </div>

          {loading ? (
            <div className="py-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-2.5">
              <Loader2 className="size-6 animate-spin text-primary" />
              <span>正在全面扫描工作配置、流水线及历史配置引用...</span>
            </div>
          ) : checkData?.needsMigration === false && !executionResult ? (
            <div className="py-10 text-center space-y-3">
              <CheckCircle2 className="size-10 text-status-success mx-auto" />
              <div>
                <p className="text-xs font-semibold text-foreground">所有配置均已与当前 Agent 体系对齐！</p>
                <p className="text-2xs text-muted-foreground mt-1">未检测到任何悬空的角色或非 Agent 引用。</p>
              </div>
              {checkData.lastMigration && (
                <div className="inline-flex items-center gap-2 p-2.5 rounded-lg border border-border bg-surface0 text-3xs text-muted-foreground mt-2">
                  <FileCheck2 className="size-3.5 text-status-info" />
                  <span>
                    最近一次迁移时间：{new Date(checkData.lastMigration.timestamp).toLocaleString()}（处理了{' '}
                    {checkData.lastMigration.migratedCount} 项）
                  </span>
                  <button
                    type="button"
                    disabled={rollingBack}
                    onClick={() => handleRollback(checkData.lastMigration!.backupPath)}
                    className="ml-2 inline-flex items-center gap-1 text-primary hover:underline font-medium"
                  >
                    <Undo2 className="size-3" />
                    <span>回滚到此备份</span>
                  </button>
                </div>
              )}
            </div>
          ) : executionResult ? (
            <div className="p-5 rounded-xl border border-status-success/40 bg-status-success/10 space-y-3 text-status-success">
              <div className="flex items-center gap-2 font-semibold text-xs">
                <CheckCircle2 className="size-4" />
                <span>迁移成功完成！</span>
              </div>
              <p className="text-2xs leading-relaxed text-foreground">
                共更新了 <strong>{executionResult.migratedCount}</strong> 项历史配置引用。已自动创建预迁移备份：
              </p>
              <div className="p-2.5 rounded bg-surface0/90 font-mono text-3xs text-muted-foreground break-all border border-border">
                {executionResult.backup.backupPath}
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={rollingBack}
                  onClick={() => handleRollback(executionResult.backup.backupPath)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-surface0 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Undo2 className="size-3.5" />
                  <span>撤销并回滚</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
                >
                  完成
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-2xs text-muted-foreground">
                <span>
                  共发现 <strong>{checkData?.issues.length}</strong> 项需要规范化迁移的配置项
                </span>
                <button
                  type="button"
                  onClick={loadCheck}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <RefreshCw className="size-3" />
                  <span>重新扫描</span>
                </button>
              </div>

              <div className="space-y-3">
                {checkData?.issues.map((issue) => {
                  const key = `${issue.targetType}-${issue.id}-${issue.field}`;
                  const currentRes = resolutions[key];
                  if (!currentRes) return null;

                  return (
                    <div
                      key={key}
                      className="p-4 rounded-xl border border-border/80 bg-surface0/70 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          {issue.targetType === 'work_profile' && (
                            <Bot className="size-4 text-primary shrink-0" />
                          )}
                          {issue.targetType === 'saved_workflow' && (
                            <Workflow className="size-4 text-status-info shrink-0" />
                          )}
                          {issue.targetType === 'session' && (
                            <GitBranch className="size-4 text-foreground-muted shrink-0" />
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-foreground text-xs">
                                {issue.name}
                              </span>
                              <span className="px-1.5 py-0.5 rounded text-3xs font-mono bg-surface2 text-muted-foreground">
                                {issue.targetType}
                              </span>
                            </div>
                            <p className="text-2xs text-status-warning mt-0.5">{issue.reason}</p>
                          </div>
                        </div>

                        {/* Resolution Mode Selector */}
                        <div className="flex items-center gap-1 bg-surface1 p-0.5 rounded-lg border border-border shrink-0">
                          <button
                            type="button"
                            onClick={() => handleResolutionChange(key, { action: 'bind_agent' })}
                            className={`px-2 py-1 rounded-md text-3xs font-medium transition-colors ${
                              currentRes.action === 'bind_agent'
                                ? 'bg-primary text-primary-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            绑定已有 Agent
                          </button>
                          <button
                            type="button"
                            onClick={() => handleResolutionChange(key, { action: 'create_agent' })}
                            className={`px-2 py-1 rounded-md text-3xs font-medium transition-colors ${
                              currentRes.action === 'create_agent'
                                ? 'bg-primary text-primary-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            新建 Agent
                          </button>
                          <button
                            type="button"
                            onClick={() => handleResolutionChange(key, { action: 'deprecate' })}
                            className={`px-2 py-1 rounded-md text-3xs font-medium transition-colors ${
                              currentRes.action === 'deprecate'
                                ? 'bg-destructive text-destructive-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            归档/废弃
                          </button>
                        </div>
                      </div>

                      {/* Action Details Form */}
                      {currentRes.action === 'bind_agent' && (
                        <div className="flex items-center gap-3 pt-2 border-t border-border/50">
                          <label className="text-2xs text-muted-foreground shrink-0">
                            选择目标 Agent:
                          </label>
                          <select
                            value={currentRes.targetAgentId}
                            onChange={(e) =>
                              handleResolutionChange(key, { targetAgentId: e.target.value })
                            }
                            className="flex-1 h-8 rounded-lg border border-border bg-surface1 px-2.5 text-xs text-foreground"
                          >
                            {checkData.availableAgents.map((ag) => (
                              <option key={ag.id} value={ag.id}>
                                {ag.name} ({ag.role})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {currentRes.action === 'create_agent' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-border/50">
                          <div>
                            <label className="text-3xs text-muted-foreground">Agent 名称</label>
                            <input
                              type="text"
                              value={currentRes.newAgent?.name || ''}
                              onChange={(e) =>
                                handleResolutionChange(key, {
                                  newAgent: { ...currentRes.newAgent!, name: e.target.value },
                                })
                              }
                              className="w-full h-7 rounded-md border border-border bg-surface1 px-2 text-2xs text-foreground"
                            />
                          </div>
                          <div>
                            <label className="text-3xs text-muted-foreground">职责定位</label>
                            <input
                              type="text"
                              value={currentRes.newAgent?.role || ''}
                              onChange={(e) =>
                                handleResolutionChange(key, {
                                  newAgent: { ...currentRes.newAgent!, role: e.target.value },
                                })
                              }
                              className="w-full h-7 rounded-md border border-border bg-surface1 px-2 text-2xs text-foreground"
                            />
                          </div>
                        </div>
                      )}

                      {currentRes.action === 'deprecate' && (
                        <p className="text-3xs text-muted-foreground italic pt-1 border-t border-border/50">
                          {issue.targetType === 'work_profile' && '该工作配置将被安全移除，不再用于新协作任务调度。'}
                          {issue.targetType === 'saved_workflow' && '该流水线模板将被安全移除，不再用于新流水线执行。'}
                          {issue.targetType === 'session' && '该历史会话将标记为已归档，历史记录与消息完全保留。'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Submit Footer */}
              <div className="flex items-center justify-between pt-4 border-t border-border">
                <div className="text-3xs text-muted-foreground">
                  已确认将对 {Object.keys(resolutions).length} 项配置执行原子迁移
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={executing}
                    className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleExecute}
                    disabled={executing || Object.keys(resolutions).length === 0}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 shadow-xs"
                  >
                    {executing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-3.5" />
                    )}
                    <span>备份并执行迁移</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
