'use client';

import { useCallback, useEffect, useRef } from 'react';
import { SidebarContent } from './sidebar-content';
import { SidebarHeader } from './sidebar-header';
import { useLayout } from './layout-context';
import {
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
    // The sidebar is pinned to the start edge, so clientX *is* the width.
    const onMove = (event: MouseEvent) => setSidebarWidth(event.clientX);
    const onUp = () => setIsResizing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Hold the resize cursor and kill text selection while the pointer travels
    // over arbitrary content in the main pane.
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = '';
    };
  }, [isResizing, setSidebarWidth]);

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

  return (
    <aside
      className={cn(
        'fixed overflow-hidden bg-surface-sidebar border-r border-border/40 top-0 bottom-0 start-0 z-20 flex flex-col shrink-0',
        // No width transition mid-drag, or the edge visibly lags the cursor.
        !isResizing && 'transition-all duration-300',
      )}
      style={{
        width: isSidebarOpen ? `${sidebarWidth}px` : '0px',
        borderRightWidth: isSidebarOpen ? '1px' : '0px',
      }}
    >
      <div className="flex flex-col h-full shrink-0" style={{ width: `${sidebarWidth}px` }}>
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
