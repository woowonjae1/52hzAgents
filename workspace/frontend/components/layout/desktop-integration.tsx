'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { getBridge } from '@/lib/desktop';
import { useLayout, type ViewMode } from './layout-context';
import { useArtifacts } from '@/lib/artifacts-context';
import { useWorkspace } from '@/lib/workspace-context';
import { SHORTCUTS_EVENT } from './global-shortcuts';
import { COMMAND_PALETTE_EVENT } from './command-palette';

/**
 * WHERE THE WINDOW AND THE APPLICATION MEET.
 *
 * The Electron shell already had most of this: a tray, notifications, a native
 * folder picker, `showItemInFolder`. What it did not have was anyone in the
 * renderer listening. `showItemInFolder` and `showNotification` were exposed on
 * the bridge and called from zero places; the menu bar could not run a single
 * command the app implements; the unread count was rendered in the Inbox header
 * and never reached the taskbar.
 *
 * Three wirings, all one-directional, all no-ops in a browser tab:
 *
 *   menu bar  → in-app command
 *   download  → "Saved · Show in folder"
 *   unread    → dock badge / taskbar overlay / tray tooltip
 *
 * Mounted once next to GlobalShortcuts. It renders nothing.
 */

/**
 * The taskbar overlay is a 32×32 image, and the main process has no canvas to
 * draw a number into — so it is drawn here and sent over as a data URL.
 *
 * Windows draws this at 16×16 in the corner of the taskbar button, so it is
 * rendered at 2× and left to scale down: a 16px canvas produces a number that
 * is legible only on the machine it was tested on.
 */
function drawBadge(count: number): string | null {
  if (typeof document === 'undefined' || count <= 0) return null;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Past 99 the digits stop being readable at 16px, which is the size that
  // actually ships. Every count above it means the same thing anyway.
  const label = count > 99 ? '99+' : String(count);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${label.length > 2 ? 14 : 19}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // +1: the cap-height of a digit sits above the geometric middle, so a
  // centred baseline looks high in a circle.
  ctx.fillText(label, size / 2, size / 2 + 1);

  return canvas.toDataURL('image/png');
}

/** Menu command id → what the app does. Mirrors global-shortcuts.tsx. */
const GO_TARGETS: Record<string, ViewMode> = {
  threads: 'threads',
  tasks: 'tasks',
  mission: 'mission',
  files: 'files',
  knowledge: 'knowledge',
  skills: 'skills',
  routines: 'routines',
  inbox: 'inbox',
  browser: 'browser',
};

export function DesktopIntegration() {
  const {
    setViewMode,
    openSettings,
    openNewThread,
    sidebarToggle,
    activeRightTab,
    setActiveRightTab,
  } = useLayout();
  const { isCanvasOpen, closeCanvas } = useArtifacts();
  const { unreadNotificationCount } = useWorkspace();

  // Read through a ref so the IPC subscription is installed once rather than
  // torn down and re-added every time the shell re-renders — a resubscribe
  // between a menu click and its delivery drops the command.
  const handlers = React.useRef({
    setViewMode,
    openSettings,
    openNewThread,
    sidebarToggle,
    activeRightTab,
    setActiveRightTab,
    isCanvasOpen,
    closeCanvas,
  });
  handlers.current = {
    setViewMode,
    openSettings,
    openNewThread,
    sidebarToggle,
    activeRightTab,
    setActiveRightTab,
    isCanvasOpen,
    closeCanvas,
  };

  // ── Menu bar → in-app command ────────────────────────────────────────
  React.useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.onMenuCommand) return;

    return bridge.onMenuCommand((commandId) => {
      const h = handlers.current;

      if (commandId.startsWith('go:')) {
        const target = GO_TARGETS[commandId.slice(3)];
        if (target) h.setViewMode(target);
        return;
      }

      switch (commandId) {
        case 'new-chat':
          h.openNewThread();
          return;
        case 'palette':
          window.dispatchEvent(new Event(COMMAND_PALETTE_EVENT));
          return;
        case 'settings':
          h.openSettings('general');
          return;
        case 'toggle-sidebar':
          h.sidebarToggle();
          return;
        case 'toggle-studio':
          if (h.activeRightTab !== null || h.isCanvasOpen) {
            h.setActiveRightTab(null);
            h.closeCanvas();
          } else {
            h.setActiveRightTab('preview');
          }
          return;
        case 'shortcuts':
          window.dispatchEvent(new Event(SHORTCUTS_EVENT));
          return;
        default:
          // An id the shell knows and this build does not. Silence beats a
          // toast the user cannot act on.
      }
    });
  }, []);

  // ── Downloads → a result the user can act on ─────────────────────────
  React.useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.onDownloadComplete) return;

    const unsubscribers = [
      bridge.onDownloadProgress?.(({ filename, percent }) => {
        if (percent > 0 && percent < 100) {
          toast.loading(`Downloading ${filename} (${percent}%)`, {
            id: `download-${filename}`,
            duration: 4000,
          });
        }
      }),
      bridge.onDownloadComplete(({ filename, savePath }) => {
        toast.dismiss(`download-${filename}`);
        toast.success(`Saved ${filename}`, {
          action: {
            label: 'Show in folder',
            onClick: () => {
              void getBridge()?.showItemInFolder(savePath);
            },
          },
          // Longer than the app's 3s default: this one carries an action, and
          // an action that vanishes before it is read is not an action.
          duration: 8000,
        });
      }),
      // Closing the Save dialog is an answer, not a failure — say nothing.
      bridge.onDownloadCancelled?.(({ filename }) => {
        if (filename) toast.dismiss(`download-${filename}`);
      }),
      bridge.onDownloadFailed?.(({ filename }) => {
        if (filename) toast.dismiss(`download-${filename}`);
        toast.error(`Could not save ${filename}`);
      }),
    ].filter(Boolean) as Array<() => void>;

    return () => unsubscribers.forEach((off) => off());
  }, []);

  // ── Unread count → the OS ────────────────────────────────────────────
  React.useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.setUnreadCount) return;
    bridge.setUnreadCount(unreadNotificationCount, drawBadge(unreadNotificationCount));
  }, [unreadNotificationCount]);

  // ── Protocol URL, Power Resume & Approval Navigation ─────────────────
  React.useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;

    const unsubs = [
      bridge.onProtocolUrl?.((rawUrl) => {
        try {
          const u = new URL(rawUrl);
          const target = u.pathname?.replace(/^\/+/, '') || u.hostname;
          if (target) {
            toast.info(`Opened via protocol: ${target}`);
          }
        } catch {
          // Invalid protocol URL
        }
      }),
      bridge.onPowerResume?.(() => {
        toast.info('System resumed. Connections synchronised.');
      }),
      bridge.onNavigateApproval?.(({ agentName, action }) => {
        toast.info(`Approval required for @${agentName}`, {
          description: action,
          duration: 8000,
        });
      }),
    ].filter(Boolean) as Array<() => void>;

    return () => unsubs.forEach((fn) => fn());
  }, []);

  return null;
}
