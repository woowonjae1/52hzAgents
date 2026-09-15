'use client';

import * as React from 'react';

/**
 * A LIST REMEMBERS WHERE YOU WERE.
 *
 * Switch from Files to Tasks and back and the file list was at the top again.
 * So was the inbox, the knowledge list, the task list — every scrollable view
 * in the app, because they unmount when the view changes and nothing recorded
 * their position. The whole app contained zero uses of `sessionStorage`.
 *
 * Desktop applications restore this without being asked; it is the difference
 * between switching panes and starting over. Scrolling back down a long list
 * to find your place is the kind of small repeated cost that makes an
 * interface feel like a website you navigated away from.
 *
 * sessionStorage, not localStorage, on purpose: a scroll position is worth
 * keeping for as long as the window is open and no longer. Restoring yesterday
 * to the middle of a list whose contents have all changed is worse than the
 * top.
 */
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export function useScrollRestore<T extends HTMLElement>(
  key: string,
  /** Wait for this to be true before restoring — pass `!loading`. */
  ready = true,
) {
  const ref = React.useRef<T | null>(null);
  const storageKey = `scroll:${key}`;
  const restored = React.useRef(false);

  // Restore once the rows exist. Restoring into an empty container just sets
  // scrollTop to 0, so a list that is still loading must not be restored yet.
  useIsomorphicLayoutEffect(() => {
    if (!ready || restored.current) return;
    const el = ref.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) {
        const n = parseInt(saved, 10);
        // Clamp: the list may be shorter than it was, and an out-of-range
        // scrollTop silently becomes 0, which looks like the restore failed.
        if (Number.isFinite(n)) el.scrollTop = Math.min(n, el.scrollHeight - el.clientHeight);
      }
    } catch {}
    restored.current = true;
  }, [ready, storageKey]);

  // Record on unmount and as the user scrolls. The scroll handler is passive
  // and writes to a ref; only the unmount and a debounce reach storage, so a
  // fling does not run a synchronous write per frame.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let latest = el.scrollTop;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const persist = () => {
      try {
        window.sessionStorage.setItem(storageKey, String(latest));
      } catch {}
    };

    const onScroll = () => {
      latest = el.scrollTop;
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 200);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      persist();
    };
  }, [storageKey]);

  return ref;
}
