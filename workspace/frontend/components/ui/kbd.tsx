'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { formatKeyToken } from '@/lib/shortcuts';

/**
 * The one key cap.
 *
 * There were four of these — `KeyBadge` in the command palette, a bare
 * `<kbd className="rounded border border-border/60 bg-surface2 …">` in the
 * empty chat pane, another in the sidebar's New-chat row, a third in the diff
 * inspector footer — each with its own radius, its own border alpha and its
 * own idea of how wide a single-character cap should be. Keys are the one
 * piece of chrome a user compares ACROSS surfaces ("the palette said Ctrl+K,
 * does this say the same thing?"), so they have to be the same object.
 */
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded border border-border bg-surface2 font-mono text-3xs leading-none text-foreground-extra-muted select-none',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * A whole binding: one cap per token, with `then` rendered as a word rather
 * than a cap — `G then T` is two presses, not a chord, and drawing it as
 * `G` `then` `T` in three identical caps says the wrong thing.
 */
export function KeyCombo({
  keys,
  className,
  capClassName,
}: {
  keys: string[];
  className?: string;
  capClassName?: string;
}) {
  // `formatKeyToken` reads the platform off the DOM, so it can disagree
  // between server and client render. Resolve after mount and render the
  // portable spelling until then.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((token, i) =>
        token === 'then' ? (
          <span key={`${token}-${i}`} className="text-3xs text-foreground-extra-muted px-0.5">
            then
          </span>
        ) : (
          <Kbd key={`${token}-${i}`} className={capClassName}>
            {mounted ? formatKeyToken(token) : token === 'Mod' ? 'Ctrl' : token}
          </Kbd>
        ),
      )}
    </span>
  );
}
