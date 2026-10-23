'use client';

import * as React from 'react';
import { useState, useCallback } from 'react';
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Check,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  Minus,
  UploadCloud,
  DownloadCloud,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';
import { toast } from '@/lib/toast';
import { workspaceApi } from '@/lib/api';
import type { GitStatus, GitFileChange } from '@/lib/use-git-status';

interface GitPanelProps {
  channelId?: string;
  gitStatus: GitStatus;
  onRefresh: () => Promise<void>;
  onSelectFile?: (path: string) => void;
  className?: string;
}

export function GitPanel({
  channelId,
  gitStatus,
  onRefresh,
  onSelectFile,
  className,
}: GitPanelProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoStage, setAutoStage] = useState(true);

  const files = gitStatus.files || [];
  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => !f.staged);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleStageAll = async () => {
    if (!channelId || unstagedFiles.length === 0) return;
    try {
      await workspaceApi.stageGitFiles(
        channelId,
        unstagedFiles.map((f) => f.path)
      );
      toast.success(`Staged ${unstagedFiles.length} file(s)`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed to stage files: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleUnstageAll = async () => {
    if (!channelId || stagedFiles.length === 0) return;
    try {
      await workspaceApi.unstageGitFiles(
        channelId,
        stagedFiles.map((f) => f.path)
      );
      toast.success(`Unstaged ${stagedFiles.length} file(s)`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed to unstage files: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleStageFile = async (path: string) => {
    if (!channelId) return;
    try {
      await workspaceApi.stageGitFiles(channelId, [path]);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed to stage file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleUnstageFile = async (path: string) => {
    if (!channelId) return;
    try {
      await workspaceApi.unstageGitFiles(channelId, [path]);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed to unstage file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCommit = async (andPush = false) => {
    if (!channelId) return;
    const msg = commitMessage.trim();
    if (!msg) {
      toast.error('Please enter a commit message');
      return;
    }

    if (!autoStage && stagedFiles.length === 0) {
      toast.error('No changes staged for commit');
      return;
    }

    setIsCommitting(true);
    try {
      await workspaceApi.createGitCommit(channelId, msg, autoStage);
      toast.success('Commit created successfully');
      setCommitMessage('');
      await onRefresh();

      if (andPush) {
        setIsPushing(true);
        try {
          const pushRes = await workspaceApi.pushGitRemote(channelId);
          toast.success(`Pushed to ${pushRes.branch || 'remote'} successfully`);
          await onRefresh();
        } catch (pushErr) {
          toast.error(`Commit created, but push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`);
        } finally {
          setIsPushing(false);
        }
      }
    } catch (err) {
      toast.error(`Failed to create commit: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCommitting(false);
    }
  };

  const handlePull = async () => {
    if (!channelId || isPulling) return;
    setIsPulling(true);
    try {
      await workspaceApi.pullGitRemote(channelId);
      toast.success('Pulled latest changes from remote');
      await onRefresh();
    } catch (err) {
      toast.error(`Failed to pull: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsPulling(false);
    }
  };

  const handlePushOnly = async () => {
    if (!channelId || isPushing) return;
    setIsPushing(true);
    try {
      const res = await workspaceApi.pushGitRemote(channelId);
      toast.success(`Pushed to ${res.branch || 'remote'}`);
      await onRefresh();
    } catch (err) {
      toast.error(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsPushing(false);
    }
  };

  return (
    <div className={cn('flex flex-col h-full bg-surface0 overflow-y-auto select-none', className)}>
      {/* Branch & Sync Card (ported from cdesktop RepoCard) */}
      <div className="p-3.5 border-b border-border bg-surface1/60 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <GitBranch className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground truncate">
                {gitStatus.branch || 'HEAD'}
              </p>
              <p className="text-3xs font-mono text-foreground-extra-muted truncate">
                {gitStatus.dir_name || 'repository'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Hint label="Sync & Refresh Git status">
              <button
                type="button"
                onClick={handleManualRefresh}
                disabled={isRefreshing}
                className="p-1.5 rounded-md hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
              >
                <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
              </button>
            </Hint>
          </div>
        </div>

        {/* Sync Stats Bar */}
        <div className="flex items-center justify-between p-2 rounded-lg bg-surface2/70 border border-border/60 text-2xs">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-foreground-muted" title="Commits ahead of remote">
              <ArrowUp className="size-3 text-status-success" />
              <span className="font-mono text-foreground">{gitStatus.ahead ?? 0}</span>
              <span className="text-3xs text-foreground-extra-muted">ahead</span>
            </div>
            <div className="flex items-center gap-1 text-foreground-muted" title="Commits behind remote">
              <ArrowDown className="size-3 text-status-warning" />
              <span className="font-mono text-foreground">{gitStatus.behind ?? 0}</span>
              <span className="text-3xs text-foreground-extra-muted">behind</span>
            </div>
          </div>

          <div className="flex items-center gap-1 font-mono text-3xs">
            <span className="text-diff-addition">+{gitStatus.additions}</span>
            <span className="text-foreground-extra-muted">/</span>
            <span className="text-diff-deletion">-{gitStatus.deletions}</span>
          </div>
        </div>

        {/* Quick Sync Remote Buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handlePull}
            disabled={isPulling}
            className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-surface2 hover:bg-surface3 text-foreground text-2xs font-medium border border-border/60 transition-colors cursor-pointer disabled:opacity-50"
          >
            {isPulling ? <Loader2 className="size-3 animate-spin" /> : <DownloadCloud className="size-3" />}
            <span>Pull Remote</span>
          </button>
          <button
            type="button"
            onClick={handlePushOnly}
            disabled={isPushing}
            className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-surface2 hover:bg-surface3 text-foreground text-2xs font-medium border border-border/60 transition-colors cursor-pointer disabled:opacity-50"
          >
            {isPushing ? <Loader2 className="size-3 animate-spin" /> : <UploadCloud className="size-3" />}
            <span>Push Remote</span>
          </button>
        </div>
      </div>

      {/* Commit Composer Section */}
      <div className="p-3.5 border-b border-border bg-surface0 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold text-foreground uppercase tracking-wider">
            Commit Changes
          </span>
          <label className="flex items-center gap-1.5 text-3xs text-foreground-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoStage}
              onChange={(e) => setAutoStage(e.target.checked)}
              className="rounded border-border accent-primary size-3 cursor-pointer"
            />
            <span>Auto-stage all</span>
          </label>
        </div>

        <textarea
          rows={3}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Write a clear commit message (e.g. feat: implement proofreading review)"
          className="w-full p-2 text-2xs font-mono rounded-lg bg-surface1 text-foreground placeholder:text-foreground-extra-muted border border-border/80 focus:border-primary/60 outline-hidden resize-none leading-relaxed"
        />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => handleCommit(false)}
            disabled={isCommitting || isPushing || !commitMessage.trim()}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 text-foreground text-2xs font-medium border border-border/80 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCommitting && !isPushing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <GitCommit className="size-3" />
            )}
            <span>Commit</span>
          </button>

          <button
            type="button"
            onClick={() => handleCommit(true)}
            disabled={isCommitting || isPushing || !commitMessage.trim()}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-2xs font-medium shadow-xs transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPushing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <UploadCloud className="size-3" />
            )}
            <span>Commit & Push</span>
          </button>
        </div>
      </div>

      {/* Changes & Staging Overview */}
      <div className="flex-1 p-3.5 space-y-4">
        {/* Staged files */}
        {stagedFiles.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-3xs font-semibold text-foreground-muted uppercase tracking-wider">
                Staged Changes ({stagedFiles.length})
              </span>
              <button
                type="button"
                onClick={handleUnstageAll}
                className="text-3xs text-foreground-extra-muted hover:text-foreground cursor-pointer transition-colors"
              >
                Unstage All
              </button>
            </div>
            <div className="space-y-1">
              {stagedFiles.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center justify-between p-1.5 rounded-md bg-surface1 hover:bg-surface2/60 border border-border/50 text-2xs font-mono group"
                >
                  <button
                    type="button"
                    onClick={() => onSelectFile?.(f.path)}
                    className="truncate text-left flex-1 text-foreground/90 hover:text-primary transition-colors cursor-pointer"
                  >
                    {f.path}
                  </button>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <span className="text-status-success text-3xs font-semibold">Staged</span>
                    <button
                      type="button"
                      onClick={() => handleUnstageFile(f.path)}
                      className="p-0.5 rounded text-foreground-extra-muted hover:text-foreground hover:bg-surface3"
                      title="Unstage file"
                    >
                      <Minus className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Unstaged files */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-3xs font-semibold text-foreground-muted uppercase tracking-wider">
              Working Changes ({unstagedFiles.length})
            </span>
            {unstagedFiles.length > 0 && (
              <button
                type="button"
                onClick={handleStageAll}
                className="text-3xs text-primary hover:text-primary-hover font-medium cursor-pointer transition-colors"
              >
                Stage All
              </button>
            )}
          </div>

          {unstagedFiles.length === 0 ? (
            <div className="py-4 text-center text-3xs text-foreground-extra-muted">
              Working tree clean
            </div>
          ) : (
            <div className="space-y-1">
              {unstagedFiles.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center justify-between p-1.5 rounded-md bg-surface1/60 hover:bg-surface2/60 border border-border/50 text-2xs font-mono group"
                >
                  <button
                    type="button"
                    onClick={() => onSelectFile?.(f.path)}
                    className="truncate text-left flex-1 text-foreground/80 hover:text-foreground transition-colors cursor-pointer"
                  >
                    {f.path}
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span className="text-3xs text-foreground-extra-muted">
                      {f.status === '?' ? 'Untracked' : f.status === 'A' ? 'Added' : 'Modified'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleStageFile(f.path)}
                      className="p-0.5 rounded text-foreground-extra-muted hover:text-foreground hover:bg-surface3 cursor-pointer"
                      title="Stage file"
                    >
                      <Plus className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
