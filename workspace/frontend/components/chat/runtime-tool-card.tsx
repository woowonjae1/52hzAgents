'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, Terminal, FileCode, AlertCircle } from 'lucide-react';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { DiffBlock } from './diff-block';

export interface RuntimeTool {
  id: string; channel: string; tool: string; args: Record<string, unknown>;
  status: 'running' | 'pending' | 'completed' | 'failed' | 'denied' | 'cancelled' | 'expired' | 'interrupted';
  output: string; output_truncated?: boolean; patch?: string; patch_truncated?: boolean; path?: string;
  cwd?: string; approval_id?: string; duration_ms?: number;
  result?: { exit_code?: number; exitCode?: number };
}

export function useRuntimeTools(channel?: string | null) {
  const [tools, setTools] = useState<RuntimeTool[]>([]);
  useEffect(() => {
    setTools([]);
    if (!channel) return;
    const controller = new AbortController();
    let changed = false;
    const refresh = () => { void workspaceApi.request<{ tools: RuntimeTool[] }>(`/v1/runtime/tools?channel=${encodeURIComponent(channel)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted && !changed) setTools(value.tools || []); }).catch(() => {}); };
    const update = (event: Event) => {
      const row = (event as CustomEvent<RuntimeTool>).detail;
      if (row.channel !== channel) return;
      changed = true;
      setTools(previous => previous.some(item => item.id === row.id) ? previous.map(item => item.id === row.id ? row : item) : [...previous, row]);
    };
    window.addEventListener('52hz:runtime-tool-updated', update); refresh();
    // Reconcile after a dropped SSE connection or a sleeping window.
    const reconcile = () => { changed = false; refresh(); };
    window.addEventListener('online', reconcile); window.addEventListener('focus', reconcile);
    const timer = window.setInterval(reconcile, 5000);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('52hz:runtime-tool-updated', update); window.removeEventListener('online', reconcile); window.removeEventListener('focus', reconcile); };
  }, [channel]);
  return tools;
}

export function RuntimeToolCard({ initial }: { initial: RuntimeTool }) {
  const [row, setRow] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let changed = false;
    const refresh = () => { void workspaceApi.request<RuntimeTool>(`/v1/runtime/tools/${initial.id}?channel=${encodeURIComponent(initial.channel)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { if (!changed) setRow(value); setChecked(true); } }).catch(() => {}); };
    const update = (event: Event) => { const next = (event as CustomEvent<RuntimeTool>).detail; if (next.id === initial.id && next.channel === initial.channel) { changed = true; setRow(next); setChecked(true); } };
    window.addEventListener('52hz:runtime-tool-updated', update); refresh();
    const timer = window.setInterval(() => { changed = false; refresh(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('52hz:runtime-tool-updated', update); };
  }, [initial.id, initial.channel]);
  const decide = async (granted: boolean) => {
    setBusy(true);
    try { const value = await workspaceApi.request<RuntimeTool>(`/v1/runtime/approvals/${row.approval_id}`, { method: 'POST', body: JSON.stringify({ channel: row.channel, granted }) }); setRow(value); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Approval failed.'); }
    finally { setBusy(false); }
  };
  const shell = row.tool === 'powershell' || row.tool === 'bash';
  const working = row.status === 'running';
  const exit = row.result?.exit_code ?? row.result?.exitCode;
  return <div className="my-3 overflow-hidden rounded-xl border border-border bg-surface1 text-xs" data-runtime-tool={row.id}>
    <div className="flex items-center gap-2 px-3 py-2.5">
      {working ? <Loader2 className="size-3.5 animate-spin" /> : row.status === 'completed' ? <Check className="size-3.5 text-emerald-500" /> : row.status === 'failed' ? <AlertCircle className="size-3.5 text-red-400" /> : shell ? <Terminal className="size-3.5" /> : <FileCode className="size-3.5" />}
      <span className="font-medium">{row.tool}</span><span className="min-w-0 flex-1 truncate font-mono text-foreground-muted">{String(row.args?.path || row.args?.text || row.args?.pattern || '')}</span>
      <span className={row.status === 'pending' ? 'text-amber-500' : 'text-foreground-muted'}>{row.status === 'pending' ? 'Approval required' : row.status}</span>
      {exit !== undefined && <span>exit {exit}</span>}{row.duration_ms !== undefined && <span className="text-foreground-extra-muted">{(row.duration_ms / 1000).toFixed(1)}s</span>}
    </div>
    {shell && <div className="border-t border-border px-3 py-3"><pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{String(row.args?.command || '')}</pre><p className="mt-2 break-all text-[10px] text-foreground-extra-muted">{row.cwd}</p></div>}
    {row.status === 'pending' && <div className="space-y-2 border-t border-border bg-amber-500/5 px-3 py-3"><p className="text-[11px] text-foreground-muted">Runs with your system permissions. Review the full command before approving.</p><div className="flex gap-2"><button disabled={busy || !checked} onClick={() => void decide(true)} className="rounded-md bg-foreground px-3 py-1.5 text-background disabled:opacity-40">Approve command</button><button disabled={busy || !checked} onClick={() => void decide(false)} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Deny</button></div></div>}
    {row.patch ? <DiffBlock code={row.patch} filePath={row.path} embedded interactiveReview={false} /> : row.output ? <details open={shell || row.status === 'failed'} className="border-t border-border px-3 py-2"><summary className="cursor-pointer text-foreground-muted">Output</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{row.output}</pre></details> : null}
    {(row.output_truncated || row.patch_truncated) && <p className="px-3 pb-2 text-[10px] text-foreground-muted">Display truncated. Inspect the project files for the full change.</p>}
  </div>;
}
