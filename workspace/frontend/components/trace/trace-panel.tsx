'use client';

import { Hint } from '@/components/ui/hint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
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
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { TRANSCRIPT_REVEAL_EVENT } from '@/components/chat/chat-messages';
import { useWorkspace } from '@/lib/workspace-context';
import { useSessionMessages } from '@/components/chat/chat-view';
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

/** A step and its single parse, kept together so nothing re-parses it. */
interface TraceEntry {
  step: WorkspaceMessage;
  parsed: ParsedStep;
}

export function TracePanel() {
  const { currentSessionId, sessions, agents, activeSessionIds } = useWorkspace();
  /*
    The SHARED transcript, not a second stream. This called
    `useMessagePolling` directly, which owns an SSE connection and its own
    cursors — so every time the Studio panel showed the trace, the channel was
    being polled twice and two independent copies of the same messages were
    advancing side by side. See SessionMessagesProvider in chat-view.tsx.
  */
  const { messages } = useSessionMessages();
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

  /*
    PARSE ONCE.

    `parseTraceStep` is regex-heavy, and it was being run three times per step
    per render: once while filtering, once while counting for the header, and
    once more inside each card. On a long agent run — which is exactly when
    this panel is open — that is thousands of redundant regex passes on every
    incoming event.

    The step and its parse travel together from here on.
  */
  const traceSteps = useMemo<TraceEntry[]>(() => {
    const raw = messages || [];
    return raw
      .filter((m) => {
        if (m.messageType === 'status' || m.messageType === 'thinking' || m.messageType === 'todos') return true;
        if (m.metadata?.tool_approval_request || m.metadata?.turn_changes) return true;
        return false;
      })
      .map((step) => ({
        step,
        parsed:
          step.messageType === 'thinking'
            ? ({ type: 'thinking', text: step.content } as ParsedStep)
            : parseTraceStep(step.content),
      }));
  }, [messages]);

  // Extract unique agents who produced trace steps
  const traceAgents = useMemo(() => {
    const set = new Set<string>();
    traceSteps.forEach(({ step }) => {
      if (step.senderName) set.add(step.senderName);
    });
    return Array.from(set);
  }, [traceSteps]);

  // Filtered steps
  const filteredSteps = useMemo(() => {
    return traceSteps.filter(({ step, parsed }) => {
      // Filter by agent
      if (agentFilter !== 'all' && step.senderName !== agentFilter) {
        return false;
      }

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
  /*
    Counted over what is ON SCREEN, not over everything held in memory. The
    header used to read "N events recorded" from the unfiltered list while the
    list below showed the filtered one, so narrowing to "tools" left the
    heading confidently reporting a number that matched nothing visible.
  */
  const stats = useMemo(() => {
    let tools = 0;
    let thinking = 0;
    let subagents = 0;
    filteredSteps.forEach(({ parsed }) => {
      if (parsed.type === 'tool_call') tools++;
      else if (parsed.type === 'thinking') thinking++;
      else if (parsed.type === 'subagents') subagents++;
    });
    return { tools, thinking, subagents, total: filteredSteps.length, all: traceSteps.length };
  }, [filteredSteps, traceSteps.length]);

  /*
    VIRTUALISED, like the transcript next to it.

    This rendered `filteredSteps.map(...)` in full. A single long agent run
    emits status messages continuously, so the panel that exists specifically
    to be open DURING long runs was the one list in the app with unbounded DOM
    — thousands of cards, each with an avatar and a collapsible `Reasoning`
    block, all live while more arrive.

    Dynamic measurement rather than a fixed row height: a tool call is one
    line, an expanded reasoning block is fifty. `estimateSize` is deliberately
    small (72px) because most steps ARE one-liners; over-estimating makes the
    scrollbar lie in the other direction, which is worse while tailing.
  */
  const virtualizer = useVirtualizer({
    count: filteredSteps.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 72,
    overscan: 12,
    getItemKey: (index) => filteredSteps[index]?.step.messageId ?? index,
  });

  /*
    ── The link back to the conversation ──

    Opening the trace from an inline step already worked; coming back did not.
    Clicking a trace entry did nothing, so the panel could tell you WHAT
    happened but never where it sat in the thread — and reading a trace almost
    always ends with wanting the surrounding turn.

    A window event rather than shared state: the transcript is virtualised and
    owns its own scroller, so only it can turn a message id into a scroll
    position. Fire-and-forget is also the honest shape — if the message is not
    in the loaded window, nothing happens, which is the correct outcome.
  */
  const revealInTranscript = useCallback((messageId: string) => {
    if (!messageId) return;
    window.dispatchEvent(new CustomEvent(TRANSCRIPT_REVEAL_EVENT, { detail: { messageId } }));
  }, []);

  /*
    Tail the stream — WITHOUT `behavior: 'smooth'`.

    Steps arrive in bursts while an agent works, and each burst fired another
    smooth scroll before the previous animation had finished. Queued smooth
    scrolls fight each other: the panel drifts, overshoots, and lags behind the
    content it is supposed to be pinned to. A log tail is not a place the user
    needs easing — it should simply already be at the bottom.

    Writing `scrollTop` directly rather than `scrollIntoView` for the same
    reason `scrollIntoView` is wrong here: it scrolls every scrollable
    ANCESTOR too, so a trace update could move the panel's own container.
  */
  useEffect(() => {
    if (!isAutoScroll || filteredSteps.length === 0) return;
    virtualizer.scrollToIndex(filteredSteps.length - 1, { align: 'end' });
  }, [filteredSteps.length, isAutoScroll, virtualizer]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    setIsAutoScroll(nearBottom);
  };

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground text-xs select-text overflow-hidden">
      {/* ── Top Header Bar ── */}
      {/*
        `.app-header` owns the height, fill, underline and the caption-button
        reserve for every top-level band in this app. This one hand-rolled all
        four — `bg-surface1/60`, a plain `--border`, and a hardcoded `pr-12`
        standing in for `--window-controls-inset` — so the trace was the only
        panel whose header was neither the chrome colour nor aligned with the
        headers beside it. The `backdrop-blur-md` went with them: it is the
        property that cost this app its draggable window once already.
      */}
      <div className="app-header justify-between shrink-0 select-none">
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
              {stats.total === stats.all
                ? `${stats.all} events`
                : `${stats.total} of ${stats.all} events`}
            </span>
          </div>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-1 shrink-0">
          <Hint label={isAutoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}>
            <button
              onClick={() => setIsAutoScroll((v) => !v)}
              className={cn(
                'size-6.5 flex items-center justify-center rounded-lg border transition-colors',
                isAutoScroll
                  ? 'text-status-success border-status-success/30 bg-surface2'
                  : 'text-foreground-muted border-border hover:text-foreground'
              )}
            >
              <ArrowDownToLine className="size-3" />
            </button>
          </Hint>
        </div>
      </div>

      {/* ── Filter & Search Toolbar ── */}
      <div className="flex flex-col gap-2 p-3 border-b border-border/60 bg-surface1/30 shrink-0">
        {/* Search input + Stats Pills */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-surface2/80 border border-border/60 focus-within:border-border-accent transition-colors">
            <Search className="size-3 text-foreground-muted shrink-0" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search trace events..."
            data-view-search
              className="bg-transparent border-0 outline-none text-2xs w-full text-foreground placeholder:text-foreground-extra-muted"
            />
          </div>

          <div className="flex items-center gap-1 text-3xs font-mono text-foreground-extra-muted shrink-0">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface2 border border-border/60">
              <Wrench className="size-2.5 shrink-0" aria-hidden />
              {stats.tools}
            </span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface2 border border-border/60">
              <Brain className="size-2.5 shrink-0" aria-hidden />
              {stats.thinking}
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
                'px-2 py-0.5 rounded font-medium transition-colors',
                filterType === 'all'
                  ? 'bg-surface0 text-foreground font-semibold shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilterType('tools')}
              className={cn(
                'px-2 py-0.5 rounded font-medium transition-colors flex items-center gap-1',
                filterType === 'tools'
                  ? 'bg-surface0 text-foreground font-semibold shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <Wrench className="size-2.5" />
              <span>Tools ({stats.tools})</span>
            </button>
            <button
              onClick={() => setFilterType('thinking')}
              className={cn(
                'px-2 py-0.5 rounded font-medium transition-colors flex items-center gap-1',
                filterType === 'thinking'
                  ? 'bg-surface0 text-foreground font-semibold shadow-xs'
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
                  'px-2 py-0.5 rounded font-medium transition-colors flex items-center gap-1',
                  filterType === 'subagents'
                    ? 'bg-surface0 text-foreground font-semibold shadow-xs'
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
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger size="sm" className="w-auto max-w-[130px] text-3xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">@All Agents</SelectItem>
                {traceAgents.map((agentName) => (
                  <SelectItem key={agentName} value={agentName}>
                    @{agentName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
        className="flex-1 min-h-0 overflow-y-auto p-3.5"
      >
        {filteredSteps.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-foreground-muted select-none">
            <div className="size-10 rounded-2xl bg-surface2 border border-border flex items-center justify-center mb-2.5">
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
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const entry = filteredSteps[row.index];
              if (!entry) return null;
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${row.start}px)`,
                    paddingBottom: '0.625rem',
                  }}
                >
                  <TraceStepCard
                    step={entry.step}
                    parsed={entry.parsed}
                    agents={agents}
                    isWorking={isWorking}
                    isLatest={row.index === filteredSteps.length - 1}
                    onReveal={revealInTranscript}
                  />
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Single Trace Step Card Component ──
function TraceStepCard({
  step,
  parsed,
  agents,
  isWorking = false,
  isLatest = false,
  onReveal,
}: {
  step: WorkspaceMessage;
  /** Parsed once by the panel — see the note on `traceSteps`. */
  parsed: ParsedStep;
  agents?: WorkspaceAgent[];
  isWorking?: boolean;
  isLatest?: boolean;
  onReveal?: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timeStr = step.createdAt
    ? new Date(step.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  const handleCopyArgs = (argsStr: string) => {
    navigator.clipboard.writeText(argsStr);
    setCopied(true);
    toast.success('Parameters copied');
    setTimeout(() => setCopied(false), 2000);
  };

  if (parsed.type === 'thinking') {
    const isThinkingWithContent = !!parsed.text && parsed.text !== 'thinking...' && parsed.text.toLowerCase() !== 'thinking';
    const isActiveThinking = isWorking && isLatest;

    return (
      <div
        className={cn(
          "rounded-xl border border-border/60 bg-surface1/60 p-2.5 space-y-1.5",
          // Double-click, not click: single clicks inside these cards
          // belong to the copy buttons and the reasoning disclosure,
          // and stealing them to navigate would make the panel hostile
          // to the reading it exists for.
          onReveal && step.messageId && "cursor-pointer hover:border-brand-border",
        )}
        onDoubleClick={
          onReveal && step.messageId ? () => onReveal(step.messageId) : undefined
        }
        title={onReveal && step.messageId ? "Double-click to show in the thread" : undefined}
      >
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
        ) : isActiveThinking ? (
          <span className="event-running text-2xs text-foreground-extra-muted">reasoning in progress…</span>
        ) : (
          <span className="text-2xs text-foreground-extra-muted italic">Reasoning halted</span>
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
      <div
        className={cn(
          "rounded-xl border border-border/60 bg-surface1/60 p-2.5 space-y-1.5",
          // Double-click, not click: single clicks inside these cards
          // belong to the copy buttons and the reasoning disclosure,
          // and stealing them to navigate would make the panel hostile
          // to the reading it exists for.
          onReveal && step.messageId && "cursor-pointer hover:border-brand-border",
        )}
        onDoubleClick={
          onReveal && step.messageId ? () => onReveal(step.messageId) : undefined
        }
        title={onReveal && step.messageId ? "Double-click to show in the thread" : undefined}
      >
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
      <div
        className={cn(
          "rounded-xl border border-border/60 bg-surface1/60 p-2.5 space-y-1.5",
          // Double-click, not click: single clicks inside these cards
          // belong to the copy buttons and the reasoning disclosure,
          // and stealing them to navigate would make the panel hostile
          // to the reading it exists for.
          onReveal && step.messageId && "cursor-pointer hover:border-brand-border",
        )}
        onDoubleClick={
          onReveal && step.messageId ? () => onReveal(step.messageId) : undefined
        }
        title={onReveal && step.messageId ? "Double-click to show in the thread" : undefined}
      >
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
                title="Copy parameters"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCopyArgs(parsed.args!);
                }}
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
    <div className="rounded-xl border border-border/60 bg-surface1/40 p-2 text-3xs flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-foreground-muted min-w-0">
        <AgentAvatar name={step.senderName} size={12} />
        <span className="font-semibold text-foreground shrink-0">@{step.senderName}</span>
        <span className="truncate text-foreground-extra-muted">{parsed.text || step.content}</span>
      </div>
      <span className="text-foreground-extra-muted font-mono tabular-nums shrink-0 ml-2">{timeStr}</span>
    </div>
  );
}
