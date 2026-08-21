'use client';

import { toast } from 'sonner';
import { NewThreadDialog } from './new-thread-dialog';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Mounts the New Thread dialog once at the app level, driven by shared layout
 * state (`newThreadOpen`). This lets any surface — the sidebar button or an
 * empty-state "New Thread" prompt — open the same agent-picker via
 * `openNewThread()` without each one owning its own dialog instance.
 */
export function NewThreadDialogHost() {
  const { newThreadOpen, setNewThreadOpen, setViewMode, isMobile, openMobileDetail } = useLayout();
  const { agents, sessions, currentSessionId, createSession } = useWorkspace();
  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const currentParticipants = currentSession?.participants;

  return (
    <NewThreadDialog
      open={newThreadOpen}
      onOpenChange={setNewThreadOpen}
      agents={agents}
      sessions={sessions}
      defaultParticipants={currentParticipants}
      defaultWorkingDir={currentSession?.workingDir}
      onCreateThread={async ({ participants, resumeFrom, workingDir }) => {
        // createSession() rejects on a failed create (notably when the API
        // singleton has not been configured yet). Firing it unawaited turned
        // that into an unhandled rejection and a full-page dev error overlay,
        // which is the loudest possible way to report "try again in a second".
        try {
          await createSession({ participants, resumeFrom, workingDir });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Could not create the channel');
          return;
        }
        setViewMode('threads');
        // On mobile, jump to the detail pane so the new thread is visible.
        if (isMobile) openMobileDetail();
      }}
    />
  );
}
