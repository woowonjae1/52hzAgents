'use client';

import * as React from 'react';
import { toast } from '@/lib/toast';
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

  /*
    ── Re-assert the drag regions ────────────────────────────────────────

    Chromium collects `-webkit-app-region` as RECTANGLES during layout and
    caches them. When the OS rebuilds the window's non-client area — maximise,
    unmaximise, restore, resize — that cache can keep describing the old frame,
    and the header then paints normally while dragging nothing. Flipping the
    property off and on is what forces a recollect, because it is a real change
    to the element's app-region and cannot be coalesced away.

    THE FLIP MUST NOT BE ABLE TO STOP HALFWAY.

    The previous version set `no-drag` synchronously and restored it inside a
    `requestAnimationFrame`, with a second `setTimeout(60)` pass that did the
    same again. rAF does not run in a window that is minimised, hidden or
    occluded — which is exactly the state a window is in around the events this
    listens to. Any callback that failed to fire left the header pinned to
    `no-drag`, and from then on the window could not be dragged AT ALL until
    some later event happened to complete a whole flip. "It just stops moving
    and never comes back" is that bug, not a stale cache.

    So the flip is synchronous and self-contained: set, force a layout read,
    clear. `offsetHeight` is not a superstition here — reading it flushes
    pending layout, which is the pass that collects the rectangles, so the
    element genuinely holds `no-drag` across one layout and `drag` across the
    next. Nothing is left pending, so nothing can be left stuck.

    The `setTimeout` that remains only ever CLEARS. It is a safety net for a
    flip interrupted by something outside this function, and it cannot itself
    create the state it is there to undo.

    `resize` is throttled through rAF-free debouncing for the same reason: a
    drag-resize fires hundreds of events, and each one forcing a synchronous
    layout on every header is a real cost.
  */
  React.useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let safety: ReturnType<typeof setTimeout> | null = null;

    const clearOverride = () => {
      document
        .querySelectorAll<HTMLElement>('.app-header, .app-titlebar, [data-drag-region]')
        .forEach((el) => el.style.removeProperty('-webkit-app-region'));
    };

    const reassert = () => {
      const els = document.querySelectorAll<HTMLElement>(
        '.app-header, .app-titlebar, [data-drag-region]',
      );
      if (els.length === 0) return;
      els.forEach((el) => {
        el.style.setProperty('-webkit-app-region', 'no-drag');
        // Flush layout so the rectangles are collected with the region off...
        void el.offsetHeight;
        // ...and hand the element straight back to the stylesheet's `drag`.
        el.style.removeProperty('-webkit-app-region');
      });
      if (safety) clearTimeout(safety);
      safety = setTimeout(clearOverride, 200);
    };

    const onResize = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(reassert, 120);
    };

    const unsubscribe = bridge.onWindowStateChanged?.(reassert);
    window.addEventListener('resize', onResize);
    reassert();

    return () => {
      if (debounce) clearTimeout(debounce);
      if (safety) clearTimeout(safety);
      unsubscribe?.();
      window.removeEventListener('resize', onResize);
      // Never unmount holding the override.
      clearOverride();
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
