'use client';

import * as React from 'react';
import { Hint } from '@/components/ui/hint';
import { PanelLeft } from 'lucide-react';
import { useLayout } from './layout-context';
import { cn } from '@/lib/utils';

interface SidebarExpandButtonProps {
  className?: string;
}

/**
 * Universal toggle button to expand the left sidebar when collapsed.
 * Appears at the inline-start of view headers so the user can always restore the sidebar
 * with one click or via keyboard shortcut (Mod+B).
 */
export function SidebarExpandButton({ className }: SidebarExpandButtonProps) {
  const { isSidebarOpen, sidebarToggle } = useLayout();

  if (isSidebarOpen) return null;

  return (
    <Hint label="Expand sidebar (Ctrl+B)">
      <button
        type="button"
        onClick={sidebarToggle}
        aria-label="Expand sidebar"
        data-no-drag
        className={cn(
          'size-7 flex items-center justify-center rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer',
          className
        )}
      >
        <PanelLeft className="size-4" />
      </button>
    </Hint>
  );
}
