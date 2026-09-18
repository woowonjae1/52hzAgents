'use client';

import * as React from 'react';
import { SquarePen, Search, History, Folder, Star, Archive, Trash2 } from 'lucide-react';
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMenuControls,
  type SidebarResourceMove,
} from '@/components/agents/ai-sidebar';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { basename } from '@/components/chat/project-folder-picker';
import { getSmartSessionTitle } from './thread-list';
import { formatCompactRelativeTime } from '@/lib/helpers';
import { FileList } from '@/components/files/file-list';
import { RoutineList } from '@/components/routines/routine-list';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/*
  THE SIDEBAR, AS beUI DRAWS IT.

  This is the replication of `agents/ai-sidebar` plus the New task / Search /
  Runs nav above it. It REPLACES `ThreadList` rather than editing it, so the
  richer list it stands in for — unread dots, relative times, message
  previews, search-hit highlighting, the "See all (N)" expanders, and the
  virtualizer — is still on disk and one import away if any of it turns out
  to be load-bearing.

  What beUI's row model does not carry, and is therefore gone for now: the
  per-row timestamp, the preview line, the unread dot, the starred band, and
  virtualization. A `SidebarResource` is an id, a label, a kind and children.
*/

const DIRECT_CHATS = 'dir:';

function folderId(dir: string | null | undefined) {
  return dir ? `dir:${dir}` : DIRECT_CHATS;
}

const ROW_CLASS =
  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring';

export function ThreadSidebar() {
  const {
    sessions,
    currentSessionId,
    setCurrentSessionId,
    lastMessageBySession,
    userSentMessageTimestamps,
    createSession,
    renameSession,
    updateSession,
    moveSessionToFolder,
  } = useWorkspace();
  const { viewMode, setViewMode, isMobile, openMobileDetail } = useLayout();

  const [showSearch, setShowSearch] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);

  const active = React.useMemo(
    () => sessions.filter((s) => s.status !== 'deleted' && s.status !== 'archived'),
    [sessions]
  );

  // id -> session, so the callbacks below never scan the list again.
  const byId = React.useMemo(
    () => new Map(active.map((s) => [s.sessionId, s])),
    [active]
  );

  const items = React.useMemo<SidebarResource[]>(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, { dir: string | null; children: SidebarResource[] }>();

    for (const session of active) {
      const label = getSmartSessionTitle(session, lastMessageBySession[session.sessionId]);
      if (needle && !label.toLowerCase().includes(needle)) continue;

      const dir = session.workingDir ?? null;
      const key = folderId(dir);
      let group = groups.get(key);
      if (!group) {
        group = { dir, children: [] };
        groups.set(key, group);
      }
      group.children.push({ id: session.sessionId, label, kind: 'file' });
    }

    return Array.from(groups.entries()).map(([id, group]) => ({
      id,
      label: group.dir ? basename(group.dir) : 'Direct chats',
      kind: 'folder' as const,
      children: group.children,
    }));
  }, [active, lastMessageBySession, query]);

  const defaultExpandedIds = React.useMemo(() => items.map((i) => i.id), [items]);

  /*
    Activity newer than the last thing YOU did in that thread. The thread you
    are currently looking at is never unread — you are reading it.
  */
  const unreadIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const session of active) {
      if (session.sessionId === currentSessionId) continue;
      const seen = userSentMessageTimestamps[session.sessionId];
      if (!seen) continue;
      if ((session.lastEventAt ?? 0) > seen) ids.add(session.sessionId);
    }
    return ids;
  }, [active, currentSessionId, userSentMessageTimestamps]);

  const handleActiveChange = React.useCallback(
    (id: string) => {
      if (id.startsWith('dir:')) return;
      setCurrentSessionId(id);
      /*
        Picking a thread is also how you LEAVE inbox/tasks/files. Without
        this the row highlighted but the main pane stayed on whatever view
        you were in, with no way back to the conversation.
      */
      setViewMode('threads');
      if (isMobile) openMobileDetail();
    },
    [setCurrentSessionId, setViewMode, isMobile, openMobileDetail]
  );

  /*
    beUI reports a move as (itemId, targetId, position). A folder here is not
    a real object — it is the set of threads sharing a `workingDir` — so the
    only thing a move can mean is "rebind this thread's folder", and the
    target folder is resolved from whatever was dropped on: the folder row
    itself, or a sibling thread's folder.
  */
  const handleMove = React.useCallback(
    async (move: SidebarResourceMove) => {
      const session = byId.get(move.itemId);
      if (!session) return;

      const target = move.targetId;
      if (!target) return;

      let dir: string | null;
      if (target.startsWith('dir:')) {
        dir = target === DIRECT_CHATS ? null : target.slice('dir:'.length);
      } else {
        const sibling = byId.get(target);
        if (!sibling) return;
        dir = sibling.workingDir ?? null;
      }

      await moveSessionToFolder(move.itemId, dir);
    },
    [byId, moveSessionToFolder]
  );

  const handleRename = React.useCallback(
    async (item: SidebarResource, label: string) => {
      if (item.kind !== 'file') {
        // Folders are derived from `workingDir`; there is nothing to write.
        toast.error('A project folder is named by its directory');
        return;
      }
      await renameSession(item.id, label);
    },
    [renameSession]
  );

  const renderIcon = React.useCallback(
    (item: SidebarResource) => {
      if (item.kind !== 'file') return <Folder className="size-4" />;
      const session = byId.get(item.id);
      return (
        <AgentAvatar
          name={session?.master || session?.participants?.[0] || item.label}
          size={16}
          className="rounded-full"
        />
      );
    },
    [byId]
  );

  /*
    The right-hand column the beUI row did not have: when this thread last
    moved, and an unread dot when it moved since you last looked at it. These
    are the two things the list this replaced put there, and the two things
    that make a conversation list scannable rather than a folder of names.
  */
  const renderMeta = React.useCallback(
    (item: SidebarResource) => {
      if (item.kind !== 'file') return null;
      const session = byId.get(item.id);
      if (!session) return null;
      const at = session.lastEventAt || (session.createdAt ? new Date(session.createdAt).getTime() : 0);
      if (!at) return null;
      return (
        <span className="inline-flex items-center gap-1.5">
          {unreadIds.has(item.id) && (
            <span aria-label="Unread" className="size-1.5 rounded-full bg-primary" />
          )}
          {formatCompactRelativeTime(at)}
        </span>
      );
    },
    [byId, unreadIds]
  );

  const renderMenu = React.useCallback(
    (item: SidebarResource, controls: SidebarResourceMenuControls) => {
      if (item.kind !== 'file') {
        /*
          The old group header carried a `+`. beUI's folder row has no
          trailing slot, so the same action lives in its menu — without it a
          project folder became a place you could not start a thread in.
        */
        const dir = item.id === DIRECT_CHATS ? undefined : item.id.slice('dir:'.length);
        return (
          <button
            type="button"
            className={ROW_CLASS}
            onClick={() => {
              void createSession({ workingDir: dir });
              controls.close();
            }}
          >
            <SquarePen className="size-3.5 shrink-0" />
            New chat here
          </button>
        );
      }
      const session = byId.get(item.id);
      return (
        <>
          <button type="button" className={ROW_CLASS} onClick={() => controls.rename()}>
            <SquarePen className="size-3.5 shrink-0" />
            Rename
          </button>
          <button
            type="button"
            className={ROW_CLASS}
            onClick={() => {
              void updateSession(item.id, { starred: !session?.starred });
              controls.close();
            }}
          >
            <Star className="size-3.5 shrink-0" />
            {session?.starred ? 'Unstar' : 'Star'}
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            className={ROW_CLASS}
            onClick={() => {
              void updateSession(item.id, { status: 'archived' });
              controls.close();
            }}
          >
            <Archive className="size-3.5 shrink-0" />
            Archive
          </button>
          <button
            type="button"
            className={cn(ROW_CLASS, 'text-destructive')}
            onClick={() => {
              void updateSession(item.id, { status: 'deleted' });
              controls.close();
            }}
          >
            <Trash2 className="size-3.5 shrink-0" />
            Delete
          </button>
        </>
      );
    },
    [byId, updateSession, createSession]
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-2">
      {/* beUI's shell opens with three nav rows before the resource tree. */}
      <nav className="flex flex-col gap-0.5">
        <button type="button" className={ROW_CLASS} onClick={() => void createSession()}>
          <SquarePen className="size-3.5 shrink-0" />
          New task
        </button>
        <button
          type="button"
          className={ROW_CLASS}
          onClick={() => {
            setShowSearch((open) => !open);
            requestAnimationFrame(() => searchRef.current?.focus());
          }}
        >
          <Search className="size-3.5 shrink-0" />
          Search
        </button>
        <button
          type="button"
          className={cn(ROW_CLASS, viewMode === 'routines' && 'bg-muted')}
          onClick={() => setViewMode(viewMode === 'routines' ? 'threads' : 'routines')}
        >
          <History className="size-3.5 shrink-0" />
          Runs
        </button>
      </nav>

      {showSearch && (
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              setShowSearch(false);
            }
          }}
          placeholder="Filter threads..."
          className="mx-1 h-7 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}

      <div className="my-1 h-px bg-border" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {viewMode === 'files' ? (
          <FileList />
        ) : viewMode === 'routines' ? (
          <RoutineList />
        ) : (
        <AISidebar
          ariaLabel="Conversations"
          items={items}
          activeId={currentSessionId}
          onActiveChange={handleActiveChange}
          defaultExpandedIds={defaultExpandedIds}
          onMove={handleMove}
          onRename={handleRename}
          renderIcon={renderIcon}
          renderMeta={renderMeta}
          renderMenu={renderMenu}
        />
        )}
      </div>
    </div>
  );
}
