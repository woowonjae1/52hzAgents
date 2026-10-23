'use client';

import * as React from 'react';
import { useState, useCallback, type KeyboardEvent } from 'react';
import {
  ChevronDown,
  User,
  ListChecks,
  Settings,
  FileCode2,
  ArrowUpRight,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { DiffBlock } from '@/components/chat/diff-block';

/* -------------------------------------------------------------------------- */
/* 1. ChatEntryContainer (ported from cdesktop ChatEntryContainer.tsx)        */
/* -------------------------------------------------------------------------- */

export type ChatEntryVariant = 'user' | 'plan' | 'plan_denied' | 'system';

export interface ChatEntryStatusLike {
  status: string;
}

interface VariantConfig {
  icon: LucideIcon;
  border: string;
  headerBg: string;
  bg: string;
}

const variantConfig: Record<ChatEntryVariant, VariantConfig> = {
  user: {
    icon: User,
    border: 'border-border',
    headerBg: '',
    bg: '',
  },
  plan: {
    icon: ListChecks,
    border: 'border-brand/60',
    headerBg: 'bg-brand/15',
    bg: 'bg-brand/[0.06]',
  },
  plan_denied: {
    icon: ListChecks,
    border: 'border-status-danger/60',
    headerBg: 'bg-status-danger/15',
    bg: 'bg-status-danger/[0.06]',
  },
  system: {
    icon: Settings,
    border: 'border-border',
    headerBg: 'bg-surface2/60',
    bg: '',
  },
};

export interface ChatEntryContainerProps {
  variant: ChatEntryVariant;
  title?: React.ReactNode;
  headerRight?: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  status?: ChatEntryStatusLike;
  isGreyed?: boolean;
}

export function ChatEntryContainer({
  variant,
  title,
  headerRight,
  expanded = false,
  onToggle,
  children,
  actions,
  className,
  status,
  isGreyed,
}: ChatEntryContainerProps) {
  const config =
    variant === 'plan' && status?.status === 'denied'
      ? variantConfig.plan_denied
      : variantConfig[variant];
  const Icon = config.icon;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onToggle || event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle();
  };

  return (
    <div
      className={cn(
        'rounded-lg w-full overflow-hidden',
        config.border && 'border',
        config.border,
        config.bg,
        isGreyed && 'opacity-50 pointer-events-none',
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center px-3 py-2 gap-2 overflow-hidden',
          config.headerBg,
          onToggle && 'cursor-pointer'
        )}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        role={onToggle ? 'button' : undefined}
        aria-expanded={onToggle ? expanded : undefined}
        tabIndex={onToggle ? 0 : undefined}
      >
        <Icon className="size-3.5 shrink-0 text-foreground-muted" />
        {title && (
          <span className="flex-1 text-xs font-medium text-foreground truncate">
            {title}
          </span>
        )}
        {headerRight}
        {onToggle && (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-foreground-muted transition-transform',
              !expanded && '-rotate-90'
            )}
          />
        )}
      </div>

      {/* Content - shown when expanded */}
      {expanded && children && <div className="p-3">{children}</div>}

      {/* Actions footer */}
      {actions && (
        <div className="bg-brand/10 backdrop-blur-xs flex items-center gap-2 px-3 py-2 border-t border-brand/20">
          {actions}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. ChatAggregatedDiffEntries (ported from cdesktop)                        */
/* -------------------------------------------------------------------------- */

export interface ChatDiffFileItem {
  path: string;
  status: string; // 'M' | 'A' | 'D' | '?'
  additions: number;
  deletions: number;
  pre_existing?: boolean;
}

interface ChatAggregatedDiffEntryRowProps {
  channelId: string;
  turnId?: string;
  file: ChatDiffFileItem;
  onOpenInChanges?: () => void;
}

function getActionLabel(status: string): string {
  switch (status) {
    case 'A':
    case '?':
      return 'Write';
    case 'D':
      return 'Delete';
    case 'R':
      return 'Rename';
    default:
      return 'Edit';
  }
}

export function ChatAggregatedDiffEntryRow({
  channelId,
  turnId,
  file,
  onOpenInChanges,
}: ChatAggregatedDiffEntryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && diffText === null && !loadingDiff && channelId) {
      setLoadingDiff(true);
      try {
        const res = await workspaceApi.getGitDiff(channelId, file.path);
        setDiffText(res.diff || '');
      } catch {
        setDiffText('');
      } finally {
        setLoadingDiff(false);
      }
    }
  }, [expanded, diffText, loadingDiff, channelId, file.path, turnId]);

  const hasStats = file.additions > 0 || file.deletions > 0;
  const actionLabel = getActionLabel(file.status);

  return (
    <div className="rounded-md border border-border/70 overflow-hidden bg-surface1/70">
      <div
        className="flex items-center px-2.5 py-1.5 w-full bg-surface2/60 hover:bg-surface2 cursor-pointer transition-colors"
        onClick={handleToggle}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        role="button"
        aria-expanded={expanded}
      >
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="relative shrink-0 text-foreground-muted">
            {isHovered ? (
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-150',
                  !expanded && '-rotate-90'
                )}
              />
            ) : (
              <FileCode2 className="size-3.5" />
            )}
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full',
                file.status === 'D'
                  ? 'bg-status-danger'
                  : file.status === 'A' || file.status === '?'
                    ? 'bg-status-success'
                    : 'bg-brand'
              )}
            />
          </span>

          <span className="text-xs font-mono text-foreground truncate">
            {file.path}
          </span>

          <span className="text-2xs text-foreground-extra-muted shrink-0">
            · {actionLabel}
          </span>

          {file.pre_existing && (
            <span className="shrink-0 text-3xs text-foreground-extra-muted px-1 py-0.2 rounded bg-surface3">
              pre-existing
            </span>
          )}

          {onOpenInChanges && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenInChanges();
              }}
              className="shrink-0 p-0.5 rounded hover:bg-surface3 text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer"
              title="Open in Review & Diff Studio"
              aria-label={`Open ${file.path} in Review & Diff Studio`}
            >
              <ArrowUpRight className="size-3" />
            </button>
          )}

          {hasStats && (
            <span className="ms-auto text-2xs font-mono shrink-0 tabular-nums space-x-1">
              {file.additions > 0 && (
                <span className="text-status-success font-medium">
                  +{file.additions}
                </span>
              )}
              {file.deletions > 0 && (
                <span className="text-status-danger font-medium">
                  −{file.deletions}
                </span>
              )}
            </span>
          )}
        </div>

        <ChevronDown
          className={cn(
            'ms-2 size-3 shrink-0 text-foreground-extra-muted transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </div>

      {expanded && (
        <div className="border-t border-border/60 bg-background/60 p-2">
          {loadingDiff ? (
            <div className="flex items-center gap-2 py-3 px-2 text-2xs text-foreground-muted">
              <Loader2 className="size-3.5 animate-spin text-brand" />
              <span>Loading file diff…</span>
            </div>
          ) : diffText ? (
            <DiffBlock
              code={diffText}
              embedded
              filePath={file.path}
              interactiveReview
            />
          ) : (
            <div className="flex items-center justify-between py-2 px-2 text-2xs text-foreground-extra-muted">
              <span>Click to inspect full diff in Review & Diff Studio</span>
              {onOpenInChanges && (
                <button
                  type="button"
                  onClick={onOpenInChanges}
                  className="text-brand hover:underline font-medium cursor-pointer"
                >
                  Open in Studio →
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
