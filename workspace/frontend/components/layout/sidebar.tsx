'use client';

import { useCallback, useEffect, useRef } from 'react';
import { SidebarContent } from './sidebar-content';
import { SidebarHeader } from './sidebar-header';
import { useLayout } from './layout-context';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '@/lib/panel-store';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const {
    isSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    isMobile,
    isSidebarResizing: isResizing,
    setSidebarResizing: setIsResizing,
  } = useLayout();
  // Read the current width inside the keyboard handler without making it a
  // dependency, so the handler identity stays stable across drags.
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    /*
      The drag deliberately does NOT go through React state. `sidebarWidth`
      lives in LayoutProvider, so one setState per pointer event re-renders
      every `useLayout()` consumer — the whole app shell — and a 120Hz mouse
      then re-renders the tree 120 times a second. That was the dropped-frame
      feel, not the animation.

      Instead the drag writes the width straight to the DOM, rAF-coalesced, with
      no React work at all. State is committed once on pointerup so localStorage
      and `aria-valuenow` catch up.

      IT WRITES THE THREE ELEMENTS, NOT `--sidebar-width` ON `<html>`, which is
      what this used to do. A custom property is INHERITED, so setting one on
      the root invalidates style for every element in the document: measured at
      37.6ms per write against this app's transcript (~1.9k nodes), where
      writing `width` on the three elements that actually read it costs 0.2ms.
      A 37ms frame is 2.3 frames of budget, so the drag still dropped frames —
      the rAF coalescing was never the problem, the invalidation scope was, and
      trading a React re-render for a full-document restyle is not a trade.

      `[data-sidebar-sized]` marks those three — this <aside>, its inner column,
      and the spacer that stands in for the fixed sidebar in wrapper.tsx — so
      the drag can size them without threading refs across the shell.
    */
    const html = document.documentElement;
    const sized = Array.from(
      document.querySelectorAll<HTMLElement>('[data-sidebar-sized]'),
    ).map((el) => ({ el, declared: el.style.width }));
    let pending = 0;
    let frame = 0;

    const flush = () => {
      frame = 0;
      for (const { el } of sized) el.style.width = `${pending}px`;
    };
    const onMove = (event: MouseEvent) => {
      // The sidebar is pinned to the start edge, so clientX *is* the width.
      pending = clampSidebarWidth(event.clientX);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (pending) {
        // Set the variable BEFORE handing the elements back, or they render one
        // frame at the pre-drag width while React's effect catches up.
        html.style.setProperty('--sidebar-width', `${pending}px`);
        setSidebarWidth(pending);
      }
      // React's inline width for these has not changed across the drag, so it
      // will not rewrite what the drag overwrote. Put back the exact string
      // each element was carrying when the drag began — snapshotted rather
      // than assumed, because a collapse mid-drag leaves React holding `0px`
      // for the aside and the spacer while the inner column still wants the
      // variable, and one hardcoded value cannot be right for both.
      for (const { el, declared } of sized) el.style.width = declared;
      setIsResizing(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Hold the resize cursor and kill text selection while the pointer travels
    // over arbitrary content in the main pane.
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = '';
    };
  }, [isResizing, setSidebarWidth, setIsResizing]);

  const onHandleKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth(widthRef.current - step);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth(widthRef.current + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSidebarWidth(MAX_SIDEBAR_WIDTH);
    }
  };

  /*
    Widths below read `var(--sidebar-width)` rather than the React number, so a
    drag can move the edge without a render. LayoutProvider keeps the variable
    in sync with `sidebarWidth` for every other path (open/close, keyboard,
    double-click reset).
  */
  return (
    <aside
      className={cn(
        // `top` clears the titlebar band, which is 0px in the browser. The
        // sidebar is `fixed`, so the wrapper's padding does not reach it.
        'fixed overflow-hidden bg-surface-sidebar border-r border-border top-[var(--titlebar-height)] bottom-0 start-0 z-20 flex flex-col shrink-0',
        // No width transition mid-drag, or the edge visibly lags the cursor.
        // `width` only — `transition-all` also animated the border, padding and
        // colours on every open/close, and at 300ms the panel visibly trailed
        // the click. Desktop panels settle in ~150ms.
        !isResizing && 'transition-[width,border-width] duration-[var(--shell-duration)] ease-[var(--shell-ease)]',
      )}
      data-sidebar-sized
      style={{
        width: isSidebarOpen ? 'var(--sidebar-width)' : '0px',
        borderRightWidth: isSidebarOpen ? '1px' : '0px',
      }}
    >
      <div data-sidebar-sized className="flex flex-col h-full shrink-0 min-w-0" style={{ width: 'var(--sidebar-width)' }}>
        <SidebarHeader />
        <SidebarContent />
      </div>

      {/*
        Resize handle. Paseo's sidebar is a resizable column (200-600, default
        320) rather than a fixed rail — see panel-store/state.ts. Double-click
        returns to the default; arrows nudge for keyboard users. Hidden on mobile,
        where the sidebar is an overlay and has no column to resize.
      */}
      {isSidebarOpen && !isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          suppressHydrationWarning
          tabIndex={0}
          onMouseDown={startResize}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={onHandleKeyDown}
          title="Drag to resize · double-click to reset"
          className={cn(
            'absolute top-0 bottom-0 end-0 z-10 w-1 cursor-col-resize transition-colors',
            'hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none',
            isResizing && 'bg-accent/60',
          )}
        />
      )}
    </aside>
  );
}
