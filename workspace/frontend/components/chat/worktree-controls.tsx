'use client';

import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';

interface State {
  available: boolean;
  active: boolean;
  id?: string;
  source?: string;
  root?: string;
  source_dirty?: boolean;
  changed?: boolean;
  reason?: string;
}

interface Review {
  revision: string;
  files: { path: string; action: string }[];
  source: string;
}

export function WorktreeControls({
  channel,
  running,
}: {
  channel: string | null;
  running: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<State | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'create' | 'apply' | 'remove' | null>(null);
  const [review, setReview] = React.useState<Review | null>(null);
  const current = React.useRef(channel);
  current.current = channel;
  const { refreshAgents, setActiveProjectDir } = useWorkspace();
  const { setActiveRightTab } = useLayout();

  React.useEffect(() => {
    setOpen(false);
    setState(null);
    setReview(null);
    setConfirm(null);
  }, [channel]);

  const refresh = React.useCallback(async () => {
    if (!channel || channel.startsWith('draft:')) return;
    try {
      const next = await workspaceApi.request<State>(
        `/v1/runtime/worktree?channel=${encodeURIComponent(channel)}`,
      );
      if (current.current === channel) setState(next);
    } catch (error) {
      if (current.current === channel) {
        setState({
          available: false,
          active: false,
          reason: error instanceof Error ? error.message : '无法读取工作区状态',
        });
      }
    }
  }, [channel]);

  React.useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, running]);

  const projectName = React.useMemo(() => {
    if (state?.source) {
      const parts = state.source.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || '当前项目';
    }
    return '当前项目';
  }, [state?.source]);

  const act = async (action: string) => {
    if (!channel || busy) return;
    const selected = channel;
    setBusy(true);
    try {
      if (action === 'review') {
        const next = await workspaceApi.request<Review>('/v1/runtime/worktree', {
          method: 'POST',
          body: JSON.stringify({ channel: selected, action }),
        });
        if (current.current === selected) {
          if (next.files.length) {
            setReview(next);
            setConfirm('apply');
          } else {
            toast.info('没有需要导回的文件。');
          }
        }
      } else {
        const next = await workspaceApi.request<State>('/v1/runtime/worktree', {
          method: 'POST',
          body: JSON.stringify({
            channel: selected,
            action,
            revision: action === 'apply' ? review?.revision : undefined,
          }),
        });
        if (current.current === selected) {
          setState(next);
          setReview(null);
          setConfirm(null);
          setActiveProjectDir((next.active ? next.root : next.source) || null);
        }
        await refreshAgents();
        window.dispatchEvent(
          new CustomEvent('52hz:project-files-changed', {
            detail: { channel: selected },
          }),
        );
        toast.success(
          action === 'apply'
            ? '已导回原项目，并保存导回前检查点。'
            : '工作区状态已更新。',
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '工作区操作失败');
      if (action === 'apply') {
        setReview(null);
        setConfirm(null);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!channel || channel.startsWith('draft:')) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="mt-2 rounded border border-border px-2 py-1 text-[11px] text-foreground-muted hover:text-foreground transition-colors"
            aria-label="项目隔离工作区"
          >
            {state?.active ? `${projectName} [隔离副本]` : '项目隔离'}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-96 max-w-[90vw] space-y-3 p-4 text-xs"
        >
          <h3 className="font-medium text-foreground">独立 Git 隔离工作区 (Worktree)</h3>
          {!state ? (
            <p className="text-foreground-muted">正在读取项目…</p>
          ) : (
            <>
              <p className="break-all leading-5 text-foreground-muted">
                {state.reason ||
                  (state.active
                    ? '当前任务在独立副本目录执行，原项目文件受到隔离保护。'
                    : '当前任务直接在原项目执行。')}
              </p>

              {state.root && (
                <div className="rounded-lg border border-border/80 bg-surface2/50 p-2.5 text-[11px] space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground flex items-center gap-1.5">
                      <span
                        className={`size-2 rounded-full ${
                          state.active ? 'bg-emerald-400' : 'bg-foreground-muted'
                        }`}
                      />
                      {projectName} · 隔离副本
                    </span>
                    <span className="rounded bg-surface3 px-1.5 py-0.5 text-[10px] font-mono text-foreground-muted">
                      {state.active ? '当前生效中' : '未切入'}
                    </span>
                  </div>
                  <div
                    className="text-[10px] text-foreground-extra-muted break-all font-mono"
                    title={state.root}
                  >
                    副本路径: {state.root}
                  </div>
                </div>
              )}

              <p className="leading-5 text-foreground-extra-muted text-[11px]">
                从当前提交创建，不带入未提交或忽略文件；依赖需自行安装。它只隔离工作目录，命令仍使用系统权限。
              </p>

              <div className="flex flex-wrap gap-2 pt-1">
                {state.id && !state.available && (
                  <button
                    disabled={running || busy}
                    onClick={() => void act('forget')}
                    className="rounded border border-border px-2 py-1.5 disabled:opacity-40 hover:bg-surface2"
                  >
                    清理未创建成功的记录
                  </button>
                )}
                {!state.id && (
                  <button
                    disabled={!state.available || running || busy}
                    onClick={() => setConfirm('create')}
                    className="rounded border border-border px-2 py-1.5 disabled:opacity-40 hover:bg-surface2"
                  >
                    创建并切入隔离副本
                  </button>
                )}
                {state.id && state.available && (
                  <>
                    <button
                      disabled={running || busy}
                      onClick={() => void act(state.active ? 'leave' : 'enter')}
                      className="rounded border border-border px-2 py-1.5 disabled:opacity-40 hover:bg-surface2"
                    >
                      {state.active
                        ? '切回原项目（保留隔离副本）'
                        : '切入已有隔离副本'}
                    </button>
                    <button
                      disabled={running || busy}
                      onClick={() => void act('review')}
                      className="rounded border border-border px-2 py-1.5 disabled:opacity-40 hover:bg-surface2"
                    >
                      审阅并导回原项目
                    </button>
                    <button
                      onClick={() => {
                        setActiveRightTab('diff');
                        setOpen(false);
                      }}
                      className="rounded border border-border px-2 py-1.5 hover:bg-surface2"
                    >
                      查看当前目录 Diff
                    </button>
                    {!state.active && (
                      <button
                        disabled={running || busy || state.changed}
                        onClick={() => setConfirm('remove')}
                        className="rounded border border-border px-2 py-1.5 disabled:opacity-40 hover:bg-surface2 text-red-400"
                      >
                        移除干净的隔离副本
                      </button>
                    )}
                  </>
                )}
              </div>
              {state.changed && (
                <p className="text-foreground-muted text-[11px]">
                  隔离副本有未提交修改，自动移除已禁用。导回后仍会保留，方便继续审阅。
                </p>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(value) => {
          if (!value && !busy) setConfirm(null);
        }}
        title={
          confirm === 'create'
            ? '创建隔离工作区'
            : confirm === 'remove'
              ? '移除干净工作区'
              : '导回原项目'
        }
        description={
          confirm === 'create' ? (
            `从当前 HEAD 创建独立副本目录。${
              state?.source_dirty
                ? '原项目有未提交修改，这些修改会留在原处，不会带入。'
                : ''
            }切换后工具和命令使用隔离目录。`
          ) : confirm === 'remove' ? (
            '仅移除没有修改、没有忽略文件且没有新增提交的隔离目录。'
          ) : (
            <span className="block space-y-2">
              <span className="block">
                将写入原项目：{review?.source}。冲突或审阅后发生变化时会拒绝导回；成功后切回原项目，并保留恢复检查点。
              </span>
              <span className="block max-h-48 overflow-auto font-mono text-[11px]">
                {review?.files.map((file) => (
                  <span key={file.path} className="block break-all">
                    {file.action} · {file.path}
                  </span>
                ))}
              </span>
              {!review?.files.length && <span>没有需要导回的文件。</span>}
            </span>
          )
        }
        confirmLabel={
          confirm === 'apply'
            ? '确认导回'
            : confirm === 'remove'
              ? '确认移除'
              : '创建并切换'
        }
        cancelLabel="取消"
        isLoading={busy}
        onConfirm={() => act(confirm === 'apply' ? 'apply' : confirm || 'create')}
      />
    </>
  );
}
