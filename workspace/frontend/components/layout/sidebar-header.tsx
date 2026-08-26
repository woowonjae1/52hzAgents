'use client';

import { PanelLeft, Sparkles } from 'lucide-react';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';

export function SidebarHeader() {
  const { sidebarToggle } = useLayout();
  const { workspace } = useWorkspace();

  return (
    <div className="flex items-center justify-between shrink-0 px-4 pt-3.5 pb-2.5 bg-surface-sidebar [app-region:drag] select-none border-b border-border/40 dark:border-white/[0.04]">
      {/* Left: Brand logo with status dot */}
      <div className="flex items-center gap-2.5 [app-region:no-drag] min-w-0">
        <div className="size-6 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-xs shadow-blue-500/20 shrink-0">
          <Sparkles className="size-3.5" />
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-bold tracking-tight text-foreground font-sans truncate" title={workspace?.name || '52hzAgents'}>
            {workspace?.name || '52hzAgents'}
          </span>
          <span className="size-1.5 rounded-full bg-status-success shrink-0" title="Workspace connected" />
        </div>
      </div>

      {/* Right: Sidebar Collapse Toggle */}
      <div className="flex items-center gap-1.5 shrink-0 [app-region:no-drag]">
        <button
          onClick={sidebarToggle}
          className="size-7 rounded-lg hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="Collapse Sidebar"
        >
          <PanelLeft className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

