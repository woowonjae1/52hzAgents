'use client';

import { memo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Brain,
  Wrench,
  Activity,
  Pencil,
  Eye,
  Terminal,
  Search,
  Clock,
  Users,
  RefreshCw,
  ListTodo,
  Copy,
  Check,
  CheckCircle2,
  Circle,
  Ban,
  Dot,
  GitFork,
  Bot,
  Cpu,
  Layers,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { WorkingIndicator } from './working-indicator';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { EventLine, EventLineAction, EventLinePre } from '@/components/ai-elements/event-line';
import { SubagentList } from '@/components/ai-elements/subagent-list';
import { MarkdownContent } from './markdown-content';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';

// ── Content Parsing ──

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
    // If not JSON, check if text has role or subagent mention
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

function parseStepContent(content: string): ParsedStep {
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
    return {
      type: 'tool_call',
      tool: 'Bash',
      toolDisplay: 'Bash',
      summary: runMatch[1],
    };
  }

  const editMatch = content.match(/\*\*Editing:\*\*\s*`([^`]+)`/);
  if (editMatch) {
    return {
      type: 'tool_call',
      tool: 'Edit',
      toolDisplay: 'Edit',
      summary: editMatch[1],
    };
  }

  // Adapters post tool activity as a plain "Name > args" status line
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

function cleanToolName(name: string): string {
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) return mcpMatch[1];
  const mcpMatch2 = name.match(/^mcp_[^_]+--.+?__(.+)$/);
  if (mcpMatch2) return mcpMatch2[1];
  return name;
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

// ── Icon Mapping ──

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Write: Pencil,
  Edit: Pencil,
  Read: Eye,
  Bash: Terminal,
  Glob: Search,
  Grep: Search,
  workspace_status: Activity,
  workspace_get_history: Clock,
  workspace_get_agents: Users,
};

function getStepIcon(parsed: ParsedStep) {
  if (parsed.type === 'thinking') return Brain;
  if (parsed.type === 'compacting') return RefreshCw;
  if (parsed.type === 'status') return Activity;
  return TOOL_ICONS[parsed.toolDisplay || ''] || Wrench;
}

function isPlaceholderThinking(message: WorkspaceMessage): boolean {
  if (message.messageType === 'todos') return false;
  const parsed = message.messageType === 'thinking'
    ? { type: 'thinking' as const, text: message.content }
    : parseStepContent(message.content);
  if (parsed.type !== 'thinking') return false;
  const t = (parsed.text || '').trim().toLowerCase();
  return t === '' || t === 'thinking...' || t === 'thinking';
}

function SubagentTree({ subagents }: { subagents: SubagentInfo[] }) {
  const [open, setOpen] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  if (!subagents || subagents.length === 0) return null;

  return (
    <div className="my-2 rounded-xl border border-border/80 bg-surface1/70 backdrop-blur-md p-3 shadow-2xs">
      {/* Root Header */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 text-left cursor-pointer group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <GitFork className="size-3.5" />
          </span>
          <span className="text-xs font-semibold text-foreground tracking-tight">
            Subagents Pool ({subagents.length} Concurrent Worker{subagents.length > 1 ? 's' : ''})
          </span>
          <span className="text-3xs font-mono px-1.5 py-0.5 rounded bg-surface2 text-foreground-muted border border-border/60">
            Parallel Delegations
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-foreground-extra-muted">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {/* Subagents Nested Tree */}
      {open && (
        <div className="mt-2.5 space-y-2 border-l-2 border-primary/30 pl-3 ml-2.5">
          {subagents.map((agent, i) => {
            const isRunning = agent.status === 'running';
            return (
              <div key={agent.index ?? i} className="rounded-lg border border-border/60 bg-surface2/60 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="flex size-5 items-center justify-center rounded-md bg-surface3 text-foreground-muted">
                      <Bot className="size-3" />
                    </span>
                    <span className="text-xs font-semibold text-foreground truncate">
                      {agent.role}
                    </span>
                    <span className="text-3xs font-mono px-1.5 py-0.2 rounded bg-surface3 text-foreground-muted">
                      {agent.typeName}
                    </span>
                    {agent.workspace && agent.workspace !== 'inherit' && (
                      <span className="text-3xs font-mono px-1.5 py-0.2 rounded bg-surface2/10 text-foreground-muted">
                        ws:{agent.workspace}
                      </span>
                    )}
                    {agent.model && agent.model !== 'inherit' && (
                      <span className="text-3xs font-mono px-1.5 py-0.2 rounded bg-status-warning/10 text-status-warning">
                        {agent.model}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1 text-3xs font-medium text-status-success">
                        <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
                        <span>Working</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-3xs font-medium text-foreground-muted">
                        <Check className="size-3 text-status-success" />
                        <span>Ready</span>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(agent.prompt);
                        setCopiedId(agent.index ?? i);
                        setTimeout(() => setCopiedId(null), 2000);
                      }}
                      className="p-1 rounded text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors cursor-pointer"
                      title="Copy subagent prompt"
                    >
                      {copiedId === (agent.index ?? i) ? (
                        <Check className="size-3 text-status-success" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                  </div>
                </div>

                {agent.prompt && (
                  <div className="text-2xs font-mono text-foreground-muted bg-surface1/80 border border-border/40 p-2 rounded-md whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto">
                    {agent.prompt}
                  </div>
                )}

                {/* Subagent Internal Steps Trace */}
                {agent.steps && agent.steps.length > 0 && (
                  <div className="mt-1 space-y-1 pl-2 border-l border-border/60">
                    {agent.steps.map((st, sIdx) => (
                      <div key={sIdx} className="flex items-center gap-1.5 text-3xs font-mono text-foreground-extra-muted">
                        <span>└──</span>
                        <span className="font-semibold text-foreground-muted">{st.tool}:</span>
                        <span className="truncate">{st.summary}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Step Item ──

const SingleStep = memo(function SingleStep({ message }: { message: WorkspaceMessage }) {
  // No `expanded` state: the disclosure is a native `<details>` inside
  // `EventLine` now, so nothing here owns open/closed.
  const [copied, setCopied] = useState(false);

  if (message.messageType === 'todos') {
    const todos = (message.metadata?.todos as Array<{ content: string; status: string; assignee?: string }>) || [];
    if (!todos.length) return null;
    return (
      <div className="py-0.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <ListTodo className="size-3.5 shrink-0 text-foreground-muted" />
          <span className="font-medium">To-do list</span>
        </div>
        <div className="ml-[22px] space-y-0.5">
          {todos.map((t, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-xs">
              {t.status === 'completed' ? (
                <Check className="size-3 shrink-0 text-foreground-extra-muted" />
              ) : t.status === 'in_progress' ? (
                <Dot className="size-3 shrink-0 text-foreground-muted" />
              ) : t.status === 'cancelled' ? (
                <Ban className="size-3 shrink-0 text-foreground-extra-muted" />
              ) : (
                <Circle className="size-3 shrink-0 text-foreground-extra-muted opacity-50" />
              )}
              {/* Shimmer on the active item, matching `TodoList` and every other
                  in-flight thing in the app. Was a spinning primary-coloured
                  `Loader2` beside a green `CheckCircle2` -- a two-colour status
                  scheme inside a step body, three levels deep in the transcript. */}
              <span className={cn(
                t.status === 'in_progress' && 'event-running',
                (t.status === 'completed' || t.status === 'cancelled') && 'line-through text-foreground-extra-muted'
              )}>{t.content}</span>
              {t.assignee && (
                <span className="text-muted-foreground/50 text-3xs">{t.assignee}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isPlaceholderThinking(message)) return null;

  const parsed = message.messageType === 'thinking'
    ? { type: 'thinking' as const, text: message.content }
    : parseStepContent(message.content);
  const Icon = getStepIcon(parsed);
  const hasDetail = parsed.type === 'tool_call' && !!parsed.args;
  const isThinkingWithContent = parsed.type === 'thinking' && !!parsed.text && parsed.text !== 'thinking...' && parsed.text.toLowerCase() !== 'thinking';

  if (isThinkingWithContent) {
    // A `**Thinking:**` prefix inside a status message -- the shape a couple of
    // connectors use instead of a real thinking event. Collapsed by default like
    // any other thought, and indented off the shared rail rather than the
    // hand-measured `ml-[22px]` that used to approximate it.
    return (
      <EventLine icon={<Icon />} label="Thought">
        <div className="whitespace-pre-wrap py-0.5 text-xs leading-relaxed text-foreground-muted">
          {parsed.text}
        </div>
      </EventLine>
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
    const completedCount = agentItems.filter((a) => a.status === 'completed').length;
    return (
      <SubagentList
        agents={agentItems}
        completedCount={completedCount}
        showSummary={agentItems.length > 1}
        summaryAgent={{ name: 'Synthesis Lead', model: 'Lead Orchestrator' }}
      />
    );
  }

  if (parsed.type === 'tool_call') {
    /*
     * The last block in the transcript that still drew its own frame.
     *
     * It was a full-width `rounded-lg border px-2.5 py-1.5` row holding a 20px
     * `bg-surface3` icon TILE, a `ChevronRight` pinned to the far right by
     * `ml-auto`, and — once expanded — a second bordered, shadowed card with its
     * own header bar. Three frames for one event. Since every tool call draws
     * through here, it was also the most-seen block in the app, so P0 unifying
     * `ai-elements/*` while leaving this alone meant the thing people look at
     * most was the thing still shaped differently from everything else.
     *
     * Now it is an `EventLine` like a plan, a diff or an approval prompt: the
     * icon and the chevron share one 16px slot at the head of the row, the
     * argument sits in a chip, and the expanded body uses the shared rail and
     * the shared `<pre>` instead of a card.
     */
    return (
      <EventLine
        icon={<Icon />}
        label={parsed.toolDisplay || 'Tool'}
        detail={parsed.summary || undefined}
        actions={
          hasDetail ? (
            <EventLineAction
              onClick={(e) => {
                e.stopPropagation();
                // `preventDefault` as well: this button lives inside a
                // `<summary>`, and without it a click would toggle the
                // disclosure on its way to copying.
                e.preventDefault();
                if (parsed.args) {
                  navigator.clipboard.writeText(parsed.args);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
              title="Copy parameters"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </EventLineAction>
          ) : undefined
        }
      >
        {hasDetail && parsed.args ? <EventLinePre>{parsed.args}</EventLinePre> : undefined}
      </EventLine>
    );
  }

  return (
    <div>
      {/*
        Three in-flight states announced three different ways: an amber pulsing
        icon, a violet spinning icon beside violet pulsing italic text, and a
        green icon. Violet was a fifth hue with no token behind it, and "Vibing
        ..." did not say what was happening. All three now use the one running
        signal (`.event-running`) on the words, with the icon left as a quiet
        glyph on the text baseline.
      */}
      <div className="flex items-baseline gap-2 text-xs py-0.5 text-foreground-extra-muted">
        <Icon className="size-3.5 shrink-0 translate-y-px" />
        {parsed.type === 'compacting' && (
          <span className="event-running">Compacting the conversation</span>
        )}
        {parsed.type === 'status' && <span className="text-foreground-muted font-mono text-2xs">{parsed.text}</span>}
        {parsed.type === 'thinking' && <span className="event-running text-2xs">thinking</span>}
      </div>
    </div>
  );
});

function ActivityIndicator({ startTime }: { startTime?: number | null }) {
  return (
    <div className="py-1.5">
      <WorkingIndicator startTime={startTime} />
    </div>
  );
}

/**
 * Consecutive `thinking` messages become ONE run.
 *
 * This is the fix for a trace that rendered as four separate lightbulb rows,
 * each holding a fragment of a single thought. The cause was one line in
 * `chat-messages.tsx`:
 *
 *     const thinkingOnly = own.every((m) => m.messageType === 'thinking');
 *
 * An all-or-nothing test. A run of pure `thinking` was handed to
 * `ThinkingMessage`, which joins the fragments and renders one clean `Thinking`
 * event — but a SINGLE interleaved `status` message ("Antigravity is
 * reasoning…", "idle") flipped that test false and demoted the entire run to
 * per-message rows. Since connectors emit a status at the start and end of
 * nearly every turn, the clean path almost never ran while the agent was
 * actually working. The tidy version only appeared after the answer landed,
 * which is why the transcript seemed to change design halfway through a reply.
 *
 * Segmenting here rather than fixing that predicate is deliberate: the grouping
 * in `chat-messages.tsx` also decides avatar/header suppression and per-sender
 * separation, and loosening its test would change all of that at once. This
 * keeps the blast radius to how a run is drawn.
 */
type StepRun =
  /** Chain-of-thought. Collapsed behind a "Thought" disclosure. */
  | { kind: 'thinking'; messages: WorkspaceMessage[] }
  /**
   * The reply itself, streamed early (`reply_preview`). Rendered as prose — it
   * IS the answer, so putting it inside a disclosure labelled "Thought" is what
   * made the same text appear twice under two different headings. It only
   * reaches here while it is still the live edge; once the real message lands,
   * `chat-messages.tsx` drops it outright.
   */
  | { kind: 'reply'; messages: WorkspaceMessage[] }
  /**
   * Tool calls the model issued AT THE SAME TIME, folded into one row.
   *
   * A model that asks for four files at once emits four `tool_use` blocks in a
   * single assistant turn; the adapters flatten those into four separate status
   * messages, so the transcript printed four rows for what was one decision.
   * With three agents working, a screen could be most of the way full of tool
   * lines that all happened in the same instant.
   *
   * Concurrency is inferred from arrival time, because that is the only signal
   * that survives the adapters — none of them mark which blocks shared a turn.
   * See `PARALLEL_WINDOW_MS`.
   */
  | { kind: 'tools'; messages: WorkspaceMessage[] }
  | { kind: 'step'; message: WorkspaceMessage };

/**
 * How close together tool calls must arrive to count as one batch.
 *
 * The adapters emit a turn's tool blocks in a tight `for` loop — consecutive
 * `await sendStatus` calls with nothing between them — so a genuine batch lands
 * inside a few hundred milliseconds even over a slow local socket. A second is
 * comfortably above that and comfortably below the gap left by a tool that
 * actually ran: no real command finishes, gets reported, and is followed by the
 * next request inside a second.
 *
 * Getting this wrong is not symmetrical. Too wide and sequential calls collapse
 * into a batch, which LIES about what the agent did; too narrow and a batch
 * shows as separate rows, which is merely the old behaviour. So it is set to err
 * narrow.
 */
const PARALLEL_WINDOW_MS = 1000;

function stepTime(msg: WorkspaceMessage): number | null {
  if (!msg.createdAt) return null;
  const t = new Date(msg.createdAt).getTime();
  return Number.isNaN(t) ? null : t;
}

function isToolCallStep(msg: WorkspaceMessage): boolean {
  if (msg.messageType === 'thinking' || msg.messageType === 'todos') return false;
  return parseStepContent(msg.content).type === 'tool_call';
}

/**
 * Fragments of one thought, rejoined as paragraphs. A blank line rather than a
 * single break because the fragments are markdown: run two of them together
 * with `\n` and a fragment ending mid-list swallows the next fragment's heading.
 */
function joinThoughts(messages: WorkspaceMessage[]): string {
  return messages.map((m) => m.content).join('\n\n');
}

/**
 * A run of steps, drawn.
 *
 * Both places that show an agent's steps render through this: the live trace
 * above a reply (`IntermediateSteps`) and the collapsed disclosure inside one
 * (`ToolCallsDisclosure`). They used to have separate copies of the loop, which
 * is how the fragmented-thinking fix landed in one of them and not the other —
 * the live trace was repaired while the disclosure kept splitting a single
 * thought across four rows.
 */
/**
 * One row for a batch of tool calls issued together.
 *
 * Names the tools instead of counting them: "3 tools" tells the reader nothing
 * they can act on, whereas "Read, Read, Grep" says what the agent reached for
 * without opening anything. Repeats are kept rather than deduplicated — four
 * reads of four different files is four reads, and collapsing that to "Read"
 * would hide the scale of what happened.
 */
const ParallelTools = memo(function ParallelTools({ messages }: { messages: WorkspaceMessage[] }) {
  const names = messages.map((m) => parseStepContent(m.content).toolDisplay || 'Tool');
  // The batch's own icon is whichever tool it led with; a wrench for a batch of
  // four reads would be less informative than the read glyph.
  const Icon = getStepIcon(parseStepContent(messages[0].content));

  return (
    <EventLine
      icon={<Icon />}
      label={`${messages.length} tools`}
      detail={names.join(', ')}
      meta={`×${messages.length}`}
    >
      {/*
        The individual calls, each still its own `SingleStep` — so a batch member
        expands to its arguments exactly like a lone tool call does. Nesting a
        disclosure inside a disclosure is acceptable here because the outer one
        is a summary of a moment and the inner one is the detail of one action.
      */}
      <div className="py-0.5">
        {messages.map((m, i) => (
          <SingleStep key={`${m.messageId || 'batch'}-${i}`} message={m} />
        ))}
      </div>
    </EventLine>
  );
});

function StepRuns({ steps, live }: { steps: WorkspaceMessage[]; live?: boolean }) {
  const runs = coalesceThinking(steps);
  return (
    <>
      {runs.map((run, runIdx) =>
        run.kind === 'thinking' ? (
          <Reasoning
            key={`think-${run.messages[0]?.messageId || runIdx}`}
            content={joinThoughts(run.messages)}
            startTime={
              run.messages[0]?.createdAt
                ? new Date(run.messages[0].createdAt).getTime()
                : undefined
            }
            durationMs={runDuration(run.messages)}
            // Only the LAST run of a live trace is still streaming. Left always
            // true, every historical thought in the scrollback would shimmer
            // forever; left always false, the one actually in flight would not.
            isStreaming={Boolean(live) && runIdx === runs.length - 1}
            defaultExpanded={false}
          />
        ) : run.kind === 'reply' ? (
          /*
           * The answer, typing itself out. No disclosure, no "Thought" heading,
           * no icon — it is the reply, so it looks like the reply. A blinking
           * cursor while it is the live edge is the whole affordance; the row
           * simply gets replaced by the real message when that arrives.
           */
          <div
            key={`reply-${run.messages[0]?.messageId || runIdx}`}
            className="py-0.5 text-sm leading-relaxed text-foreground"
          >
            <MarkdownContent content={joinThoughts(run.messages)} />
            {Boolean(live) && runIdx === runs.length - 1 && (
              <span className="streaming-cursor" aria-hidden />
            )}
          </div>
        ) : run.kind === 'tools' ? (
          <ParallelTools
            key={`tools-${run.messages[0]?.messageId || runIdx}`}
            messages={run.messages}
          />
        ) : (
          <SingleStep
            key={`${run.message.messageId || 'step'}-${runIdx}`}
            message={run.message}
          />
        )
      )}
    </>
  );
}

/**
 * Wall time from the run's first fragment to its last.
 *
 * The only honest duration available for a finished thought: the caller holds
 * both ends, whereas `Reasoning` alone can see only where it started — which is
 * how a twenty-minute-old reply came to report `Thought 1367.1s`. Returns
 * undefined for a single fragment, since a one-message run has no measurable
 * span and `0.0s` would claim it was instant.
 */
function runDuration(messages: WorkspaceMessage[]): number | undefined {
  const first = messages[0]?.createdAt;
  const last = messages[messages.length - 1]?.createdAt;
  if (!first || !last || messages.length < 2) return undefined;
  const ms = new Date(last).getTime() - new Date(first).getTime();
  return ms > 0 ? ms : undefined;
}

function coalesceThinking(steps: WorkspaceMessage[]): StepRun[] {
  const runs: StepRun[] = [];
  for (const step of steps) {
    const isThinking = step.messageType === 'thinking' && !isPlaceholderThinking(step);
    if (!isThinking) {
      runs.push({ kind: 'step', message: step });
      continue;
    }
    // A reply preview and real reasoning never merge into one run, even when
    // they arrive back to back — they are different kinds of text and are drawn
    // differently. Absent flag means "unknown", which is treated as reasoning:
    // showing a duplicate beats hiding the model's actual thinking.
    const kind: 'thinking' | 'reply' = step.metadata?.reply_preview === true ? 'reply' : 'thinking';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.messages.push(step);
    else runs.push({ kind, messages: [step] });
  }
  return foldParallelTools(runs);
}

/**
 * Fold adjacent tool-call steps that arrived together into one `tools` run.
 *
 * Runs as a second pass over the output rather than inside the loop above: the
 * decision needs the PREVIOUS tool call's timestamp, and threading that through
 * the thinking/reply branching made both harder to read than either is alone.
 *
 * A batch of one is left as a plain step. A single tool call is not a batch, and
 * wrapping it in a "1 tool" disclosure would bury the thing it did behind a
 * click.
 */
function foldParallelTools(runs: StepRun[]): StepRun[] {
  const out: StepRun[] = [];
  let batch: WorkspaceMessage[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    if (batch.length === 1) out.push({ kind: 'step', message: batch[0] });
    else out.push({ kind: 'tools', messages: batch });
    batch = [];
  };

  for (const run of runs) {
    if (run.kind !== 'step' || !isToolCallStep(run.message)) {
      // Anything that is not a tool call ends the batch — a thought or a status
      // between two calls means the agent did something in between, so they were
      // not issued together.
      flush();
      out.push(run);
      continue;
    }
    const prev = batch[batch.length - 1];
    const t = stepTime(run.message);
    const prevT = prev ? stepTime(prev) : null;
    // An unknown timestamp never joins a batch: guessing would be the one
    // failure mode that misreports what happened.
    const together = prev !== undefined && t !== null && prevT !== null && t - prevT <= PARALLEL_WINDOW_MS;
    if (prev && !together) flush();
    batch.push(run.message);
  }
  flush();
  return out;
}

function isTerminalStatus(step: WorkspaceMessage) {
  return (
    step.messageType === 'status' &&
    /stopped|stopping failed/i.test(step.content)
  );
}

// ── Tool Calls Disclosure ──

interface ToolCallsDisclosureProps {
  steps: WorkspaceMessage[];
  defaultOpen?: boolean;
}

/**
 * The tool activity that led to a reply, rendered INSIDE that reply's bubble and
 * collapsed by default.
 *
 * Tool activity arrives as separate `status` events, so it used to render as its
 * own block above the messages, with every agent's steps interleaved in one
 * list — in a multi-agent channel it was impossible to tell who had done what.
 * Attaching the steps to their author's message makes attribution structural,
 * and collapsing them keeps the conversation readable while the detail stays one
 * click away.
 */
export const ToolCallsDisclosure = memo(function ToolCallsDisclosure({
  steps,
  defaultOpen = false,
}: ToolCallsDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);

  const renderable = (steps || []).filter((s) => !isPlaceholderThinking(s));
  if (renderable.length === 0) return null;

  /*
   * What the whole run amounted to, counted rather than listed: "4 tool calls,
   * 2 thoughts". One line standing in for a dozen is the point — a finished turn
   * is scrollback, and scrollback that costs a screen and a half to scroll past
   * is what makes a long conversation unreadable.
   *
   * Thoughts are counted as RUNS, not as messages, because a single thought
   * arrives as however many fragments the connector felt like sending. Counting
   * messages would report "11 thoughts" for one.
   */
  const runs = coalesceThinking(renderable);
  const toolCount = renderable.filter((s) => {
    if (s.messageType === 'todos' || s.messageType === 'thinking') return false;
    return parseStepContent(s.content).type === 'tool_call';
  }).length;
  const thoughtCount = runs.filter((r) => r.kind === 'thinking').length;

  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
  if (thoughtCount > 0) parts.push(`${thoughtCount} thought${thoughtCount === 1 ? '' : 's'}`);
  // Neither — statuses only. Fall back to the raw count rather than claiming
  // zero of something.
  if (parts.length === 0) {
    parts.push(`${renderable.length} step${renderable.length === 1 ? '' : 's'}`);
  }

  return (
    <EventLine
      className="mb-2"
      icon={<Wrench />}
      label={parts.join(', ')}
      defaultOpen={defaultOpen}
    >
      {/* `live` is deliberately absent: a disclosure only exists once the reply
          it sits inside has landed, so nothing in here is still streaming. */}
      <StepRuns steps={renderable} />
    </EventLine>
  );
});

// ── Intermediate Steps Group ──

interface IntermediateStepsProps {
  steps: WorkspaceMessage[];
  agents?: WorkspaceAgent[];
  isActive?: boolean;
}

export const IntermediateSteps = memo(function IntermediateSteps({ steps, agents, isActive = false }: IntermediateStepsProps) {
  if (!steps || steps.length === 0) return null;
  const renderableSteps = steps.filter((s) => !isPlaceholderThinking(s));
  if (renderableSteps.length === 0) return null;
  const hasTerminalStatus = steps.some(isTerminalStatus);

  const hasMultipleAgents = (agents?.length ?? 0) > 1;
  const senderGroups: { sender: string; steps: WorkspaceMessage[] }[] = [];
  for (const step of steps) {
    const last = senderGroups[senderGroups.length - 1];
    if (last && last.sender === step.senderName) {
      last.steps.push(step);
    } else {
      senderGroups.push({ sender: step.senderName, steps: [step] });
    }
  }

  // Whose steps these are. `senderGroups` is ordered, so the first group is the
  // agent that opened the run.
  const primarySender = senderGroups[0]?.sender || '';
  const primaryAgent = agents?.find((a) => a.agentName === primarySender);

  return (
    <div className="flex items-start gap-3 py-1">
      {/*
        THE AVATAR, which used to be an empty 32px spacer.

        That spacer was harmless while a separate "Starting" row above carried
        the avatar — but that row is now suppressed whenever an agent has begun
        reporting for itself (otherwise one working agent announced its identity
        twice on adjacent lines). With the row gone and this slot empty, a turn
        that emitted any `status` event showed tool calls and thoughts with no
        indication of who was doing them.

        It only looked intermittent: a run of pure `thinking` groups as
        `ThinkingMessage`, which draws its own avatar, so the identity appeared.
        One interleaved status demoted the run to this component and the avatar
        vanished.
      */}
      <AgentAvatar
        name={primarySender}
        agentType={primaryAgent?.agentType}
        size={28}
        className="mt-0.5 shrink-0"
      />
      {/* One rail width for the whole app: a centred 1px column in a 1rem
          track, matching `EventLineBody`. This was `border-l-2 … pl-3` — a 2px
          line at a different indent from the one every expanded event draws. */}
      <div className="grid min-w-0 flex-1 grid-cols-[1rem_1fr] gap-x-1.5 py-0.5 [&>*:nth-child(even)]:min-w-0">
        <span aria-hidden className="mx-auto h-full w-px bg-border" />
        <div className="min-w-0">
        {senderGroups.map((group, gi) => (
          <div key={`${group.sender}-${gi}`}>
            {/*
              A sub-label only for HANDOVERS — a second agent picking up inside
              the same run. `gi > 0` because the 28px avatar beside the rail
              already names the agent that opened it; labelling the first group
              as well printed the same identity twice, half an inch apart.
            */}
            {hasMultipleAgents && gi > 0 && (
              <div className="flex items-baseline gap-1.5 mb-0.5 mt-1.5">
                <AgentAvatar name={group.sender} size={14} className="translate-y-px" />
                <span className="text-3xs font-medium text-foreground-muted">
                  {group.sender}
                </span>
              </div>
            )}
            <StepRuns steps={group.steps} live={isActive} />
          </div>
        ))}
          {isActive && !hasTerminalStatus && (
            <ActivityIndicator
              startTime={steps[0]?.createdAt ? new Date(steps[0].createdAt).getTime() : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
});
