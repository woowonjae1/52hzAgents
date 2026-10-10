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

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = AGENT_PROFILES.findIndex((p) => p.id === profileId);
    const next = AGENT_PROFILES[(i + (e.key === 'ArrowRight' ? 1 : AGENT_PROFILES.length - 1)) % AGENT_PROFILES.length];
    select(next.id);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-profile="${next.id}"]`)?.focus();
  };

  // For Review, say per agent whether read-only is a guard or a request.
  const enforced = targets.filter((a) => isReadOnlyEnforced(a.agentType, a.agentName)).map((a) => `@${a.agentName}`);
  const promptOnly = targets.filter((a) => !isReadOnlyEnforced(a.agentType, a.agentName)).map((a) => `@${a.agentName}`);

  return (
    <div
      role="radiogroup"
      aria-label="Work mode"
      onKeyDown={onKeyDown}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-surface1 p-0.5"
    >
      {AGENT_PROFILES.map((p) => {
        const Icon = p.icon;
        const isActive = p.id === profileId;
        return (
          <Hint
            key={p.id}
            side="top"
            label={
              <span className="block max-w-64">
                <span className="font-medium">{p.label}</span>
                <span className="block text-foreground-muted">{p.whenToUse}</span>
                {p.settings.agentMode === 'plan' && targets.length > 0 && (
                  <span className="mt-1 block text-foreground-muted">
                    {enforced.length > 0 && <>Blocked: {enforced.join(', ')}. </>}
                    {promptOnly.length > 0 && <>Asked only: {promptOnly.join(', ')}.</>}
                  </span>
                )}
                <span className="mt-1 block text-foreground-extra-muted">
                  This thread only. Applies from your next message; a reply already running keeps its mode.
                </span>
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-label={`${p.label} mode`}
              data-profile={p.id}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(p.id)}
              className={cn(
                'inline-flex h-5 items-center gap-1 rounded-[5px] px-1.5',
                'text-3xs font-mono select-none transition-colors',
                'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
                isActive
                  ? 'bg-surface3 text-foreground shadow-xs'
                  : 'text-foreground-extra-muted hover:text-foreground',
              )}
            >
              <Icon className="size-3 shrink-0" />
              {isActive && <span>{p.label}</span>}
            </button>
          </Hint>
        );
      })}
    </div>
  );
}
