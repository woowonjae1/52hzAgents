'use client';

import * as React from 'react';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import type { WorkspaceSession } from '@/lib/types';
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  getProfile,
  isReadOnlyEnforced,
  loadThreadProfile,
  saveThreadProfile,
  THREAD_PROFILE_EVENT,
  type AgentProfileId,
} from '@/lib/agent-profiles';

const norm = (s: string) => s.toLowerCase();

interface Props {
  session: WorkspaceSession;
}

/**
 * The thread's work mode — Fix / Review — as a segmented switch beside the
 * collaboration mode, in the same visual recipe as OrchestrationControl.
 *
 * Shown as a MODE, not a profile: "profile" means a saved agent + model + mode
 * preset that agents delegate to (Settings > Agents > Profiles), and those use
 * these same two modes. The `Profile` identifiers here predate that.
 *
 * Picking a mode only stores it for this thread. Every message the thread
 * sends then carries the matching `agent_mode` (chat-view handleSend), and the
 * adapter runs that turn in it — so nothing is broadcast to the agents, an
 * agent can review here while fixing elsewhere, and an adapter restart loses
 * nothing.
 */
export function AgentProfileControl({ session }: Props) {
  const { agents } = useWorkspace();
  const sessionId = session.sessionId;

  const [profileId, setProfileId] = React.useState<AgentProfileId>(
    () => loadThreadProfile(sessionId) ?? DEFAULT_PROFILE_ID,
  );
  React.useEffect(() => {
    setProfileId(loadThreadProfile(sessionId) ?? DEFAULT_PROFILE_ID);
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; id: AgentProfileId }>).detail;
      if (detail?.sessionId === sessionId) setProfileId(detail.id);
    };
    window.addEventListener(THREAD_PROFILE_EVENT, onChange);
    return () => window.removeEventListener(THREAD_PROFILE_EVENT, onChange);
  }, [sessionId]);

  // Whose read-only is a guard and whose only a request: the thread's online
  // participants, or every online agent when the thread names none (the same
  // scoping as the model switcher).
  const targets = React.useMemo(() => {
    const online = agents.filter((a) => a.status === 'online');
    const inThread = new Set((session.participants || []).map(norm));
    return inThread.size > 0 ? online.filter((a) => inThread.has(norm(a.agentName))) : online;
  }, [agents, session.participants]);

  const select = (next: AgentProfileId) => {
    if (next === profileId) return;
    setProfileId(next);
    saveThreadProfile(sessionId, next);
  };

  const isReview = profileId === 'review';
  const toggle = () => select(isReview ? 'fix' : 'review');
  const cur = getProfile(profileId);
  const Icon = cur.icon;

  // For Review, say per agent whether read-only is a guard or a request.
  const enforced = targets.filter((a) => isReadOnlyEnforced(a.agentType, a.agentName)).map((a) => `@${a.agentName}`);
  const promptOnly = targets.filter((a) => !isReadOnlyEnforced(a.agentType, a.agentName)).map((a) => `@${a.agentName}`);

  return (
    <Hint
      side="top"
      label={
        <span className="block max-w-64">
          <span className="font-medium">{cur.label} mode</span>
          <span className="block text-foreground-muted">{cur.whenToUse}</span>
          {cur.settings.agentMode === 'plan' && targets.length > 0 && (
            <span className="mt-1 block text-foreground-muted">
              {enforced.length > 0 && <>Blocked: {enforced.join(', ')}. </>}
              {promptOnly.length > 0 && <>Asked only: {promptOnly.join(', ')}.</>}
            </span>
          )}
          <span className="mt-1 block text-foreground-extra-muted">
            Click to switch to {isReview ? 'Edit (Fix)' : 'Read-only (Review)'} mode.
          </span>
        </span>
      }
    >
      <button
        type="button"
        aria-label={`Work mode: ${cur.label}`}
        onClick={toggle}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-2xs font-medium select-none transition-all cursor-pointer active:scale-95 shrink-0',
          isReview
            ? 'bg-status-warning/15 text-status-warning border border-status-warning/30 font-semibold'
            : 'bg-surface1 text-foreground-muted hover:text-foreground hover:bg-surface2 border border-border/60'
        )}
      >
        <Icon className={cn('size-3 shrink-0', isReview ? 'text-status-warning' : 'text-foreground-extra-muted')} />
        <span>{isReview ? 'Read-only' : 'Fix'}</span>
      </button>
    </Hint>
  );
}
