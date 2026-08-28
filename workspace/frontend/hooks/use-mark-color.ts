'use client';

import * as React from 'react';
import {
  DEFAULT_MARK_COLOR,
  readStoredMarkColor,
  storeMarkColor,
  subscribeMarkColor,
} from '@/lib/mark-color-store';

/**
 * Reads and writes the SignalMark body colour.
 *
 * Starts at the default rather than at the stored value so the first client
 * render matches the server HTML — the real value lands in the effect. The mark
 * itself never waits on this: the pre-paint script in app/layout.tsx has already
 * set the CSS variable, so only this hook's own consumers (the swatch grid) see
 * one frame of the default.
 */
export function useMarkColor(): [string, (color: string) => void] {
  const [color, setColor] = React.useState(DEFAULT_MARK_COLOR);

  React.useEffect(() => {
    setColor(readStoredMarkColor());
    return subscribeMarkColor(setColor);
  }, []);

  const set = React.useCallback((next: string) => {
    storeMarkColor(next);
  }, []);

  return [color, set];
}
