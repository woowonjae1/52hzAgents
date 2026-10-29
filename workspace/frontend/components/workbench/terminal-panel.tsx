'use client';

import { Terminal } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useRuntimeTools, RuntimeToolCard } from '@/components/chat/runtime-tool-card';

/** Real command history for the selected session, shared with the agent transcript. */
export function TerminalPanel() {
  const { currentSessionId } = useWorkspace();
  const rows = useRuntimeTools(currentSessionId).filter(row => row.tool === 'powershell' || row.tool === 'bash');
  return <div className="flex h-full flex-col bg-background">
    <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs font-medium"><Terminal className="size-3.5" />Command output<span className="ml-auto text-foreground-muted">{rows.length} commands</span></div>
    <div className="flex-1 overflow-auto px-4 py-2">
      {rows.length ? rows.map(row => <RuntimeToolCard key={row.id} initial={row} />) : <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center text-xs text-foreground-muted"><Terminal className="size-6 opacity-40" /><p>No commands in this session yet.</p><p className="max-w-64 text-[11px] leading-5">Choose Agent mode and ask it to run a check. Approve the command to see its actual output here.</p></div>}
    </div>
  </div>;
}
