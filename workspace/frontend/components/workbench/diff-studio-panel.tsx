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

  useEffect(() => {
    if (files.length > 0 && (!selectedPath || !files.some((f) => f.path === selectedPath))) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

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
        <div className="flex items-center gap-1">
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

      {/* File List Rail (Horizontal Scrollable Tabs or Compact List) */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-surface0 overflow-x-auto no-scrollbar shrink-0 select-none">
        {files.map((file) => {
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
    </div>
  );
}
