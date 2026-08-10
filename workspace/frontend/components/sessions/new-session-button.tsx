'use client';

import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface NewSessionButtonProps {
  isCollapsed?: boolean;
  onNewSession: () => void;
}

export function NewSessionButton({ isCollapsed = false, onNewSession }: NewSessionButtonProps) {
  const buttonContent = (
    <Button
      onClick={onNewSession}
      // The primary button is a flat inverted fill: light ground, dark text in
      // dark mode and the reverse in light. It was a purple gradient, which is
      // the one thing this palette has no room for — a brand accent.
      className={cn(
        'h-10 bg-accent text-accent-foreground hover:bg-accent-bright shadow-xs text-sm transition-colors rounded-full px-4 mb-5.5',
        isCollapsed ? 'size-10 p-0 justify-center' : 'w-full justify-start gap-1.5 lg:gap-2'
      )}
      size="sm"
    >
      {!isCollapsed && <span className="font-semibold">New Session</span>}
      <Plus className={cn('size-3 lg:size-4', isCollapsed ? 'size-4' : 'ms-auto size-3')} />
    </Button>
  );

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex justify-center">{buttonContent}</div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>New Session</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return buttonContent;
}
