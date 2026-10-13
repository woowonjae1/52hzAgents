'use client';

import * as React from 'react';
import { Search, Star, MessageSquare, Folder, Clock, ArrowUpDown, X, ExternalLink } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentAvatarStack, type AgentStackItem } from '@/components/agents/agent-avatar';
import { getSmartSessionTitle, extractSessionAgents } from './thread-list';
import { formatCompactRelativeTime } from '@/lib/helpers';
import { basename } from '@/components/chat/project-folder-picker';
import { cn } from '@/lib/utils';
import type { WorkspaceSession, WorkspaceAgent } from '@/lib/types';
import type { LastMessageInfo } from '@/lib/workspace-context';

interface AllThreadsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: WorkspaceSession[];
  agents: WorkspaceAgent[];
  lastMessageBySession: Record<string, LastMessageInfo | undefined>;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onToggleStar?: (sessionId: string, starred: boolean) => void;
}

type SortOrder = 'updated' | 'created' | 'alpha';

export function AllThreadsModal({
  open,
  onOpenChange,
  sessions,
  agents,
  lastMessageBySession,
  currentSessionId,
  onSelectSession,
  onToggleStar,
}: AllThreadsModalProps) {
  const [search, setSearch] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState<SortOrder>('updated');
  const [folderFilter, setFolderFilter] = React.useState<string>('all');

  // Collect distinct project folders
  const folders = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.workingDir) set.add(s.workingDir);
    }
    return Array.from(set);
  }, [sessions]);

  const filtered = React.useMemo(() => {
    let list = sessions.filter((s) => s.status !== 'deleted' && s.status !== 'archived');

    // Folder filter
    if (folderFilter !== 'all') {
      if (folderFilter === '__direct__') {
        list = list.filter((s) => !s.workingDir);
      } else {
        list = list.filter((s) => s.workingDir === folderFilter);
      }
    }

    // Search query
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((s) => {
        const title = getSmartSessionTitle(s, lastMessageBySession[s.sessionId]).toLowerCase();
        const dir = (s.workingDir || '').toLowerCase();
        return title.includes(q) || dir.includes(q);
      });
    }

    // Sort order
    return [...list].sort((a, b) => {
      // Pinned/starred always float to top
      if (a.starred !== b.starred) {
        return a.starred ? -1 : 1;
      }
      if (sortOrder === 'updated') {
        return (b.lastEventAt || 0) - (a.lastEventAt || 0);
      }
      if (sortOrder === 'created') {
        const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bT - aT;
      }
      if (sortOrder === 'alpha') {
        const aTitle = getSmartSessionTitle(a, lastMessageBySession[a.sessionId]);
        const bTitle = getSmartSessionTitle(b, lastMessageBySession[b.sessionId]);
        return aTitle.localeCompare(bTitle);
      }
      return 0;
    });
  }, [sessions, folderFilter, search, sortOrder, lastMessageBySession]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-4 pb-2 border-b border-border/60">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold">
              All Conversations ({sessions.length})
            </DialogTitle>
          </div>

          {/* Search & Sort Controls */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search across all conversations…"
                className="w-full h-8 rounded-lg border border-border bg-surface0 pl-8 pr-7 text-xs text-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {/* Folder filter */}
            {folders.length > 0 && (
              <select
                value={folderFilter}
                onChange={(e) => setFolderFilter(e.target.value)}
                className="h-8 rounded-lg border border-border bg-surface0 px-2 text-xs text-foreground outline-none cursor-pointer"
              >
                <option value="all">All Workspaces</option>
                <option value="__direct__">Direct Chats</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {basename(f)}
                  </option>
                ))}
              </select>
            )}

            {/* Sort order */}
            <div className="flex items-center gap-1 rounded-lg border border-border bg-surface0 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setSortOrder('updated')}
                className={cn(
                  'px-2 py-1 rounded-md text-2xs transition-colors cursor-pointer',
                  sortOrder === 'updated'
                    ? 'bg-surface2 text-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Recently Updated
              </button>
              <button
                type="button"
                onClick={() => setSortOrder('created')}
                className={cn(
                  'px-2 py-1 rounded-md text-2xs transition-colors cursor-pointer',
                  sortOrder === 'created'
                    ? 'bg-surface2 text-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Newest
              </button>
              <button
                type="button"
                onClick={() => setSortOrder('alpha')}
                className={cn(
                  'px-2 py-1 rounded-md text-2xs transition-colors cursor-pointer',
                  sortOrder === 'alpha'
                    ? 'bg-surface2 text-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                A-Z
              </button>
            </div>
          </div>
        </DialogHeader>

        {/* List of sessions */}
        <div className="flex-1 overflow-y-auto p-2 divide-y divide-border/20">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No conversations found matching your filter.
            </div>
          ) : (
            filtered.map((session) => {
              const label = getSmartSessionTitle(session, lastMessageBySession[session.sessionId]);
              const lastMsg = lastMessageBySession[session.sessionId];
              const sessionAgents = extractSessionAgents(session, agents, lastMsg, label);
              const isCurrent = session.sessionId === currentSessionId;
              const timeMs = session.lastEventAt || (session.createdAt ? new Date(session.createdAt).getTime() : 0);
              const timeStr = timeMs ? formatCompactRelativeTime(timeMs) : '';

              return (
                <div
                  key={session.sessionId}
                  onClick={() => {
                    onSelectSession(session.sessionId);
                    onOpenChange(false);
                  }}
                  className={cn(
                    'group flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors hover:bg-surface2/70',
                    isCurrent && 'bg-surface2 border-l-2 border-primary font-medium'
                  )}
                >
                  {/* Avatars */}
                  <div className="shrink-0">
                    {sessionAgents.length > 0 ? (
                      <AgentAvatarStack agents={sessionAgents} max={2} size={18} />
                    ) : (
                      <MessageSquare className="size-4 text-muted-foreground" />
                    )}
                  </div>

                  {/* Title & metadata */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-foreground font-medium truncate">
                        {label}
                      </span>
                      {session.starred && (
                        <Star className="size-3 fill-amber-400 stroke-amber-400 shrink-0" />
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
                      {session.workingDir ? (
                        <span className="flex items-center gap-1 font-mono truncate max-w-[160px]">
                          <Folder className="size-2.5 shrink-0" />
                          {basename(session.workingDir)}
                        </span>
                      ) : (
                        <span>Direct Chat</span>
                      )}
                      <span>·</span>
                      <span>Updated {timeStr}</span>
                    </div>
                  </div>

                  {/* Star toggle */}
                  {onToggleStar && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStar(session.sessionId, !session.starred);
                      }}
                      className={cn(
                        'opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-surface3 text-muted-foreground hover:text-foreground transition-all cursor-pointer',
                        session.starred && 'opacity-100 text-amber-400'
                      )}
                      title={session.starred ? 'Unstar conversation' : 'Star conversation'}
                    >
                      <Star className={cn('size-3.5', session.starred && 'fill-amber-400 stroke-amber-400')} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
