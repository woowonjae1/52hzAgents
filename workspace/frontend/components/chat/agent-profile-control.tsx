'use client';

import * as React from 'react';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import type { WorkspaceSession } from '@/lib/types';
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  getProfile,
  isReadOnlyEnforced,
  lastSentMode,
  loadThreadProfile,
  noteModeSent,
  saveThreadProfile,
  type AgentMode,
  type AgentProfileId,
} from '@/lib/agent-profiles';

const norm = (s: string) => s.toLowerCase();

interface Props {
  session: WorkspaceSession;
}

/**
 * The thread's work profile — Fix / Review — as a segmented switch beside the
 * collaboration mode, in the same visual recipe as OrchestrationControl.
 *
 * Picking a profile stores it for this thread and sends each of the thread's
 * online agents the matching `set_mode`. Because the adapter keeps one mode
 * per AGENT, the thread's profile is re-applied whenever the thread is opened
 * (skipping agents that are mid-turn, retried once they finish).
 */
export function AgentProfileControl({ session }: Props) {
  const { agents, workspaceId, agentModes, updateAgentMode, workingAgentNames } = useWorkspace();
  const sessionId = session.sessionId;

  const [profileId, setProfileId] = React.useState<AgentProfileId>(
    () => loadThreadProfile(sessionId) ?? DEFAULT_PROFILE_ID,
  );
  React.useEffect(() => {
    setProfileId(loadThreadProfile(sessionId) ?? DEFAULT_PROFILE_ID);
  }, [sessionId]);
  const profile = getProfile(profileId);

  // Same scoping as the model switcher: the thread's online participants, or
  // every online agent when the thread names none.
  const targets = React.useMemo(() => {
    const online = agents.filter((a) => a.status === 'online');
    const inThread = new Set((session.participants || []).map(norm));
    return inThread.size > 0 ? online.filter((a) => inThread.has(norm(a.agentName))) : online;
  }, [agents, session.participants]);

  const sendMode = React.useCallback(
    async (agentName: string, mode: AgentMode) => {
      if (workspaceId) workspaceApi.setWorkspaceId(workspaceId);
      await workspaceApi.sendAgentControl(agentName, 'set_mode', { mode });
      noteModeSent(agentName, mode);
      updateAgentMode(agentName, mode);
    },
    [workspaceId, updateAgentMode],
  );

  /*
    Re-apply on open. Keyed by thread so each (thread, agent, mode) is sent at
    most once per visit; busy agents are left alone — flipping one mid-turn
    would change the mode under ANOTHER thread's work — and picked up when
    workingAgentNames drops them.
  */
  const appliedRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    appliedRef.current = new Set();
  }, [sessionId]);

  React.useEffect(() => {
    const mode = profile.settings.agentMode;
    for (const a of targets) {
      const key = `${a.agentName}:${mode}`;
      if (appliedRef.current.has(key)) continue;
      if (workingAgentNames.has(a.agentName)) continue;
      const needs =
        mode === 'plan'
          ? true
          : lastSentMode(a.agentName) === 'plan' || agentModes[a.agentName] === 'plan';
      appliedRef.current.add(key);
      if (!needs) continue;
      sendMode(a.agentName, mode).catch(() => {
        appliedRef.current.delete(key);
      });
    }
  }, [profile, targets, workingAgentNames, agentModes, sendMode]);

  const select = async (next: AgentProfileId) => {
    if (next === profileId) return;
    const nextProfile = getProfile(next);
    setProfileId(next);
    saveThreadProfile(sessionId, next);
    // An explicit pick reaches every agent, busy or not. Mark them applied
    // BEFORE sending so the re-apply effect (which re-runs on the profile
    // change) does not send the same event a second time.
    const mode = nextProfile.settings.agentMode;
    appliedRef.current = new Set(targets.map((a) => `${a.agentName}:${mode}`));
    const results = await Promise.allSettled(targets.map((a) => sendMode(a.agentName, mode)));
    const failedAgents = targets.filter((_, i) => results[i].status === 'rejected');
    // Left unmarked, so the next re-apply pass tries them again.
    for (const a of failedAgents) appliedRef.current.delete(`${a.agentName}:${mode}`);
    const failed = failedAgents.map((a) => `@${a.agentName}`);
    if (failed.length) toast.error(`Could not switch ${failed.join(', ')} to ${nextProfile.label}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = AGENT_PROFILES.findIndex((p) => p.id === profileId);
    const next = AGENT_PROFILES[(i + (e.key === 'ArrowRight' ? 1 : AGENT_PROFILES.length - 1)) % AGENT_PROFILES.length];
    void select(next.id);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-profile="${next.id}"]`)?.focus();
  };

  // For Review, say per agent whether read-only is a guard or a request.
  const enforced = targets.filter((a) => isReadOnlyEnforced(a.agentType, a.agentName)).map((a) => `@${a.agentName}`);
  const promptOnly = targets.filter((a) => !isReadOnlyEnforced(a.agentType, a.agentName)).map((a) => `@${a.agentName}`);

  return (
    <div
      role="radiogroup"
      aria-label="Work profile"
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
                  Mode is per agent, shared by all its threads; reapplied when you open this one.
                </span>
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-label={`${p.label} profile`}
              data-profile={p.id}
              tabIndex={isActive ? 0 : -1}
              onClick={() => void select(p.id)}
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
