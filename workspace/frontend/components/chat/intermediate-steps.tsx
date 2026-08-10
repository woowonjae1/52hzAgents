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
} from 'lucide-react';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { WorkingIndicator } from './working-indicator';
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
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <span className="shrink-0">{t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : t.status === 'cancelled' ? '⊘' : '⬜'}</span>
              <span className={cn(
                (t.status === 'completed' || t.status === 'cancelled') && 'line-through text-muted-foreground'
              )}>{t.content}</span>
              {t.assignee && (
                <span className="text-muted-foreground/50 text-[10px]">→ {t.assignee}</span>
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
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0 mt-0.5 text-status-warning" />
          <span className="italic text-[11px]">thinking</span>
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
          <span className="font-mono text-[11px] font-semibold text-foreground shrink-0">{parsed.toolDisplay}</span>
          {parsed.summary && (
            <>
              <span className="text-muted-foreground/40 shrink-0">›</span>
              <span className="truncate font-mono text-[11px] text-foreground-muted min-w-0 flex-1">{parsed.summary}</span>
            </>
          )}
          {hasDetail && (
            <ChevronRight className={cn('size-3.5 shrink-0 ml-auto text-muted-foreground/60 transition-transform', expanded && 'rotate-90')} />
          )}
        </button>
        {expanded && parsed.args && (
          <div className="relative group/args ml-1 mt-1 mb-1.5 rounded-lg border border-border bg-surface0 overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/60 bg-surface1 text-[11px] text-foreground font-mono">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="size-2 rounded-full bg-status-success inline-block" />
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
                {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="text-[11px] leading-relaxed p-3 overflow-x-auto max-h-60 text-foreground font-mono whitespace-pre-wrap break-all selection:bg-surface4">
              {parsed.args}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-xs py-0.5 text-muted-foreground">
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            parsed.type === 'thinking' && 'text-status-warning animate-pulse',
            parsed.type === 'compacting' && 'text-violet-500 animate-spin',
            parsed.type === 'status' && 'text-status-success'
          )}
        />
        {parsed.type === 'compacting' && (
          <span className="italic text-violet-500/80 animate-pulse">Vibing ...</span>
        )}
        {parsed.type === 'status' && <span className="text-foreground-muted font-mono text-[11px]">{parsed.text}</span>}
        {parsed.type === 'thinking' && <span className="italic text-[11px]">thinking</span>}
      </div>
    </div>
  );
});

function ActivityIndicator() {
  return (
    <div className="py-1.5">
      <WorkingIndicator />
    </div>
  );
}

function isTerminalStatus(step: WorkspaceMessage) {
  return (
    step.messageType === 'status' &&
    /stopped|stopping failed/i.test(step.content)
  );
}

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
      <div className="border-l-2 border-border pl-3 py-0.5 min-w-0 flex-1">
        {senderGroups.map((group, gi) => (
          <div key={`${group.sender}-${gi}`}>
            {hasMultipleAgents && (
              <div className="flex items-center gap-1.5 mb-0.5 mt-1 first:mt-0">
                <AgentAvatar name={group.sender} size={14} />
                <span className="text-[10px] font-medium text-muted-foreground/70">
                  {group.sender}
                </span>
              </div>
            )}
            {group.steps.map((step, stepIdx) => (
              <SingleStep key={`${step.messageId || 'step'}-${stepIdx}`} message={step} />
            ))}
          </div>
        ))}
        {isActive && !hasTerminalStatus && <ActivityIndicator />}
      </div>
    </div>
  );
});
