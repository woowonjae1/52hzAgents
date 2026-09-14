'use client';

import * as React from 'react';

/**
 * A PANEL EDGE YOU CAN ACTUALLY DRAG.
 *
 * The app had three resizable edges and three separate implementations. The
 * sidebar's was a real splitter — `role="separator"`, arrow keys, Home/End,
 * double-click to reset. The Studio's and the Canvas's were bare `<div>`s with
 * an `onMouseDown` and a native `title=` tooltip: no keyboard, no reset, and
 * nothing telling assistive tech that the thing was a control at all.
 *
 * Both of those also had a bug you hit within seconds of trying them. They
 * tracked the drag with `window.addEventListener('mousemove')`, and the panel
 * they size contains an `<iframe>` (the browser view, the file preview) or a
 * `<webview>` (the local preview). A cross-document element swallows mouse
 * events: the moment the pointer crossed into it mid-drag the events stopped
 * arriving, and the edge froze under the cursor while the button was still
 * down. Dragging the Studio NARROWER — which moves the pointer into exactly
 * that region — was the broken direction.
 *
 * `setPointerCapture` is the fix and it is the whole reason this is pointer
 * events rather than mouse events. A captured pointer delivers every move to
 * the capturing element no matter what it is over, iframes included, and it
 * releases itself if the window loses focus. It also means pen and touch work,
 * which `mousedown` never did.
 */

export interface SplitterOptions {
  min: number;
  max: number | (() => number);
  /** Width restored by double-clicking the handle. */
  defaultWidth: number;
  /** localStorage key. Omit for a width that should not persist. */
  storageKey?: string;
  /**
   * Which edge the panel is pinned to. `end` panels (Studio, Canvas) grow as
   * the pointer moves left, so their width is measured from the window's right
   * edge; `start` panels measure from the left.
   */
  edge?: 'start' | 'end';
  /** Accessible name, e.g. "Resize Studio panel". */
  label: string;
}

function readStored(key: string | undefined, fallback: number, min: number, max: number): number {
  if (!key || typeof window === 'undefined') return fallback;
  try {
    const saved = window.localStorage.getItem(key);
    if (!saved) return fallback;
    const n = parseInt(saved, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  } catch {
    return fallback;
  }
}

export function useSplitter({
  min,
  max,
  defaultWidth,
  storageKey,
  edge = 'end',
  label,
}: SplitterOptions) {
  const resolveMax = React.useCallback(
    () => (typeof max === 'function' ? max() : max),
    [max],
  );

  const [width, setWidthState] = React.useState<number>(() =>
    readStored(storageKey, defaultWidth, min, typeof max === 'function' ? 4096 : max),
  );
  const [isResizing, setIsResizing] = React.useState(false);

  const widthRef = React.useRef(width);
  widthRef.current = width;

  const clamp = React.useCallback(
    (n: number) => Math.max(min, Math.min(resolveMax(), n)),
    [min, resolveMax],
  );

  const persist = React.useCallback(
    (n: number) => {
      if (!storageKey) return;
      try {
        window.localStorage.setItem(storageKey, String(n));
      } catch {}
    },
    [storageKey],
  );

  const setWidth = React.useCallback(
    (n: number) => {
      const next = clamp(n);
      setWidthState(next);
      persist(next);
    },
    [clamp, persist],
  );

  /** Pointer x → panel width, for whichever edge the panel is pinned to. */
  const widthFromPointer = React.useCallback(
    (clientX: number) => clamp(edge === 'end' ? window.innerWidth - clientX : clientX),
    [clamp, edge],
  );

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Secondary buttons open a context menu; they do not start a drag.
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsResizing(true);
    },
    [],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      setWidthState(widthFromPointer(e.clientX));
    },
    [widthFromPointer],
  );

  const endDrag = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setIsResizing(false);
      persist(widthRef.current);
    },
    [persist],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Shift is the coarse step, matching the sidebar's handle.
      const step = e.shiftKey ? 32 : 8;
      // An `end` panel grows when the edge moves LEFT, so the arrow that makes
      // it wider is the opposite of the one a `start` panel uses. Getting this
      // backwards is not a crash, just a control that feels inverted.
      const grow = edge === 'end' ? 'ArrowLeft' : 'ArrowRight';
      const shrink = edge === 'end' ? 'ArrowRight' : 'ArrowLeft';

      if (e.key === grow) {
        e.preventDefault();
        setWidth(widthRef.current + step);
      } else if (e.key === shrink) {
        e.preventDefault();
        setWidth(widthRef.current - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setWidth(min);
      } else if (e.key === 'End') {
        e.preventDefault();
        setWidth(resolveMax());
      } else if (e.key === 'Enter' || e.key === ' ') {
        // No drag to commit from the keyboard, so the activation key does what
        // double-click does.
        e.preventDefault();
        setWidth(defaultWidth);
      }
    },
    [edge, min, defaultWidth, resolveMax, setWidth],
  );

  /**
   * Spread onto the handle element. It must be the element that receives the
   * pointerdown — pointer capture is per-element, so moving these onto a child
   * silently loses the capture.
   */
  const separatorProps = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': label,
    'aria-valuenow': width,
    'aria-valuemin': min,
    'aria-valuemax': resolveMax(),
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    // A pointer that is cancelled (an OS gesture takes over, the window loses
    // the device) never sends pointerup, and without this the edge stays stuck
    // to the cursor with no button held.
    onPointerCancel: endDrag,
    onKeyDown,
    onDoubleClick: () => setWidth(defaultWidth),
    style: { touchAction: 'none' as const },
  };

  return { width, setWidth, isResizing, separatorProps };
}
