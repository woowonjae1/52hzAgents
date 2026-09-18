'use client';

import * as React from 'react';
import { Wrench, Search, FileCode, Terminal, Globe } from 'lucide-react';
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result';

/*
  THE ADAPTER, NOT A SECOND IMPLEMENTATION.

  This file used to draw its own card: a `rounded-xl border bg-surface1/60`
  box with a hand-rolled disclosure button, a spinning loader, a query chip
  and a copy button. All of that is what beUI's `ToolResult` already is, so
  the body is gone and only the mapping survives.

  The props are unchanged on purpose. Every call site keeps passing
  `label` / `query` / `request` / `result` / `running`, and none of them had
  to learn `ToolResult`'s vocabulary.
*/

export interface ToolCallProps {
  label: string;
  activeLabel?: string;
  query?: string;
  request?: string | Record<string, unknown>;
  result?: string | Record<string, unknown>;
  running?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
  className?: string;
}

/* The label is all we know about a tool, so the glyph is inferred from it. */
function inferIcon(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes('search') || lower.includes('grep')) return <Search />;
  if (lower.includes('read') || lower.includes('write') || lower.includes('edit')) return <FileCode />;
  if (lower.includes('bash') || lower.includes('cmd') || lower.includes('term')) return <Terminal />;
  if (lower.includes('web') || lower.includes('fetch')) return <Globe />;
  return <Wrench />;
}

function asText(value: string | Record<string, unknown> | undefined) {
  if (value === undefined) return undefined;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running = false,
  open,
  onOpenChange,
  icon: CustomIcon,
  className,
}: ToolCallProps) {
  const requestStr = asText(request);
  const resultStr = asText(result);

  const icon = React.isValidElement(CustomIcon)
    ? CustomIcon
    : typeof CustomIcon === 'function'
      ? React.createElement(CustomIcon as React.ComponentType<{ className?: string }>)
      : inferIcon(label);

  /*
    `tool` is beUI's mono subtitle — the machine name of what ran — and
    `title` is the human sentence above it. This app only ever had one
    string, so the running variant ("Searching…") becomes the title and the
    bare label stays underneath as the identifier.
  */
  const title = running ? activeLabel || `${label}…` : label;

  const body = [
    query ? `${query}` : undefined,
    requestStr,
    resultStr,
  ].filter(Boolean) as string[];

  return (
    <ToolResult
      tool={label}
      title={title}
      status={running ? 'running' : 'success'}
      icon={icon}
      open={open}
      onOpenChange={onOpenChange}
      copyText={body.length > 0 ? body.join('\n\n') : undefined}
      className={className}
    >
      {body.length > 0 ? (
        <ToolResultOutput>{body.join('\n\n')}</ToolResultOutput>
      ) : null}
    </ToolResult>
  );
}
