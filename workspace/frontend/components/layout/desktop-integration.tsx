'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { getBridge, syncDesktopAttributes, WINDOW_CONTROLS_INSET } from '@/lib/desktop';
import { useLayout, type ViewMode } from './layout-context';
import { useArtifacts } from '@/lib/artifacts-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useTheme } from 'next-themes';
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

  const { resolvedTheme } = useTheme();

  /*
    ── Is this window the one you are looking at? ────────────────────────

    Nothing in this app answered that. A backgrounded window rendered pixel
    for pixel like the focused one — which is the single most reliable tell
    that something is a web page wearing a window, because every native app
    on both platforms answers it. macOS pulls the whole chrome toward grey;
    Windows 11 is subtler but still drops the title and the caption glyphs.

    NO IPC. `window`'s own focus/blur fire on OS window activation inside
    Electron, so the main process does not need to forward anything and there
    is no channel to keep in sync with preload.js. `document.hasFocus()` seeds
    the initial value, because the app can be launched into the background
    (tray, auto-start) and would otherwise spend its first paint claiming to
    be focused.

    Gated on `[data-desktop]`. A browser tab that loses focus is not the same
    event — you switch tabs constantly and dimming the UI each time would be
    noise, not information.

    The attribute lands on <html>, so globals.css can dim chrome without a
    single component knowing this exists.
  */
  React.useEffect(() => {
    const root = document.documentElement;
    if (!root.hasAttribute('data-desktop')) return;
    const apply = (active: boolean) => {
      if (active) root.removeAttribute('data-window-inactive');
      else root.setAttribute('data-window-inactive', '');
    };
    apply(document.hasFocus());
    const onFocus = () => apply(true);
    const onBlur = () => apply(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      root.removeAttribute('data-window-inactive');
    };
  }, []);

  // ── Sync light/dark theme to Electron nativeTheme & Mica material ─────
  React.useEffect(() => {
    if (!resolvedTheme) return;
    const bridge = getBridge();
    bridge?.setTheme?.(resolvedTheme);
    bridge?.setTitleBarSymbolColor?.(resolvedTheme === 'dark' ? '#8a8a8a' : '#52525b');
  }, [resolvedTheme]);

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

  /*
    ── Hydration-immune desktop attribute persistence ─────────────────────
    React 19 hydration reconciles <html lang="en"> against JSX and strips
    attributes injected before hydration (such as data-desktop, data-platform).
    We re-assert them immediately and attach a MutationObserver to ensure
    they remain active for the entire application lifetime.
  */
  React.useEffect(() => {
    syncDesktopAttributes();
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const bridge = getBridge();
      if (bridge || (window as unknown as { electronBridge?: unknown }).electronBridge) {
        const observer = new MutationObserver(() => {
          const root = document.documentElement;
          if (!root.hasAttribute('data-desktop')) {
            syncDesktopAttributes();
          }
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-desktop'] });
        return () => observer.disconnect();
      }
    }
  }, []);

  /*
    ── The caption-button reserve, MEASURED instead of guessed ─────────────

    `--window-controls-inset` was the literal 138 — "three 46px buttons" — set
    once from a constant in lib/desktop.ts. That number is right for exactly
    one configuration: Windows 11, 100% display scaling, the default overlay
    height. It is wrong for a 125% or 150% display (the commonest laptop
    setting in this app's user base), wrong on Windows 10, and wrong again the
    moment the window is maximised on some builds — and when it is too small,
    the app's own header controls are drawn underneath the real minimise /
    maximise / close buttons, which is exactly the overlap being reported.

    The platform will simply tell us. `windowControlsOverlay.getTitlebarAreaRect()`
    returns the area NOT occupied by the caption buttons, so the reserve is
    whatever is left over on the trailing edge. `geometrychange` fires when the
    overlay resizes — maximise, restore, a DPI change, the user moving the
    window to a differently-scaled monitor — so this stays correct instead of
    being correct once at startup.

    The 138 stays as the pre-paint fallback: the attribute has to be on <html>
    before the first frame, and this effect cannot run that early.
  */
  React.useEffect(() => {
    const bridge = getBridge();
    const isDarwin = bridge?.platform === 'darwin' || (typeof document !== 'undefined' && document.documentElement.getAttribute('data-platform') === 'darwin');
    if (isDarwin) return;

    const wco = (navigator as unknown as {
      windowControlsOverlay?: {
        visible: boolean;
        getTitlebarAreaRect(): DOMRect;
        addEventListener(t: string, h: () => void): void;
        removeEventListener(t: string, h: () => void): void;
      };
    }).windowControlsOverlay;

    const apply = () => {
      try {
        const isFullscreen = Boolean(document.fullscreenElement || (window.innerHeight === screen.height && window.innerWidth === screen.width));
        if (isFullscreen) {
          document.documentElement.style.setProperty('--window-controls-inset', '0px');
          return;
        }

        if (wco && wco.visible) {
          const rect = wco.getTitlebarAreaRect();
          const trailing = Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)));
          const leading = Math.max(0, Math.round(rect.x));
          const inset = Math.max(trailing, leading);
          const finalInset = Math.max(inset, WINDOW_CONTROLS_INSET);
          document.documentElement.style.setProperty('--window-controls-inset', `${finalInset}px`);
        } else {
          // Keep safe 138px reserve if WCO rect is temporarily not ready or not visible outside fullscreen
          document.documentElement.style.setProperty('--window-controls-inset', `${WINDOW_CONTROLS_INSET}px`);
        }
      } catch {
        // Leave the pre-paint fallback in place.
      }
    };

    apply();
    if (wco) {
      wco.addEventListener('geometrychange', apply);
    }
    window.addEventListener('resize', apply);
    return () => {
      if (wco) {
        wco.removeEventListener('geometrychange', apply);
      }
      window.removeEventListener('resize', apply);
    };
  }, []);

  // ── Re-assert drag regions on window state changes and resize ───────────
  // Chromium caches -webkit-app-region rectangles from layout. When the window
  // is unmaximized, restored, or resized, the cache becomes stale and stops
  // moving the window. Flipping -webkit-app-region to no-drag and back on the
  // next animation frame forces Chromium to recollect the drag bounds.
  React.useEffect(() => {
    const bridge = getBridge();
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reassert = () => {
      if (typeof document === 'undefined') return;
      const dragElements = document.querySelectorAll<HTMLElement>(
        '.app-header, .app-titlebar, [data-drag-region]'
      );
      if (dragElements.length === 0) return;

      dragElements.forEach((el) => el.style.setProperty('-webkit-app-region', 'no-drag'));
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        dragElements.forEach((el) => el.style.removeProperty('-webkit-app-region'));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          dragElements.forEach((el) => {
            el.style.setProperty('-webkit-app-region', 'no-drag');
            requestAnimationFrame(() => el.style.removeProperty('-webkit-app-region'));
          });
        }, 60);
      });
    };

    const unsubscribe = bridge?.onWindowStateChanged?.(reassert);
    window.addEventListener('resize', reassert);

    reassert();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('resize', reassert);
    };
  }, []);
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
