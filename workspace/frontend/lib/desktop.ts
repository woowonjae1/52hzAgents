/**
 * Desktop-shell facts, in one place.
 *
 * Four components used to each compute `isDesktop` inline from
 * `window.electronBridge` and then hardcode their own guess at the window-chrome
 * geometry — a 28px top strip in the wrapper, a 144px right reserve in the chat
 * header, nothing at all in Tasks / Mission / Skills / Knowledge / Settings.
 * The native caption buttons are 38px tall and ~138px wide, so every one of
 * those numbers was wrong in a different direction and the right-hand controls
 * of five views sat underneath the real minimise/close buttons.
 *
 * The geometry now lives in CSS variables stamped on <html> before first paint,
 * so layout is correct on the first frame (no flash of web-shaped chrome) and
 * every consumer reads one number. `useIsDesktop()` exists for the cases that
 * need to branch on markup rather than spacing.
 */

import * as React from 'react';

/**
 * Height of the app's own titlebar band. Must equal `TITLEBAR_HEIGHT` in
 * desktop/main.js, which passes it to `titleBarOverlay.height` — the native
 * caption buttons are drawn at that height whatever CSS thinks, so a mismatch
 * puts them half over the band and half over the content below it.
 */
export const TITLEBAR_HEIGHT = 36;

/**
 * Width to keep clear at the inline-end of the titlebar for the Windows/Linux
 * caption buttons. Electron's overlay draws three 46px buttons.
 */
export const WINDOW_CONTROLS_INSET = 138;

/** Width of the macOS traffic lights, which sit at the inline-start instead. */
export const TRAFFIC_LIGHTS_INSET = 78;

/**
 * One height for every top-level view header, so the sidebar's bottom border
 * and the main pane's bottom border land on the same baseline and the row does
 * not change height when the view changes. Was five different paddings.
 */
export const HEADER_HEIGHT = 48;

/**
 * Stamped on <html> in a blocking inline script (see app/layout.tsx) so the
 * `[data-desktop]` rules in globals.css apply on the first paint. Deliberately
 * does NOT read localStorage — `window.electronBridge` is injected by the
 * preload script, so it is already there when this runs.
 */
export const DESKTOP_PREPAINT_SCRIPT = `(function(){try{var b=window.electronBridge;if(!b)return;var r=document.documentElement;r.setAttribute('data-desktop','');r.setAttribute('data-platform',b.platform||'');}catch(e){}})();`;

/**
 * True inside the Electron shell. Reads the DOM attribute rather than
 * `window.electronBridge` directly so that server render and first client
 * render agree: the attribute is set pre-paint, but React still hydrates
 * against markup built with `false`, so the value is committed in an effect.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState(false);
  React.useEffect(() => {
    setIsDesktop(document.documentElement.hasAttribute('data-desktop'));
  }, []);
  return isDesktop;
}

/**
 * THE SHELL BRIDGE, TYPED ONCE.
 *
 * Eight components reached for `window.electronBridge` through their own
 * inline `as unknown as { electronBridge?: { … } }` cast, each declaring only
 * the one method it needed. So the bridge had eight partial, drifting type
 * declarations and no single place that said what the shell can actually do —
 * which is how `showItemInFolder` and `showNotification` ended up exposed in
 * preload.js and called from nowhere. Nobody knew they were there.
 */
export interface ElectronBridge {
  isDesktop: true;
  platform: string;
  minimizeWindow(): void;
  maximizeWindow(): void;
  closeWindow(): void;
  isMaximized(): Promise<boolean>;
  setTitleBarSymbolColor(color: string): void;
  onWindowStateChanged(handler: () => void): () => void;
  hideQuickBar(): void;
  openMainWindow(route?: string): void;
  getAutostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<boolean>;
  getApiUrl(): string;
  browseFolder(defaultPath?: string): Promise<string | null>;
  /** Open a path with the OS default handler. */
  openPath(pathStr: string): Promise<boolean>;
  /** Reveal a path in Explorer / Finder / the Linux file manager. */
  showItemInFolder(pathStr: string): Promise<boolean>;
  showNotification(opts: { title: string; body: string; channel?: string; silent?: boolean }): Promise<boolean>;
  setUnreadCount(count: number, overlayDataUrl?: string | null): void;
  onDownloadProgress(handler: (p: { filename: string; received: number; total: number; percent: number }) => void): () => void;
  onDownloadComplete(handler: (p: { filename: string; savePath: string }) => void): () => void;
  onDownloadCancelled(handler: (p: { filename: string }) => void): () => void;
  onDownloadFailed(handler: (p: { filename: string; state: string }) => void): () => void;
  onMenuCommand(handler: (command: string) => void): () => void;
  onNavigateToChannel(handler: (channel: string) => void): () => void;
}

/**
 * The bridge, or null in a browser tab. Every caller must handle null — the
 * same build runs at claude.ai-style web URLs with no shell at all.
 */
export function getBridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronBridge?: ElectronBridge }).electronBridge ?? null;
}
