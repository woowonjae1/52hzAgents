'use client';

import { Hint } from '@/components/ui/hint';
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, RefreshCw, Trash2, Plus, ArrowLeft, History } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { CreateRoutineDialog } from './create-routine-dialog';
import { RoutineHistoryDrawer } from './routine-history-drawer';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RoutineItem } from '@/lib/types';
import { stripAddressPrefix } from '@/lib/types';
import { formatSchedule, timeUntil } from '@/lib/schedule-format';

export function RoutineList() {
  const { routines, refreshRoutines, createRoutine, currentSessionId, setCurrentSessionId, agents } = useWorkspace();
  const { isMobile, openMobileDetail, setViewMode } = useLayout();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [historyRoutine, setHistoryRoutine] = useState<RoutineItem | null>(null);
  const [deletingRoutine, setDeletingRoutine] = useState<RoutineItem | null>(null);

  useEffect(() => {
    refreshRoutines();
  }, [refreshRoutines]);

  const activeRoutines = useMemo(
    () => routines.filter((r) => r.status === 'active'),
    [routines],
  );

  // Auto-select the first routine when entering the routines view
  useEffect(() => {
    if (activeRoutines.length > 0 && (!currentSessionId || !currentSessionId.startsWith('routine')) && typeof activeRoutines[0].channelName === 'string') {
      setCurrentSessionId(activeRoutines[0].channelName);
    }
  }, [activeRoutines, currentSessionId, setCurrentSessionId]);

  const handleSelect = (channelName: string) => {
    setCurrentSessionId(channelName);
    if (isMobile) openMobileDetail();
  };

  const handleCancel = async (routineId: string) => {
    try {
      await workspaceApi.cancelRoutine(routineId);
      await refreshRoutines();
    } catch {
      // Ignore
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with Back Navigation */}
      <div className="shrink-0 px-3 py-2.5 border-b border-border flex items-center justify-between bg-surface1/40">
        <div className="flex items-center gap-2">
          <Hint label="Back to chats">
            <button
              type="button"
              onClick={() => setViewMode('threads')}
              className="p-1 -ml-1 rounded-md hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
            >
              <ArrowLeft className="size-3.5" />
              <span className="text-xs font-medium">Back</span>
            </button>
          </Hint>
          <div className="h-3.5 w-px bg-border/60" />
          <CalendarClock className="size-3.5 text-status-merged" />
          <ScreenTitle>Scheduled tasks</ScreenTitle>
          {activeRoutines.length > 0 && (
            <span className="text-xs text-muted-foreground font-mono">({activeRoutines.length})</span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Hint label="Create a scheduled task">
            <button
              type="button"
              onClick={() => setShowCreateDialog(true)}
              className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground transition-colors cursor-pointer"
            >
              <Plus className="size-3.5" />
            </button>
          </Hint>
          <Hint label="Refresh">
            <button
              type="button"
              onClick={refreshRoutines}
              className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground transition-colors cursor-pointer"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </Hint>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {activeRoutines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <CalendarClock className="size-8 opacity-30" />
            <p className="text-sm">No routines yet</p>
            <p className="text-xs opacity-60">Click + to create one</p>
          </div>
        ) : (
          <div className="py-1">
            {activeRoutines.map((routine) => {
              const agentName = stripAddressPrefix(routine.createdBy) || 'agent';
              const isSelected = currentSessionId === routine.channelName;

              return (
                <button
                  key={routine.id}
                  className={cn(
                    'group w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors border-b border-border/60',
                    isSelected
                      ? 'bg-surface2'
                      : 'hover:bg-surface1'
                  )}
                  onClick={() => handleSelect(routine.channelName)}
                >
                  <AgentAvatar name={agentName} size={20} className="mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{routine.name}</div>
                    <div className="text-2xs text-muted-foreground mt-0.5">{formatSchedule(routine)}</div>
                    <div className="text-2xs text-muted-foreground truncate mt-0.5">{routine.message}</div>
                    <div className="text-3xs text-muted-foreground/60 mt-1">
                      next: {routine.nextFiresAt ? timeUntil(routine.nextFiresAt) : 'N/A'}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    <Hint label="Run history">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setHistoryRoutine(routine); }}
                        className="p-1 rounded hover:bg-surface3 text-muted-foreground hover:text-status-merged transition-colors"
                      >
                        <History className="size-3.5" />
                      </button>
                    </Hint>
                    <Hint label="Delete schedule">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDeletingRoutine(routine); }}
                        className="p-1 rounded hover:bg-surface3 text-muted-foreground hover:text-status-danger transition-colors"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </Hint>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <CreateRoutineDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        agents={agents}
        onCreateRoutine={createRoutine}
      />

      <RoutineHistoryDrawer
        routine={historyRoutine}
        open={Boolean(historyRoutine)}
        onOpenChange={(open) => !open && setHistoryRoutine(null)}
        onOpenThread={handleSelect}
      />

      <Dialog open={Boolean(deletingRoutine)} onOpenChange={(open) => !open && setDeletingRoutine(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete schedule</DialogTitle>
            <DialogDescription>
              Delete “{deletingRoutine?.name}”? Every future automated trigger for it stops.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setDeletingRoutine(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (deletingRoutine) {
                  await handleCancel(deletingRoutine.id);
                  setDeletingRoutine(null);
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}