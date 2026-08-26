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
  ChevronRight,
  RefreshCw,
  ListTodo,
  Copy,
  Check,
  CheckCircle2,
  Circle,
  Ban,
  Dot,
} from 'lucide-react';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { WorkingIndicator } from './working-indicator';
import { Reasoning } from '@/components/ai-elements/reasoning';
import { EventLine } from '@/components/ai-elements/event-line';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';

// ── Content Parsing ──

interface ParsedStep {
  type: 'thinking' | 'tool_call' | 'status' | 'compacting';
  tool?: string;
  toolDisplay?: string;
  args?: string;
  summary?: string;
  text?: string;
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

  // Adapters post tool activity as a plain "Name > args" status line (see the
  // claude adapter's sendStatus on tool_use). Without this branch it fell
  // through to a generic `status` step, losing the tool's identity, its icon and
  // the expandable detail — which is why long arguments appeared truncated with
  // no way to read them. Checked before the /compact/ test so a command that
  // merely contains the word "compact" is not misread as a compaction notice.
  const inlineToolMatch = content.match(/^([A-Za-z][\w.-]*)\s*›\s*([\s\S]+)$/);
  if (inlineToolMatch) {
    const toolDisplay = cleanToolName(inlineToolMatch[1].trim());
    const args = inlineToolMatch[2].trim();
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

// ── Step Item ──

const SingleStep = memo(function SingleStep({ message }: { message: WorkspaceMessage }) {
  const [expanded, setExpanded] = useState(false);
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
    return (
      <div className="py-0.5">
        <div className="flex items-baseline gap-2 text-xs text-foreground-extra-muted">
          <Icon className="size-3.5 shrink-0 translate-y-px" />
          <span className="text-2xs">thinking</span>
        </div>
        <div className="text-xs leading-relaxed text-foreground/60 ml-[22px] mt-0.5 mb-1 whitespace-pre-wrap">
          {parsed.text}
        </div>
      </div>
    );
  }

  if (parsed.type === 'tool_call') {
    return (
      <div className="my-1">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded(!expanded)}
          disabled={!hasDetail}
          className={cn(
            'group/tool flex items-center gap-2 w-full text-left rounded-lg border px-2.5 py-1.5 transition-colors',
            'border-border/70 dark:border-border/70 bg-surface1/60',
            hasDetail && 'cursor-pointer hover:border-border-accent hover:bg-surface2',
          )}
        >
          <span className="size-5 shrink-0 rounded-md bg-surface3 flex items-center justify-center">
            <Icon className="size-3 text-foreground-muted" />
          </span>
          <span className="font-mono text-2xs font-medium text-foreground shrink-0">{parsed.toolDisplay}</span>
          {parsed.summary && (
            <>
              <span className="text-muted-foreground/40 shrink-0">›</span>
              <span className="truncate font-mono text-2xs text-foreground-muted min-w-0 flex-1">{parsed.summary}</span>
            </>
          )}
          {hasDetail && (
            <ChevronRight className={cn('size-3.5 shrink-0 ml-auto text-muted-foreground/60 transition-transform', expanded && 'rotate-90')} />
          )}
        </button>
        {expanded && parsed.args && (
          <div className="relative group/args ml-1 mt-1 mb-1.5 rounded-lg border border-border bg-surface0 overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/60 bg-surface1 text-2xs text-foreground font-mono">
              <span className="flex items-baseline gap-1.5 font-medium">
                <span>{parsed.toolDisplay || 'Terminal Output'}</span>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (parsed.args) {
                    navigator.clipboard.writeText(parsed.args);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }
                }}
                className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
                title="Copy parameters"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="text-2xs leading-relaxed p-3 overflow-x-auto max-h-60 text-foreground font-mono whitespace-pre-wrap break-all selection:bg-surface4">
              {parsed.args}
            </pre>
          </div>
        )}
      </div>
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
  | { kind: 'thinking'; messages: WorkspaceMessage[] }
  | { kind: 'step'; message: WorkspaceMessage };

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
    const last = runs[runs.length - 1];
    if (last && last.kind === 'thinking') last.messages.push(step);
    else runs.push({ kind: 'thinking', messages: [step] });
  }
  return runs;
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

  return (
    <div className="flex items-start gap-3 py-1">
      <div className="size-8 shrink-0" />
      {/* One rail width for the whole app: a centred 1px column in a 1rem
          track, matching `EventLineBody`. This was `border-l-2 … pl-3` — a 2px
          line at a different indent from the one every expanded event draws. */}
      <div className="grid min-w-0 flex-1 grid-cols-[1rem_1fr] gap-x-1.5 py-0.5 [&>*:nth-child(even)]:min-w-0">
        <span aria-hidden className="mx-auto h-full w-px bg-border" />
        <div className="min-w-0">
        {senderGroups.map((group, gi) => (
          <div key={`${group.sender}-${gi}`}>
            {hasMultipleAgents && (
              <div className="flex items-center gap-1.5 mb-0.5 mt-1 first:mt-0">
                <AgentAvatar name={group.sender} size={14} />
                <span className="text-3xs font-medium text-muted-foreground/70">
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
