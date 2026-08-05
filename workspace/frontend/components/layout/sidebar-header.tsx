'use client';

import { Search, Plus, ChevronDown, PanelLeft } from 'lucide-react';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function SidebarHeader() {
  const { sidebarToggle, openNewThread } = useLayout();
  const { workspace } = useWorkspace();

  return (
    <div className="flex items-center justify-between shrink-0 px-4 py-3 border-b border-border/80 bg-surface-sidebar">
      {/* Left: Workspace / Host Selector with status dot */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left max-w-[200px] cursor-pointer outline-none group">
            <span className="size-2 rounded-full bg-status-success shrink-0 animate-pulse" title="Host Connected" />
            <span className="text-sm font-semibold tracking-tight truncate text-foreground">
              {workspace?.name || '52hzAgents'}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 bg-surface0 border-border">
          <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Workspaces</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled className="font-semibold text-foreground text-xs">
            {workspace?.name || 'Demo Workspace'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-muted-foreground text-[11px]" disabled>
            ID: {workspace?.slug || 'slug'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {/* New Thread */}
        <button
          onClick={openNewThread}
          className="size-7 rounded-lg hover:bg-surface-sidebar-hover text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="New Thread"
        >
          <Plus className="size-4" />
        </button>

        {/* Collapse Sidebar toggle */}
        <button
          onClick={sidebarToggle}
          className="size-7 rounded-lg hover:bg-surface-sidebar-hover text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="Collapse Sidebar"
        >
          <PanelLeft className="size-4" />
        </button>
      </div>
    </div>
  );
}
