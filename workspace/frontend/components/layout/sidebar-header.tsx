'use client';

import { Hint } from '@/components/ui/hint';
import { PanelLeft, SquarePen } from 'lucide-react';
import { useLayout } from './layout-context';
import { SignalMark } from '@/components/brand/signal-mark';
import { useWorkspace } from '@/lib/workspace-context';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { toast } from '@/lib/toast';

export function SidebarHeader() {
  const { sidebarToggle, setViewMode } = useLayout();
  const { workspace, createSession, setCurrentSessionId } = useWorkspace();

  const handleNewSession = async () => {
    try {
      const s = await createSession();
      setCurrentSessionId(s.sessionId);
      setViewMode('threads');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create new session');
    }
  };

  return (
    <div
      className="app-header justify-between px-4"
      style={{
        paddingInlineStart: 'max(0.875rem, var(--traffic-lights-inset, 0px))',
      }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <Hint label="Collapse sidebar">
          <button
            onClick={sidebarToggle}
            aria-label="Collapse sidebar"
            data-no-drag
            className="size-7 -ml-1 shrink-0 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
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
        <Hint label="New session (Ctrl+N)">
          <button
            type="button"
            onClick={handleNewSession}
            aria-label="New session"
            data-no-drag
            className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
          >
            <SquarePen className="size-4" />
          </button>
        </Hint>
        <NotificationBell />
      </div>
    </div>
  );
}

