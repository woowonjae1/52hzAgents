'use client';

import { Hint } from '@/components/ui/hint';
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav';
import { useScrollRestore } from '@/hooks/use-scroll-restore';
import { useEffect, useMemo, useState } from 'react';
import { cn, mergeRefs } from '@/lib/utils';
import { Inbox, CheckCheck, RefreshCw, X, ExternalLink, ArrowRight, Check, Copy, ShieldAlert } from 'lucide-react';
import { toast } from '@/lib/toast';
import { RowActions } from '@/components/ui/row-actions';
import { useWorkspace } from '@/lib/workspace-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { useLayout } from '@/components/layout/layout-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import type { NotificationItem } from '@/lib/types';
import { stripAddressPrefix } from '@/lib/types';
import { usePendingToolApprovals } from '@/components/home/use-home-attention';
import { respondToToolApproval, type PendingActionItem } from '@/components/mission/action-required-banner';

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function PriorityDot({ priority }: { priority: NotificationItem['priority'] }) {
  return (
    <span
      className={cn(
        'size-2 rounded-full shrink-0 mt-1.5',
        priority === 'high' && 'bg-status-danger',
        priority === 'normal' && 'bg-foreground-extra-muted',
        priority === 'low' && 'bg-foreground-extra-muted',
      )}
    />
  );
}

function NotificationCard({
  notification,
  onRead,
  onDismiss,
  onNavigate,
}: {
  notification: NotificationItem;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
  onNavigate: (notification: NotificationItem) => void;
}) {
  const agentName = stripAddressPrefix(notification.createdBy) || 'system';

  return (
    <div
      className={cn(
        'skip-offscreen-row group px-3 py-2.5 flex items-start gap-2.5 transition-colors',
        !notification.isRead
          ? 'bg-surface2 hover:bg-surface3'
          : 'hover:bg-surface2',
      )}
      onClick={() => onNavigate(notification)}
    >
      <PriorityDot priority={notification.priority} />
      <AgentAvatar name={agentName} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-sm font-medium leading-snug', !notification.isRead && 'font-semibold')}>
            {notification.title}
          </span>
          {notification.priority === 'high' && (
            <span className="text-3xs px-1 py-0.5 rounded bg-surface2 text-status-danger font-medium shrink-0">
              High
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {notification.message}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-3xs text-muted-foreground">{agentName}</span>
          <span className="text-3xs text-muted-foreground">{timeAgo(notification.createdAt)}</span>
          {notification.channelName && (
            <span className="text-3xs text-foreground-muted flex items-center gap-0.5">
              <ArrowRight className="size-2.5" />
              Go to thread
            </span>
          )}
          {notification.linkUrl && (
            <a
              href={notification.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-3xs text-foreground-muted flex items-center gap-0.5"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="size-2.5" />
              Link
            </a>
          )}
        </div>
      </div>
      <RowActions
        label={`Actions for ${notification.title}`}
        items={[
          ...(notification.channelName
            ? [{ label: 'Go to thread', icon: ArrowRight, onSelect: () => onNavigate(notification) }]
            : []),
          ...(notification.isRead
            ? []
            : [{ label: 'Mark as read', icon: Check, onSelect: () => onRead(notification.id) }]),
          {
            label: 'Copy message',
            icon: Copy,
            onSelect: () => {
              navigator.clipboard.writeText(`${notification.title}

${notification.message}`);
              toast.success('Copied');
            },
          },
          { label: 'Dismiss', icon: X, destructive: true, onSelect: () => onDismiss(notification.id) },
        ]}
      />
    </div>
  );
}

function NotificationSection({
  indexOffset,
  cursor,
  rowProps,
  title,
  items,
  onRead,
  onDismiss,
  onNavigate,
}: {
  title: string;
  items: NotificationItem[];
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
  onNavigate: (notification: NotificationItem) => void;
  /** Where this section starts in the flat, cross-section cursor. */
  indexOffset: number;
  cursor: number;
  rowProps: (index: number, selected?: boolean) => Record<string, unknown>;
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
        {title} ({items.length})
      </h3>
      <div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
        {items.map((n, i) => (
          <div
            key={n.id}
            {...rowProps(indexOffset + i, cursor === indexOffset + i)}
            className={cn('group', cursor === indexOffset + i && 'ring-1 ring-inset ring-border-accent')}
          >
            <NotificationCard
              notification={n}
              onRead={onRead}
              onDismiss={onDismiss}
              onNavigate={onNavigate}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function InboxView() {
  const {
    notifications,
    unreadNotificationCount,
    refreshNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    dismissNotification,
    setCurrentSessionId,
    sessions,
  } = useWorkspace();
  const { setViewMode } = useLayout();

  useEffect(() => {
    refreshNotifications();
  }, [refreshNotifications]);

  const { unread, read } = useMemo(() => {
    const u = notifications
      .filter((n) => !n.isRead)
      .sort((a, b) => {
        const priorityOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
        const aP = (a.priority && priorityOrder[a.priority as string]) ?? 1;
        const bP = (b.priority && priorityOrder[b.priority as string]) ?? 1;
        const pDiff = aP - bP;
        if (pDiff !== 0) return pDiff;
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      });
    const r = notifications
      .filter((n) => n.isRead)
      .sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      });
    return { unread: u, read: r };
  }, [notifications]);

  /*
   * The inbox draws two sections but the keyboard walks ONE list — Unread then
   * Read, the order they appear in. Splitting the cursor per section would mean
   * ↓ stopping dead at the bottom of Unread with more rows visible below it,
   * which is the behaviour people read as "the arrow keys are broken".
   */
  const ordered = useMemo(() => [...unread, ...read], [unread, read]);
  const scrollRef = useScrollRestore<HTMLDivElement>('inbox');

  const { cursor, listNavProps, rowProps } = useListKeyboardNav({
    count: ordered.length,
    onActivate: (i) => { const n = ordered[i]; if (n) handleNavigate(n); },
    onDelete: (i) => { const n = ordered[i]; if (n) dismissNotification(n.id); },
    onToggle: (i) => { const n = ordered[i]; if (n && !n.isRead) markNotificationRead(n.id); },
    pageSize: 8,
  });

  const approvals = usePendingToolApprovals(sessions);
  const [busyApproval, setBusyApproval] = useState<string | null>(null);

  const handleApprovalAnswer = async (item: PendingActionItem, granted: boolean) => {
    setBusyApproval(item.id);
    try {
      await respondToToolApproval(item, granted);
      if (granted) toast.success(`Approved @${item.agentName}`);
      else toast.info(`Denied @${item.agentName}`);
      void approvals.refresh();
    } catch {
      toast.error(granted ? 'Approval failed' : 'Could not submit denial');
    } finally {
      setBusyApproval(null);
    }
  };

  const handleNavigate = (notification: NotificationItem) => {
    if (!notification.isRead) {
      markNotificationRead(notification.id);
    }
    if (notification.channelName) {
      const session = sessions.find((s) => s.sessionId === notification.channelName);
      if (session) {
        setCurrentSessionId(notification.channelName);
        setViewMode('threads');
      }
    }
  };

  const totalUnresolved = unreadNotificationCount + approvals.items.length;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="app-header justify-between ps-4 shrink-0">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 text-foreground-muted" />
          <ScreenTitle>Inbox</ScreenTitle>
          {totalUnresolved > 0 && (
            <span className="text-xs text-muted-foreground font-mono">
              {totalUnresolved} pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {unreadNotificationCount > 0 && (
            <Hint label="Mark all as read">
              <button
                onClick={markAllNotificationsRead}
                className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground transition-colors"
              >
                <CheckCheck className="size-3.5" />
              </button>
            </Hint>
          )}
          <Hint label="Refresh">
            <button
              onClick={() => {
                refreshNotifications();
                void approvals.refresh();
              }}
              className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground transition-colors"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </Hint>
        </div>
      </div>

      {/* Content */}
      <div
        {...listNavProps}
        ref={mergeRefs(listNavProps.ref, scrollRef)}
        className="flex-1 overflow-y-auto outline-none"
      >
        {notifications.length === 0 && approvals.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Inbox className="size-8 opacity-30" />
            <p className="text-sm font-medium">No pending items</p>
            <p className="text-xs opacity-60">Approvals and agent notifications will appear here</p>
            {unreadNotificationCount > 0 && (
              <button
                type="button"
                onClick={markAllNotificationsRead}
                className="mt-2 text-xs px-3 py-1.5 rounded-md bg-surface2 hover:bg-surface3 text-foreground font-medium transition-colors"
              >
                Clear unread badge ({unreadNotificationCount})
              </button>
            )}
          </div>
        ) : (
          <div className="p-4 space-y-6">
            {/* Action Required: Antigravity-style cross-agent approval inbox */}
            {approvals.items.length > 0 && (
              <section className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <ShieldAlert className="size-4 text-status-warning" />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-status-warning">
                    Action Required ({approvals.items.length})
                  </h3>
                </div>
                <div className="space-y-2">
                  {approvals.items.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-status-warning/30 bg-status-warning/5 p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <AgentAvatar name={item.agentName} size={20} className="rounded-full shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-foreground">@{item.agentName}</span>
                            <span className="text-muted-foreground">requested approval:</span>
                            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-surface2 font-semibold">
                              {item.toolName || 'tool action'}
                            </span>
                          </div>
                          {item.command && (
                            <div className="mt-1 font-mono text-xs text-foreground bg-surface0/60 p-2 rounded-lg border border-border/40 truncate">
                              {item.command}
                            </div>
                          )}
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            Thread: {item.channelTitle || item.channelId}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                        <button
                          type="button"
                          disabled={busyApproval === item.id}
                          onClick={() => handleApprovalAnswer(item, false)}
                          className="px-2.5 py-1 text-xs rounded-lg border border-border bg-surface2 hover:bg-surface3 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                        >
                          Deny
                        </button>
                        <button
                          type="button"
                          disabled={busyApproval === item.id}
                          onClick={() => handleApprovalAnswer(item, true)}
                          className="px-2.5 py-1 text-xs rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-medium cursor-pointer transition-colors shadow-xs"
                        >
                          Approve
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {unread.length > 0 && (
              <NotificationSection
                title="Unread"
                items={unread}
                indexOffset={0}
                cursor={cursor}
                rowProps={rowProps}
                onRead={markNotificationRead}
                onDismiss={dismissNotification}
                onNavigate={handleNavigate}
              />
            )}
            {read.length > 0 && (
              <NotificationSection
                title="Read"
                items={read}
                indexOffset={unread.length}
                cursor={cursor}
                rowProps={rowProps}
                onRead={markNotificationRead}
                onDismiss={dismissNotification}
                onNavigate={handleNavigate}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}