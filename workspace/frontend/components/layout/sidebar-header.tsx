'use client';

import { Hint } from '@/components/ui/hint';
import { PanelLeft } from 'lucide-react';
import { useLayout } from './layout-context';
import { SignalMark } from '@/components/brand/signal-mark';
import { useWorkspace } from '@/lib/workspace-context';
export function SidebarHeader() {
  const { sidebarToggle } = useLayout();
  const { workspace } = useWorkspace();

  return (
    <div
      className="app-header justify-between px-4"
      style={{
        paddingInlineStart: 'max(1rem, var(--traffic-lights-inset, 0px))',
      }}
    >
      {/* Left: Brand logo with status dot */}
      <div className="flex items-center gap-3 min-w-0">
        <SignalMark size={22} className="shrink-0" title="52hzAgents" />
        <div className="flex items-center gap-1.5 min-w-0">
          <Hint label={workspace?.name || '52hzAgents'}>
            <span className="text-sm font-bold tracking-tight text-foreground font-sans truncate">
              {workspace?.name || '52hzAgents'}
            </span>
          </Hint>
          <Hint label="Workspace connected">
            <span className="size-2 rounded-full bg-status-success shrink-0" />
          </Hint>
        </div>
      </div>

      {/* Right: Sidebar Collapse Toggle */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Hint label="Collapse Sidebar">
          <button
            onClick={sidebarToggle}
            className="size-7 rounded-lg hover:bg-surface2 text-foreground-extra-muted hover:text-foreground flex items-center justify-center transition-colors"
          >
            <PanelLeft className="size-3.5" />
          </button>
        </Hint>
      </div>
    </div>
  );
}

