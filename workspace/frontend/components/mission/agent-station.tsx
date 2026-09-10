'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import {
  MessageSquare,
  Wrench,
  Plug,
  ShieldAlert,
  Clock,
  Check,
  X,
  RotateCw,
} from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';

export type StationStatus = 'working' | 'ready' | 'offline' | 'blocked' | 'stalled';

export interface StationData {
  agent: WorkspaceAgent;
  status: StationStatus;
  threads: WorkspaceSession[];
  focusThread: WorkspaceSession | null;
  activity: { content: string; senderName: string; isStatus?: boolean } | null;
  skillCount: number;
  tokenCount?: number;
  isCatalogPlaceholder?: boolean;
  stalledMs?: number;
  pendingApproval?: {
    approvalId: string;
    tool: string;
    command?: string;
    path?: string;
  };
  lastHeartbeatAt?: string | number | null;
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '0';
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

interface AgentStationProps {
  data: StationData;
  onOpenAgent: () => void;
  onOpenThread: (sessionId: string) => void;
  onPairAgent?: () => void;
  onApprovalResolved?: () => void;
  className?: string;
}

export function AgentStation({
  data,
  onOpenAgent,
  onOpenThread,
  onPairAgent,
  onApprovalResolved,
  className,
}: AgentStationProps) {
  const {
    agent,
    status,
    threads,
    activity,
    skillCount,
    tokenCount = 0,
    isCatalogPlaceholder = false,
    stalledMs,
    pendingApproval,
    lastHeartbeatAt,
  } = data;

  const isWorking = status === 'working';
  const isBlocked = status === 'blocked';
  const isStalled = status === 'stalled';
  const isCustomPlaceholder = isCatalogPlaceholder === true && agent.agentName.toLowerCase() === 'custom';
  const activeThread = threads[0];
  const [busy, setBusy] = React.useState(false);

  // Heartbeat timeout calculation
  const heartbeatDiffSec = React.useMemo(() => {
    if (!lastHeartbeatAt) return null;
    const timeMs = typeof lastHeartbeatAt === 'string' ? new Date(lastHeartbeatAt).getTime() : lastHeartbeatAt;
    if (!timeMs || isNaN(timeMs)) return null;
    return Math.max(1, Math.round((Date.now() - timeMs) / 1000));
  }, [lastHeartbeatAt]);

  const isHeartbeatTimeout = heartbeatDiffSec !== null && heartbeatDiffSec > 30;

  // Single Source of Truth for Status Badge
  const statusBadge = React.useMemo(() => {
    if (isBlocked) {
      return {
        label: 'Awaiting approval',
        dot: 'bg-status-warning',
        ring: 'ring-status-warning/25',
        badge: 'bg-status-warning/15 text-status-warning font-medium',
      };
    }
    if (isStalled) {
      const sec = stalledMs ? Math.round(stalledMs / 1000) : 30;
      return {
        label: `Stalled · ${sec}s`,
        dot: 'bg-status-danger',
        ring: 'ring-status-danger/25',
        badge: 'bg-status-danger/10 text-status-danger font-medium',
      };
    }
    if (isHeartbeatTimeout) {
      const hbTime = typeof lastHeartbeatAt === 'string' ? lastHeartbeatAt : new Date(lastHeartbeatAt!).toISOString();
      return {
        label: `Heartbeat lost · ${timeAgo(hbTime)}`,
        dot: 'bg-status-warning',
        ring: 'ring-status-warning/25',
        badge: 'bg-status-warning/10 text-status-warning font-medium',
      };
    }
    if (isWorking) {
      return {
        label: 'Running',
        dot: 'bg-status-warning',
        ring: 'ring-status-warning/25',
        badge: 'bg-status-warning/10 text-status-warning font-medium',
      };
    }
    if (status === 'ready') {
      return {
        label: 'Ready',
        dot: 'bg-status-success',
        ring: 'ring-status-success/25',
        badge: 'bg-status-success/10 text-status-success font-medium',
      };
    }
    if (isCatalogPlaceholder) {
      return {
        label: 'Not connected',
        dot: 'bg-muted-foreground/40',
        ring: 'ring-muted-foreground/10',
        badge: 'bg-surface2/60 text-muted-foreground font-medium',
      };
    }
    return {
      label: 'Offline',
      dot: 'bg-muted-foreground/50',
      ring: 'ring-muted-foreground/10',
      badge: 'bg-surface2/80 text-muted-foreground font-medium',
    };
  }, [isBlocked, isStalled, isHeartbeatTimeout, isWorking, status, isCatalogPlaceholder, stalledMs, lastHeartbeatAt]);

  const handleApprove = async () => {
    if (!pendingApproval || !activeThread) return;
    setBusy(true);
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: 'human:user',
        target: `channel/${activeThread.sessionId}`,
        payload: {
          content: 'Approved command execution via Agent Card.',
          sender_type: 'human',
          sender_name: 'user',
        },
        metadata: {
          target_agents: [agent.agentName],
          tool_approval_response: {
            approval_id: pendingApproval.approvalId,
            granted: true,
          },
        },
        visibility: 'channel',
      });
      toast.success(`Approved @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('Approval failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDeny = async () => {
    if (!pendingApproval || !activeThread) return;
    setBusy(true);
    try {
      await workspaceApi.sendEvent({
        type: 'workspace.message.posted',
        source: 'human:user',
        target: `channel/${activeThread.sessionId}`,
        payload: {
          content: 'Rejected command execution via Agent Card.',
          sender_type: 'human',
          sender_name: 'user',
        },
        metadata: {
          target_agents: [agent.agentName],
          tool_approval_response: {
            approval_id: pendingApproval.approvalId,
            granted: false,
          },
        },
        visibility: 'channel',
      });
      toast.info(`Denied @${agent.agentName}`);
      onApprovalResolved?.();
    } catch {
      toast.error('Could not submit the denial');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'group relative flex flex-col justify-between rounded-xl p-3.5 h-full',
        /*
          220px is the height a *connected* station needs for its live rows —
          model switcher, quota, activity. A catalog placeholder has a logo, two
          lines of description and a Connect button, so the same floor left it
          with ~40px of empty card, thirteen times over on an empty workspace.
        */
        !isCatalogPlaceholder && 'min-h-[220px]',
        'bg-surface1 transition-colors duration-150',
        'border border-border/60 hover:border-border/60 hover:shadow-xs',
        isBlocked && 'ring-2 ring-status-warning/20 bg-status-warning/[0.02]',
        isStalled && 'ring-2 ring-status-danger/20 bg-status-danger/[0.02]',
        isHeartbeatTimeout && 'border-status-warning/30',
        status === 'offline' && !isCatalogPlaceholder && 'opacity-85',
        isCatalogPlaceholder && 'bg-surface1/30',
        className
      )}
    >
      {/* Top Header */}
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onOpenAgent}
          className="flex flex-1 items-center gap-2.5 min-w-0 text-left cursor-pointer group/title"
        >
          <AgentAvatar
            name={agent.agentName}
            agentType={agent.agentType}
            size={28}
            status={agent.status}
          />

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {/* No max-width cap: the flex row already bounds this, and the
                  cap plus a `shrink-0` status badge left the name 20px in a
                  two-column grid — every card showed a single letter. */}
              <span className="font-semibold text-xs text-foreground truncate group-hover/title:text-primary transition-colors">
                {agent.agentName}
              </span>
              {agent.role === 'master' && (
                <span className="text-3xs px-1 rounded bg-surface3 text-foreground font-mono font-medium shrink-0">
                  Master
                </span>
              )}
            </div>
            <div className="text-3xs text-muted-foreground truncate font-mono mt-0.5">
              {agent.agentType || 'agent'}
            </div>
          </div>
        </button>

        {/*
          Unified Status Badge. Allowed to shrink — it was `shrink-0` while
          carrying a relative timestamp ("Heartbeat lost · 1 week ago"), so it
          took ~150px of a 236px card and the agent's identity paid for it. The
          dot never shrinks, so the state is still readable even when the label
          is clipped.
        */}
        <span
          className={cn(
            'inline-flex min-w-0 items-center gap-1 px-2 py-0.5 rounded-full text-3xs',
            statusBadge.badge
          )}
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full ring-2',
              statusBadge.dot,
              statusBadge.ring,
            )}
          />
          <span className={cn('truncate', isWorking && 'event-running')} title={statusBadge.label}>
            {statusBadge.label}
          </span>
        </span>
      </div>

      {/* Inline Blocked Approval */}
      {isBlocked && pendingApproval ? (
        <div className="my-2 p-2 rounded-xl bg-status-warning/10 space-y-1.5 text-xs animate-in zoom-in-95 duration-150 flex-1 flex flex-col justify-between">
          <div className="flex items-center justify-between text-3xs font-medium text-status-warning">
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3" />
              <span>Awaiting approval · {pendingApproval.tool}</span>
            </span>
          </div>
          {pendingApproval.command && (
            <div className="font-mono text-3xs text-foreground font-medium truncate p-1 bg-surface1 rounded">
              $ {pendingApproval.command}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={handleDeny}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-2xs font-medium text-status-danger hover:bg-status-danger/10 cursor-pointer"
            >
              <X className="size-2.5" />
              <span>Deny</span>
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1 h-6 rounded-lg text-2xs font-medium bg-primary text-primary-foreground hover:opacity-90 cursor-pointer shadow-xs"
            >
              <Check className="size-2.5" />
              <span>Approve</span>
            </button>
          </div>
        </div>
      ) : !isCatalogPlaceholder ? (
        /* Configured Agent: 3 Micro Metrics Grid + Activity */
        <div className="my-2 space-y-1.5 flex-1 flex flex-col justify-start">
          {/*
            NOT A SCOREBOARD. This was a three-column grid of uppercase mono
            micro-labels over big figures in its own tinted, rounded box --
            TOKENS 0 / CHANNEL 1 / SKILLS 0 on a fresh workspace. Three
            problems, all really the same problem:

            1. TWO OF THE THREE WERE USUALLY ZERO, and a zero set at the same
               weight as a real value costs the reader a fixation to learn
               nothing. A count of 0 is not news, it is the absence of news,
               and it should be absent.
            2. The grid-of-labelled-figures form is a telemetry HUD, which is
               the one thing this workspace is explicitly not. It made a card
               about a colleague read like a server dashboard.
            3. Its own box (`rounded-xl bg-surface2/50`) put a second frame
               inside a card that is already a frame.

            Now: one quiet line, carrying only the parts that have a value.
            Tokens lead because that is the number that actually moves, and the
            separator is a middot rather than a column because these are three
            facts about one agent, not three independent readings.
          */}
          {(tokenCount > 0 || threads.length > 0 || skillCount > 0) && (
            <div className="flex items-center gap-1.5 px-1 text-3xs text-muted-foreground">
              {tokenCount > 0 && (
                <span className="font-mono tabular-nums">{fmtTokens(tokenCount)} tokens</span>
              )}
              {tokenCount > 0 && (threads.length > 0 || skillCount > 0) && <span aria-hidden>&middot;</span>}
              {threads.length > 0 && (
                <span className="font-mono tabular-nums">
                  {threads.length} {threads.length === 1 ? 'channel' : 'channels'}
                </span>
              )}
              {threads.length > 0 && skillCount > 0 && <span aria-hidden>&middot;</span>}
              {skillCount > 0 && (
                <span className="font-mono tabular-nums">
                  {skillCount} {skillCount === 1 ? 'skill' : 'skills'}
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-1 text-2xs text-muted-foreground px-1 truncate">
            {isWorking ? (
              <span className="inline-flex items-center gap-1 font-medium truncate event-running">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate">{stripMarkdown(activity?.content || 'Working…')}</span>
              </span>
            ) : activeThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(activeThread.sessionId)}
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors truncate cursor-pointer text-left text-3xs"
              >
                <span className="text-primary font-medium">#{activeThread.title || 'New channel'}</span>
                {activeThread.lastEventAt && (
                  <span className="text-muted-foreground/70">
                    · {timeAgo(new Date(activeThread.lastEventAt).toISOString())}
                  </span>
                )}
              </button>
            ) : (
              <span className="text-muted-foreground/60 italic text-3xs">
                {isHeartbeatTimeout ? 'Heartbeat lost' : status === 'offline' ? 'Process not running' : 'Standing by'}
              </span>
            )}
          </div>

        </div>
      ) : (
        /* Unconnected Template Agent */
        <div className="my-2 px-1 py-1 text-2xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[38px]">
          {agent.description || 'Workspace adapter for ACP / MCP capable agents.'}
        </div>
      )}

      {/* Footer Controls */}
      <div className="flex items-center gap-1.5 pt-2 mt-auto">
        {!isCatalogPlaceholder && (
          <button
            type="button"
            onClick={onOpenAgent}
            className="flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg bg-surface2/80 hover:bg-surface3 text-xs font-medium text-foreground transition-colors cursor-pointer shadow-2xs"
          >
            <MessageSquare className="size-3 text-muted-foreground" />
            <span>Chat</span>
          </button>
        )}

        {/*
          A CONNECTED AGENT GETS NO BUTTON AT ALL.

          "Connected" was rendered as a filled, tinted, shadowed button beside
          "Chat", taking an equal `flex-1` share of the row -- so the card's
          action row held one real action and one disabled label wearing an
          action's clothes, and the label was the louder of the two. The state
          is already on the card twice (the status dot and the "Ready" badge in
          the header), so repeating it as the widest control spent the row's
          most valuable position on a fact the reader had at a glance.

          Dropping it lets `Chat` -- the thing you came here to do -- take the
          full width, and it means every button still in this row is one you
          can actually press.
        */}
        {status === 'ready' && !isHeartbeatTimeout ? null : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPairAgent?.();
          }}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-1 h-7 rounded-lg text-xs font-medium transition-all',
            isHeartbeatTimeout
              ? 'bg-status-warning/15 text-status-warning hover:bg-status-warning/25 cursor-pointer font-semibold'
              : 'bg-surface2/80 hover:bg-surface3 text-foreground cursor-pointer'
          )}
        >
          {isHeartbeatTimeout ? (
            <>
              <RotateCw className="size-3" />
              <span>Reconnect</span>
            </>
          ) : isCustomPlaceholder ? (
            <span>Configure</span>
          ) : (
            <>
              <Plug className="size-3 text-muted-foreground" />
              <span>Connect</span>
            </>
          )}
        </button>
        )}
      </div>
    </div>
  );
}
