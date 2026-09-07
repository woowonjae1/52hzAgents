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
