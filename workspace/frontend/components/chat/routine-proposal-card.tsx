'use client';

import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { EventLine } from '@/components/ai-elements/event-line';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import type { RoutineProposalMetadata } from '@/lib/types';

/*
  AN AGENT'S PROPOSED ROUTINE, DECIDED IN PLACE.

  A routine an agent creates is stored as pending_approval and does nothing
  until a person approves it. The backend announces it in the channel with
  `metadata.routine_proposal`; this is that announcement, drawn as one more
  transcript event (EventLine) rather than a card of its own, so it reads in
  the same rhythm as a tool call or a permission prompt.

  State comes from the workspace's routine list, not from this message: the
  same routine can be approved here, in Automations, or by another viewer, and
  the card must show what is true now. After this card acts, its own result is
  shown until the list catches up.
*/

type Outcome = 'active' | 'paused' | 'cancelled' | 'pending_approval' | 'gone';

function outcomeText(outcome: Outcome): string {
  switch (outcome) {
    case 'active':
      return 'Approved, active';
    case 'paused':
      return 'Approved, paused';
    case 'cancelled':
      return 'Rejected';
    case 'gone':
      return 'No longer pending';
    default:
      return 'Waiting for approval';
  }
}

export function RoutineProposalCard({ proposal }: { proposal: RoutineProposalMetadata }) {
  const { routines, refreshRoutines } = useWorkspace();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [local, setLocal] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listed = routines.find((r) => r.id === proposal.routine_id);
  // The list omits cancelled routines, so "not listed" after the list has
  // loaded means rejected or deleted.
  const fromList: Outcome | null = listed
    ? (listed.status as Outcome)
    : routines.length > 0
      ? 'gone'
      : null;
  const outcome: Outcome = local ?? fromList ?? 'pending_approval';
  const pending = outcome === 'pending_approval';

  const act = async (action: 'approve' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const saved =
        action === 'approve'
          ? await workspaceApi.approveRoutine(proposal.routine_id)
          : await workspaceApi.rejectRoutine(proposal.routine_id);
      setLocal((saved.status as Outcome) || (action === 'approve' ? 'active' : 'cancelled'));
      void refreshRoutines();
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^API \d+:\s*/, '') : 'The action could not be completed';
      setError(message);
      void refreshRoutines();
    } finally {
      setBusy(null);
    }
  };

  return (
    <EventLine
      icon={<CalendarClock />}
      label="Proposed routine"
      detail={proposal.name}
      detailMono={false}
      state={busy ? 'running' : 'idle'}
      meta={busy ? (busy === 'approve' ? 'Approving' : 'Rejecting') : outcomeText(outcome)}
      alwaysOpen
    >
      <div className="space-y-2">
        <p className="text-xs text-foreground-muted">
          <span className="text-foreground">{proposal.schedule_text}</span>
          {proposal.short_id ? <span className="font-mono text-foreground-extra-muted"> · {proposal.short_id}</span> : null}
          <span> · proposed by {proposal.created_by}</span>
        </p>
        {pending ? (
          <>
            <p className="text-xs text-foreground-muted">It will not run until you approve it.</p>
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-7 px-3 text-xs" disabled={busy !== null} onClick={() => void act('approve')}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs"
                disabled={busy !== null}
                onClick={() => void act('reject')}
              >
                Reject
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-foreground-muted">
            {outcome === 'active'
              ? 'Runs on schedule. Manage it in Automations.'
              : outcome === 'paused'
                ? listed?.pausedReason || 'Paused. Resume it in Automations.'
                : 'This routine will not run.'}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </EventLine>
  );
}
