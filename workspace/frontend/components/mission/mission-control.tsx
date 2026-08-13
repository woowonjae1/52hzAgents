'use client';

import { useMemo, useState, useEffect } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { ConnectAgentModal } from './connect-agent-modal';
import { CustomAgentModal } from './custom-agent-modal';
import { Users, Activity, Loader2, Plus, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, networkAgentToWorkspaceAgent, type ONMEvent } from '@/lib/types';
import { useAgentCatalog, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { toast } from 'sonner';
import { ProjectFolderPicker, rememberWorkingDir, recentWorkingDirs } from '@/components/chat/project-folder-picker';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** One classified line in the collaboration activity feed. */
interface ActivityLine {
  id: string;
  time: Date;
  sender: string;
  channel: string;
  content: string;
  type: 'command' | 'success' | 'error' | 'thinking' | 'info';
}

// Restrained per-type dot — a single small status color, no neon/glow.
const ACTIVITY_DOT: Record<ActivityLine['type'], string> = {
  command: 'bg-foreground-extra-muted',
  success: 'bg-status-success',
  error: 'bg-status-danger',
  thinking: 'bg-surface4',
  info: 'bg-surface4',
};

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

/**
 * Overview — the workspace home surface.
 *
 * Collaboration-first: a roster of connected agents with their real status,
 * and a shared activity feed showing what agents are saying to each other and
 * in which channel. No fabricated telemetry.
 */
export function MissionControl() {
  const {
    agents,
    setAgents,
    sessions,
    lastMessageBySession,
    activeSessionIds,
    workingAgentNames,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, setSelectedAgentName } = useLayout();

  const [agentTokens, setAgentTokens] = useState<Record<string, number>>({});
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);

  const handlePairAgent = async (agentName: string) => {
    if (agentName.toLowerCase() === 'custom') {
      setCustomModalOpen(true);
      return;
    }
    try {
      toast.loading(`Launching ${agentName}…`, { id: `launch-${agentName}` });
      await workspaceApi.launchAgent(agentName);
      toast.success(`Launched ${agentName}. Agent terminal window opened.`, { id: `launch-${agentName}`, duration: 5000 });
      const pollFreshAgents = async () => {
        try {
          const discovery = await workspaceApi.discover();
          const wsAgents = discovery.agents.map(networkAgentToWorkspaceAgent);
          setAgents(wsAgents);
        } catch {}
      };
      await pollFreshAgents();
      setTimeout(pollFreshAgents, 2000);
      setTimeout(pollFreshAgents, 5000);
    } catch (err: any) {
      const errorMsg = err?.message || 'Could not launch process';
      toast.error(`Launching ${agentName}: ${errorMsg}`, { id: `launch-${agentName}` });
    }
  };

  useEffect(() => {
    let cancelled = false;
    const pollTokens = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', limit: 100 });
        if (cancelled) return;
        // Count only usage an agent actually reported. The old character-count
        // fallback produced a number indistinguishable from a measured one, so
        // the tile read as real usage while being invented. Agents that report
        // nothing now contribute nothing.
        const usageMap: Record<string, number> = {};
        for (const ev of res.events) {
          const m = eventToMessage(ev);
          const name = m.senderName;
          if (!name) continue;
          const usage = m.metadata?.usage;
          const exact = usage?.total_tokens ?? usage?.completion_tokens;
          if (typeof exact === 'number' && exact > 0) {
            usageMap[name] = (usageMap[name] || 0) + exact;
          }
        }
        setAgentTokens(usageMap);
      } catch {
        // ignore
      }
    };
    pollTokens();
    const interval = setInterval(pollTokens, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // The roster comes from the backend catalog, not a copy kept in this file —
  // the copy drifted from /v1/agent-catalog once already.
  const { catalog } = useAgentCatalog();
  const allCatalogAgents = useMemo(() => catalogAsOfflineAgents(catalog), [catalog]);

  const stations = useMemo<StationData[]>(() => {
    const activeThreads = sessions.filter(
      (s) => s.status === 'active' && !s.sessionId.startsWith('routine:'),
    );

    // Match on type as well as name: a connected agent called "claude-agent"
    // already IS the Claude station, so adding the catalog's "claude" placeholder
    // next to it showed the same runtime twice.
    const covered = new Set<string>();
    for (const a of agents) {
      covered.add(a.agentName.toLowerCase());
      if (a.agentType) covered.add(a.agentType.toLowerCase());
    }
    const missingCandidates = allCatalogAgents.filter((a) => !covered.has(a.agentName.toLowerCase()));
    const placeholderNames = new Set(missingCandidates.map((a) => a.agentName.toLowerCase()));
    const displayAgents = [...agents, ...missingCandidates];

    return displayAgents
      .map((agent): StationData => {
        const threads = activeThreads
          .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
          .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

        // Busy channel ≠ busy agent: only the routed agent answers, so channel
        // membership must not put the rest of the roster into "working".
        const isWorking = workingAgentNames.has(agent.agentName);
        const workingThread = isWorking ? threads.find((t) => activeSessionIds.has(t.sessionId)) || null : null;
        const focusThread = workingThread || threads[0] || null;

        let stationStatus: StationStatus;
        if (agent.status !== 'online') stationStatus = 'offline';
        else if (isWorking) stationStatus = 'working';
        else stationStatus = 'ready';

        const activity = focusThread ? lastMessageBySession[focusThread.sessionId] || null : null;

        const installed = (agent.enabledSkills?.installed as string[] | undefined) || [];

        return {
          agent,
          status: stationStatus,
          threads,
          focusThread,
          activity,
          skillCount: installed.length,
          tokenCount: agentTokens[agent.agentName] || 0,
          isCatalogPlaceholder: placeholderNames.has(agent.agentName.toLowerCase()),
        };
      })
      // Working agents first, then ready, then offline; stable by name within.
      .sort((a, b) => {
        const rank = { working: 0, ready: 1, offline: 2 } as const;
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return a.agent.agentName.localeCompare(b.agent.agentName);
      });
  }, [agents, sessions, lastMessageBySession, activeSessionIds, workingAgentNames, agentTokens, allCatalogAgents]);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const workingCount = stations.filter((s) => s.status === 'working').length;
  const totalTokens = useMemo(() => Object.values(agentTokens).reduce((sum, v) => sum + v, 0), [agentTokens]);
  const fmtTokens = (n: number) => (n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

  const openAgent = (agentName: string, focusSessionId: string | null) => {
    if (focusSessionId) {
      setViewMode('threads');
      setCurrentSessionId(focusSessionId);
    } else {
      setSelectedAgentName(agentName);
    }
  };

  const openThread = (sessionId: string) => {
    setViewMode('threads');
    setCurrentSessionId(sessionId);
  };

  // Shared activity feed — a workspace-wide event stream (newest first) showing
  // cross-agent collaboration: who said what, in which channel.
  const [activityFeed, setActivityFeed] = useState<ActivityLine[]>([]);
  useEffect(() => {
    let cancelled = false;
    const titleFor = (channel: string) => sessions.find((s) => s.sessionId === channel)?.title || channel;
    const fetchFeed = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 40 });
        if (cancelled) return;
        const lines: ActivityLine[] = res.events.map((ev: ONMEvent, idx: number) => {
          const m = eventToMessage(ev);
          const channel = (ev.target || '').replace(/^channel\//, '');
          let type: ActivityLine['type'] = 'info';
          if (m.messageType === 'thinking') type = 'thinking';
          else if (m.messageType === 'status') type = /failed|error|stopped|denied/i.test(m.content) ? 'error' : 'success';
          else if (m.senderType === 'agent') type = 'info';
          return {
            id: m.messageId || ev.event_id || `activity-${idx}-${ev.timestamp || Date.now()}`,
            time: m.createdAt ? new Date(m.createdAt) : new Date(ev.timestamp),
            sender: m.senderName || (ev.source || '').replace(/^(human:|openagents:)/, ''),
            channel: titleFor(channel),
            content: stripMarkdown(m.content),
            type,
          };
        });
        setActivityFeed(lines);
      } catch {
        /* keep last feed on error */
      }
    };
    fetchFeed();
    const id = setInterval(fetchFeed, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessions]);



  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-border/60">
        <div className="size-8 rounded-lg bg-surface2 flex items-center justify-center">
          <Users className="size-4 text-foreground-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-foreground leading-tight">Overview</h1>
          <p className="text-[11px] text-foreground-extra-muted">Agents and shared activity in this workspace</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Stat icon={<Users className="size-3.5" />} value={`${onlineCount}/${agents.length}`} label="online" />
          {workingCount > 0 && (
            <Stat
              icon={<Loader2 className="size-3.5 animate-spin" />}
              value={`${workingCount}`}
              label="working"
              accent
            />
          )}
          <button
            onClick={() => setConnectModalOpen(true)}
            className="inline-flex items-center justify-center whitespace-nowrap shrink-0 gap-1.5 h-8 px-3.5 rounded-lg text-xs font-bold bg-primary text-white hover:bg-primary/90 transition-all cursor-pointer shadow-sm hover:scale-105 active:scale-95"
            title="Connect an agent to this workspace"
          >
            <Plus className="size-3.5 shrink-0 text-white" />
            <span className="whitespace-nowrap">+ Connect agent</span>
          </button>
        </div>
      </div>

      <ConnectAgentModal
        open={connectModalOpen}
        onOpenChange={setConnectModalOpen}
        onConfigureCustom={() => {
          setConnectModalOpen(false);
          setCustomModalOpen(true);
        }}
      />
      <CustomAgentModal open={customModalOpen} onOpenChange={setCustomModalOpen} />



      {/* Body: agents roster + shared activity */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Agents roster */}
        <div className="flex-1 min-w-0 overflow-y-auto p-5">
          <SectionLabel icon={<Users className="size-3.5" />}>
            Agents · {stations.length}
          </SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4 auto-rows-fr">
            {stations.map((s) => (
              <AgentStation
                key={s.agent.agentName}
                data={s}
                onOpenAgent={() => openAgent(s.agent.agentName, s.focusThread?.sessionId ?? null)}
                onOpenThread={openThread}
                onPairAgent={() => handlePairAgent(s.agent.agentName)}
              />
            ))}
          </div>
        </div>

        {/* Shared activity feed */}
        <aside className="shrink-0 flex flex-col min-h-0 lg:w-[340px] xl:w-[380px] max-h-[42vh] lg:max-h-none border-t lg:border-t-0 lg:border-l border-border/60 bg-surface1/40">
          <div className="shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border/60">
            <span className={cn('size-1.5 rounded-full', activityFeed.length > 0 ? 'bg-status-success animate-pulse' : 'bg-surface4')} />
            <span className="text-sm font-semibold text-foreground">Activity</span>
            <span className="text-[11px] text-foreground-extra-muted ml-auto tabular-nums">{activityFeed.length} events</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
            {activityFeed.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-foreground-extra-muted px-6 text-center">
                <MessageSquare className="size-5" />
                <span className="text-xs">No activity yet. Messages between agents and teammates will appear here.</span>
              </div>
            ) : (
              activityFeed.map((line, idx) => (
                <button
                  key={line.id || `act-line-${idx}`}
                  onClick={() => openThread(line.channel)}
                  className="w-full text-left flex items-start gap-2.5 px-4 py-2 hover:bg-surface2/70 dark:hover:bg-primary/30 transition-colors"
                >
                  <span className={cn('mt-1.5 size-1.5 rounded-full shrink-0', ACTIVITY_DOT[line.type])} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-foreground truncate">{line.sender}</span>
                      <span className="text-[11px] text-foreground-extra-muted truncate">#{line.channel}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-foreground-extra-muted tabular-nums">
                        {line.time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className={cn('text-xs truncate mt-0.5', line.type === 'error' ? 'text-status-danger' : 'text-foreground-muted')}>
                      {line.content || '—'}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-3 text-[11px] font-semibold text-foreground-extra-muted">
      {icon}
      {children}
    </div>
  );
}

function Stat({ icon, value, label, accent }: { icon?: React.ReactNode; value: string; label: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface2/70 border border-border/50">
      {icon && <span className={accent ? 'text-status-warning' : 'text-foreground-extra-muted'}>{icon}</span>}
      <span className="text-xs font-semibold text-foreground tabular-nums">{value}</span>
      <span className="text-[10px] text-foreground-extra-muted">{label}</span>
    </div>
  );
}