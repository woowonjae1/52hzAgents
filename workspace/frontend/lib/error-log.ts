'use client';

import { toast } from 'sonner';

/**
 * WHERE ERRORS GO AFTER THE TOAST.
 *
 * There are 89 `toast.error` calls in this app and the toaster holds each one
 * for three seconds. If you were looking at another window, switching tabs, or
 * simply reading something else on screen, the only report of a failure is
 * gone before you see it — and there is nowhere to go and look. "It didn't
 * work and I don't know why" is the single most common way a desktop app
 * loses a user's trust.
 *
 * So every error toast is also written to a ring buffer that a panel can read
 * back. The capture is a patch on `toast.error` rather than a new
 * `notifyError()` helper because the 89 call sites already exist and a helper
 * only catches the ones someone remembers to migrate.
 */

export interface LoggedError {
  id: string;
  message: string;
  detail?: string;
  at: number;
}

const MAX = 100;

let entries: LoggedError[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function recordError(message: string, detail?: string) {
  entries = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, message, detail, at: Date.now() },
    ...entries,
  ].slice(0, MAX);
  emit();
}

export function clearErrors() {
  entries = [];
  emit();
}

export function getErrors(): LoggedError[] {
  return entries;
}

export function subscribeErrors(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ------------------------------------------------------------------------ */

let patched = false;

/**
 * Route every `toast.error(...)` into the log as well as the toaster.
 *
 * Called once from the app shell. Idempotent, because React 18 mounts effects
 * twice in development and a double patch would record every error twice.
 */
export function installErrorCapture() {
  if (patched || typeof window === 'undefined') return;
  patched = true;

  const original = toast.error.bind(toast);
  // The signature is sonner's; we only read the first argument and pass the
  // rest through untouched, so a future sonner option keeps working.
  (toast as unknown as { error: typeof toast.error }).error = ((
    message: Parameters<typeof toast.error>[0],
    data?: Parameters<typeof toast.error>[1],
  ) => {
    const text =
      typeof message === 'string'
        ? message
        : typeof message === 'number'
          ? String(message)
          : 'Something went wrong';
    const detail =
      data && typeof data === 'object' && 'description' in data && typeof data.description === 'string'
        ? data.description
        : undefined;
    recordError(text, detail);
    return original(message, data);
  }) as typeof toast.error;

  // Failures that never reached a toast at all — a rejected promise nobody
  // caught, a render that threw. These are the ones users report as "it just
  // stopped working".
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    recordError(
      reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection'),
      reason instanceof Error ? reason.stack : undefined,
    );
  });
  window.addEventListener('error', (e) => {
    if (!e.message) return;
    recordError(e.message, e.filename ? `${e.filename}:${e.lineno}` : undefined);
  });
}
