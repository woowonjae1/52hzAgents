/*
  THE TOAST FACADE.

  Notifications are drawn by `components/motion/animated-toast-stack`, whose
  state lives in a React hook — but 50-odd call sites fire toasts from event
  handlers, `catch` blocks and plain modules that have no hook to call. So the
  hook does not get to own the queue: this module does, as a tiny synchronous
  event bus, and `<AnimatedToaster />` is the one subscriber that feeds it into
  the hook.

  The surface is deliberately sonner's, method for method, so the call sites
  read the same after the swap as before it.
*/

import type { ReactNode } from 'react';

export type ToastKind = 'neutral' | 'info' | 'loading' | 'success' | 'error';

export interface ToastOptions {
  id?: string;
  description?: ReactNode;
  /*
    Milliseconds. The stack pins anything <= 0 and never starts a timer for
    it; `Infinity` must NOT be passed through, because `setTimeout` coerces it
    to 0 and the toast would vanish on the next tick. `normalizeDuration`
    folds both spellings of "stay up" into 0.
  */
  duration?: number;
  dismissible?: boolean;
  icon?: ReactNode;
  action?: { label: ReactNode; onClick: () => void };
  /*
    Sonner split "the reader closed it" from "it timed out"; the stack that
    replaces it does not, because its auto-dismiss and its close button both
    end at the same `dismissToast`. Both spellings are kept so the call sites
    read unchanged, and both fire exactly once, when the toast leaves the
    queue. Anything relying on the DIFFERENCE between them would be wrong
    here — the one caller that uses them (`lib/undoable`) commits either way.
  */
  onDismiss?: () => void;
  onAutoClose?: () => void;
}

export interface ToastEvent {
  type: 'show' | 'dismiss' | 'clear';
  id?: string;
  title?: ReactNode;
  status?: ToastKind;
  options?: ToastOptions;
}

type Listener = (event: ToastEvent) => void;

const listeners = new Set<Listener>();

/*
  Toasts fired before the subscriber mounts (a failed bootstrap request, an
  auth error on first paint) would otherwise vanish. They queue here and drain
  on subscribe. Only the queue is bounded — an unmounted app that keeps
  erroring should not grow this forever.
*/
const pending: ToastEvent[] = [];
const MAX_PENDING = 8;

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  if (pending.length > 0) {
    const drain = pending.splice(0, pending.length);
    drain.forEach((event) => listener(event));
  }
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: ToastEvent) {
  if (listeners.size === 0) {
    pending.push(event);
    if (pending.length > MAX_PENDING) pending.shift();
    return;
  }
  listeners.forEach((listener) => listener(event));
}

let seq = 0;
function nextId() {
  seq += 1;
  return `toast-${Date.now().toString(36)}-${seq}`;
}

export function normalizeDuration(duration: number | undefined): number | undefined {
  if (duration === undefined) return undefined;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration;
}

function show(status: ToastKind, title: ReactNode, options?: ToastOptions) {
  const id = options?.id ?? nextId();
  emit({
    type: 'show',
    id,
    title,
    status,
    options: options ? { ...options, duration: normalizeDuration(options.duration) } : undefined,
  });
  return id;
}

export const toast = {
  success: (title: ReactNode, options?: ToastOptions) => show('success', title, options),
  error: (title: ReactNode, options?: ToastOptions) => show('error', title, options),
  info: (title: ReactNode, options?: ToastOptions) => show('info', title, options),
  /* A loading toast has no natural end, so it never self-dismisses. */
  loading: (title: ReactNode, options?: ToastOptions) =>
    show('loading', title, { duration: 0, ...options }),
  message: (title: ReactNode, options?: ToastOptions) => show('neutral', title, options),
  dismiss: (id?: string) => emit(id ? { type: 'dismiss', id } : { type: 'clear' }),
};

export type Toast = typeof toast;
