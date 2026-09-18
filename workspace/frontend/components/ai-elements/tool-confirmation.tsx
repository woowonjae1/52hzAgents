'use client';

import * as React from 'react';
import {
  ToolApproval,
  type ToolApprovalParameter,
} from '@/components/agents/tool-approval';

/*
  THE ADAPTER, NOT A SECOND IMPLEMENTATION.

  beUI's `ToolApproval` is the "Run focused checkout checks? / terminal.run /
  Approval required / View details / Allow once · Always allow · Deny" card.
  This app already had the same moment — an agent asking before it runs
  something — drawn its own way, so only the mapping is kept.

  The interesting half is `args → parameters`: beUI renders them as the
  labelled Command / Scope table, which is strictly more readable than the
  JSON blob this used to print.
*/

export interface ToolConfirmationProps {
  toolName?: string;
  args?: Record<string, unknown> | string;
  approvalId?: string;
  status?: 'pending' | 'approved' | 'denied';
  onApprove: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
  className?: string;
}

function toParameters(args: Record<string, unknown> | string | undefined): ToolApprovalParameter[] {
  if (args === undefined) return [];
  if (typeof args === 'string') {
    return args.trim() ? [{ id: 'input', label: 'Input', value: args }] : [];
  }
  return Object.entries(args).map(([key, value]) => ({
    id: key,
    label: key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

export function ToolConfirmation({
  toolName,
  args,
  status = 'pending',
  onApprove,
  onDeny,
  className,
}: ToolConfirmationProps) {
  const parameters = React.useMemo(() => toParameters(args), [args]);

  return (
    <ToolApproval
      tool={toolName || 'tool'}
      title={toolName ? `Run ${toolName}?` : 'Run this tool?'}
      description="The agent needs permission before this runs."
      parameters={parameters}
      status={status}
      onApprove={() => void onApprove()}
      onDeny={() => void onDeny()}
      className={className}
    />
  );
}
