'use client';

import * as React from 'react';
import { CheckCircle2, AlertCircle, Info, Loader2, Bell } from 'lucide-react';
import {
  AnimatedToastStack,
  useAnimatedToastStack,
} from '@/components/motion/animated-toast-stack';
import { subscribeToasts, type ToastEvent } from '@/lib/toast';

/*
  THE ONE SUBSCRIBER.

  `lib/toast` owns the queue because most call sites have no hook to call;
  this component owns the *timers* and the rendering, by handing every event
  it receives to `useAnimatedToastStack`. Keep exactly one of these mounted —
  a second instance would subscribe a second listener and every toast would
  appear twice.
*/
export function AnimatedToaster() {
  /*
    Lifecycle callbacks cannot ride along inside the toast object — the stack
    would render them — so they are parked here by id and fired when that id
    leaves the queue, whichever way it left.
  */
  const exitCallbacks = React.useRef(new Map<string, () => void>());
  const liveIds = React.useRef(new Set<string>());

  const { toasts, showToast, dismissToast, clearToasts } = useAnimatedToastStack({
    /*
      3s was sonner's `duration` here and is kept: long enough to read one
      line, short enough that a burst of saves does not stack into a wall.
      An explicit `duration: 0` from the caller still pins a toast.
    */
    defaultDuration: 3000,
  });

  React.useEffect(() => {
    return subscribeToasts((event: ToastEvent) => {
      if (event.type === 'clear') {
        clearToasts();
        return;
      }
      if (event.type === 'dismiss') {
        if (event.id) dismissToast(event.id);
        return;
      }

      const { options } = event;
      showToast({
        id: event.id,
        title: event.title,
        description: options?.description,
        status: event.status,
        duration: options?.duration,
        dismissible: options?.dismissible,
        icon: options?.icon,
        action: options?.action
          ? { label: options.action.label, onClick: () => options.action!.onClick() }
          : undefined,
      });

      const onExit = options?.onDismiss ?? options?.onAutoClose;
      if (event.id && onExit) {
        const fired = { done: false };
        exitCallbacks.current.set(event.id, () => {
          if (fired.done) return;
          fired.done = true;
          onExit();
          options?.onAutoClose && options.onAutoClose !== onExit && options.onAutoClose();
        });
      }
    });
  }, [showToast, dismissToast, clearToasts]);

  /*
    The hook's own timer removes a toast without routing through `onDismiss`,
    so "did this toast go away" is answered by diffing the rendered queue
    rather than by any one callback.
  */
  React.useEffect(() => {
    const current = new Set(toasts.map((t) => t.id));
    liveIds.current.forEach((id) => {
      if (current.has(id)) return;
      const callback = exitCallbacks.current.get(id);
      exitCallbacks.current.delete(id);
      callback?.();
    });
    liveIds.current = current;
  }, [toasts]);

  return (
    <AnimatedToastStack
      toasts={toasts}
      onDismiss={dismissToast}
      /*
        BOTTOM-RIGHT, NOT TOP-CENTRE — carried over from the sonner setup it
        replaces. A banner over the middle of the top edge is a web pattern; a
        desktop window collects transient status in the corner furthest from
        the work, and top-centre here landed under the titlebar and over the
        thread header.
      */
      position="bottom-right"
      placement="fixed"
      maxVisible={3}
      icons={{
        /*
          Status TOKENS, not palette shades — `--status-*` carries a per-theme
          value, where `emerald-400` and friends sit near 1.9:1 on the light
          toast ground. `info` and `neutral` stay uncoloured: a fact does not
          change what the reader should do next, so it does not get to spend a
          coloured disc saying what the sentence beside it already says.
        */
        success: <CheckCircle2 className="size-4 text-status-success shrink-0 stroke-[2.2]" />,
        error: <AlertCircle className="size-4 text-status-danger shrink-0 stroke-[2.2]" />,
        info: <Info className="size-4 text-foreground-muted shrink-0 stroke-[2.2]" />,
        loading: <Loader2 className="size-4 text-foreground-muted shrink-0 animate-spin" />,
        neutral: <Bell className="size-4 text-foreground-muted shrink-0 stroke-[2.2]" />,
      }}
      classNames={{
        surface:
          'bg-surface-overlay/95 text-foreground border-border shadow-xl backdrop-blur-xl rounded-2xl',
        title: 'text-[14px] font-medium leading-snug text-foreground tracking-normal',
        description: 'text-xs leading-normal text-muted-foreground',
        action:
          'rounded-full bg-primary text-primary-foreground text-xs px-3.5 py-1.5 font-medium shadow-sm hover:opacity-90',
      }}
    />
  );
}
