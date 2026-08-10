import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ScreenTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

/**
 * Canonical screen title for use inside a screen header. One typography, one
 * color, responsive weight. Leading icons are siblings, never nested inside.
 *
 * 1:1 with paseo/components/headers/screen-title.tsx: `fontSize.base` (16px) and
 * `fontWeight: { xs: "400", md: "300" }` — 400 on narrow screens, 300 from the md
 * breakpoint up. The 300 is declared inline there rather than in theme.ts's
 * FONT_WEIGHT scale, so reading that scale alone makes it look like 300 is not
 * part of the design language. It is.
 */
export function ScreenTitle({ children, className, ...props }: ScreenTitleProps) {
  return (
    <h1
      className={cn(
        'text-base font-semibold text-foreground truncate min-w-0 shrink',
        className
      )}
      {...props}
    >
      {children}
    </h1>
  );
}
