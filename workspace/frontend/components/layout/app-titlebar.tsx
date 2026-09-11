'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { PanelLeft } from 'lucide-react';
import { SignalMark } from '@/components/brand/signal-mark';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from './layout-context';

/**
 * The window's own titlebar, rendered only inside the Electron shell.
 *
 * `titleBarStyle: 'hidden'` gives the window no native caption bar but still
 * draws the caption *buttons* over the top-right of the web content. This band
 * is what those buttons sit in: it spans the full window width, is draggable
 * along its whole length, and reserves `--window-controls-inset` at the end
 * (or `--traffic-lights-inset` at the start on macOS) so nothing is ever drawn
 * underneath them. Every view below it is then free to lay out edge to edge.
 *
 * It also absorbs three things that were duplicated below it: the brand mark,
 * the workspace name with its connection dot, and the sidebar toggle. Those
 * lived in SidebarHeader, which is why the desktop shell had a 36px strip, then
 * a 58px sidebar header, then a 52px view header — three bands to say what one
 * says. SidebarHeader still renders in the browser, where there is no titlebar
 * to move them into.
 */
export function AppTitlebar() {
  const { workspace, realtimeStatus } = useWorkspace();
  const { isSidebarOpen, sidebarToggle } = useLayout();
  const { resolvedTheme } = useTheme();
  const isLive = realtimeStatus === 'live';
  const isConnecting = realtimeStatus === 'connecting';
  const connectionLabel = isLive ? 'Workspace connected' : isConnecting ? 'Reconnecting to workspace' : 'Workspace offline';
  const bandRef = React.useRef<HTMLElement>(null);

  /*
    RE-ASSERT THE DRAG REGION AFTER EVERY WINDOW STATE CHANGE.

    This band is the only thing that moves the window — `titleBarStyle:
    'hidden'` leaves no native caption bar to grab. Chromium collects the
    `-webkit-app-region: drag` rectangles from the layout and caches them, and
    when the OS rebuilds the window's non-client area (maximise, restore from
    minimised, re-show from the tray) that cache can keep describing the old
    frame. The band still paints, still looks draggable, and drags nothing.

    Flipping the property to `no-drag` and back on the next frame is what makes
    the collection run again: it is a real change to the element's app-region,
    so it cannot be coalesced away. One frame with the region off is not
    reachable by a user — the event arrives while the window is still animating
    into its new state.

    If the cache was fine, this is two style writes and a no-op.
  */
  React.useEffect(() => {
    const bridge = (window as unknown as {
      electronBridge?: { onWindowStateChanged?: (cb: () => void) => () => void };
    }).electronBridge;
    if (!bridge?.onWindowStateChanged) return;

    let frame = 0;
    const reassert = () => {
      const band = bandRef.current;
      if (!band) return;
      band.style.setProperty('-webkit-app-region', 'no-drag');
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Removing the override hands the element back to the stylesheet's
        // `app-region: drag`, rather than pinning `drag` inline and shadowing
        // the `:where(button, a, …)` no-drag rule for everything inside.
        band.style.removeProperty('-webkit-app-region');
      });
    };

    const unsubscribe = bridge.onWindowStateChanged(reassert);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribe?.();
    };
  }, []);

  /*
    The caption buttons are drawn by the OS on top of this band, so CSS cannot
    reach their glyphs. They were pinned to one mid-grey that was chosen against
    the dark theme and went nearly invisible on the light one. `resolvedTheme`
    rather than `theme`, which can be the literal 'system'.
  */
  React.useEffect(() => {
    if (!resolvedTheme) return;
    const bridge = (window as unknown as {
      electronBridge?: { setTitleBarSymbolColor?: (color: string) => void };
    }).electronBridge;
    bridge?.setTitleBarSymbolColor?.(resolvedTheme === 'dark' ? '#8a8a8a' : '#52525b');
  }, [resolvedTheme]);

  /*
    NO BOTTOM BORDER ON THIS BAND.

    The top of the window carried TWO full-strength hairlines stacked one
    header-height apart -- this one and `.app-header`'s -- and each already came
    with a fill change of its own. Two rules and two tonal steps for what is, at
    most, one boundary; the double rule that produced is a classic way for a
    window to read as cheap.

    There is only one real boundary up here: chrome against content, and
    `.app-header` draws it. The titlebar and the view header are both chrome, so
    a rule between them separates things that belong together.

    On the sidebar side this border was the only thing between the app name and
    "New chat" -- they share `--surface-sidebar`, so dropping it lets the name
    sit at the head of the sidebar as one continuous column, which is what it
    is. On the main-pane side the step from `--surface-sidebar` to `--surface0`
    marks the change on its own.
  */
  return (
    <header
      ref={bandRef}
      className="app-titlebar fixed top-0 start-0 end-0 z-50 flex items-center gap-2 bg-surface-sidebar"
      aria-label="Window titlebar"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={sidebarToggle}
            aria-label={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={isSidebarOpen}
            className="size-6 shrink-0 rounded-md flex items-center justify-center text-foreground-extra-muted hover:text-foreground hover:bg-surface2 transition-colors"
          >
            <PanelLeft className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        </TooltipContent>
      </Tooltip>

      <span className="h-3.5 w-px bg-border shrink-0" />

      <div className="flex items-center gap-2 min-w-0">
        <SignalMark size={16} className="shrink-0" title="52hzAgents" />
        <span
          className="text-2xs font-medium tracking-tight text-foreground-muted truncate"
          title={workspace?.name || '52hzAgents'}
        >
          {workspace?.name || '52hzAgents'}
        </span>
        <span
          className={`size-1.5 rounded-full shrink-0 ${isLive ? 'bg-status-success' : isConnecting ? 'bg-status-warning animate-pulse' : 'bg-status-danger'}`}
          title={connectionLabel}
          aria-label={connectionLabel}
        />
      </div>
    </header>
  );
}
