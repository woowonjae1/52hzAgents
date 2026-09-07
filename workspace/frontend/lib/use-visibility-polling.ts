'use client';

import { useEffect, useRef } from 'react';

export interface VisibilityPollingOptions {
  /** Whether the polling loop is active. Defaults to true. */
  enabled?: boolean;
  /** Whether to run the callback immediately upon mount. Defaults to true. */
  immediate?: boolean;
  /** Whether to run the callback immediately when the document returns to visible state. Defaults to true. */
  runOnVisible?: boolean;
}

/**
 * Returns whether the document is currently visible (not hidden and not minimized).
 */
export function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return !document.hidden;
}

/**
 * A visibility-aware polling hook that:
 * 1. Pauses completely when document.hidden is true (saving CPU, network, and battery).
 * 2. Catches up immediately when document becomes visible again.
 * 3. Guards against overlapping async executions (isExecutingRef).
 * 4. Cleans up timers and event listeners cleanly on unmount.
 */
export function useVisibilityPolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: VisibilityPollingOptions = {}
) {
  const { enabled = true, immediate = true, runOnVisible = true } = options;
  const savedCallback = useRef(callback);
  const isExecutingRef = useRef(false);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let isCancelled = false;

    const execute = async () => {
      if (isCancelled || isExecutingRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      isExecutingRef.current = true;
      try {
        await savedCallback.current();
      } catch {
        // Silently handled by caller
      } finally {
        isExecutingRef.current = false;
      }
    };

    const startTimer = () => {
      if (timer !== null) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      timer = setInterval(execute, intervalMs);
    };

    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopTimer();
      } else {
        if (runOnVisible) {
          void execute();
        }
        startTimer();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    if (immediate && (typeof document === 'undefined' || !document.hidden)) {
      void execute();
    }
    startTimer();

    return () => {
      isCancelled = true;
      stopTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [intervalMs, enabled, immediate, runOnVisible]);
}
