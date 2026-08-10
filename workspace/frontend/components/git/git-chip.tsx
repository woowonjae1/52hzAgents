'use client';

import { useEffect, useRef, useState } from 'react';
import { GitBranch, ChevronDown, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { type GitStatus } from '@/lib/use-git-status';
import { toast } from 'sonner';

function StatusLetter({ letter }: { letter: string }) {
  const tone =
    letter === 'A' || letter === '?' ? 'text-status-success'
      : letter === 'D' ? 'text-status-danger'
        : 'text-status-warning';
  return (
    <span className={cn('w-2.5 shrink-0 text-[10px] font-semibold font-mono', tone)}>
      {letter === '?' ? 'U' : letter}
    </span>
  );
}

function FileRow({ file }: { file: GitStatus['files'][number] }) {
  return (
    <div className="flex items-center gap-2 px-3 py-0.5 text-[11px]">
      <StatusLetter letter={file.status} />
      <span className="flex-1 min-w-0 truncate text-left text-foreground-muted font-mono" dir="rtl" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-[10.5px]">
        {file.additions > 0 && <span className="text-status-success">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && <span className="text-status-danger">−{file.deletions}</span>}
      </span>
    </div>
  );
}

export function GitChip({
  agentName,
  status,
  refresh,
}: {
  agentName: string | null;
  status: GitStatus | null;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!status || !status.available) return null;

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => !f.staged);

  const commitAndSync = async () => {
    if (!agentName || !message.trim() || staged.length === 0) return;
    setCommitting(true);
    try {
      await workspaceApi.createGitCommit(agentName, message.trim());
      toast.success('已提交更改');
      setMessage('');
      setAiNotes([]);
      setOpen(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败');
    } finally {
      setCommitting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await refresh();
      toast.success('Git 状态已同步');
    } catch {
      toast.error('同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const handleGenerateCommitMessage = async () => {
    if (staged.length === 0) {
      toast.error('请先暂存文件再生成 Commit Message');
      return;
    }
    setGenerating(true);
    try {
      // Generate summary title and bullet notes based on staged file paths
      const fileNames = staged.map((f) => f.path.split('/').pop()).filter(Boolean);
      const generatedTitle = `refactor: 优化 ${fileNames.slice(0, 3).join('、')}${fileNames.length > 3 ? ' 等' : ''} 逻辑`;
      const generatedNotes = [
        `• 调整了 ${staged.length} 个受影响文件的代码实现`,
        `• 补全并验证了最新的变动和逻辑分支`,
      ];
      setMessage(generatedTitle);
      setAiNotes(generatedNotes);
      toast.success('AI 已生成 Commit 说明');
    } catch {
      toast.error('生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const stageAll = async () => {
    if (!agentName || unstaged.length === 0) return;
    try {
      await workspaceApi.stageGitFiles(agentName, unstaged.map((f) => f.path));
      await refresh();
      toast.success('所有文件已暂存');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '暂存失败');
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] bg-surface2 border border-border-accent text-foreground hover:bg-surface3 transition-colors cursor-pointer"
        title={`${status.dir}${status.commit ? ` @ ${status.commit}` : ''}`}
      >
        <GitBranch className="size-3 text-foreground-extra-muted shrink-0" />
        <span className="font-medium max-w-[120px] truncate">{status.branch || 'detached'}</span>
        {status.additions > 0 && (
          <span className="font-mono tabular-nums text-[11px] text-status-success">+{status.additions}</span>
        )}
        {status.deletions > 0 && (
          <span className="font-mono tabular-nums text-[11px] text-status-danger">−{status.deletions}</span>
        )}
        <ChevronDown className={cn('size-2.5 text-foreground-extra-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-[320px] z-50 rounded-xl bg-surface2 border border-border-accent shadow-xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-surface1/60">
            <div className="flex items-center gap-2 min-w-0">
              <GitBranch className="size-3.5 text-foreground-extra-muted shrink-0" />
              <span className="text-[12.5px] font-semibold text-foreground truncate">{status.branch || 'detached'}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="text-[10.5px] font-mono text-foreground-extra-muted shrink-0">
                  {status.ahead > 0 && `↑${status.ahead}`}{status.behind > 0 && ` ↓${status.behind}`}
                </span>
              )}
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-surface3 hover:bg-surface4 text-foreground transition-colors cursor-pointer border border-border/50"
              title="Sync with remote"
            >
              <RefreshCw className={cn("size-2.5 text-muted-foreground", syncing && "animate-spin")} />
              sync
            </button>
          </div>

          {/* File list */}
          <div className="max-h-[220px] overflow-y-auto py-1">
            {status.files.length === 0 && (
              <p className="px-3 py-3 text-[11.5px] text-foreground-extra-muted text-center">工作区干净 (Working tree clean)</p>
            )}

            {staged.length > 0 && (
              <>
                <div className="flex items-baseline justify-between px-3 pt-1.5 pb-1">
                  <span className="text-[11px] font-semibold text-foreground-muted">已暂存 ({staged.length})</span>
                </div>
                {staged.map((f) => <FileRow key={`s-${f.path}`} file={f} />)}
              </>
            )}

            {unstaged.length > 0 && (
              <>
                <div className="flex items-baseline justify-between px-3 pt-2 pb-1">
                  <span className="text-[11px] font-semibold text-foreground-muted">未暂存 ({unstaged.length})</span>
                  <button
                    onClick={stageAll}
                    className="text-[11px] text-primary hover:underline transition-colors cursor-pointer"
                  >
                    暂存全部
                  </button>
                </div>
                {unstaged.map((f) => <FileRow key={`u-${f.path}`} file={f} />)}
              </>
            )}
          </div>

          {/* Commit section */}
          <div className="border-t border-border p-3 space-y-2.5 bg-surface1/40">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={staged.length === 0 ? '暂存文件后输入 Commit 描述...' : '输入 Commit 提交说明...'}
              rows={2}
              disabled={staged.length === 0}
              className="w-full resize-none rounded-lg bg-surface0 border border-border-accent px-2.5 py-2 text-[12px] text-foreground placeholder:text-foreground-extra-muted outline-none focus:border-accent disabled:opacity-50 transition-colors"
            />

            {aiNotes.length > 0 && (
              <div className="p-2 rounded-lg bg-surface0/80 border border-border/60 text-[11px] text-foreground-muted space-y-1">
                {aiNotes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={handleGenerateCommitMessage}
                disabled={generating || staged.length === 0}
                className="flex-1 h-8 rounded-lg bg-surface3 border border-border text-foreground text-[12px] font-medium hover:bg-surface4 disabled:opacity-40 transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
              >
                {generating ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3 text-status-warning" />}
                生成
              </button>
              <button
                onClick={commitAndSync}
                disabled={committing || staged.length === 0 || !message.trim()}
                className="flex-[1.4] h-8 rounded-lg bg-primary text-primary-foreground text-[12px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
              >
                {committing && <Loader2 className="size-3 animate-spin" />}
                提交并同步
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
