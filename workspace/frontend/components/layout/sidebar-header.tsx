'use client';

import { LayoutGrid, PanelLeft, Home } from 'lucide-react';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';

export function SidebarHeader() {
  const { sidebarToggle } = useLayout();
  const { workspace } = useWorkspace();

  const handleBackToWorkspaces = () => {
    try {
      localStorage.removeItem('last_workspace_slug');
    } catch {}
    window.location.href = '/';
  };

  return (
    <div className="flex items-center justify-between shrink-0 px-3.5 py-3 border-b border-border/60 bg-surface-sidebar [app-region:drag] select-none">
      {/* Left: Brand logo with status dot */}
      <div className="flex items-center gap-2 [app-region:no-drag] min-w-0">
        <span className="size-2 rounded-full bg-status-success shrink-0" title="Workspace Connected" />
        <span className="text-sm font-semibold tracking-tight text-foreground font-sans truncate" title={workspace?.name || '52hzAgents'}>
          {workspace?.name || '52hzAgents'}
        </span>
      </div>

      {/* Right: Layout Action Icons + Back to Workspaces */}
      <div className="flex items-center gap-1.5 shrink-0 [app-region:no-drag]">
        <button
          onClick={handleBackToWorkspaces}
          className="h-7 px-2 rounded-lg bg-surface2 hover:bg-surface3 border border-border/60 text-foreground-muted hover:text-foreground flex items-center gap-1 text-[11px] font-semibold transition-colors cursor-pointer"
          title="Back to Workspaces Dashboard / Switch Workspace"
        >
          <Home className="size-3" />
          <span>Workspaces</span>
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
