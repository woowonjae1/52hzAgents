'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, Users } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { cn } from '@/lib/utils';
import { useElapsedFrom } from '@/lib/use-elapsed';
import type { AgentTurn } from '@/lib/use-agent-turns';
import type { WorkspaceMessage } from '@/lib/types';
import { describeStep } from './intermediate-steps';
import { isToolCallMessage } from './message-kinds';
import { TRANSCRIPT_REVEAL_EVENT } from './chat-messages';

/*
  ONE LANE PER AGENT THAT IS WORKING RIGHT NOW.

  When several agents run at once in a master/dynamic channel, their steps
  interleave in the transcript: each agent's thinking is grouped per sender
  (chat-messages.tsx), but the groups are ordered by time, so "what is each of
  them doing" means scrolling and reading. This answers it in one glance, above
  the transcript: who is mid-turn, for how long, what their latest step is, and
  -- expanded -- their last few steps, each a link into the transcript.

  Real data only. "Working" is the adapter's own turn report (useAgentTurns),
  not a guess from which message came last; steps are the agent's thinking /
  status / todos messages since its turn started. Parallel batches have their
  own lane view with worktrees and diffstats (parallel-batch-panel.tsx), so the
  caller hides this one there.
*/

const RECENT_STEPS = 5;

interface Lane {
  turn: AgentTurn;
  steps: WorkspaceMessage[];
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function reveal(messageId: string) {
  window.dispatchEvent(new CustomEvent(TRANSCRIPT_REVEAL_EVENT, { detail: { messageId } }));
}

export function AgentLanes({
  runningTurns,
  messages,
  agentTypes,
  className,
}: {
  /** Turns in state `running` for this channel. */
  runningTurns: AgentTurn[];
  messages: WorkspaceMessage[];
  /** agentName (lowercase) -> agentType, for the avatar. */
  agentTypes?: Map<string, string | null>;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const lanes = useMemo<Lane[]>(() => {
    return runningTurns
      .map((turn) => {
        const name = turn.agentName.toLowerCase();
        const since = ms(turn.startedAt);
        const steps = messages.filter(
          (m) =>
            m.senderType === 'agent' &&
            m.senderName.toLowerCase() === name &&
            (m.messageType === 'thinking' || m.messageType === 'status' || m.messageType === 'todos') &&
            (!since || ms(m.createdAt) >= since)
        );
        return { turn, steps };
      })
      .sort((a, b) => ms(a.turn.startedAt) - ms(b.turn.startedAt));
  }, [runningTurns, messages]);

  // One agent working is already obvious from the transcript itself.
  if (lanes.length < 2) return null;

  return (
    <div className={cn('rounded-xl border border-border/70 bg-surface1/80 text-xs', className)}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground-muted hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
        <Users className="size-3.5 shrink-0" />
        <span className="font-medium">{lanes.length} agents working</span>
        {collapsed && (
          <span className="truncate text-foreground-extra-muted">
            {lanes.map((l) => `@${l.turn.agentName}`).join(', ')}
          </span>
        )}
      </button>

      {!collapsed && (
        <ul className="border-t border-border/60">
          {lanes.map((lane) => (
            <LaneRow
              key={lane.turn.agentName}
              lane={lane}
              agentType={agentTypes?.get(lane.turn.agentName.toLowerCase()) ?? null}
              open={expanded === lane.turn.agentName}
              onToggle={() => setExpanded((cur) => (cur === lane.turn.agentName ? null : lane.turn.agentName))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LaneRow({
  lane,
  agentType,
  open,
  onToggle,
}: {
  lane: Lane;
  agentType: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { turn, steps } = lane;
  const elapsed = useElapsedFrom(ms(turn.startedAt) || null, true);

  /*
    Newest first. Adapters stream prose as many small `thinking` messages
    ("update the browser", "progress and", "."), which the transcript stitches
    back together (coalesceThinking); a run of them is one step here too,
    labelled with its joined text. Tool calls and todos stay one step each.
  */
  const described = useMemo(() => {
    type Entry = { message: WorkspaceMessage; label: string; Icon: NonNullable<ReturnType<typeof describeStep>>['Icon'] };
    const out: Entry[] = [];
    let run: WorkspaceMessage[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      const text = run.map((m) => m.content || '').join('').replace(/\s+/g, ' ').trim();
      const d = describeStep({ ...run[run.length - 1], content: text });
      if (d) out.push({ message: run[run.length - 1], ...d });
      run = [];
    };
    for (const m of steps) {
      if (m.messageType === 'thinking' && !isToolCallMessage(m)) {
        run.push(m);
        continue;
      }
      flushRun();
      const d = describeStep(m);
      if (d) out.push({ message: m, ...d });
    }
    flushRun();
    return out.reverse();
  }, [steps]);

  const recent = described.slice(0, RECENT_STEPS);
  const latest = described[0];
  const LatestIcon = latest?.Icon;

  return (
    <li className="border-b border-border/40 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-foreground-extra-muted" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-foreground-extra-muted" />
          )}
          <AgentAvatar name={turn.agentName} agentType={agentType} size={16} />
          <span className="shrink-0 font-medium text-foreground">@{turn.agentName}</span>
          {elapsed && <span className="shrink-0 tabular-nums text-foreground-extra-muted">{elapsed}</span>}
          <span className="flex min-w-0 items-center gap-1 text-foreground-muted">
            {LatestIcon && <LatestIcon className="size-3 shrink-0" />}
            <span className="truncate">{latest ? latest.label : 'Starting…'}</span>
          </span>
        </button>
        {described.length > 0 && (
          <span className="shrink-0 tabular-nums text-foreground-extra-muted">
            {described.length} {described.length === 1 ? 'step' : 'steps'}
          </span>
        )}
        {latest && (
          <Hint label="Show in transcript">
            <button
              type="button"
              onClick={() => reveal(latest.message.messageId)}
              aria-label={`Show @${turn.agentName}'s latest step in the transcript`}
              className="shrink-0 rounded p-0.5 text-foreground-extra-muted hover:bg-surface3 hover:text-foreground"
            >
              <CornerDownRight className="size-3.5" />
            </button>
          </Hint>
        )}
      </div>

      {open && (
        <ol className="space-y-0.5 pb-2 pl-10 pr-3">
          {recent.length === 0 && <li className="text-foreground-extra-muted">No steps reported yet.</li>}
          {recent.map(({ message, label, Icon }) => (
            <li key={message.messageId}>
              <button
                type="button"
                onClick={() => reveal(message.messageId)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-foreground-muted hover:bg-surface3/70 hover:text-foreground"
              >
                <Icon className="size-3 shrink-0" />
                <span className="truncate">{label}</span>
                {message.createdAt && (
                  <span className="ml-auto shrink-0 tabular-nums text-foreground-extra-muted">
                    {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
