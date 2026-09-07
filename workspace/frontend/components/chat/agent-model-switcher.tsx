'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  currentModelFor,
  hydrateAgentModels,
  modelsFor,
  rememberForSession,
  restoreForSession,
  parseReportedModels,
  setCurrentModel,
  useAgentModels,
} from '@/lib/agent-model-store';

// Re-exported: agent-station, agent-profile-panel and mission-control import
// these from here. The definitions moved to lib/agent-model-store.ts because
// all four surfaces parse the same adapter payload.
export { parseReportedModels, type AgentModelOption } from '@/lib/agent-model-store';

export function getAgentKind(agentName?: string | null, agentType?: string | null): string {
  return (agentType || agentName || '').toLowerCase();
}

interface AgentModelSwitcherProps {
  /**
   * The thread's leader. Shown first and named on the chip, because it is the
   * agent a bare message goes to — but it does NOT gate the control any more.
   */
  agentName?: string;
  /**
   * The thread's participants. The menu is scoped to these; every other online
   * agent in the workspace is still reachable, under its own heading, because
   * an agent can be added to a thread from anywhere and this chip should not be
   * the one surface that cannot see it.
   */
  participants?: string[];
  sessionId?: string | null;
  className?: string;
}

const norm = (s: string) => s.toLowerCase();

export function AgentModelSwitcher({
  agentName,
  participants,
  sessionId,
  className,
}: AgentModelSwitcherProps) {
  const { workspaceId, agents } = useWorkspace();
  const modelState = useAgentModels();

  const onlineAgents = React.useMemo(
    () => agents.filter((a) => a.status === 'online'),
    [agents],
  );

  /*
    THE MENU IS GROUPED, NOT FILTERED.

    It used to list every online agent in the workspace with no notion of the
    thread, so an 8-agent workspace showed 8 sections for a 2-agent
    conversation. Scoping it to the participants and dropping the rest would
    trade that for a different wrong answer, since an agent can be added to the
    thread from Mission Control or the roster. Both groups, participants first.
  */
  const participantSet = React.useMemo(
    () => new Set((participants || []).map(norm)),
    [participants],
  );

  const inThread = React.useMemo(
    () => onlineAgents.filter((a) => participantSet.has(norm(a.agentName))),
    [onlineAgents, participantSet],
  );
  const elsewhere = React.useMemo(
    () => onlineAgents.filter((a) => !participantSet.has(norm(a.agentName))),
    [onlineAgents, participantSet],
  );

  /*
    With no participant list (a fresh thread, or a caller that does not pass
    one) everything online is treated as in-thread rather than as "elsewhere" —
    an unlabelled list beats a list where every row is flagged as foreign.
  */
  const primary = participantSet.size > 0 ? inThread : onlineAgents;
  const secondary = participantSet.size > 0 ? elsewhere : [];

  /** The agent the chip names. Leader if it is online, else the first primary. */
  const leadAgent = React.useMemo(() => {
    if (agentName) {
      const match = onlineAgents.find((a) => norm(a.agentName) === norm(agentName));
      if (match) return match;
    }
    return primary[0] || null;
  }, [agentName, onlineAgents, primary]);

  /*
    GATING IS PER TARGET, NOT PER LEADER.

    `canConfigure` used to be `!!activeAgent`, where `activeAgent` was the
    leader — so if the leader happened to be offline the whole chip went inert
    and NO agent's model could be changed, even with five others online. The
    control channel is polled by each connected agent independently, so the
    only thing that decides whether a switch can land is whether THAT agent is
    up. The chip is live whenever anything is.
  */
  const anyOnline = onlineAgents.length > 0;
  const offlineHint = 'No agent online — connect one to switch models';

  const agentNamesKey = React.useMemo(
    () => onlineAgents.map((a) => a.agentName).sort().join(','),
    [onlineAgents],
  );

  // Heartbeat: fold each agent's reported model list into the shared store.
  React.useEffect(() => {
    if (!agentNamesKey) return;
    const names = agentNamesKey.split(',');
    let cancelled = false;

    const load = async () => {
      if (workspaceId) workspaceApi.setWorkspaceId(workspaceId);
      await Promise.all(
        names.map(async (name) => {
          try {
            const usage = await workspaceApi.getAgentUsage(name);
            if (cancelled) return;
            hydrateAgentModels(name, {
              options: parseReportedModels(usage?.available_models),
              current: usage?.current_model,
            });
          } catch {
            // An agent that does not answer keeps whatever the store holds.
          }
        }),
      );
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startTimer = () => {
      if (timer !== null || cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      timer = setInterval(load, 30_000);
    };
    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopTimer();
      } else {
        load();
        startTimer();
      }
    };

    load();
    startTimer();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [agentNamesKey, workspaceId]);

  // Saved per-thread choices, folded into the same store.
  React.useEffect(() => {
    if (!sessionId || !agentNamesKey) return;
    restoreForSession(sessionId, agentNamesKey.split(','));
  }, [sessionId, agentNamesKey]);

  const leadName = leadAgent?.agentName || agentName || 'agent';
  const leadCurrent = currentModelFor(modelState, leadName);
  const leadModels = modelsFor(modelState, leadName);

  /** What the chip reads when the lead agent has a model. */
  const leadLabel = React.useMemo(() => {
    if (!leadCurrent) return 'Default';
    const match = leadModels.find(
      (m) => m.id === leadCurrent || m.shortName === leadCurrent,
    );
    if (match) return match.shortName;
    return leadCurrent.includes('/') ? leadCurrent.split('/')[1] : leadCurrent;
  }, [leadCurrent, leadModels]);

  /*
    How many OTHER agents in this thread are on a model of their own. The chip
    used to name one model and say nothing about the rest, which is how a
    multi-agent thread ended up looking single-model — the thing that made the
    control feel like it was in the wrong place. `+2` is the smallest honest
    way to say "this is not the only one".
  */
  const othersConfigured = React.useMemo(
    () =>
      primary.filter(
        (a) => norm(a.agentName) !== norm(leadName) && !!currentModelFor(modelState, a.agentName),
      ).length,
    [primary, leadName, modelState],
  );

  if (!anyOnline && !agentName) return null;

  const handleSelectModel = async (
    targetAgentName: string,
    targetOnline: boolean,
    modelId: string,
    modelName: string,
  ) => {
    if (!targetOnline) return;
    const previousId = currentModelFor(modelState, targetAgentName);

    setCurrentModel(targetAgentName, modelId);

    try {
      if (workspaceId) workspaceApi.setWorkspaceId(workspaceId);
      await workspaceApi.sendAgentControl(targetAgentName, 'set_model', {
        model: modelId,
        channel: sessionId || undefined,
      });
      if (sessionId) rememberForSession(sessionId, targetAgentName, modelId);
      toast.success(`${targetAgentName} switched to ${modelName}`);
    } catch (e) {
      setCurrentModel(targetAgentName, previousId);
      const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
      toast.error(`${targetAgentName} could not switch to ${modelName}${detail}`);
    }
  };

  const renderAgentGroup = (
    list: typeof onlineAgents,
    heading: string | null,
    keyPrefix: string,
  ) =>
    list.map((agentItem, idx) => {
      const models = modelsFor(modelState, agentItem.agentName);
      const currentSelectedId = currentModelFor(modelState, agentItem.agentName);
      const isLead = norm(agentItem.agentName) === norm(leadName);

      return (
        <div
          key={`${keyPrefix}-${agentItem.agentName}`}
          className={cn('space-y-0.5', (idx > 0 || heading) && 'pt-2 border-t border-border/40 mt-1.5')}
        >
          {heading && idx === 0 && (
            <div className="px-2 pb-1 text-3xs font-semibold tracking-wider text-foreground-extra-muted uppercase">
              {heading}
            </div>
          )}
          <div className="px-2 py-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase flex items-center justify-between gap-2">
            <span className={cn('truncate', isLead && 'text-foreground')}>@{agentItem.agentName}</span>
            <span className="text-3xs font-normal text-muted-foreground/80 shrink-0">
              {isLead ? 'leader' : agentItem.agentType || 'agent'}
            </span>
          </div>

          {models.length > 0 ? (
            models.map((m) => {
              const isSelected =
                !!currentSelectedId &&
                (currentSelectedId === m.id || currentSelectedId === m.shortName);

              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => handleSelectModel(agentItem.agentName, true, m.id, m.name)}
                  className={cn(
                    'flex items-center justify-between px-2.5 py-1.5 rounded-md cursor-pointer text-xs font-medium transition-colors',
                    isSelected
                      ? 'bg-surface3 text-foreground font-semibold'
                      : 'text-foreground-muted hover:text-foreground hover:bg-surface2',
                  )}
                >
                  <span className="truncate">{m.name}</span>
                  <span className="flex items-center gap-1.5 shrink-0 ml-2">
                    {m.provider && (
                      <span className="text-3xs font-normal text-muted-foreground/80">
                        {m.provider}
                      </span>
                    )}
                    {isSelected && <Check className="size-3.5" />}
                  </span>
                </DropdownMenuItem>
              );
            })
          ) : (
            <div className="px-2.5 py-1 text-xs text-muted-foreground italic flex items-center justify-between">
              <span>{currentSelectedId || 'Environment default'}</span>
            </div>
          )}
        </div>
      );
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!anyOnline}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border transition-colors select-none shadow-2xs',
            anyOnline
              ? 'bg-surface2 hover:bg-surface3 border-border text-foreground cursor-pointer'
              : 'bg-surface2/40 border-border/40 text-muted-foreground/60 cursor-not-allowed',
            className,
          )}
          title={
            anyOnline
              ? `@${leadName}: ${leadLabel}${othersConfigured > 0 ? ` · ${othersConfigured} more agent${othersConfigured > 1 ? 's' : ''} set separately` : ''}`
              : offlineHint
          }
        >
          <span className="truncate max-w-[140px]">{anyOnline ? leadLabel : 'Offline'}</span>
          {anyOnline && othersConfigured > 0 && (
            <span className="shrink-0 text-foreground-extra-muted">+{othersConfigured}</span>
          )}
          <ChevronDown
            className={cn(
              'size-3 shrink-0',
              anyOnline ? 'text-foreground-extra-muted' : 'text-muted-foreground/40',
            )}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-64 p-1.5 shadow-lg border-border bg-surface1 max-h-[420px] overflow-y-auto"
      >
        {renderAgentGroup(
          [...primary].sort((a, b) =>
            norm(a.agentName) === norm(leadName) ? -1 : norm(b.agentName) === norm(leadName) ? 1 : 0,
          ),
          participantSet.size > 0 ? 'In this thread' : null,
          'in',
        )}
        {secondary.length > 0 && renderAgentGroup(secondary, 'Not in this thread', 'out')}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
