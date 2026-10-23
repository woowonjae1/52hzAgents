'use client';

import * as React from 'react';
import { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  Crown,
  FolderGit2,
  PanelRight,
  MoreHorizontal,
  Filter,
  Download,
  FileDiff,
  Columns2,
} from 'lucide-react';
import { useSessionGridOptional } from '@/lib/session-grid-context';
import { useLayout } from '@/components/layout/layout-context';
import { Hint } from '@/components/ui/hint';
import { GitChip } from '@/components/git/git-chip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { headerIconButtonClass } from '@/components/headers/header-chip';
import { stripTitleMentions } from '@/lib/thread-title';
import { stripAddressPrefix } from '@/lib/types';
import { isComposing } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { SidebarExpandButton } from '@/components/layout/sidebar-expand-button';
import { isDraftSessionId } from '@/lib/workspace-context';
import type { WorkspaceMessage, WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import type { GitStatus } from '@/lib/use-git-status';

function basename(pathStr: string): string {
  const parts = pathStr.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || pathStr;
}

export interface ChannelHeaderProps {
  currentSession: WorkspaceSession | null | undefined;
  currentSessionId: string | null;
  isDM: boolean;
  agents: WorkspaceAgent[];
  activeHeaderAgents: string[];
  sessionParticipants: string[];
  workingHere: string[];
  currentSessionWorkingDir?: string | null;
  gitChannelId: string | null;
  gitStatus: GitStatus | null;
  refreshGit: () => Promise<void>;
  outputsCount: number;
  isStudioOpen: boolean;
  filterOpen: boolean;
  filterActive: boolean;
  exporting: boolean;
  onRenameSession: (title: string) => Promise<void>;
  onToggleFilter: () => void;
  onToggleStudio: () => void;
  onOpenProjectWorkspace: () => void;
  onExportMarkdown: () => Promise<void>;
}

export function ChannelHeader({
  currentSession,
  currentSessionId,
  isDM,
  agents,
  activeHeaderAgents,
  sessionParticipants,
  workingHere,
  currentSessionWorkingDir,
  gitChannelId,
  gitStatus,
  refreshGit,
  outputsCount,
  isStudioOpen,
  filterOpen,
  filterActive,
  exporting,
  onRenameSession,
  onToggleFilter,
  onToggleStudio,
  onOpenProjectWorkspace,
  onExportMarkdown,
}: ChannelHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { activeRightTab, setActiveRightTab, setViewMode, openSettings } = useLayout();
  const grid = useSessionGridOptional();

  const startEditingTitle = () => {
    if (isDM) return;
    setTitleDraft(currentSession?.title ? stripTitleMentions(currentSession.title) : '');
    setEditingTitle(true);
  };

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const commitTitle = async () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === (currentSession?.title || '')) return;
    await onRenameSession(trimmed);
  };

  return (
    <div className="app-header app-header-fade sticky top-0 z-10 px-3.5">
      <div className="flex flex-1 items-center gap-2 lg:gap-3 min-w-0">
        <SidebarExpandButton />
        {isDM ? (
          <h2 className="text-sm font-bold tracking-tight truncate flex items-center gap-2 text-foreground">
            <MessageSquare className="size-4 text-muted-foreground" />
            <span>{currentSessionId!.slice(3).split(',').map(stripAddressPrefix).join(' · ')}</span>
            <span className="text-3xs px-2 py-0.5 rounded-full bg-surface3/80 text-muted-foreground border border-border/60 font-mono">
              read-only
            </span>
          </h2>
        ) : editingTitle ? (
          <input
            ref={titleInputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            className="text-sm font-semibold tracking-tight bg-surface2/50 border-b-2 border-border-accent px-2 py-0.5 rounded-t min-w-0 max-w-[300px] text-foreground h-7"
            autoFocus
          />
        ) : (
          <Hint label="Click to rename">
            <div className="flex min-w-0 flex-col cursor-pointer" onClick={startEditingTitle}>
              <div className="flex items-center gap-1.5 min-w-0">
                <h2 className="truncate text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-foreground-muted">
                  {currentSession?.title && !['new channel', 'new session', 'untitled', 'new chat', 'untitled channel', '新频道'].includes(currentSession.title.trim().toLowerCase())
                    ? stripTitleMentions(currentSession.title)
                    : (currentSessionId && !isDraftSessionId(currentSessionId) ? 'Session' : 'New Session')}
                </h2>
                {currentSession?.master && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-primary/10 text-primary border border-primary/20 shrink-0"
                    title={`Master agent: ${currentSession.master}`}
                  >
                    <Crown className="size-2.5" />
                    <span>{currentSession.master}</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
                {currentSessionWorkingDir && (
                  <>
                    <span className="truncate">{basename(currentSessionWorkingDir)}</span>
                    <span className="text-foreground-extra-muted">·</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openSettings('agents');
                  }}
                  className="inline-flex items-center gap-1 hover:text-foreground hover:underline transition-colors cursor-pointer select-none"
                  title="Open Agents Management"
                >
                  <span className="size-1.5 rounded-full bg-status-success animate-pulse shrink-0" />
                  <span>
                    {(() => {
                      const total = sessionParticipants.length > 0 ? sessionParticipants.length : agents.length;
                      if (activeHeaderAgents.length > 0) {
                        return activeHeaderAgents.length === total
                          ? `${total} agent${total > 1 ? 's' : ''}`
                          : `${activeHeaderAgents.length}/${total} online`;
                      }
                      if (total > 0) {
                        return `${total} agent${total > 1 ? 's' : ''} (offline)`;
                      }
                      return 'no agents configured';
                    })()}
                  </span>
                </button>
              </div>
            </div>
          </Hint>
        )}

        <span className="ml-auto" aria-hidden />

        {/* Live working indicator in header */}
        {!isDM && workingHere.length > 0 && (
          <div className="hidden sm:flex items-baseline gap-2 shrink min-w-0 max-w-[45%]">
            <span className="event-running inline-flex items-baseline gap-1.5 text-xs min-w-0 text-foreground-muted">
              <span className="truncate text-foreground">{workingHere.join(', ')}</span>
              <span className="shrink-0">working</span>
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <GitChip channelId={gitChannelId} status={gitStatus} refresh={refreshGit} />
        {gitStatus?.files && gitStatus.files.length > 0 && (
          <Hint label={`Review ${gitStatus.files.length} modified file${gitStatus.files.length > 1 ? 's' : ''} in Studio`}>
            <button
              type="button"
              onClick={() => {
                if (!isStudioOpen) onToggleStudio();
                setActiveRightTab('diff');
              }}
              className={cn(
                'inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-md transition-colors cursor-pointer shrink-0 border',
                activeRightTab === 'diff' && isStudioOpen
                  ? 'bg-primary/15 text-primary border-primary/30 font-semibold'
                  : 'bg-surface2 hover:bg-surface3 text-foreground-muted hover:text-foreground border-border/60'
              )}
            >
              <FileDiff className="size-3 text-primary" />
              <span className="text-2xs font-semibold">Diff ({gitStatus.files.length})</span>
            </button>
          </Hint>
        )}
        {currentSessionWorkingDir && (
          <Hint label={`Project workspace: ${currentSessionWorkingDir}`}>
            <button
              type="button"
              onClick={onOpenProjectWorkspace}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md bg-surface2 hover:bg-surface3 border border-border/60 text-foreground transition-colors shrink-0 cursor-pointer"
            >
              <FolderGit2 className="size-3 text-primary" />
              <span className="font-mono text-2xs hidden sm:inline max-w-[120px] truncate">
                {basename(currentSessionWorkingDir)}
              </span>
            </button>
          </Hint>
        )}

        <span className="h-4 w-px bg-border/60 shrink-0 mx-0.5" aria-hidden />

        {/* Dual Split Screen Toggle (ported from cdesktop SessionGrid) */}
        {grid && (
          <Hint label={grid.isSplit ? 'Exit dual split view' : 'Split screen with another session'}>
            <button
              type="button"
              onClick={() => grid.toggleSplit()}
              className={cn(
                headerIconButtonClass,
                'relative cursor-pointer',
                grid.isSplit && 'bg-surface3 text-foreground border border-border'
              )}
            >
              <Columns2 className="size-4" />
            </button>
          </Hint>
        )}

        {/* Studio Panel Toggle */}
        <Hint
          label={
            isStudioOpen
              ? 'Close Studio panel'
              : outputsCount > 0
              ? `Studio outputs (${outputsCount})`
              : 'Open Studio panel'
          }
        >
          <button
            onClick={onToggleStudio}
            className={cn(
              headerIconButtonClass,
              'relative cursor-pointer',
              isStudioOpen && 'bg-surface3 text-foreground border border-border',
            )}
          >
            <PanelRight className="size-4" />
            {outputsCount > 0 && !isStudioOpen && (
              <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold flex items-center justify-center leading-none shadow-xs pointer-events-none">
                {outputsCount}
              </span>
            )}
          </button>
        </Hint>

        {/* More Actions Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Hint label="More actions">
              <button className={cn(headerIconButtonClass, 'cursor-pointer')}>
                <MoreHorizontal className="size-4" />
              </button>
            </Hint>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onToggleFilter}>
              <Filter className="size-4 mr-2 text-foreground-muted" />
              <span>{filterOpen || filterActive ? 'Clear filter' : 'Filter this thread'}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void onExportMarkdown()}
              disabled={exporting || !currentSessionId}
            >
              <Download className="size-4 mr-2" />
              <span>Export as Markdown</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="desktop-only h-4 w-px bg-border shrink-0 ms-1" aria-hidden />
      </div>
    </div>
  );
}
