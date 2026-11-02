'use client';

import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import { useLayout } from '@/components/layout/layout-context';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';

interface Checkpoint { id: string; scope?: string; files: string[]; restored_at: number | null; partial?: boolean; pending_command?: boolean; root_matches?: boolean; coverage?: string; worktree?: boolean; restore_error?: string }
interface RecoveryRun { id: string; channel: string; outcome: string | null; checkpoint: Checkpoint | null; started_at: number; error?: { code: string; message: string }; evidence?: { files_modified?: string[]; commands?: { command: string; exitCode?: number }[] } }
interface Recovery { storage: { recovered: boolean } | null; runs: RecoveryRun[] }
const labels: Record<string, string> = { interrupted: '应用退出导致任务中断', cancelled: '任务已停止', timed_out: '任务超时', failed: '任务失败', denied: '命令已拒绝', expired: '命令审批已过期', limited: '达到执行上限', finished: '运行已结束' };

export function RunRecoveryPanel({ channel, running }: { channel: string | null; running: boolean }) {
  const [state, setState] = React.useState<Recovery | null>(null);
  const [target, setTarget] = React.useState<RecoveryRun | null>(null);
  const [busy, setBusy] = React.useState(false);
  const current = React.useRef(channel); current.current = channel;
  const { setActiveRightTab, openSettings } = useLayout();
  const refresh = React.useCallback(async () => {
    if (!channel || channel.startsWith('draft:')) return;
    try {
      const next = await workspaceApi.request<Recovery>(`/v1/runtime/recovery?channel=${encodeURIComponent(channel)}`);
      if (current.current === channel) setState(next);
    } catch { /* Offline: keep the last known recovery state. */ }
  }, [channel]);
  React.useEffect(() => { setState(null); setTarget(null); void refresh(); }, [refresh]);
  useVisibilityPolling(refresh, running ? 3000 : 10000);
  React.useEffect(() => { void refresh(); }, [running, refresh]);
  React.useEffect(() => { const changed = () => { void refresh(); }; window.addEventListener('52hz:project-files-changed', changed); return () => window.removeEventListener('52hz:project-files-changed', changed); }, [refresh]);
  const runs = state?.runs.filter(run => run.outcome && (run.checkpoint || ['interrupted', 'cancelled', 'failed', 'timed_out', 'denied', 'expired', 'limited'].includes(run.outcome))).slice(-5).reverse() || [];
  if (!runs.length && !state?.storage?.recovered) return null;
  const restore = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await workspaceApi.request('/v1/runtime/restore', { method: 'POST', body: JSON.stringify({ channel, run_id: target.id }) });
      toast.success('检查点覆盖的文件已恢复，外部操作未撤销。');
      window.dispatchEvent(new Event('focus')); await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : '撤销失败'); }
    finally { setBusy(false); setTarget(null); }
  };
  return <div className="mt-2 rounded-lg border border-border bg-surface1 px-3 py-2 text-xs" data-testid="run-recovery">
    {state?.storage?.recovered && <p role="status" className="mb-2 text-amber-500">工作区数据已从上次有效备份恢复，损坏原文件已保留。</p>}
    {!!runs.length && <details><summary className="cursor-pointer text-foreground-muted">{labels[runs[0].outcome || ''] || '任务记录'} · 修改恢复记录</summary>
      <p className="mt-2 leading-5 text-foreground-muted">中断后不会自动重放命令。可查看当前修改，再发送新消息继续；Agent 会重新检查项目，命令仍需审批。</p>
      <div className="mt-2 max-h-52 overflow-y-auto space-y-3">{runs.map(run => <div key={run.id} className="border-t border-border pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><span>{labels[run.outcome || ''] || run.outcome} · {new Date(run.started_at).toLocaleString()}</span>{!run.checkpoint?.worktree && <button type="button" onClick={() => setActiveRightTab('diff')} className="underline underline-offset-2">查看修改</button>}</div>
        {run.error && <p className="mt-2 break-words text-foreground-muted">{run.error.message}{['AUTH_FAILED','MODEL_ACCESS_DENIED','MODEL_NOT_FOUND','NETWORK_ERROR','QUOTA_EXHAUSTED','RATE_LIMITED','SERVER_ERROR'].includes(run.error.code) && <button type="button" onClick={() => openSettings('agents')} className="ml-2 underline underline-offset-2">检查模型连接</button>}</p>}
        {run.evidence?.commands?.some(command => command.exitCode === undefined) && <p className="mt-1 text-amber-500">存在未获得退出结果的命令，请先确认其实际影响。</p>}
        {run.checkpoint && <><p className="mt-1 break-all text-foreground-muted">检查点文件：{run.checkpoint.files.join('、') || '未记录文件变更'}</p>
          {run.checkpoint.coverage && <p className="mt-1 leading-5 text-foreground-muted">覆盖范围：{run.checkpoint.coverage}</p>}
          {run.checkpoint.partial && <p className="mt-1 text-amber-500">快照仅覆盖部分文件，超限或忽略文件需要人工检查。</p>}
          {run.checkpoint.pending_command && <p className="mt-1 text-amber-500">命令缺少执行后快照，自动恢复已禁用。请先人工检查进程与文件。</p>}
          {run.checkpoint.worktree && <p className="mt-1 text-foreground-muted">恢复目标为此子任务的独立工作区。恢复后需要重试任务并重新审阅。</p>}
          {run.checkpoint.root_matches === false && <p className="mt-1 text-foreground-muted">{run.checkpoint.restore_error || '检查点属于另一个工作目录，切回该目录后可恢复。'}</p>}
          <button type="button" disabled={running || busy || !!run.checkpoint.restored_at || !!run.checkpoint.pending_command || run.checkpoint.root_matches === false || !run.checkpoint.files.length} onClick={() => setTarget(run)} className="mt-2 rounded border border-border px-2 py-1 disabled:opacity-40">{run.checkpoint.restored_at ? '检查点文件已恢复' : '恢复此任务的检查点文件'}</button></>}
      </div>)}</div>
      <p className="mt-2 leading-5 text-foreground-muted">恢复仅覆盖记录在检查点中的项目文件；忽略或超限文件、进程、数据库与外部服务操作不在范围内。文件有后续改动时会阻止恢复。</p>
    </details>}
    <ConfirmDialog open={!!target} onOpenChange={open => { if (!open && !busy) setTarget(null); }} title="恢复检查点文件" description={`将恢复 ${target?.checkpoint?.files.length || 0} 个文件到此任务记录的修改前内容，保留当时已有的未提交改动。仅恢复快照覆盖的文件；进程、数据库、外部操作无法撤销，后续文件冲突会阻止恢复。`} confirmLabel="确认恢复" cancelLabel="取消" variant="destructive" isLoading={busy} onConfirm={restore} />
  </div>;
}
