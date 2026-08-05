import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ScreenTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

/**
 * Canonical screen title for use inside ScreenHeader.
 * Uses font-light / font-weight 300 on desktop to give a calm, spacious aesthetic.
 */
export function ScreenTitle({ children, className, ...props }: ScreenTitleProps) {
  return (
    <h1
      className={cn(
        'text-base font-normal lg:font-light tracking-tight text-foreground truncate min-w-0 shrink',
        className
      )}
      {...props}
    >
      {children}
    </h1>
  );
}
