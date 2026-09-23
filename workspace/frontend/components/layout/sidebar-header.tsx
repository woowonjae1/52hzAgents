'use client';

import { Hint } from '@/components/ui/hint';
import { PanelLeft } from 'lucide-react';
import { useLayout } from './layout-context';
import { SignalMark } from '@/components/brand/signal-mark';
import { useWorkspace } from '@/lib/workspace-context';
import { NotificationBell } from '@/components/notifications/notification-bell';

export function SidebarHeader() {
  const { sidebarToggle } = useLayout();
  const { workspace } = useWorkspace();

  return (
    <div
      className="app-header justify-between px-4"
      style={{
        // 0.875rem, the chat header's own inline padding — so the toggle below
        // lands on the same x as the expand button that replaces it.
        paddingInlineStart: 'max(0.875rem, var(--traffic-lights-inset, 0px))',
      }}
    >
      {/*
        THE TOGGLE NO LONGER JUMPS.

        Collapse lived at the RIGHT edge of this header, ~280px in. Collapsing
        the sidebar removed it, and the button that brings the sidebar back
        appeared at the LEFT edge of the chat header instead — so the control
        was never where your pointer had just been, and "close" and "open" were
        two different buttons in two different places.

        It now opens the row, at the same x, size and icon size as the expand
        button in the chat header. Toggling changes the state, not the target.
      */}
      <div className="flex items-center gap-2.5 min-w-0">
        <Hint label="Collapse sidebar">
          <button
            onClick={sidebarToggle}
            aria-label="Collapse sidebar"
            className="size-7 -ml-1 shrink-0 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors"
          >
            <PanelLeft className="size-4" />
          </button>
        </Hint>
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

      <div className="flex items-center gap-1 shrink-0">
        <NotificationBell />
      </div>
    </div>
  );
}

