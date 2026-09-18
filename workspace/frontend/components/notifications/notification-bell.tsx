'use client';

import { useState, useMemo } from 'react';
import { Bell, CheckCheck, RefreshCw, Check, ArrowRight, BellOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Hint } from '@/components/ui/hint';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { stripAddressPrefix } from '@/lib/types';
import type { NotificationItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}m 前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  return `${days}d 前`;
}

function PriorityDot({ priority }: { priority: NotificationItem['priority'] }) {
  return (
    <span
      className={cn(
        'size-1.5 rounded-full shrink-0 mt-1',
        priority === 'high' ? 'bg-status-danger' : 'bg-foreground-extra-muted'
      )}
    />
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const {
    notifications,
    unreadNotificationCount,
    markNotificationRead,
    markAllNotificationsRead,
    refreshNotifications,
    setCurrentSessionId,
  } = useWorkspace();
  const { viewMode, setViewMode } = useLayout();

  const unreadList = useMemo(
    () => notifications.filter((n) => !n.isRead),
    [notifications]
  );

  const displayCount = unreadNotificationCount > 0 ? unreadNotificationCount : unreadList.length;

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRefreshing(true);
    try {
      await refreshNotifications();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleMarkAllRead = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await markAllNotificationsRead();
      toast.success('已标记全部通知为已读');
    } catch {
      toast.error('标记已读失败');
    }
  };

  const handleNotificationClick = async (n: NotificationItem) => {
    if (!n.isRead) {
      void markNotificationRead(n.id);
    }
    if (n.threadId || n.channelName) {
      if (viewMode !== 'threads') {
        setViewMode('threads');
      }
      setCurrentSessionId(n.threadId || n.channelName);
      setOpen(false);
    } else if (n.linkUrl) {
      window.open(n.linkUrl, '_blank', 'noopener,noreferrer');
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={displayCount > 0 ? `${displayCount} 条未读通知` : '通知中心'}
          className={cn(
            'size-7 rounded-lg flex items-center justify-center transition-colors relative',
            open
              ? 'bg-surface2 text-foreground'
              : 'text-foreground-extra-muted hover:text-foreground hover:bg-surface2'
          )}
        >
          <Bell className="size-3.5" />
          {displayCount > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-status-danger text-white text-[9px] font-bold flex items-center justify-center border-2 border-surface0 dark:border-surface-sidebar shadow-xs animate-in fade-in zoom-in-75 duration-150"
              title={`${displayCount} 条未读通知`}
            >
              {displayCount > 99 ? '99+' : displayCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 p-0 shadow-2xl rounded-xl border border-border bg-surface1/95 backdrop-blur-xl z-50 overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60 shrink-0 bg-surface0/60">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground">通知</span>
            {displayCount > 0 && (
              <span className="text-3xs px-1.5 py-0.5 rounded-full bg-status-danger/15 text-status-danger font-medium font-mono">
                {displayCount}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {displayCount > 0 && (
              <Hint label="全部标记为已读">
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors flex items-center gap-1 text-3xs"
                >
                  <CheckCheck className="size-3.5" />
                  <span>全部已读</span>
                </button>
              </Hint>
            )}
            <Hint label="刷新通知">
              <button
                type="button"
                onClick={handleRefresh}
                className={cn(
                  'p-1 rounded-md text-foreground-extra-muted hover:text-foreground hover:bg-surface2 transition-colors',
                  isRefreshing && 'animate-spin text-foreground'
                )}
              >
                <RefreshCw className="size-3" />
              </button>
            </Hint>
          </div>
        </div>

        {/* List Body */}
        <div className="max-h-72 overflow-y-auto divide-y divide-border/40 min-h-[100px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-6 text-center text-foreground-muted gap-2">
              <BellOff className="size-6 opacity-40 text-foreground-extra-muted" />
              <p className="text-xs font-medium">暂无通知</p>
              {displayCount > 0 ? (
                <div className="mt-1 flex flex-col items-center gap-1.5">
                  <p className="text-3xs text-foreground-extra-muted">
                    检测到未清除的角标计数，点击下方立即重置
                  </p>
                  <button
                    type="button"
                    onClick={handleMarkAllRead}
                    className="text-3xs px-2.5 py-1 rounded-md bg-surface2 hover:bg-surface3 text-foreground font-medium transition-colors"
                  >
                    清除未读标记
                  </button>
                </div>
              ) : (
                <p className="text-3xs text-foreground-extra-muted">Agent 的执行与状态更新将在此提示</p>
              )}
            </div>
          ) : (
            notifications.slice(0, 15).map((n) => {
              const agentName = stripAddressPrefix(n.createdBy) || 'system';
              return (
                <div
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  className={cn(
                    'p-2.5 flex items-start gap-2.5 transition-colors cursor-pointer group text-left relative',
                    !n.isRead ? 'bg-surface2/60 hover:bg-surface2' : 'hover:bg-surface2/40 opacity-75 hover:opacity-100'
                  )}
                >
                  <PriorityDot priority={n.priority} />
                  <AgentAvatar name={agentName} size={20} className="shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className={cn('text-xs truncate font-medium', !n.isRead && 'font-semibold text-foreground')}>
                        {n.title}
                      </span>
                      <span className="text-3xs text-foreground-extra-muted shrink-0 tabular-nums">
                        {timeAgo(n.createdAt)}
                      </span>
                    </div>
                    <p className="text-2xs text-foreground-muted line-clamp-2 mt-0.5 leading-snug">
                      {n.message || n.body}
                    </p>
                    {(n.threadId || n.channelName) && (
                      <div className="flex items-center gap-1 mt-1 text-3xs text-brand font-medium">
                        <ArrowRight className="size-2.5" />
                        <span>前往相关频道</span>
                      </div>
                    )}
                  </div>

                  {!n.isRead && (
                    <Hint label="标记为已读">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void markNotificationRead(n.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface3 text-foreground-muted hover:text-foreground transition-all shrink-0"
                      >
                        <Check className="size-3 text-status-success" />
                      </button>
                    </Hint>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer: Open full inbox */}
        <div className="px-3 py-2 border-t border-border/60 shrink-0 bg-surface0/40 flex items-center justify-between text-3xs">
          <button
            type="button"
            onClick={() => {
              setViewMode('inbox');
              setOpen(false);
            }}
            className="text-foreground-muted hover:text-foreground font-medium flex items-center gap-1 transition-colors"
          >
            <span>打开收件箱与审批</span>
            <ArrowRight className="size-2.5" />
          </button>
          {displayCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="text-foreground-extra-muted hover:text-status-danger transition-colors"
            >
              一键清空
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
