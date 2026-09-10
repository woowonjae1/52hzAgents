'use client';

import { Hint } from '@/components/ui/hint';
import { PanelLeft } from 'lucide-react';
import { useLayout } from './layout-context';
import { SignalMark } from '@/components/brand/signal-mark';
import { useWorkspace } from '@/lib/workspace-context';
import { useIsDesktop } from '@/lib/desktop';

export function SidebarHeader() {
  const { sidebarToggle } = useLayout();
  const { workspace } = useWorkspace();
  const isDesktop = useIsDesktop();

  /*
    In the Electron shell the brand mark, the workspace name and the sidebar
    toggle all live in AppTitlebar — see the note there. Rendering them here too
    gave the desktop window three stacked bands before any content. In the
    browser there is no titlebar, so this is where they belong.
  */
  if (isDesktop) return null;

  return (
    <div className="app-header justify-between px-4">
      {/* Left: Brand logo with status dot */}
      <div className="flex items-center gap-3 min-w-0">
        <SignalMark size={22} className="shrink-0" title="52hzAgents" />
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-bold tracking-tight text-foreground font-sans truncate" title={workspace?.name || '52hzAgents'}>
            {workspace?.name || '52hzAgents'}
          </span>
          <span className="size-2 rounded-full bg-status-success shrink-0" title="Workspace connected" />
        </div>
      </div>

      {/* Right: Sidebar Collapse Toggle */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Hint label="Collapse Sidebar">
          <button
            onClick={sidebarToggle}
            className="size-7 rounded-lg hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          >
            <PanelLeft className="size-3.5" />
          </button>
        </Hint>
      </div>
    </div>
  );
}

