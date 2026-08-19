'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Terminal, Brain, ShieldAlert, Clock } from 'lucide-react';
import type { WorkspaceAgent } from '@/lib/types';

export interface SwimlaneEvent {
  id: string;
  agentName: string;
  type: 'tool' | 'thinking' | 'blocked' | 'stalled' | 'message';
  title: string;
  startOffsetSec: number;
  durationSec: number;
  channelTitle?: string;
  sessionId: string;
  status: 'running' | 'success' | 'blocked' | 'error';
}

interface SwimlaneTimelineProps {
  agents: WorkspaceAgent[];
  events: SwimlaneEvent[];
  onOpenThread: (sessionId: string) => void;
  className?: string;
}

export function SwimlaneTimeline({
  agents,
  events,
  onOpenThread,
  className,
}: SwimlaneTimelineProps) {
  const sortedAgents = React.useMemo(() => {
    return [...agents].sort((a, b) => {
      const aHas = events.some((e) => e.agentName === a.agentName);
      const bHas = events.some((e) => e.agentName === b.agentName);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.agentName.localeCompare(b.agentName);
    });
  }, [agents, events]);

  const timeMarkers = [120, 90, 60, 30, 0];

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/40 bg-surface1/70 backdrop-blur-md p-4 space-y-3 shadow-2xs',
        className
      )}
    >
      {/* Header & Legend */}
      <div className="flex items-center justify-between gap-2 border-b border-border/30 pb-2.5">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">
            多 Agent 并行时序泳道
          </span>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 text-[10.5px] font-mono text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded bg-emerald-500" />
            <span>工具执行</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded bg-violet-500" />
            <span>深度思考</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded bg-amber-500 animate-pulse" />
            <span>等待审批</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded bg-rose-500" />
            <span>执行停滞</span>
          </span>
        </div>
      </div>

      {/* Swimlane Grid */}
      <div className="space-y-2 relative">
        {/* Time Axis Header */}
        <div className="flex items-center pl-36 pr-2 text-[10px] font-mono text-muted-foreground/70 justify-between select-none">
          {timeMarkers.map((sec) => (
            <span key={sec}>{sec === 0 ? '现在' : `-${sec}s`}</span>
          ))}
        </div>

        {/* Tracks */}
        <div className="space-y-1.5 divide-y divide-border/20">
          {sortedAgents.map((agent) => {
            const agentEvents = events.filter((e) => e.agentName === agent.agentName);
            const isOnline = agent.status === 'online';

            return (
              <div
                key={agent.agentName}
                className="flex items-center pt-1.5 first:pt-0 group/row hover:bg-surface2/40 rounded-xl transition-colors"
              >
                {/* Agent Left Label */}
                <div className="w-36 shrink-0 flex items-center gap-2 pr-2 select-none">
                  <AgentAvatar
                    name={agent.agentName}
                    agentType={agent.agentType}
                    size={22}
                    status={agent.status}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-foreground truncate">
                      {agent.agentName}
                    </div>
                    <div className="text-[9.5px] font-mono text-muted-foreground truncate">
                      {isOnline ? '在线' : '离线'}
                    </div>
                  </div>
                </div>

                {/* Track Bar Area */}
                <div className="flex-1 h-7 rounded-lg bg-surface2/50 border border-border/30 relative overflow-hidden flex items-center px-1">
                  <div className="absolute inset-0 grid grid-cols-4 pointer-events-none opacity-20 divide-x divide-border" />

                  {agentEvents.length === 0 ? (
                    <span className="text-[10px] font-mono text-muted-foreground/40 italic pl-2">
                      {isOnline ? '空闲待命中' : '进程未连接'}
                    </span>
                  ) : (
                    agentEvents.map((ev) => {
                      const widthPct = Math.min(100, Math.max(8, (ev.durationSec / 120) * 100));
                      const leftPct = Math.max(0, Math.min(92, ((120 - ev.startOffsetSec) / 120) * 100));

                      const bgClass =
                        ev.type === 'blocked'
                          ? 'bg-amber-500/80 text-white animate-pulse border-amber-300'
                          : ev.type === 'stalled'
                          ? 'bg-rose-500/80 text-white border-rose-300'
                          : ev.type === 'thinking'
                          ? 'bg-violet-500/80 text-white border-violet-300'
                          : 'bg-emerald-500/80 text-white border-emerald-300';

                      return (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => onOpenThread(ev.sessionId)}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                          className={cn(
                            'absolute h-5 rounded-md px-1.5 text-[10.5px] font-mono font-medium',
                            'flex items-center gap-1 border shadow-xs transition-transform hover:scale-105 cursor-pointer z-10 truncate',
                            bgClass
                          )}
                          title={`${ev.title} · ${ev.durationSec}s · #${ev.channelTitle}`}
                        >
                          {ev.type === 'thinking' ? (
                            <Brain className="size-3 shrink-0" />
                          ) : ev.type === 'blocked' ? (
                            <ShieldAlert className="size-3 shrink-0" />
                          ) : (
                            <Terminal className="size-3 shrink-0" />
                          )}
                          <span className="truncate">{ev.title}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
