'use client';

import { LayoutGrid, PanelLeft, Plus } from 'lucide-react';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';

export function SidebarHeader() {
  const { sidebarToggle, openNewThread } = useLayout();
  const { workspace } = useWorkspace();

  return (
    <div className="flex items-center justify-between shrink-0 px-3.5 py-3 border-b border-border/60 bg-surface-sidebar [app-region:drag] select-none">
      {/* Left: Brand logo with status dot */}
      <div className="flex items-center gap-2 [app-region:no-drag]">
        <span className="size-2 rounded-full bg-status-success shrink-0" title="Workspace Connected" />
        <span className="text-sm font-semibold tracking-tight text-foreground font-sans">
          {workspace?.name || '52hzAgents'}
        </span>
      </div>

      {/* Right: Layout Action Icons matching mockup */}
      <div className="flex items-center gap-1 shrink-0 [app-region:no-drag]">
        <button
          onClick={sidebarToggle}
          className="size-7 rounded-lg hover:bg-surface3/80 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="Toggle Grid / Split View"
        >
          <LayoutGrid className="size-3.5" />
        </button>
        <button
          onClick={sidebarToggle}
          className="size-7 rounded-lg hover:bg-surface3/80 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          title="Collapse Sidebar"
        >
          <PanelLeft className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
