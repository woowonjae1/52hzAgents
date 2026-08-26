'use client';

import { useEffect, useState } from 'react';

/**
 * A live "how long has this been running" clock.
 *
 * Replaces the three bouncing dots. The dots said "still going", which the
 * reader already knew from the fact that no answer had arrived; a number says
 * how long, which is the thing they are actually trying to decide about (wait,
 * or stop it).
 *
 * THE ELAPSED TIME IS DERIVED FROM `startTime`, NOT COUNTED UP FROM MOUNT.
 * The obvious implementation — `useState(0)` plus `setInterval(d => d + 1)` —
 * is wrong here for two reasons, and both of them look fine in a demo:
 *
 * 1. The transcript is virtualised (`@tanstack/react-virtual`) and re-renders on
 *    every poll, so a row can unmount and remount mid-run. A counter that
 *    starts at mount silently resets to 0.0s and the user watches the clock go
 *    backwards.
 * 2. `setInterval` accumulates drift. Over a two-minute tool call a 100ms
 *    interval loses seconds. Recomputing from a timestamp cannot drift.
 *
 * ONE TICKER FOR THE WHOLE APP. Several events run at once in a multi-agent
 * channel, and one 100ms interval per event means N timers all waking the main
 * thread on their own phase. Subscribers share a single interval, which also
 * makes "stop while the window is hidden" a single decision instead of N.
 */

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

function tick() {
  for (const notify of subscribers) notify();
}

function startTicker() {
  if (timer !== null) return;
  // A hidden tab paints nothing, so the work is pure waste — and browsers clamp
  // background timers anyway, which would make the readout wrong rather than
  // merely late. It is recomputed from `startTime` on the next tick, so nothing
  // needs catching up when the window comes back.
  if (typeof document !== 'undefined' && document.hidden) return;
  timer = setInterval(tick, 100);
}

function stopTicker() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTicker();
    } else if (subscribers.size > 0) {
      tick();
      startTicker();
    }
  });
}

/**
 * `4.2s` under a minute, `1m 07s` over it.
 *
 * Tenths below a minute because that is the range where the difference between
 * 0.4s and 0.9s is worth seeing; whole seconds above it because a tenths digit
 * two minutes in is just a flickering pixel. The seconds are zero-padded so the
 * string keeps its width — paired with `tabular-nums` the number updates in
 * place instead of shoving whatever sits next to it sideways.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * @param startTime epoch ms the event began, or nullish if it is not known yet
 * @param running   subscribe to the ticker. When false the value is computed
 *                  once and left alone — a settled event keeps showing the
 *                  duration it took without holding the interval open.
 */
export function useElapsedFrom(startTime?: number | null, running = true): string | null {
  // Starts null rather than computing during render: this app builds with
  // `output: 'export'`, so a render-time `Date.now()` would be baked into the
  // prerendered HTML and then disagree with the client on hydration.
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!startTime) {
      setText(null);
      return;
    }
    const update = () => setText(formatElapsed(Date.now() - startTime));
    update();
    if (!running) return;

    subscribers.add(update);
    bindVisibility();
    startTicker();
    return () => {
      subscribers.delete(update);
      if (subscribers.size === 0) stopTicker();
    };
  }, [startTime, running]);

  return text;
}
