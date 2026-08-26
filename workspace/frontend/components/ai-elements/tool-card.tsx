'use client';

import {
  Terminal,
  FileCode,
  Search,
  Copy,
  Check,
  Globe,
  Settings,
  FolderOpen,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  EventLine,
  EventLineAction,
  EventLinePre,
  type EventState,
} from './event-line';

export type ToolStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface ToolCardProps {
  toolName: string;
  toolInput?: Record<string, any> | string;
  toolOutput?: string;
  status?: ToolStatus;
  durationMs?: number;
  error?: string;
  defaultExpanded?: boolean;
  className?: string;
}

function getToolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes('bash') || lower.includes('cmd') || lower.includes('terminal') || lower.includes('exec')) {
    return <Terminal />;
  }
  if (lower.includes('read') || lower.includes('write') || lower.includes('file') || lower.includes('edit')) {
    return <FileCode />;
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return <Search />;
  }
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('url') || lower.includes('http')) {
    return <Globe />;
  }
  if (lower.includes('dir') || lower.includes('list')) {
    return <FolderOpen />;
  }
  return <Settings />;
}

/**
 * 从工具入参中提炼出一行「命令 / 目标」摘要，用于头部单行展示，
 * 避免把整段 JSON 直接铺在卡片头部造成日志噪音。
 */
const TARGET_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'prompt'];

function getTargetSummary(toolInput?: Record<string, any> | string): string | null {
  if (!toolInput) return null;
  if (typeof toolInput === 'string') return toolInput.replace(/\s+/g, ' ').trim() || null;
  for (const key of TARGET_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim();
    }
  }
  const keys = Object.keys(toolInput);
  if (keys.length === 0) return null;
  return keys.map((k) => `${k}=${JSON.stringify(toolInput[k])}`).join(' ').replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * The transport-level statuses this component is handed, mapped onto the shared
 * event vocabulary. `error` becomes `failed` rather than `blocked` because a
 * tool that threw is not a tool that was refused — see `EventState`.
 */
const STATE: Record<ToolStatus, EventState> = {
  running: 'running',
  success: 'ok',
  error: 'failed',
  cancelled: 'cancelled',
};

/**
 * One tool call.
 *
 * This used to own a card: its own border, radius, backdrop blur, shadow tier,
 * a four-colour status badge, an amber glow while running, and a
 * motion/AnimatePresence height animation. All of that now comes from
 * `EventLine`, which every other agent event also draws through, so a tool call
 * and a plan and a diff sit on one rhythm. What is left here is what is actually
 * specific to a tool call: which icon, what the one-line target is, and how the
 * parameters and output are laid out once expanded.
 */
export function ToolCard({
  toolName,
  toolInput,
  toolOutput,
  status = 'success',
  durationMs,
  error,
  defaultExpanded = false,
  className,
}: ToolCardProps) {
  const [copied, setCopied] = useState(false);

  const inputStr = typeof toolInput === 'string'
    ? toolInput
    : toolInput
    ? JSON.stringify(toolInput, null, 2)
    : null;

  const target = getTargetSummary(toolInput);
  const hasBody = Boolean(inputStr || toolOutput || error);

  const handleCopyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = toolOutput || error || inputStr || '';
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    toast.success('Tool output copied');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <EventLine
      className={className}
      icon={getToolIcon(toolName)}
      label={toolName}
      detail={target ?? undefined}
      state={STATE[status] ?? 'ok'}
      // No duration on a call still in flight: a number that is already stale
      // the moment it is painted reads as a bug, and the shimmer already says
      // "still going".
      meta={status !== 'running' && durationMs && durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : undefined}
      defaultOpen={defaultExpanded}
    >
      {hasBody && (
        <div className="space-y-2 py-0.5">
          {inputStr && (
            <div className="space-y-1">
              <div className="text-3xs uppercase tracking-wider text-foreground-extra-muted">
                Arguments
              </div>
              <EventLinePre>{inputStr}</EventLinePre>
            </div>
          )}

          {(toolOutput || error) && (
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-3xs uppercase tracking-wider text-foreground-extra-muted">
                  Output
                </span>
                <EventLineAction onClick={handleCopyOutput} title="Copy output">
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </EventLineAction>
              </div>
              <EventLinePre tone={error ? 'bad' : 'default'}>
                {error || toolOutput}
              </EventLinePre>
            </div>
          )}
        </div>
      )}
    </EventLine>
  );
}
