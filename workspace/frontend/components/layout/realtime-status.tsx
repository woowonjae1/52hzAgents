'use client';

import * as React from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';

/** How long the stream may be down before it is worth interrupting anyone. */
const GRACE_MS = 2500;

/**
 * "This workspace has stopped being live."
 *
 * Everything on this screen — agent status dots, the task board, routine runs,
 * notifications — is fed by one SSE connection. When it dropped, the client
 * retried quietly with a backoff that climbs to 30 seconds and the UI said
 * nothing: agents stayed green, the thread list stayed still, and the only
 * symptom was that the workspace had gone strangely quiet. A user cannot tell
 * "no one is saying anything" apart from "I am not being told what is said".
 *
 * So: nothing at all while the stream is healthy, and one quiet bar with a way
 * out once it is not. The grace period keeps a one-second blip — a laptop lid,
 * a server restart — from flashing a banner nobody needed to read.
 */
export function RealtimeStatus() {
  const { realtimeStatus, reconnectRealtime } = useWorkspace();
  const [visible, setVisible] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);

  React.useEffect(() => {
    if (realtimeStatus === 'live') {
      setVisible(false);
      setRetrying(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [realtimeStatus]);

  if (!visible) return null;

  const connecting = realtimeStatus === 'connecting';

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-[calc(var(--titlebar-height)+8px)] left-1/2 -translate-x-1/2 z-40 flex items-center gap-2.5 rounded-full border border-border bg-surface-overlay/95 backdrop-blur-xl pl-3 pr-1.5 py-1 shadow-xl"
    >
      <CloudOff className={cn('size-3.5 shrink-0', connecting ? 'text-foreground-muted' : 'text-status-warning')} />
      <span className="text-2xs text-foreground-muted">
        {connecting ? 'Reconnecting to the workspace…' : 'Live updates are offline — this view may be stale'}
      </span>
      <button
        type="button"
        disabled={connecting || retrying}
        onClick={() => {
          setRetrying(true);
          reconnectRealtime();
        }}
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium text-foreground hover:bg-surface2 disabled:opacity-50 transition-colors cursor-pointer"
      >
        <RefreshCw className={cn('size-3', (connecting || retrying) && 'animate-spin')} />
        Retry
      </button>
    </div>
  );
}
