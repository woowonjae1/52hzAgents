import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ScreenMarkProps {
  /** A lucide icon component — the screen's glyph. */
  icon: React.ComponentType<{ className?: string }>;
  className?: string;
}

/**
 * The glyph tile that sits left of a `ScreenTitle`.
 *
 * Deliberately colourless. Screen marks used to pick a colour each — Skill Hub
 * amber, Scheduled tasks violet, the share card green — and those colours came
 * out of the *status* palette, where amber means "warning" and violet means
 * "merged" everywhere else in the app. Decorating a header with them spends
 * the status vocabulary on nothing, and a wall of differently-tinted glyphs is
 * the look of a generated app, not a workspace. One surface tile, one muted
 * foreground: the icon says which screen you are on, colour stays reserved for
 * things that changed.
 */
export function ScreenMark({ icon: Icon, className }: ScreenMarkProps) {
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface2 text-foreground-muted',
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}
