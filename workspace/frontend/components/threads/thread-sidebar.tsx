'use client';

import * as React from 'react';
import { SquarePen, Search, Folder, FolderMinus, Star, Archive, Trash2, MessageSquare, Loader2, Plus, FileText, CalendarClock, Inbox, BookOpen, CircleCheck, Users } from 'lucide-react';
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMenuControls,
  type SidebarResourceMove,
} from '@/components/agents/ai-sidebar';
import { AgentAvatar, AgentAvatarStack } from '@/components/agents/agent-avatar';
import { useWorkspace, isUnusedSession } from '@/lib/workspace-context';
import { useThreadSeen } from '@/lib/thread-seen';
import { useAgentTurns } from '@/lib/use-agent-turns';
import { useLayout } from '@/components/layout/layout-context';
import { basename, browseForFolder } from '@/components/chat/project-folder-picker';
import { getSmartSessionTitle, extractSessionAgents } from './thread-list';
import { formatCompactRelativeTime } from '@/lib/helpers';
import { FileList } from '@/components/files/file-list';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';

/*
  THE SIDEBAR, AS beUI DRAWS IT.

  This is the replication of `agents/ai-sidebar` plus the New chat / Search /
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

/** Nav rows: the same height and radius as the thread rows below. */
const NAV_ROW_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring';
const NAV_ROW_ACTIVE = 'bg-muted font-medium text-foreground';

/** Small uppercase group label, as in the reference shells' grouped nav. */
const SECTION_LABEL_CLASS = 'text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground/75';

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      <div className="mt-3 mb-0.5 flex h-6 items-center pl-2.5">
        <span className={SECTION_LABEL_CLASS}>{label}</span>
      </div>
      {children}
    </div>
  );
}

const ROW_CLASS =
  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring';

export function ThreadSidebar() {
  const {
    sessions,
    currentSessionId,
    setCurrentSessionId,
    agents,
    lastMessageBySession,
    activeSessionIds,
    currentUser,
    createSession,
    renameSession,
    updateSession,
    moveSessionToFolder,
    unreadNotificationCount,
  } = useWorkspace();
  const { viewMode, setViewMode, isMobile, openMobileDetail, setSidebarOpen, tasksTab, setTasksTab, openSettings } = useLayout();
  // Same rule as the wrapper: Home, or Threads with nothing open.
  const isHome = viewMode === 'home' || (viewMode === 'threads' && !currentSessionId);

  /*
    "New session" opens Home's setup rather than an empty draft: picking the
    agents, folder and mode IS starting a session, and the draft Home creates
    carries all of it. The quick path (an immediate draft with everyone) is
    still C / the palette's "New chat", and "New chat here" on a project row.
  */
  const startNewSession = React.useCallback(() => {
    setCurrentSessionId(null);
    setViewMode('home');
  }, [setCurrentSessionId, setViewMode]);

  /*
    Per channel, what the agents themselves reported: a channel with any
    reported turn is answered from those rows; only a channel no agent has
    ever reported in falls back to the message-stream guess.
  */
  const { rows: turnRows } = useAgentTurns();
  const turnsByChannel = React.useMemo(() => {
    const map = new Map<string, { running: boolean; error: string | null }>();
    const recentMs = 60 * 60 * 1000;
    for (const t of turnRows) {
      const cur = map.get(t.channelName) || { running: false, error: null };
      if (t.state === 'running') cur.running = true;
      else if (t.state === 'error' && !cur.error) {
        const ended = t.endedAt ? new Date(t.endedAt).getTime() : 0;
        if (ended && Date.now() - ended < recentMs) cur.error = t.error || 'Turn failed';
      }
      map.set(t.channelName, cur);
    }
    return map;
  }, [turnRows]);

  const [showSearch, setShowSearch] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [browsingFolder, setBrowsingFolder] = React.useState(false);

  /*
    Opening the native folder dialog is the same call in both cases; what
    differs is what we do with the path. `addProjectFolder` creates the first
    thread in a directory — which is also what MAKES the folder, since a
    folder row here is just the set of threads sharing a `workingDir`.
    `changeSessionFolder` re-points a thread that already exists, seeded at
    wherever it currently lives.
  */
  const pickFolder = React.useCallback(async (seed?: string) => {
    if (browsingFolder) return null;
    setBrowsingFolder(true);
    try {
      return await browseForFolder(seed);
    } catch (e) {
      toast.error(
        e instanceof Error
          ? `Could not reach the local wwj daemon (${e.message}). Make sure \`wwj up\` is running.`
          : 'Could not open the folder picker.',
      );
      return null;
    } finally {
      setBrowsingFolder(false);
    }
  }, [browsingFolder]);

  const addProjectFolder = React.useCallback(async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setSidebarOpen(true);
    await createSession({ workingDir: dir });
  }, [pickFolder, createSession, setSidebarOpen]);

  const changeSessionFolder = React.useCallback(async (sessionId: string, current: string | null) => {
    const dir = await pickFolder(current ?? undefined);
    if (!dir) return;
    await moveSessionToFolder(sessionId, dir);
    toast.success(`Thread moved to ${basename(dir)}`);
  }, [pickFolder, moveSessionToFolder]);


  // Unused threads (never spoken in) are hidden unless open: "New chat" now
  // reuses one instead of stacking identical empty rows. See isUnusedSession.
  const active = React.useMemo(
    () =>
      sessions.filter(
        (s) =>
          s.status !== 'deleted' &&
          s.status !== 'archived' &&
          (s.sessionId === currentSessionId || !isUnusedSession(s, lastMessageBySession))
      ),
    [sessions, currentSessionId, lastMessageBySession]
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
    UNREAD MEANS "MOVED SINCE YOU LAST LOOKED", NOT "SINCE YOU LAST TYPED".

    This compared a thread's newest event with the last time you SENT a message
    there. An agent's reply always comes after your message, so every thread you
    had ever spoken in lit up and stayed lit -- opening it did not clear it,
    only typing again did -- and the dot column carried no information at all.

    useThreadSeen is the tracker built for this (the mobile list already uses
    it): the open thread is marked seen continuously, a thread met for the first
    time starts as read, and a thread whose last word was yours is never unread.
  */
  const { isUnread: isThreadUnread, primeUnknown } = useThreadSeen(currentSessionId);
  React.useEffect(() => {
    if (active.length > 0) primeUnknown(active.map((s) => s.sessionId));
  }, [active, primeUnknown]);
  const unreadIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const session of active) {
      const sender = lastMessageBySession[session.sessionId]?.senderName ?? '';
      const lastIsSelf = sender === 'user' || (!!currentUser?.name && sender === currentUser.name);
      if (isThreadUnread(session.sessionId, session.lastEventAt ?? 0, lastIsSelf)) ids.add(session.sessionId);
    }
    return ids;
  }, [active, lastMessageBySession, currentUser?.name, isThreadUnread]);

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
      if (item.kind !== 'file') return undefined;
      const session = byId.get(item.id);
      if (!session) return <MessageSquare className="size-3.5 text-foreground-extra-muted shrink-0" />;

      const lastMsg = lastMessageBySession[session.sessionId];
      const sessionAgents = extractSessionAgents(session, agents, lastMsg, item.label);

      if (sessionAgents.length > 0) {
        if (sessionAgents.length === 1) {
          return (
            <AgentAvatar
              name={sessionAgents[0].name}
              agentType={sessionAgents[0].agentType}
              status={sessionAgents[0].status}
              size={16}
              className="rounded-full shrink-0"
            />
          );
        }
        return (
          <AgentAvatarStack
            agents={sessionAgents}
            max={2}
            size={16}
            className="shrink-0"
          />
        );
      }

      if (session.workingDir) {
        return (
          <span className="size-4 shrink-0 flex items-center justify-center text-foreground-extra-muted text-xs font-mono font-semibold">
            #
          </span>
        );
      }

      return <MessageSquare className="size-3.5 text-foreground-extra-muted shrink-0" />;
    },
    [byId, lastMessageBySession, agents]
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
      const reported = turnsByChannel.get(item.id);
      const isRunning = reported ? reported.running : activeSessionIds.has(item.id);
      const turnError = reported && !reported.running ? reported.error : null;
      const isUnread = unreadIds.has(item.id);
      const at = session.lastEventAt || (session.createdAt ? new Date(session.createdAt).getTime() : 0);

      return (
        <span className="inline-flex items-center gap-1.5">
          {isRunning ? (
            <span
              aria-label="Agent working"
              title="Agent is actively working"
              className="relative flex size-2 items-center justify-center"
            >
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
          ) : turnError ? (
            <span
              aria-label="Agent stopped mid-turn"
              title={`Agent stopped mid-turn: ${turnError}`}
              className="size-1.5 rounded-full bg-status-danger"
            />
          ) : isUnread ? (
            <span aria-label="Unread" className="size-1.5 rounded-full bg-primary" />
          ) : null}
          {/*
            The relative time is gone from the row, for the same reason it went
            from the other list: twenty-five rows of "4d", "6d", "2h" restate
            the order the list is already sorted in, and "4d versus 6d" changes
            nothing anyone does. What is left in this slot is exceptional state
            only — working, or unread — which is the kind of thing worth
            carrying twenty-five times.
          */}
        </span>
      );
    },
    [byId, activeSessionIds, unreadIds, turnsByChannel]
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
            onClick={(e) => {
              e.stopPropagation();
              setSidebarOpen(true);
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
          <button
            type="button"
            className={ROW_CLASS}
            onClick={(e) => {
              e.stopPropagation();
              controls.rename();
            }}
          >
            <SquarePen className="size-3.5 shrink-0" />
            Rename
          </button>
          <button
            type="button"
            className={ROW_CLASS}
            onClick={(e) => {
              e.stopPropagation();
              void updateSession(item.id, { starred: !session?.starred });
              controls.close();
            }}
          >
            <Star className="size-3.5 shrink-0" />
            {session?.starred ? 'Unstar' : 'Star'}
          </button>
          <div className="my-1 h-px bg-border" />
          {/*
            Re-point a thread that already exists. Dragging it onto another
            folder row already worked, but only between folders the tree
            happens to show — and the tree only shows folders some thread is
            already in, so a new directory was unreachable from here.
          */}
          <button
            type="button"
            className={ROW_CLASS}
            disabled={browsingFolder}
            onClick={(e) => {
              e.stopPropagation();
              void changeSessionFolder(item.id, session?.workingDir ?? null);
              controls.close();
            }}
          >
            <Folder className="size-3.5 shrink-0" />
            {session?.workingDir ? 'Change project folder…' : 'Set project folder…'}
          </button>
          {session?.workingDir && (
            <button
              type="button"
              className={ROW_CLASS}
              onClick={(e) => {
                e.stopPropagation();
                void moveSessionToFolder(item.id, null);
                controls.close();
              }}
            >
              <FolderMinus className="size-3.5 shrink-0" />
              Remove from project
            </button>
          )}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            className={ROW_CLASS}
            onClick={(e) => {
              e.stopPropagation();
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
            onClick={(e) => {
              e.stopPropagation();
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
    [byId, updateSession, createSession, setSidebarOpen, browsingFolder, changeSessionFolder, moveSessionToFolder]
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-2">
      {/*
        THE TOP OF THE SIDEBAR IS A SHORT, QUIET LIST OF PLACES.

        Every row is a destination or one action, drawn the same way: one
        glyph, one word, the same height and type as the thread rows below, so
        the eye reads one column instead of two sizes of button. The primary
        action leads and carries the only fill at rest -- the reference
        shells (ChatGPT's New chat, Claude's New) mark "start here" this way
        rather than with a button.

        "New project" left this list: it CREATES something, and creation sits
        beside the list it creates into (the Projects header below).
      */}
      <nav className="flex flex-col gap-0.5" aria-label="Workspace navigation">
        {/*
          The one solid control in the sidebar, and the way Home: a session
          starts there. A separate "Home" row went to the same place and was
          dropped (see the sidebar audit in home-dashboard).
        */}
        <button
          type="button"
          onClick={startNewSession}
          aria-current={isHome ? 'page' : undefined}
          className="mb-1 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Plus className="size-4 shrink-0" />
          New session
        </button>
        <button
          type="button"
          className={cn(NAV_ROW_CLASS, showSearch && NAV_ROW_ACTIVE)}
          onClick={() => {
            setShowSearch((open) => !open);
            requestAnimationFrame(() => searchRef.current?.focus());
          }}
        >
          <Search className="size-4 shrink-0" />
          Search
        </button>

        <NavSection label="Main">
          <button
            type="button"
            className={cn(NAV_ROW_CLASS, (isHome || viewMode === 'mission') && NAV_ROW_ACTIVE)}
            onClick={() => {
              setCurrentSessionId(null);
              setViewMode('home');
            }}
          >
            <Users className="size-4 shrink-0" />
            Agents
          </button>
          {/*
            Was "Runs": Tasks' Runs page is where scheduled work and its
            history live, so the row is named for what it holds.
          */}
          <button
            type="button"
            className={cn(NAV_ROW_CLASS, viewMode === 'tasks' && tasksTab !== 'tasks' && NAV_ROW_ACTIVE)}
            onClick={() => {
              setTasksTab('runs');
              setViewMode('tasks');
            }}
          >
            <CalendarClock className="size-4 shrink-0" />
            Automations
          </button>
          <button
            type="button"
            className={cn(NAV_ROW_CLASS, viewMode === 'inbox' && NAV_ROW_ACTIVE)}
            onClick={() => setViewMode('inbox')}
          >
            <Inbox className="size-4 shrink-0" />
            Inbox
            {unreadNotificationCount > 0 && (
              <span className="ms-auto text-2xs tabular-nums text-muted-foreground" aria-label={`${unreadNotificationCount} unread`}>
                {unreadNotificationCount}
              </span>
            )}
          </button>
        </NavSection>

        <NavSection label="Workspace">
          {/*
            The workspace's shared files: what you uploaded and what agents
            produced (adapters register files they write each turn). The tree
            below swaps to the file list while this is on.
          */}
          <button
            type="button"
            className={cn(NAV_ROW_CLASS, viewMode === 'files' && NAV_ROW_ACTIVE)}
            onClick={() => setViewMode(viewMode === 'files' ? 'threads' : 'files')}
          >
            <FileText className="size-4 shrink-0" />
            Files
          </button>
          <button type="button" className={NAV_ROW_CLASS} onClick={() => openSettings('knowledge')}>
            <BookOpen className="size-4 shrink-0" />
            Knowledge
          </button>
          <button
            type="button"
            className={cn(NAV_ROW_CLASS, viewMode === 'tasks' && tasksTab === 'tasks' && NAV_ROW_ACTIVE)}
            onClick={() => {
              setTasksTab('tasks');
              setViewMode('tasks');
            }}
          >
            <CircleCheck className="size-4 shrink-0" />
            Tasks
          </button>
        </NavSection>
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

      {/*
        A section label, not a divider line. A project folder in this tree is
        derived -- it exists only because some thread already has that
        `workingDir` -- so the `+` here is the one way to open a directory the
        workspace has not seen before.
      */}
      {viewMode !== 'files' && (
      <div className="mt-3 mb-0.5 flex h-6 items-center justify-between pl-2.5 pr-1">
        <span className={SECTION_LABEL_CLASS}>Projects</span>
        <Hint label={browsingFolder ? 'Opening folder…' : 'New project'}>
          <button
            type="button"
            aria-label="New project"
            disabled={browsingFolder}
            onClick={() => void addProjectFolder()}
            className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {browsingFolder ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          </button>
        </Hint>
      </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {viewMode === 'files' ? (
          <FileList />
        ) : (
        <AISidebar
          ariaLabel="Conversations"
          items={items}
          activeId={isHome ? null : currentSessionId}
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
