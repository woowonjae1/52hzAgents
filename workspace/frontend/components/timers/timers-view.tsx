'use client';

import { useEffect, useMemo, useState } from 'react';
import { Clock3, Loader2, Plus, RefreshCw, Timer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/lib/workspace-context';

const DELAY_PRESETS = [
  { label: '5 min', seconds: 5 * 60 },
  { label: '15 min', seconds: 15 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
];

function timeUntil(dateStr: string): string {
  const difference = new Date(dateStr).getTime() - Date.now();
  if (difference <= 0) return 'due now';
  const minutes = Math.ceil(difference / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function TimersView() {
  const { timers, refreshTimers, createTimer, cancelTimer, agents, sessions, currentSessionId } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [delaySeconds, setDelaySeconds] = useState(15 * 60);
  const [source, setSource] = useState('');
  const [channel, setChannel] = useState('general');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableAgents = useMemo(() => {
    const online = agents.filter((agent) => agent.status === 'online');
    return online.length ? online : agents;
  }, [agents]);
  const channels = useMemo(() => {
    const values = sessions
      .filter((session) => !session.sessionId.startsWith('routines:'))
      .map((session) => ({ id: session.sessionId, title: session.title || session.sessionId }));
    return values.length ? values : [{ id: 'general', title: 'General' }];
  }, [sessions]);
  const activeTimers = useMemo(() => timers.filter((timer) => timer.status === 'active').sort((a, b) => (
    new Date(a.firesAt).getTime() - new Date(b.firesAt).getTime()
  )), [timers]);

  useEffect(() => {
    void refreshTimers();
  }, [refreshTimers]);

  const openCreate = () => {
    const defaultAgent = availableAgents.find((agent) => agent.role === 'master')?.agentName || availableAgents[0]?.agentName || '';
    const defaultChannel = currentSessionId && !currentSessionId.startsWith('routines:')
      ? currentSessionId
      : channels[0]?.id || 'general';
    setMessage('');
    setDelaySeconds(15 * 60);
    setSource(defaultAgent);
    setChannel(defaultChannel);
    setError(null);
    setDialogOpen(true);
  };

  const submit = async () => {
    if (!message.trim() || !source || !channel || delaySeconds < 1) return;
    setSubmitting(true);
    setError(null);
    try {
      await createTimer({
        source: `openagents:${source}`,
        channel,
        message: message.trim(),
        delaySeconds,
      });
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create timer.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Timers</h2>
          <p className="text-xs text-muted-foreground">Schedule one-time reminders for an agent</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" mode="icon" size="sm" onClick={() => void refreshTimers()} title="Refresh timers"><RefreshCw className="size-4" /></Button>
          <Button size="sm" onClick={openCreate} disabled={!availableAgents.length}><Plus className="mr-1 size-3.5" />New timer</Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTimers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Timer className="size-8 opacity-30" />
            <p className="text-sm">No active timers</p>
            <p className="text-xs">A timer posts a reminder into the selected conversation.</p>
            <Button variant="outline" size="sm" onClick={openCreate} disabled={!availableAgents.length}>Create timer</Button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
            {activeTimers.map((timer) => (
              <div key={timer.id} className="flex items-start gap-3 px-3 py-3">
                <Clock3 className="mt-0.5 size-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug">{timer.message}</p>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span>{timer.channelName}</span>
                    <span>for {timer.createdBy.replace(/^openagents:/, '')}</span>
                    <span title={formatDate(timer.firesAt)}>{timeUntil(timer.firesAt)}</span>
                  </div>
                </div>
                <Button variant="ghost" mode="icon" size="sm" onClick={() => void cancelTimer(timer.id)} title="Cancel timer">
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Create timer</DialogTitle>
          <DialogDescription>The selected agent will receive this reminder in the chosen conversation.</DialogDescription>
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Reminder</label>
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} disabled={submitting} placeholder="e.g. Check whether the deployment completed" className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-650 transition-colors" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Agent</label>
              <select value={source} onChange={(event) => setSource(event.target.value)} disabled={submitting} className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-650 transition-colors">
                {availableAgents.map((agent) => <option key={agent.agentName} value={agent.agentName}>{agent.agentName}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Conversation</label>
              <select value={channel} onChange={(event) => setChannel(event.target.value)} disabled={submitting} className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-650 transition-colors">
                {channels.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Remind after</label>
              <div className="grid grid-cols-4 gap-1.5">
                {DELAY_PRESETS.map((preset) => (
                  <button key={preset.seconds} type="button" onClick={() => setDelaySeconds(preset.seconds)} disabled={submitting} className={delaySeconds === preset.seconds ? 'rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 px-2 py-1.5 text-xs font-semibold' : 'rounded-md border border-input px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted'}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Custom</span>
                <Input type="number" min={1} max={31536000} value={delaySeconds} onChange={(event) => setDelaySeconds(Math.max(1, Number(event.target.value) || 1))} disabled={submitting} className="w-28 focus-visible:ring-0 focus-visible:border-zinc-400 dark:focus-visible:border-zinc-650 transition-colors" />
                <span className="text-muted-foreground">seconds</span>
              </div>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={submitting}>Cancel</Button>
            <Button size="sm" onClick={() => void submit()} disabled={submitting || !message.trim() || !source}>{submitting ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Creating...</> : 'Create timer'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
