'use client';

import { useEffect, useRef, useState } from 'react';
import { GitBranch, ChevronDown, Loader2, RefreshCw, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
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
    <span className={cn('w-2.5 shrink-0 text-3xs font-medium font-mono', tone)}>
      {letter === '?' ? 'U' : letter}
    </span>
  );
}

function FileRow({ file }: { file: GitStatus['files'][number] }) {
  return (
    <div className="flex items-center gap-2 px-3 py-0.5 text-2xs">
      <StatusLetter letter={file.status} />
      <span className="flex-1 min-w-0 truncate text-left text-foreground-muted font-mono" dir="rtl" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-3xs">
        {file.additions > 0 && <span className="text-status-success">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && <span className="text-status-danger">−{file.deletions}</span>}
      </span>
    </div>
  );
}

export function GitChip({
  channelId,
  status,
  refresh,
}: {
  channelId: string | null;
  status: GitStatus | null;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
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

  const commit = async () => {
    if (!channelId || !message.trim() || status.files.length === 0) return;
    setCommitting(true);
    try {
      const autoStage = staged.length === 0;
      await workspaceApi.createGitCommit(channelId, message.trim(), autoStage);
      toast.success(autoStage ? 'All changes staged & committed' : 'Changes committed');
      setMessage('');
      setOpen(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  // Fetch first, then re-read status: without the fetch, ahead/behind are stale
  // numbers from whenever something else last talked to the remote.
  const handleSync = async () => {
    if (!channelId) return;
    setSyncing(true);
    try {
      await workspaceApi.fetchGitRemote(channelId);
      await refresh();
      toast.success('Synced with remote');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handlePull = async () => {
    if (!channelId) return;
    setPulling(true);
    try {
      await workspaceApi.pullGitRemote(channelId);
      await refresh();
      toast.success('Pulled from remote');
    } catch (e) {
      // --ff-only refusals land here; the git message names the real problem
      // (diverged branches), so show it rather than a generic failure.
      toast.error(e instanceof Error ? e.message : 'Pull failed');
    } finally {
      setPulling(false);
    }
  };

  const handlePush = async () => {
    if (!channelId) return;
    setPushing(true);
    try {
      const res = await workspaceApi.pushGitRemote(channelId);
      await refresh();
      toast.success(`Pushed to origin/${res.branch}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Push failed');
    } finally {
      setPushing(false);
    }
  };

  const stageAll = async () => {
    if (!channelId || unstaged.length === 0) return;
    try {
      await workspaceApi.stageGitFiles(channelId, unstaged.map((f) => f.path));
      await refresh();
      toast.success('All files staged');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Stage failed');
    }
  };

  const unstageAll = async () => {
    if (!channelId || staged.length === 0) return;
    try {
      await workspaceApi.unstageGitFiles(channelId, staged.map((f) => f.path));
      await refresh();
      toast.success('Unstaged');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unstage failed');
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-surface2 border border-border-accent text-foreground hover:bg-surface3 transition-colors cursor-pointer"
        title={`${status.dir}${status.commit ? ` @ ${status.commit}` : ''}`}
      >
        <GitBranch className="size-3 text-foreground-muted shrink-0" />
        <span className="font-medium max-w-[120px] truncate">{status.branch || 'detached'}</span>
        {status.additions > 0 && (
          <span className="font-mono tabular-nums text-2xs text-status-success">+{status.additions}</span>
        )}
        {status.deletions > 0 && (
          <span className="font-mono tabular-nums text-2xs text-status-danger">−{status.deletions}</span>
        )}
        <ChevronDown className={cn('size-2.5 text-foreground-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-[320px] z-50 rounded-xl bg-surface2 border border-border-accent shadow-xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-surface1/60">
            <div className="flex items-center gap-2 min-w-0">
              <GitBranch className="size-3.5 text-foreground-extra-muted shrink-0" />
              <span className="text-xs font-semibold text-foreground truncate">{status.branch || 'detached'}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="text-3xs font-mono text-foreground-extra-muted shrink-0">
                  {status.ahead > 0 && `↑${status.ahead}`}{status.behind > 0 && ` ↓${status.behind}`}
                </span>
              )}
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-surface3 hover:bg-surface4 text-foreground transition-colors cursor-pointer border border-border/50"
              title="git fetch --prune, then re-read status"
            >
              <RefreshCw className={cn("size-2.5 text-muted-foreground", syncing && "animate-spin")} />
              Sync
            </button>
          </div>

          {/* File list */}
          <div className="max-h-[220px] overflow-y-auto py-1">
            {status.files.length === 0 && (
              <p className="px-3 py-3 text-2xs text-foreground-extra-muted text-center">Working tree clean</p>
            )}

            {staged.length > 0 && (
              <>
                <div className="flex items-baseline justify-between px-3 pt-1.5 pb-1">
                  <span className="text-2xs font-medium text-foreground-muted">Staged ({staged.length})</span>
                  <button
                    onClick={unstageAll}
                    className="text-2xs text-primary hover:underline transition-colors cursor-pointer"
                  >
                    Unstage
                  </button>
                </div>
                {staged.map((f) => <FileRow key={`s-${f.path}`} file={f} />)}
              </>
            )}

            {unstaged.length > 0 && (
              <>
                <div className="flex items-baseline justify-between px-3 pt-2 pb-1">
                  <span className="text-2xs font-medium text-foreground-muted">Unstaged ({unstaged.length})</span>
                  <button
                    onClick={stageAll}
                    className="text-2xs text-primary hover:underline transition-colors cursor-pointer"
                  >
                    Stage all
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
              placeholder={status.files.length === 0 ? 'Working tree clean' : staged.length === 0 ? 'Commit message (auto-stages all changes)…' : 'Write a commit message…'}
              rows={2}
              disabled={status.files.length === 0}
              className="w-full resize-none rounded-lg bg-surface0 border border-border-accent px-2.5 py-2 text-xs text-foreground placeholder:text-foreground-extra-muted outline-none focus:border-accent disabled:opacity-50 transition-colors"
            />

            <button
              onClick={commit}
              disabled={committing || status.files.length === 0 || !message.trim()}
              className="w-full h-8 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
            >
              {committing && <Loader2 className="size-3 animate-spin" />}
              {staged.length === 0 && unstaged.length > 0 ? 'Commit (Auto-stage all)' : 'Commit'}
            </button>

            {/* Remote actions. Always available — ahead/behind can be stale until
                the sync above runs, so hiding them on those counts would hide
                the push you just made a commit for. */}
            <div className="flex items-center gap-2">
              <button
                onClick={handlePull}
                disabled={pulling || !channelId}
                className="flex-1 h-8 rounded-lg bg-surface3 border border-border text-foreground text-xs font-medium hover:bg-surface4 disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                title="git pull --ff-only"
              >
                {pulling ? <Loader2 className="size-3 animate-spin" /> : <ArrowDownToLine className="size-3 text-foreground-muted" />}
                Pull{status.behind > 0 ? ` (${status.behind})` : ''}
              </button>
              <button
                onClick={handlePush}
                disabled={pushing || !channelId}
                className="flex-1 h-8 rounded-lg bg-surface3 border border-border text-foreground text-xs font-medium hover:bg-surface4 disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                title="git push -u origin <current branch>"
              >
                {pushing ? <Loader2 className="size-3 animate-spin" /> : <ArrowUpFromLine className="size-3 text-foreground-muted" />}
                Push{status.ahead > 0 ? ` (${status.ahead})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
