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
  MessageSquare,
  MessageSquarePlus,
  FolderTree,
  GitPullRequest,
  SlidersHorizontal,
  GitCommit,
} from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { DiffBlock } from '@/components/chat/diff-block';
import { useWorkspace } from '@/lib/workspace-context';
import { useReviewOptional } from '@/lib/review-context';
import { workspaceApi } from '@/lib/api';
import { useGitStatus, type GitFileChange } from '@/lib/use-git-status';
import { copyWithToast } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FileTree } from './file-tree';
import { GitPanel } from './git-panel';

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
  const review = useReviewOptional();
  const totalReviewComments = review?.comments.length ?? 0;

  const files = gitStatus?.files || [];
  const [panelMode, setPanelMode] = useState<'diff' | 'git'>('diff');
  const [showFileTree, setShowFileTree] = useState(true);
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

  return (
    <div className="flex flex-col h-full bg-surface0 select-text overflow-hidden">
      {/* Top Meta Sub-Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-surface1/60 select-none shrink-0 text-2xs">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-2xs text-foreground font-semibold">
            <GitBranch className="size-3 text-primary shrink-0" />
            <span className="truncate max-w-[120px]">{gitStatus.branch || 'HEAD'}</span>
          </div>

          <span className="text-3xs px-1.5 py-0.2 rounded-full bg-surface2 font-mono text-foreground-muted border border-border/60">
            +{gitStatus.additions} -{gitStatus.deletions}
          </span>

          {totalReviewComments > 0 && (
            <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.2 rounded-full bg-primary/15 font-mono text-primary font-semibold border border-primary/30">
              <MessageSquare className="size-2.5" />
              <span>{totalReviewComments}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Toggle between Diff view and Git commit view */}
          <button
            type="button"
            onClick={() => setPanelMode((m) => (m === 'diff' ? 'git' : 'diff'))}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-3xs font-medium transition-colors cursor-pointer border',
              panelMode === 'git'
                ? 'bg-primary/15 text-primary border-primary/30 font-semibold'
                : 'bg-surface2 text-foreground-muted hover:text-foreground border-border/60'
            )}
          >
            <GitCommit className="size-3" />
            <span>{panelMode === 'git' ? 'View Diff' : 'Git Commit'}</span>
          </button>

          {panelMode === 'diff' && files.length > 0 && (
            <Hint label={showFileTree ? 'Hide File Tree' : 'Show File Tree'}>
              <button
                type="button"
                onClick={() => setShowFileTree((prev) => !prev)}
                className={cn(
                  'p-1 rounded-md transition-colors cursor-pointer',
                  showFileTree ? 'bg-surface2 text-foreground' : 'text-foreground-muted hover:text-foreground'
                )}
              >
                <FolderTree className="size-3.5" />
              </button>
            </Hint>
          )}

          {panelMode === 'diff' && selectedPath && (
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

      {/* Main Panel Content: Git Mode vs Diff Mode */}
      {panelMode === 'git' ? (
        <GitPanel
          channelId={serverSessionId || undefined}
          gitStatus={gitStatus}
          onRefresh={refreshGit}
          onSelectFile={(path) => {
            setSelectedPath(path);
            setPanelMode('diff');
          }}
        />
      ) : files.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 p-6 text-center text-muted-foreground select-none">
          <CheckCircle2 className="size-8 text-status-success mb-2.5 opacity-80" />
          <p className="text-xs font-semibold text-foreground">Working Tree Clean</p>
          <p className="text-3xs mt-1 max-w-xs text-foreground-extra-muted">
            All agent changes have been committed or no pending modifications exist.
          </p>
          <button
            type="button"
            onClick={() => setPanelMode('git')}
            className="mt-3 px-3 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 text-foreground text-2xs font-medium border border-border/80 transition-colors cursor-pointer"
          >
            Open Git & Sync Panel
          </button>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left File Tree Sidebar */}
          {showFileTree && (
            <div className="w-56 md:w-64 shrink-0 h-full border-r border-border">
              <FileTree
                files={files}
                selectedPath={selectedPath}
                onSelectFile={setSelectedPath}
                reviewComments={review?.comments}
              />
            </div>
          )}

          {/* Right Diff Workspace */}
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-surface0">
            {/* Active File Review Bar */}
            {selectedPath && (
              <div className="flex items-center justify-between px-3.5 py-1.5 bg-surface1/50 border-b border-border/50 text-2xs select-none shrink-0">
                <div className="flex items-center gap-1.5 font-mono text-foreground-muted truncate min-w-0">
                  <FileCode2 className="size-3.5 text-foreground-extra-muted shrink-0" />
                  <span className="truncate">{selectedPath}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="hidden sm:inline-flex items-center gap-1 text-3xs text-foreground-extra-muted">
                    <MessageSquarePlus className="size-3 text-primary/80" />
                    <span>Click any line to comment</span>
                  </span>
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

            {/* Diff Content View */}
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              {isFileLoading ? (
                <div className="flex items-center justify-center h-48 gap-2 text-xs text-foreground-muted">
                  <Loader2 className="size-4 animate-spin" />
                  <span>Loading diff for {selectedPath}...</span>
                </div>
              ) : currentDiff ? (
                <DiffBlock
                  code={currentDiff}
                  filePath={selectedPath}
                  interactiveReview
                  embedded
                />
              ) : (
                <div className="flex items-center justify-center h-48 text-xs text-foreground-muted">
                  Select a file from the tree to inspect diffs
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
