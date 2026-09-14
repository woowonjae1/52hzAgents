'use client';

import * as React from 'react';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';

const VIEW_LABEL: Record<string, string> = {
  mission: 'Mission Control',
  files: 'Files',
  browser: 'Browser',
  tasks: 'Tasks',
  timers: 'Timers',
  inbox: 'Inbox',
  connect: 'Connect',
  settings: 'Settings',
  knowledge: 'Knowledge',
  skills: 'Skills',
  routines: 'Routines',
};

/**
 * THE TITLE BAR SAYS WHAT THE WINDOW IS SHOWING.
 *
 * `document.title` appeared exactly zero times in this codebase, so every
 * window, every taskbar button and every Alt-Tab card read "52hzAgents
 * Workspace" — including two windows open on two different channels, which is
 * the case the title exists to disambiguate. It is also what the OS uses for
 * window search, for the dock menu on macOS, and for the tooltip on a
 * taskbar's grouped icons.
 *
 * Document first, application second — `Untitled.txt — Notepad`, not the
 * other way round. The part the user is switching between has to be the part
 * that survives truncation.
 *
 * The unread count goes in front, because a taskbar entry truncates from the
 * right and a badge nobody can see is not a badge.
 */
export function WindowTitle() {
  const { viewMode, settingsTab } = useLayout();
  const { workspace, sessions, currentSessionId, unreadNotificationCount } = useWorkspace();

  React.useEffect(() => {
    const app = workspace?.name ? `${workspace.name} · 52hzAgents` : '52hzAgents';

    let subject: string | null = null;
    if (viewMode === 'threads') {
      const s = sessions.find((x) => x.sessionId === currentSessionId);
      subject = s?.title || (currentSessionId ? `#${currentSessionId.replace(/^channel\//, '')}` : null);
    } else if (viewMode === 'settings') {
      const tab = settingsTab === 'general' ? 'Settings' : VIEW_LABEL[settingsTab] || 'Settings';
      subject = tab;
    } else {
      subject = VIEW_LABEL[viewMode] ?? null;
    }

    const badge = unreadNotificationCount > 0 ? `(${unreadNotificationCount}) ` : '';
    document.title = subject ? `${badge}${subject} — ${app}` : `${badge}${app}`;
  }, [viewMode, settingsTab, workspace?.name, sessions, currentSessionId, unreadNotificationCount]);

  return null;
}
