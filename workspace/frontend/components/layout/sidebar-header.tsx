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
    <div className="flex items-center justify-between shrink-0 px-4 py-3.5 border-b border-zinc-200/40 dark:border-zinc-800/40">
      {/* Left: Workspace Selector dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors text-left max-w-[150px] cursor-pointer outline-none">
            <img 
              src="/logo-icon.png" 
              className="size-4.5 object-contain shrink-0 rounded-sm" 
              alt="Workspace logo" 
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            <span className="text-xs font-bold truncate text-zinc-800 dark:text-zinc-200">
              {workspace?.name || '52hzAgents'}
            </span>
            <ChevronDown className="size-3.5 text-zinc-400 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled className="font-semibold text-zinc-700 dark:text-zinc-300">
            {workspace?.name || 'Demo Workspace'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-zinc-400 text-xs" disabled>
            ID: {workspace?.slug || 'slug'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Right: Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* New Thread */}
        <button
          onClick={openNewThread}
          className="size-7 rounded-lg hover:bg-zinc-150 dark:hover:bg-zinc-900 text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 flex items-center justify-center transition-colors cursor-pointer"
          title="New Thread"
        >
          <Plus className="size-4" />
        </button>

        {/* Collapse Sidebar toggle */}
        <button
          onClick={sidebarToggle}
          className="size-7 rounded-lg hover:bg-zinc-150 dark:hover:bg-zinc-900 text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 flex items-center justify-center transition-colors cursor-pointer"
          title="Collapse Sidebar"
        >
          <PanelLeft className="size-4" />
        </button>
      </div>
    </div>
  );
}
