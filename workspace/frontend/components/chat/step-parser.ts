import type { WorkspaceMessage } from '@/lib/types';
import { isToolCallMessage } from './message-kinds';
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
} from 'lucide-react';

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

export interface ParsedStep {
  type: 'thinking' | 'tool_call' | 'status' | 'compacting' | 'subagents';
  tool?: string;
  toolDisplay?: string;
  args?: string;
  summary?: string;
  text?: string;
  subagents?: SubagentInfo[];
}

export function cleanToolName(name: string): string {
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) return mcpMatch[1];
  const mcpMatch2 = name.match(/^mcp_[^_]+--.+?__(.+)$/);
  if (mcpMatch2) return mcpMatch2[1];
  return name;
}

/** Arguments that name what a call acted on, most telling first. */
export const SUMMARY_ARG_KEYS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
];

export function extractToolSummary(tool: string, args: string): string {
  const trimmedArgs = args.trim();
  if (trimmedArgs.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmedArgs) as Record<string, unknown>;
      for (const key of SUMMARY_ARG_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim())
          return value.replace(/\s+/g, ' ').trim().slice(0, 200);
      }
    } catch {
      /* fall through to the legacy patterns */
    }
  }

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

export function parseSubagentsPayload(raw: string): SubagentInfo[] | null {
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
      return [
        {
          index: 0,
          role: m[1].trim(),
          typeName: 'research',
          prompt: m[2].trim(),
          workspace: 'inherit',
          model: 'inherit',
          status: 'running',
        },
      ];
    }
  }
  return null;
}

export function parseStepContent(content: string): ParsedStep {
  if (content === 'thinking...' || content.toLowerCase() === 'thinking') {
    return { type: 'thinking', text: content };
  }

  const thinkingMatch = content.match(/^\*\*Thinking:\*\*\n([\s\S]+)$/);
  if (thinkingMatch) {
    return { type: 'thinking', text: thinkingMatch[1].trim() };
  }

  const toolMatch = content.match(/\*\*Using tool:\*\*\s*`([^`]+)`\s*```([\s\S]*?)```/);
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

/** Prefer structured adapter metadata when present; fall back to legacy text. */
export function parseMessageStep(message: WorkspaceMessage): ParsedStep {
  const metadata = message.metadata || {};
  const rawTool = metadata.tool_name || metadata.tool || metadata.tool_call;
  if (typeof rawTool === 'string' && rawTool.trim()) {
    const rawArgs = metadata.tool_args ?? metadata.arguments ?? metadata.args;
    const args = typeof rawArgs === 'string' ? rawArgs : rawArgs ? JSON.stringify(rawArgs, null, 2) : undefined;
    const status = String(metadata.tool_status || metadata.status || '').toLowerCase();
    const step: ParsedStep = {
      type: 'tool_call',
      tool: rawTool,
      toolDisplay: cleanToolName(rawTool),
      args,
      summary:
        typeof metadata.tool_summary === 'string'
          ? metadata.tool_summary
          : extractToolSummary(cleanToolName(rawTool), args || ''),
    };
    if (status === 'failed' || status === 'error') step.summary = `${step.summary || 'Tool call'} · failed`;
    return step;
  }
  return parseStepContent(message.content);
}

export const TOOL_ICONS: Record<string, typeof Wrench> = {
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

export function getStepIcon(parsed: ParsedStep) {
  if (parsed.type === 'thinking') return Brain;
  if (parsed.type === 'compacting') return RefreshCw;
  if (parsed.type === 'status') return Activity;
  return TOOL_ICONS[parsed.toolDisplay || ''] || Wrench;
}

export function isPlaceholderThinking(message: WorkspaceMessage): boolean {
  if (message.messageType === 'todos' || isToolCallMessage(message)) return false;
  const parsed =
    message.messageType === 'thinking'
      ? { type: 'thinking' as const, text: message.content }
      : parseMessageStep(message);
  if (parsed.type !== 'thinking') return false;
  const t = (parsed.text || '').trim().toLowerCase();
  return t === '' || t === 'thinking...' || t === 'thinking';
}

/**
 * One line for a step in a compact view (the agent lanes), using the same
 * parsing as the transcript so both say the same thing about it.
 */
export function describeStep(
  message: WorkspaceMessage
): { label: string; Icon: typeof Wrench } | null {
  if (message.messageType === 'todos') return { label: 'Updated the todo list', Icon: Activity };
  if (isPlaceholderThinking(message)) return null;
  const parsed = isToolCallMessage(message)
    ? parseMessageStep(message)
    : message.messageType === 'thinking'
    ? { type: 'thinking' as const, text: message.content }
    : parseStepContent(message.content);
  const firstLine = (s?: string) =>
    (s || '').replace(/^\*\*Thinking:\*\*\s*/, '').trim().split(/\r?\n/)[0].slice(0, 160);
  let label: string;
  if (parsed.type === 'tool_call') {
    label = parsed.summary ? `${parsed.toolDisplay} · ${firstLine(parsed.summary)}` : parsed.toolDisplay || 'Tool call';
  } else if (parsed.type === 'subagents') {
    label = `Subagents (${parsed.subagents?.length ?? 0})`;
  } else if (parsed.type === 'compacting') {
    label = 'Compacting context';
  } else {
    label = firstLine(parsed.text) || (parsed.type === 'thinking' ? 'Thinking' : 'Working');
  }
  return { label, Icon: getStepIcon(parsed) };
}

/** The row verb for a tool, in beUI's vocabulary; unknown tools keep their own name. */
export function toolAction(display: string): string {
  const name = display.toLowerCase();
  if (/^(read|view|cat|open)/.test(name)) return 'read';
  if (/(edit|write|patch|replace|create)/.test(name)) return 'edit';
  if (/(bash|shell|exec|command|terminal|^run)/.test(name)) return 'run';
  return display;
}

export function prettyToolArgs(args: string): string {
  const trimmed = args.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return args;
    }
  }
  return args;
}
