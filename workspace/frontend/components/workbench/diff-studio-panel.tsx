'use client';

import * as React from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileCode2,
  FileDiff,
  RefreshCw,
  Copy,
  Check,
  Undo2,
  CheckCircle2,
  Loader2,
  GitBranch,
} from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { DiffBlock } from '@/components/chat/diff-block';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { useGitStatus, type GitFileChange } from '@/lib/use-git-status';
import { copyWithToast } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

function StatusBadge({ status }: { status: string }) {
  const isAdded = status === 'A' || status === '?';
  const isDeleted = status === 'D';
  const label = isAdded ? 'Added' : isDeleted ? 'Deleted' : 'Modified';

  return (
    <span
      className={cn(
        'w-4 h-4 shrink-0 rounded text-center font-mono text-3xs font-semibold flex items-center justify-center',
        isAdded && 'text-diff-addition bg-diff-addition/15',
        isDeleted && 'text-diff-deletion bg-diff-deletion/15',
        !isAdded && !isDeleted && 'text-foreground-extra-muted bg-surface3 border border-border/50'
      )}
      title={label}
    >
      {status === '?' ? 'U' : status}
    </span>
  );
}

export function DiffStudioPanel() {
  const { currentSessionId, sessions } = useWorkspace();
  const serverSessionId = currentSessionId;
  const { status: gitStatus, refresh: refreshGit } = useGitStatus(serverSessionId);

  const files = gitStatus?.files || [];
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [diffCache, setDiffCache] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [confirmDiscardPath, setConfirmDiscardPath] = useState<string | null>(null);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'M' | 'A' | 'D'>('all');
  const [filterQuery, setFilterQuery] = useState('');

  const modifiedCount = useMemo(() => files.filter((f) => f.status !== 'A' && f.status !== '?' && f.status !== 'D').length, [files]);
  const addedCount = useMemo(() => files.filter((f) => f.status === 'A' || f.status === '?').length, [files]);
  const deletedCount = useMemo(() => files.filter((f) => f.status === 'D').length, [files]);

  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      if (filterType !== 'all') {
        const isAdded = f.status === 'A' || f.status === '?';
        const isDeleted = f.status === 'D';
        const isMod = !isAdded && !isDeleted;
        if (filterType === 'A' && !isAdded) return false;
        if (filterType === 'D' && !isDeleted) return false;
        if (filterType === 'M' && !isMod) return false;
      }
      if (filterQuery.trim()) {
        return f.path.toLowerCase().includes(filterQuery.trim().toLowerCase());
      }
      return true;
    });
  }, [files, filterType, filterQuery]);

  useEffect(() => {
    if (filteredFiles.length > 0 && (!selectedPath || !filteredFiles.some((f) => f.path === selectedPath))) {
      setSelectedPath(filteredFiles[0].path);
    }
  }, [filteredFiles, selectedPath]);

  const fetchDiff = useCallback(
    async (filePath: string) => {
      if (!serverSessionId || !filePath) return;
      if (diffCache[filePath] !== undefined) return;

      setLoadingFile(filePath);
      try {
        const res = await workspaceApi.getGitDiff(serverSessionId, filePath);
        setDiffCache((prev) => ({
          ...prev,
          [filePath]: res.diff || 'No textual changes detected against baseline.',
        }));
      } catch (err) {
        setDiffCache((prev) => ({
          ...prev,
          [filePath]: `Error loading diff: ${err instanceof Error ? err.message : String(err)}`,
        }));
      } finally {
        setLoadingFile(null);
      }
    },
    [serverSessionId, diffCache]
  );

  useEffect(() => {
    if (selectedPath) {
      void fetchDiff(selectedPath);
    }
  }, [selectedPath, fetchDiff]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    setDiffCache({});
    try {
      await refreshGit();
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyDiff = async () => {
    const activeDiff = diffCache[selectedPath];
    if (!activeDiff) return;
    const ok = await copyWithToast(activeDiff, 'Diff copied to clipboard');
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDiscardFile = async (path: string) => {
    if (!serverSessionId || !path || discarding) return;
    setDiscarding(path);
    try {
      await workspaceApi.discardGitChanges(serverSessionId, [path]);
      const name = path.split(/[/\\]/).pop() || path;
      toast.success(`Discarded changes to ${name}`);
      setDiffCache((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      await refreshGit();
    } catch (err) {
      toast.error(`Failed to discard changes: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiscarding(null);
      setConfirmDiscardPath(null);
    }
  };

  const handleDiscardAll = async () => {
    if (!serverSessionId || files.length === 0 || discarding) return;
    setDiscarding('all');
    try {
      await workspaceApi.discardGitChanges(serverSessionId, files.map((f) => f.path));
      toast.success(`Discarded all changes across ${files.length} file(s)`);
      setDiffCache({});
      await refreshGit();
    } catch (err) {
      toast.error(`Failed to discard changes: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiscarding(null);
      setConfirmDiscardAll(false);
    }
  };

  const currentDiff = diffCache[selectedPath] || '';
  const isFileLoading = loadingFile === selectedPath;

  if (!gitStatus?.available) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground select-none">
        <FileDiff className="size-8 text-foreground-extra-muted mb-2.5 opacity-60" />
        <p className="text-xs font-semibold text-foreground">Git Repository Not Detected</p>
        <p className="text-3xs mt-1 max-w-xs text-foreground-extra-muted">
          This project directory is not a Git repository or Git is not initialized.
        </p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col h-full bg-surface0">
        <div className="flex items-center justify-between px-3.5 py-2 border-b border-border-chrome bg-surface1/60 select-none">
          <div className="flex items-center gap-2 min-w-0">
            <GitBranch className="size-3.5 text-primary shrink-0" />
            <span className="text-xs font-mono font-medium truncate">{gitStatus.branch || 'HEAD'}</span>
          </div>
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="p-1 rounded-md hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>
        <div className="flex flex-col items-center justify-center flex-1 p-6 text-center text-muted-foreground select-none">
          <CheckCircle2 className="size-8 text-status-success mb-2.5 opacity-80" />
          <p className="text-xs font-semibold text-foreground">Working Tree Clean</p>
          <p className="text-3xs mt-1 max-w-xs text-foreground-extra-muted">
            All agent changes have been committed or no pending modifications exist.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface0 select-text overflow-hidden">
      {/* Top Meta Bar */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-border-chrome bg-surface1/70 select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="size-3.5 text-primary shrink-0" />
          <span className="text-xs font-mono font-medium truncate">{gitStatus.branch || 'HEAD'}</span>
          <span className="text-3xs px-1.5 py-0.5 rounded-full bg-surface2 font-mono text-foreground-muted border border-border/60">
            +{gitStatus.additions} -{gitStatus.deletions}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {files.length > 0 && (
            <Hint label="Discard all modified files">
              <button
                type="button"
                onClick={() => setConfirmDiscardAll(true)}
                disabled={Boolean(discarding)}
                className="px-2 py-1 rounded-md text-3xs font-medium text-destructive hover:bg-destructive/10 transition-colors cursor-pointer disabled:opacity-50"
              >
                Discard All
              </button>
            </Hint>
          )}
          {selectedPath && (
            <Hint label={copied ? 'Copied' : 'Copy diff'}>
              <button
                type="button"
                onClick={handleCopyDiff}
                className="p-1 rounded-md hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
              >
                {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
              </button>
            </Hint>
          )}
          <Hint label="Refresh diffs">
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={refreshing}
              className="p-1 rounded-md hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            </button>
          </Hint>
        </div>
      </div>

      {/* Proofreading Filter Bar (Visible when files exist) */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/60 bg-surface1/40 text-3xs select-none shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterType('all')}
            className={cn(
              'px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer',
              filterType === 'all'
                ? 'bg-surface3 text-foreground font-semibold shadow-2xs'
                : 'text-foreground-muted hover:text-foreground'
            )}
          >
            All ({files.length})
          </button>
          {modifiedCount > 0 && (
            <button
              type="button"
              onClick={() => setFilterType('M')}
              className={cn(
                'px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer',
                filterType === 'M'
                  ? 'bg-surface3 text-foreground font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              Modified ({modifiedCount})
            </button>
          )}
          {addedCount > 0 && (
            <button
              type="button"
              onClick={() => setFilterType('A')}
              className={cn(
                'px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer',
                filterType === 'A'
                  ? 'bg-surface3 text-diff-addition font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-diff-addition'
              )}
            >
              Added ({addedCount})
            </button>
          )}
          {deletedCount > 0 && (
            <button
              type="button"
              onClick={() => setFilterType('D')}
              className={cn(
                'px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer',
                filterType === 'D'
                  ? 'bg-surface3 text-diff-deletion font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-diff-deletion'
              )}
            >
              Deleted ({deletedCount})
            </button>
          )}
        </div>

        {files.length > 5 && (
          <input
            type="text"
            placeholder="Filter file…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="w-24 px-1.5 py-0.5 rounded bg-surface2/60 text-3xs text-foreground placeholder:text-foreground-extra-muted border border-border/50 outline-hidden focus:w-36 transition-all"
          />
        )}
      </div>

      {/* File List Rail (Horizontal Scrollable Tabs or Compact List) */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-surface0 overflow-x-auto no-scrollbar shrink-0 select-none">
        {filteredFiles.map((file) => {
          const isSelected = file.path === selectedPath;
          const fileName = file.path.split(/[/\\]/).pop() || file.path;
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedPath(file.path)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-mono transition-all shrink-0 cursor-pointer border',
                isSelected
                  ? 'bg-surface2 text-foreground font-semibold border-border shadow-xs'
                  : 'bg-transparent text-foreground-muted hover:text-foreground hover:bg-surface2/60 border-transparent'
              )}
            >
              <StatusBadge status={file.status} />
              <span className="truncate max-w-[140px]">{fileName}</span>
            </button>
          );
        })}
      </div>

      {/* Active File Review Bar */}
      {selectedPath && (
        <div className="flex items-center justify-between px-3.5 py-1.5 bg-surface1/50 border-b border-border/50 text-2xs select-none shrink-0">
          <div className="flex items-center gap-1.5 font-mono text-foreground-muted truncate min-w-0">
            <FileCode2 className="size-3.5 text-foreground-extra-muted shrink-0" />
            <span className="truncate">{selectedPath}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmDiscardPath(selectedPath)}
              disabled={Boolean(discarding)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-destructive hover:bg-destructive/10 transition-colors cursor-pointer text-3xs font-medium disabled:opacity-50"
            >
              <Undo2 className="size-3" />
              <span>Discard File</span>
            </button>
          </div>
        </div>
      )}

      {/* Diff Inspector Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {isFileLoading ? (
          <div className="flex items-center justify-center h-48 gap-2 text-xs text-foreground-muted">
            <Loader2 className="size-4 animate-spin" />
            <span>Loading diff for {selectedPath}...</span>
          </div>
        ) : currentDiff ? (
          <DiffBlock
            code={currentDiff}
            embedded
          />
        ) : (
          <div className="flex items-center justify-center h-48 text-xs text-foreground-muted">
            Select a file to inspect diffs
          </div>
        )}
      </div>

      {/* Confirm Discard Single File */}
      <ConfirmDialog
        open={Boolean(confirmDiscardPath)}
        onOpenChange={(v) => { if (!v) setConfirmDiscardPath(null); }}
        title="Discard File Changes?"
        description={`This will permanently revert all pending modifications in "${confirmDiscardPath ? confirmDiscardPath.split(/[/\\]/).pop() : ''}" back to the repository baseline.`}
        confirmLabel="Discard File"
        variant="destructive"
        isLoading={discarding === confirmDiscardPath}
        onConfirm={() => {
          if (confirmDiscardPath) return handleDiscardFile(confirmDiscardPath);
        }}
      />

      {/* Confirm Discard All Files */}
      <ConfirmDialog
        open={confirmDiscardAll}
        onOpenChange={setConfirmDiscardAll}
        title="Discard All Changes?"
        description={`This will permanently revert all ${files.length} modified file(s) in this workspace back to the repository baseline. This action cannot be undone.`}
        confirmLabel="Discard All Changes"
        variant="destructive"
        isLoading={discarding === 'all'}
        onConfirm={handleDiscardAll}
      />
    </div>
  );
}
