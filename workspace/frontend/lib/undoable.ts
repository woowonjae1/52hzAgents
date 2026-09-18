'use client';

import { toast } from '@/lib/toast';

/**
 * DELETE, WITH A WAY BACK.
 *
 * Every destructive path in this app was a confirm dialog followed by a toast
 * that said "deleted" and nothing else — 89 error toasts in the codebase and
 * not one of them offered an action. A confirmation dialog is not undo: it
 * costs the user a click on every single delete, including the 99% they meant,
 * and it still cannot save the one they did not.
 *
 * Desktop applications solve this the other way round: the action happens
 * immediately, the row disappears, and there is a few-second window in which
 * it can come back. That is what this is.
 *
 * HOW IT WORKS. The row is hidden locally (`onOptimistic`), a toast with an
 * Undo button goes up, and the real API call does not happen until the toast
 * expires. Clicking Undo cancels the timer and unhides the row — no server
 * round trip at all, so undo cannot itself fail.
 *
 * `pagehide` commits everything still pending. Without it, closing the window
 * inside the undo window would silently drop the delete, and the row would be
 * back on next launch with no explanation.
 */

interface PendingCommit {
  commit: () => void;
}

const pending = new Set<PendingCommit>();

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    // Copy first: `commit` removes itself from the set as it runs.
    for (const p of Array.from(pending)) p.commit();
  });
}

export interface UndoableOptions {
  /** Past tense, as the toast reads it: "Deleted report.pdf". */
  message: string;
  /** Hide the thing now. Runs synchronously, before the toast. */
  onOptimistic: () => void;
  /** Put it back. Must be the exact inverse of `onOptimistic`. */
  onRevert: () => void;
  /** The real, irreversible call. Runs when the window closes. */
  onCommit: () => Promise<unknown>;
  /** How long the way back stays open. */
  durationMs?: number;
  /** Shown if `onCommit` rejects, after the row has been put back. */
  errorMessage?: string;
}

/**
 * Run a destructive action with an undo window. Returns a function that
 * commits it early, for callers that need to (e.g. before navigating away).
 */
export function runUndoable({
  message,
  onOptimistic,
  onRevert,
  onCommit,
  durationMs = 6000,
  errorMessage,
}: UndoableOptions): () => void {
  onOptimistic();

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const entry: PendingCommit = { commit: () => void commit() };

  const commit = async () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    pending.delete(entry);
    try {
      await onCommit();
    } catch (e) {
      // The server refused. Put it back rather than leaving the UI showing a
      // deletion that did not happen — the one outcome worse than either.
      onRevert();
      toast.error(
        errorMessage || (e instanceof Error ? e.message : 'Could not complete that'),
      );
    }
  };

  const undo = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    pending.delete(entry);
    onRevert();
  };

  pending.add(entry);
  timer = setTimeout(commit, durationMs);

  toast.success(message, {
    duration: durationMs,
    action: { label: 'Undo', onClick: undo },
    /* Dismissing the toast by hand is consent, not a cancel — the same as
       every mail client. `onAutoClose` and `onDismiss` both end the window. */
    onDismiss: () => void commit(),
    onAutoClose: () => void commit(),
  });

  return () => void commit();
}
