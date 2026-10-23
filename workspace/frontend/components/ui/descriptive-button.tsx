'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DescriptiveButtonProps extends React.ComponentProps<typeof Button> {
  orientation?: 'horizontal' | 'vertical';
}

export function DescriptiveButton({
  children,
  className,
  orientation = 'horizontal',
  ...props
}: DescriptiveButtonProps) {
  return (
    <Button
      variant="ghost"
      className={cn(
        'group/button border border-border/70 hover:border-border-accent/60 bg-surface1/60 hover:bg-surface2/80 flex h-auto w-full min-w-0 max-w-full shrink items-start justify-start gap-3 p-3.5 text-left whitespace-normal rounded-xl transition-all active:scale-[0.99] cursor-pointer shadow-xs',
        orientation === 'vertical' && 'flex-col',
        className,
      )}
      data-orientation={orientation}
      {...props}
    >
      {children}
    </Button>
  );
}

export function DescriptiveButtonTitle({ children, className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span className={cn('truncate font-semibold text-xs text-foreground', className)} {...props}>
      {children}
    </span>
  );
}

export function DescriptiveButtonDescription({ children, className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span className={cn('text-muted-foreground block min-w-0 text-2xs font-normal leading-relaxed', className)} {...props}>
      {children}
    </span>
  );
}

export function DescriptiveButtonContent({ children, className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', className)} {...props}>
      {children}
    </div>
  );
}
