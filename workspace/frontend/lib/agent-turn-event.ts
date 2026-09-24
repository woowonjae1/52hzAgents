/*
  WHICH WORKSPACE A RELAYED TURN EVENT BELONGS TO.

  The store in use-agent-turns is keyed by the workspace id from the ROUTE,
  which is normally the slug (`/my-workspace`), while the backend stamps each
  turn row with the workspace UUID. Comparing the two dropped every live turn
  event, so the sidebar only caught up on the next 15s poll: "working" showed
  late and "stopped mid-turn" later still. The workspace SSE handler therefore
  tags the relay with the route key it subscribed under, and that tag is what
  is compared. The row's own `workspace_id` is only a fallback for a relay
  that carries no tag.

  Kept free of imports so it can be unit-tested without the React tree.
*/

export interface AgentTurnEventDetail {
  /** Route workspace key (slug or id) of the SSE stream that relayed this. */
  workspace?: string;
  turn?: Record<string, unknown>;
}

/** The turn row to apply, or null when the event is for another workspace. */
export function turnForWorkspace(
  detail: AgentTurnEventDetail | undefined,
  currentWorkspace: string | null
): Record<string, unknown> | null {
  if (!detail?.turn || !currentWorkspace) return null;
  const from = detail.workspace ?? String(detail.turn.workspace_id || '');
  if (from && from !== currentWorkspace) return null;
  return detail.turn;
}
