'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  Activity,
  Brain,
  Wrench,
  GitFork,
  Search,
  ArrowDownToLine,
  Copy,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { SubagentList } from '@/components/ai-elements/subagent-list';
import { EventLine, EventLineAction, EventLinePre } from '@/components/ai-elements/event-line';
import { WorkingIndicator } from '@/components/chat/working-indicator';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { toast } from 'sonner';

export interface SubagentInfo {
  index: number;
  role: string;
  typeName: string;
  prompt: string;
  workspace: string;
  model: string;
  subagentId?: string;
  status?: 'running' | 'completed' | 'failed';
  steps?: { tool: string; summary: string }[];
}

interface ParsedStep {
  type: 'thinking' | 'tool_call' | 'status' | 'compacting' | 'subagents';
  tool?: string;
  toolDisplay?: string;
  args?: string;
  summary?: string;
  text?: string;
  subagents?: SubagentInfo[];
}

function cleanToolName(name: string): string {
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) return mcpMatch[1];
  const mcpMatch2 = name.match(/^mcp_[^_]+--.+?__(.+)$/);
  if (mcpMatch2) return mcpMatch2[1];
  return name;
}

function parseSubagentsPayload(raw: string): SubagentInfo[] | null {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data.length > 0) {
      return data.map((item, idx) => ({
        index: item.index ?? idx,
        role: item.role ?? item.Role ?? item.TypeName ?? item.typeName ?? 'Subagent',
        typeName: item.typeName ?? item.TypeName ?? 'research',
        prompt: item.prompt ?? item.Prompt ?? '',
        workspace: item.workspace ?? item.Workspace ?? 'inherit',
        model: item.model ?? item.Model ?? 'inherit',
        subagentId: item.subagentId ?? item.SubagentId ?? item.id ?? item.Id,
        status: item.status ?? 'running',
        steps: item.steps || [],
      }));
    }
    const subagentsList = data.Subagents || data.subagents;
    if (Array.isArray(subagentsList) && subagentsList.length > 0) {
      return subagentsList.map((item: any, idx: number) => ({
        index: idx,
        role: item.Role ?? item.role ?? item.TypeName ?? item.typeName ?? 'Subagent',
        typeName: item.TypeName ?? item.typeName ?? 'research',
        prompt: item.Prompt ?? item.prompt ?? '',
        workspace: item.Workspace ?? item.workspace ?? 'inherit',
        model: item.Model ?? item.model ?? 'inherit',
        subagentId: item.SubagentId ?? item.subagentId ?? item.Id ?? item.id,
        status: 'running',
        steps: [],
      }));
    }
  } catch {
    const m = raw.match(/([A-Za-z0-9 _-]+):\s*([\s\S]+)/);
    if (m) {
      return [{
        index: 0,
        role: m[1].trim(),
        typeName: 'research',
        prompt: m[2].trim(),
        workspace: 'inherit',
        model: 'inherit',
        status: 'running',
      }];
    }
  }
  return null;
}

function extractToolSummary(tool: string, args: string): string {
  const fileMatch = args.match(/'file_path':\s*'([^']+)'/);
  if (fileMatch && ['Write', 'Read', 'Edit'].includes(tool)) {
    return fileMatch[1];
  }

  const commandMatch = args.match(/'command':\s*'([^']+)'/);
  if (commandMatch && tool === 'Bash') {
    return commandMatch[1].slice(0, 80);
  }

  const statusMatch = args.match(/'status':\s*'([^']+)'/);
  if (statusMatch) return statusMatch[1];

  const contentMatch = args.match(/'content':\s*'([^']{0,60})/);
  if (contentMatch) {
    return contentMatch[1] + (contentMatch[1].length >= 60 ? '...' : '');
  }

  const patternMatch = args.match(/'pattern':\s*'([^']+)'/);
  if (patternMatch) return patternMatch[1];

  return args.length > 60 ? args.slice(0, 60) + '...' : args;
}

function parseTraceStep(content: string): ParsedStep {
  if (content === 'thinking...' || content.toLowerCase() === 'thinking') {
    return { type: 'thinking', text: content };
  }

  const thinkingMatch = content.match(/^\*\*Thinking:\*\*\n([\s\S]+)$/);
  if (thinkingMatch) {
    return { type: 'thinking', text: thinkingMatch[1].trim() };
  }

  const toolMatch = content.match(
    /\*\*Using tool:\*\*\s*`([^`]+)`\s*```([\s\S]*?)```/
  );
  if (toolMatch) {
    const rawTool = toolMatch[1];
    const args = toolMatch[2].trim();
    const toolDisplay = cleanToolName(rawTool);
    if (toolDisplay.toLowerCase() === 'invoke_subagent' || toolDisplay.toLowerCase() === 'subagent') {
      const subagents = parseSubagentsPayload(args);
      if (subagents && subagents.length > 0) {
        return { type: 'subagents', tool: rawTool, toolDisplay: 'Subagents', args, subagents };
      }
    }
    const summary = extractToolSummary(toolDisplay, args);
    return { type: 'tool_call', tool: rawTool, toolDisplay, args, summary };
  }

  const runMatch = content.match(/\*\*Running:\*\*\s*`([^`]+)`/);
  if (runMatch) {
    return { type: 'tool_call', tool: 'Bash', toolDisplay: 'Bash', summary: runMatch[1] };
  }

  const editMatch = content.match(/\*\*Editing:\*\*\s*`([^`]+)`/);
  if (editMatch) {
    return { type: 'tool_call', tool: 'Edit', toolDisplay: 'Edit', summary: editMatch[1] };
  }

  const inlineToolMatch = content.match(/^([A-Za-z][\w.-]*)\s*›\s*([\s\S]+)$/);
  if (inlineToolMatch) {
    const toolDisplay = cleanToolName(inlineToolMatch[1].trim());
    const args = inlineToolMatch[2].trim();
    if (toolDisplay.toLowerCase() === 'invoke_subagent' || toolDisplay.toLowerCase() === 'subagent') {
      const subagents = parseSubagentsPayload(args);
      if (subagents && subagents.length > 0) {
        return { type: 'subagents', tool: toolDisplay, toolDisplay: 'Subagents', args, subagents };
      }
    }
    const oneLine = args.replace(/\s+/g, ' ').trim();
    return {
      type: 'tool_call',
      tool: toolDisplay,
      toolDisplay,
      args,
      summary: oneLine.length > 100 ? oneLine.slice(0, 100) + '…' : oneLine,
    };
  }

  if (/compact/i.test(content)) {
    return { type: 'compacting', text: content };
  }

  return { type: 'status', text: content };
}

type StepFilterType = 'all' | 'tools' | 'thinking' | 'subagents';

export function TracePanel() {
  const { currentSessionId, sessions, agents, activeSessionIds } = useWorkspace();
  const { messages } = useMessagePolling({ sessionId: currentSessionId });
  const [filterType, setFilterType] = useState<StepFilterType>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isAutoScroll, setIsAutoScroll] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === currentSessionId),
    [sessions, currentSessionId]
  );

  const isWorking = Boolean(currentSessionId && activeSessionIds.has(currentSessionId));

  // Extract all steps from current session messages
  const traceSteps = useMemo(() => {
    const raw = messages || [];
    return raw.filter((m) => {
      if (m.messageType === 'status' || m.messageType === 'thinking' || m.messageType === 'todos') return true;
      if (m.metadata?.tool_approval_request || m.metadata?.turn_changes) return true;
      return false;
    });
  }, [messages]);

  // Extract unique agents who produced trace steps
  const traceAgents = useMemo(() => {
    const set = new Set<string>();
    traceSteps.forEach((s) => {
      if (s.senderName) set.add(s.senderName);
    });
    return Array.from(set);
  }, [traceSteps]);

  // Filtered steps
  const filteredSteps = useMemo(() => {
    return traceSteps.filter((step) => {
      // Filter by agent
      if (agentFilter !== 'all' && step.senderName !== agentFilter) {
        return false;
      }

      const parsed = step.messageType === 'thinking'
        ? { type: 'thinking' as const, text: step.content }
        : parseTraceStep(step.content);

      // Filter by type
      if (filterType === 'tools' && parsed.type !== 'tool_call') return false;
      if (filterType === 'thinking' && parsed.type !== 'thinking') return false;
      if (filterType === 'subagents' && parsed.type !== 'subagents') return false;

      // Filter by search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const contentMatch = step.content.toLowerCase().includes(q);
        const senderMatch = step.senderName.toLowerCase().includes(q);
        const toolMatch = parsed.toolDisplay?.toLowerCase().includes(q);
        if (!contentMatch && !senderMatch && !toolMatch) return false;
      }

      return true;
    });
  }, [traceSteps, agentFilter, filterType, searchQuery]);

  // Aggregate statistics
  const stats = useMemo(() => {
    let tools = 0;
    let thinking = 0;
    let subagents = 0;

    traceSteps.forEach((s) => {
      if (s.messageType === 'thinking') {
        thinking++;
      } else {
        const parsed = parseTraceStep(s.content);
        if (parsed.type === 'tool_call') tools++;
        else if (parsed.type === 'thinking') thinking++;
        else if (parsed.type === 'subagents') subagents++;
      }
    });

    return { tools, thinking, subagents, total: traceSteps.length };
  }, [traceSteps]);

  // Auto-scroll when new steps arrive and auto-scroll is enabled
  useEffect(() => {
    if (isAutoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredSteps.length, isAutoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    setIsAutoScroll(nearBottom);
  };

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground text-xs select-text overflow-hidden">
      {/* ── Top Header Bar ── */}
      <div className="flex items-center justify-between pl-4 pr-12 py-2.5 border-b border-border/70 bg-surface1/60 backdrop-blur-md shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-6.5 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Activity className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-foreground truncate">
                {activeSession?.title || 'Execution Trace'}
              </span>
              {isWorking && (
                <span className="event-running text-3xs font-medium text-primary shrink-0">
                  Live
                </span>
              )}
            </div>
            <span className="text-3xs text-foreground-extra-muted font-mono">
              {stats.total} events recorded
            </span>
          </div>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setIsAutoScroll((v) => !v)}
            className={cn(
              'size-6.5 flex items-center justify-center rounded-lg border transition-colors cursor-pointer',
              isAutoScroll
                ? 'text-status-success border-status-success/30 bg-surface2'
                : 'text-foreground-muted border-border hover:text-foreground'
            )}
            title={isAutoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
          >
            <ArrowDownToLine className="size-3" />
          </button>
        </div>
      </div>

      {/* ── Filter & Search Toolbar ── */}
      <div className="flex flex-col gap-2 p-3 border-b border-border/50 bg-surface1/30 shrink-0">
        {/* Search input + Stats Pills */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-surface2/80 border border-border/60 focus-within:border-border-accent transition-colors">
            <Search className="size-3 text-foreground-muted shrink-0" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search trace events..."
              className="bg-transparent border-0 outline-none text-2xs w-full text-foreground placeholder:text-foreground-extra-muted"
            />
          </div>

          <div className="flex items-center gap-1 text-3xs font-mono text-foreground-extra-muted shrink-0">
            <span className="px-1.5 py-0.5 rounded bg-surface2 border border-border/40">
              ⚡ {stats.tools}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-surface2 border border-border/40">
              💭 {stats.thinking}
            </span>
          </div>
        </div>

        {/* Type Tabs + Agent Selector */}
        <div className="flex items-center justify-between gap-1 overflow-x-auto">
          {/* Type filters */}
          <div className="flex items-center p-0.5 rounded-lg bg-surface2 border border-border text-3xs">
            <button
              onClick={() => setFilterType('all')}
              className={cn(
                'px-2 py-0.5 rounded font-medium transition-colors cursor-pointer',
                filterType === 'all'
                  ? 'bg-surface0 text-foreground font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilterType('tools')}
              className={cn(
                'px-2 py-0.5 rounded font-medium transition-colors cursor-pointer flex items-center gap-1',
                filterType === 'tools'
                  ? 'bg-surface0 text-foreground font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <Wrench className="size-2.5" />
              <span>Tools ({stats.tools})</span>
            </button>
            <button
              onClick={() => setFilterType('thinking')}
              className={cn(
                'px-2 py-0.5 rounded font-medium transition-colors cursor-pointer flex items-center gap-1',
                filterType === 'thinking'
                  ? 'bg-surface0 text-foreground font-semibold shadow-2xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <Brain className="size-2.5" />
              <span>Thoughts</span>
            </button>
            {stats.subagents > 0 && (
              <button
                onClick={() => setFilterType('subagents')}
                className={cn(
                  'px-2 py-0.5 rounded font-medium transition-colors cursor-pointer flex items-center gap-1',
                  filterType === 'subagents'
                    ? 'bg-surface0 text-foreground font-semibold shadow-2xs'
                    : 'text-foreground-muted hover:text-foreground'
                )}
              >
                <GitFork className="size-2.5" />
                <span>Subagents</span>
              </button>
            )}
          </div>

          {/* Agent Filter Pill Selector */}
          {traceAgents.length > 1 && (
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="px-2 py-0.5 rounded-lg bg-surface2 border border-border/70 text-3xs font-medium text-foreground outline-none cursor-pointer max-w-[110px] truncate"
            >
              <option value="all">@All Agents</option>
              {traceAgents.map((agentName) => (
                <option key={agentName} value={agentName}>
                  @{agentName}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ── Active Live Indicator when Agent is Working ── */}
      {isWorking && (
        <div className="flex items-center justify-between px-3.5 py-1.5 bg-primary/8 border-b border-primary/20 text-2xs text-foreground shrink-0">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-status-success animate-pulse" />
            <span className="font-semibold text-primary">Active execution in progress</span>
          </div>
          <WorkingIndicator label="running" />
        </div>
      )}

      {/* ── Trace Events Stream ── */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-2.5"
      >
        {filteredSteps.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-foreground-muted select-none">
            <div className="size-10 rounded-2xl bg-surface2 border border-border/80 flex items-center justify-center mb-2.5">
              <Activity className="size-5 text-foreground-extra-muted" />
            </div>
            <p className="text-xs font-semibold text-foreground">No trace events found</p>
            <p className="text-3xs text-foreground-extra-muted max-w-xs mt-0.5 leading-relaxed">
              {searchQuery || filterType !== 'all' || agentFilter !== 'all'
                ? 'No events match the active filters.'
                : 'Tool calls, agent reasoning, and subagent delegations will stream here in real time.'}
            </p>
          </div>
        ) : (
          filteredSteps.map((step, idx) => (
            <TraceStepCard key={step.messageId || `step-${idx}`} step={step} agents={agents} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Single Trace Step Card Component ──
function TraceStepCard({ step, agents }: { step: WorkspaceMessage; agents?: WorkspaceAgent[] }) {
  const [copied, setCopied] = useState(false);
  const timeStr = step.createdAt
    ? new Date(step.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  const parsed = step.messageType === 'thinking'
    ? { type: 'thinking' as const, text: step.content }
    : parseTraceStep(step.content);

  const handleCopyArgs = (argsStr: string) => {
    navigator.clipboard.writeText(argsStr);
    setCopied(true);
    toast.success('Parameters copied');
    setTimeout(() => setCopied(false), 2000);
  };

  if (parsed.type === 'thinking') {
    const isThinkingWithContent = !!parsed.text && parsed.text !== 'thinking...' && parsed.text.toLowerCase() !== 'thinking';
    return (
      <div className="rounded-xl border border-border/60 bg-surface1/60 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between text-3xs select-none">
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <AgentAvatar name={step.senderName} size={14} />
            <span className="font-semibold text-foreground">@{step.senderName}</span>
            <span className="text-foreground-extra-muted font-mono">thought</span>
          </div>
          <span className="text-foreground-extra-muted font-mono tabular-nums">{timeStr}</span>
        </div>
        {isThinkingWithContent ? (
          <Reasoning content={parsed.text!} defaultExpanded={false} />
        ) : (
          <span className="event-running text-2xs text-foreground-extra-muted">reasoning in progress…</span>
        )}
      </div>
    );
  }

  if (parsed.type === 'subagents' && parsed.subagents && parsed.subagents.length > 0) {
    const agentItems = parsed.subagents.map((a) => ({
      name: a.role || a.typeName || 'Subagent',
      role: a.role,
      model: a.model && a.model !== 'inherit' ? a.model : undefined,
      workspace: a.workspace,
      prompt: a.prompt,
      status: a.status || 'running',
      steps: a.steps,
    }));
    return (
      <div className="rounded-xl border border-border/60 bg-surface1/60 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between text-3xs select-none">
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <AgentAvatar name={step.senderName} size={14} />
            <span className="font-semibold text-foreground">@{step.senderName}</span>
            <span className="px-1 rounded bg-primary/10 text-primary font-mono font-medium">Subagents</span>
          </div>
          <span className="text-foreground-extra-muted font-mono tabular-nums">{timeStr}</span>
        </div>
        <SubagentList agents={agentItems} completedCount={0} />
      </div>
    );
  }

  if (parsed.type === 'tool_call') {
    return (
      <div className="rounded-xl border border-border/60 bg-surface1/60 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between text-3xs select-none">
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <AgentAvatar name={step.senderName} size={14} />
            <span className="font-semibold text-foreground">@{step.senderName}</span>
            <span className="text-foreground-extra-muted font-mono">›</span>
            <span className="font-mono font-medium text-foreground">{parsed.toolDisplay || 'Tool'}</span>
          </div>
          <span className="text-foreground-extra-muted font-mono tabular-nums">{timeStr}</span>
        </div>

        <EventLine
          icon={<Wrench />}
          label={parsed.toolDisplay || 'Tool Call'}
          detail={parsed.summary}
          actions={
            parsed.args ? (
              <EventLineAction
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCopyArgs(parsed.args!);
                }}
                title="Copy parameters"
              >
                {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
              </EventLineAction>
            ) : undefined
          }
        >
          {parsed.args && <EventLinePre>{parsed.args}</EventLinePre>}
        </EventLine>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/40 bg-surface1/40 p-2 text-3xs flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-foreground-muted min-w-0">
        <AgentAvatar name={step.senderName} size={12} />
        <span className="font-semibold text-foreground shrink-0">@{step.senderName}</span>
        <span className="truncate text-foreground-extra-muted">{parsed.text || step.content}</span>
      </div>
      <span className="text-foreground-extra-muted font-mono tabular-nums shrink-0 ml-2">{timeStr}</span>
    </div>
  );
}
