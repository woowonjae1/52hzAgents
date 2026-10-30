'use client';

import * as React from 'react';
import { Database, Download, RefreshCw, ShieldCheck, AlertTriangle, CheckCircle2, Loader2, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';

interface BackupItem {
  path: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  metadata?: {
    label?: string;
    checksum?: string;
    sourceDb?: string;
  };
}

export function BackupRecoverySettings() {
  const { refreshWorkspace } = useWorkspace();
  const [backups, setBackups] = React.useState<BackupItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [restoringPath, setRestoringPath] = React.useState<string | null>(null);
  const [backupLabel, setBackupLabel] = React.useState('');
  const [integrityState, setIntegrityState] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [checkingIntegrity, setCheckingIntegrity] = React.useState(false);
  const [confirmRestore, setConfirmRestore] = React.useState<string | null>(null);

  const loadBackups = React.useCallback(async () => {
    try {
      setLoading(true);
      const list = await workspaceApi.listBackups();
      setBackups(list);
    } catch (err: any) {
      toast.error('Failed to load database backups: ' + (err.message || 'unknown error'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const handleCreateBackup = async () => {
    try {
      setCreating(true);
      const label = backupLabel.trim() || 'manual';
      await workspaceApi.createBackup({ label });
      toast.success(`Backup created: ${label}`);
      setBackupLabel('');
      await loadBackups();
    } catch (err: any) {
      toast.error('Failed to create backup: ' + (err.message || 'unknown error'));
    } finally {
      setCreating(false);
    }
  };

  const handleCheckIntegrity = async () => {
    try {
      setCheckingIntegrity(true);
      const res = await workspaceApi.checkIntegrity();
      if (res.ok) {
        setIntegrityState({ ok: true, message: 'Database integrity verified: PRAGMA integrity_check and foreign keys are valid.' });
        toast.success('Database integrity verified');
      } else {
        const violations = res.foreignKeyViolations?.length ? ` (${res.foreignKeyViolations.length} FK violations)` : '';
        setIntegrityState({ ok: false, message: `Integrity check failed: ${res.integrity.join(', ')}${violations}` });
        toast.error('Database integrity check reported warnings');
      }
    } catch (err: any) {
      setIntegrityState({ ok: false, message: 'Failed to verify integrity: ' + err.message });
      toast.error('Failed to check database integrity');
    } finally {
      setCheckingIntegrity(false);
    }
  };

  const handleRestoreBackup = async (backupPath: string) => {
    try {
      setRestoringPath(backupPath);
      await workspaceApi.restoreBackup(backupPath);
      toast.success('Database restored successfully from backup.');
      setConfirmRestore(null);
      await loadBackups();
      await refreshWorkspace();
    } catch (err: any) {
      toast.error('Failed to restore backup: ' + (err.message || 'unknown error'));
    } finally {
      setRestoringPath(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="p-6 rounded-2xl bg-surface1 border border-border/60 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Database className="size-5 text-primary" />
              数据库备份与灾难恢复
            </h2>
            <p className="text-xs text-foreground-muted leading-relaxed">
              支持在线热备份 (SQLite Backup API)、SHA-256 完整性哈希与跨进程无损回滚。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckIntegrity}
              disabled={checkingIntegrity}
              className="text-xs h-8 flex items-center gap-1.5"
            >
              {checkingIntegrity ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5 text-emerald-500" />}
              <span>完整性校验</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={loadBackups}
              disabled={loading}
              className="text-xs h-8 flex items-center gap-1.5"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              <span>刷新</span>
            </Button>
          </div>
        </div>

        {integrityState && (
          <div className={cn(
            'p-3 rounded-xl border text-xs flex items-center gap-2',
            integrityState.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 border-destructive/20 text-destructive'
          )}>
            {integrityState.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
            <span>{integrityState.message}</span>
          </div>
        )}

        {/* Create backup row */}
        <div className="pt-2 flex items-center gap-2">
          <Input
            placeholder="备份备注标签（可选，默认 manual）"
            value={backupLabel}
            onChange={(e) => setBackupLabel(e.target.value)}
            className="max-w-xs h-8 text-xs bg-surface2 border-border/60"
          />
          <Button
            size="sm"
            onClick={handleCreateBackup}
            disabled={creating}
            className="bg-primary text-primary-foreground text-xs h-8 flex items-center gap-1.5 shadow-xs"
          >
            {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            <span>创建热备份</span>
          </Button>
        </div>
      </div>

      {/* Backups List */}
      <div className="p-6 rounded-2xl bg-surface1 border border-border/60 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <History className="size-4 text-primary" />
          历史备份清单 ({backups.length})
        </h3>

        {loading ? (
          <div className="py-8 flex items-center justify-center text-xs text-foreground-muted gap-2">
            <Loader2 className="size-4 animate-spin" />
            <span>加载备份列表中…</span>
          </div>
        ) : backups.length === 0 ? (
          <div className="py-8 text-center text-xs text-foreground-muted">
            暂无备份文件。点击上方“创建热备份”可即时归档当前数据库快照。
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {backups.map((b) => (
              <div key={b.path} className="py-3 flex items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground truncate">{b.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface2 text-foreground-muted font-mono">
                      {formatSize(b.sizeBytes)}
                    </span>
                    {b.metadata?.label && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary font-medium">
                        {b.metadata.label}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground-muted flex items-center gap-3">
                    <span>{new Date(b.createdAt).toLocaleString()}</span>
                    {b.metadata?.checksum && (
                      <span className="font-mono text-[10px] text-foreground-muted/80">
                        SHA-256: {b.metadata.checksum.slice(0, 12)}…
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {confirmRestore === b.path ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="text-xs h-7 px-2.5"
                        disabled={restoringPath === b.path}
                        onClick={() => handleRestoreBackup(b.path)}
                      >
                        {restoringPath === b.path ? <Loader2 className="size-3 animate-spin" /> : '确认恢复'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 px-2"
                        onClick={() => setConfirmRestore(null)}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7 px-2.5 flex items-center gap-1.5"
                      onClick={() => setConfirmRestore(b.path)}
                    >
                      <RefreshCw className="size-3" />
                      <span>恢复</span>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
