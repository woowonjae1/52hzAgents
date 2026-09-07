'use client';

import { useCallback, useEffect, useState } from 'react';
import { workspaceApi } from './api';
import { useWorkspace } from './workspace-context';
import { useVisibilityPolling } from './use-visibility-polling';

export interface GitFileChange {
  path: string;
  status: string; // "M", "A", "D", "R", "?"
  staged: boolean;
  additions: number;
  deletions: number;
}

export interface GitStatus {
  available: boolean;
  reason?: string;
  dir: string;
  dir_name: string;
  branch: string;
  commit?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  additions: number;
  deletions: number;
}

/** How often the chip re-checks. Slow on purpose — see the note in the hook. */
const POLL_MS = 15000;

/**
 * Git status for the repository the channel is bound to, shared by the header
 * chip and the composer's context line.
 *
 * They both need the same numbers, and each shelling out to `git status` on its
 * own schedule would double the process spawns for one screen. One hook, one
 * poll, two readers.
 *
 * The interval is deliberately long: this drives an ambient status line, not a
 * progress bar, and every tick is a real `git status` on the user's disk. A
 * `refresh()` is exposed so an action that *changes* the state (staging, a
 * commit) can update immediately instead of waiting out the interval.
 */
/**
 * @param channelId the channel whose binding decides which repository is read.
 *   The server resolves the path from the channel row, so nothing here needs to
 *   know it.
 *
 * Git state belongs to the project the channel is bound to. It used to be looked
 * up per agent, but an agent's working directory is fixed when it launches and
 * is identical across every channel it sits in, so every channel reported the
 * same repository.
 *
 * A channel with no working directory has no repository to report on, and asking
 * anyway is a guaranteed 400 on every poll — so it short-circuits to `null`
 * without a request. A bound directory that simply isn't a checkout is a
 * different case: the server answers `available: false` and the chip renders
 * nothing.
 */
export function useGitStatus(channelId: string | null | undefined) {
  const { sessions } = useWorkspace();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The binding, not the session object: that one is replaced on every incoming
  // event and would restart the poll each time.
  const workingDir = channelId
    ? sessions.find((s) => s.sessionId === channelId)?.workingDir ?? null
    : null;
  const boundChannelId = channelId && workingDir ? channelId : null;

  const refresh = useCallback(async () => {
    if (!boundChannelId) {
      setStatus(null);
      setError(null);
      return;
    }
    try {
      setStatus(await workspaceApi.getGitStatus(boundChannelId));
      setError(null);
    } catch (e) {
      // A backend without the git routes, or a directory that has gone away, is
      // an ordinary state here — the chip simply does not render. Not worth a
      // toast on every poll.
      setStatus(null);
      setError(e instanceof Error ? e.message : 'git status unavailable');
    }
  }, [boundChannelId]);

  useVisibilityPolling(refresh, POLL_MS, { enabled: !!boundChannelId });

  // `channelId` is echoed back so write calls (stage, commit) go to the same
  // channel the status came from, and are skipped entirely when there is none.
  return { status, error, refresh, channelId: boundChannelId };
}
