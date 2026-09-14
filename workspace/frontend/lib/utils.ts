import type * as React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Point several refs at one element.
 *
 * Needed where two hooks both want the same node — a list's scroll container
 * is both the keyboard-navigation root (`useListKeyboardNav`) and the thing
 * whose scroll position is restored (`useScrollRestore`). Spreading one hook's
 * props and then writing `ref=` yourself silently drops whichever came first.
 */
export function mergeRefs<T>(
  ...refs: Array<React.Ref<T> | undefined | null>
): React.RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}
