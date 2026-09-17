'use client';

import { Hint } from '@/components/ui/hint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Loader2, Plus, RefreshCw, Timer, X, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { RowActions } from '@/components/ui/row-actions';
import { runUndoable } from '@/lib/undoable';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/lib/workspace-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { stripAddressPrefix } from '@/lib/types';

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

  /*
    CANCELLING A TIMER WAS THE ONE DESTRUCTIVE ACTION IN THE APP WITH NO WAY
    BACK — no confirmation dialog, no undo window, one click and the reminder
    is gone. Knowledge entries and routines at least ask first; this did not.

    An undo window rather than a dialog, matching what files and threads
    already do here. A confirmation stops you every time to protect against the
    rare mistake; an undo window costs nothing when you meant it and still
    catches the one time you did not — which is the right trade for something
    you cancel deliberately and often.

    `hidden` is local because the row list comes from the workspace context and
    cannot be mutated optimistically from here; hiding the row is the optimistic
    half, and putting it back is the exact inverse.
  */
  const [hiddenTimerIds, setHiddenTimerIds] = useState<Set<string>>(new Set());

  const cancelTimerUndoable = useCallback((timer: { id: string; message: string }) => {
    const label = timer.message.length > 32 ? timer.message.slice(0, 32).trim() + '…' : timer.message;
    runUndoable({
      message: `Cancelled "${label}"`,
      onOptimistic: () => setHiddenTimerIds((prev) => new Set(prev).add(timer.id)),
      onRevert: () => setHiddenTimerIds((prev) => {
        const next = new Set(prev);
        next.delete(timer.id);
        return next;
      }),
      onCommit: async () => {
        await cancelTimer(timer.id);
        // The server no longer lists it, so the local hide has served its
        // purpose; leaving the id in the set would leak one entry per cancel.
        setHiddenTimerIds((prev) => {
          const next = new Set(prev);
          next.delete(timer.id);
          return next;
        });
      },
      errorMessage: 'Could not cancel the timer',
    });
  }, [cancelTimer]);
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
  const activeTimers = useMemo(() => timers.filter((timer) => timer.status === 'active' && !hiddenTimerIds.has(timer.id)).sort((a, b) => {
    const aT = a.firesAt ? new Date(a.firesAt).getTime() : 0;
    const bT = b.firesAt ? new Date(b.firesAt).getTime() : 0;
    return aT - bT;
  }), [timers]);

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
        source: source.includes(':') ? source : `52hz:${source}`,
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
      <header className="app-header justify-between ps-4 shrink-0">
        <div>
          <ScreenTitle>Timers</ScreenTitle>
          <p className="text-xs text-muted-foreground">Schedule one-time reminders for an agent</p>
        </div>
        <div className="flex items-center gap-1">
          <Hint label="Refresh timers">
            <Button variant="ghost" mode="icon" size="sm" onClick={() => void refreshTimers()}><RefreshCw className="size-4" /></Button>
          </Hint>
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
                <Clock3 className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug">{timer.message}</p>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-3xs text-muted-foreground">
                    <span>{timer.channelName}</span>
                    <span>for {stripAddressPrefix(timer.createdBy)}</span>
                    <Hint label={formatDate(timer.firesAt)}>
                      <span>{timeUntil(timer.firesAt)}</span>
                    </Hint>
                  </div>
                </div>
                <RowActions
                  label={`Actions for timer ${timer.id}`}
                  items={[
                    {
                      label: 'Copy message',
                      icon: Copy,
                      onSelect: () => {
                        navigator.clipboard.writeText(timer.message);
                        toast.success('Copied');
                      },
                    },
                    { label: 'Cancel timer', icon: X, destructive: true, onSelect: () => cancelTimerUndoable(timer) },
                  ]}
                />
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
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} disabled={submitting} placeholder="e.g. Check whether the deployment completed" className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-border-accent transition-colors" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Agent</label>
              <Select value={source} onValueChange={setSource} disabled={submitting}>
                <SelectTrigger size="lg" className="w-full">
                  <SelectValue placeholder="Pick an agent" />
                </SelectTrigger>
                <SelectContent>
                  {availableAgents.map((agent) => <SelectItem key={agent.agentName} value={agent.agentName}>{agent.agentName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Conversation</label>
              <Select value={channel} onValueChange={setChannel} disabled={submitting}>
                <SelectTrigger size="lg" className="w-full">
                  <SelectValue placeholder="Pick a conversation" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Remind after</label>
              <div className="grid grid-cols-4 gap-1.5">
                {DELAY_PRESETS.map((preset) => (
                  <button key={preset.seconds} type="button" onClick={() => setDelaySeconds(preset.seconds)} disabled={submitting} className={delaySeconds === preset.seconds ? 'rounded-md bg-primary text-primary-foreground px-2 py-1.5 text-xs font-medium' : 'rounded-md border border-input px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted'}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Custom</span>
                <Input type="number" min={1} max={31536000} value={delaySeconds} onChange={(event) => setDelaySeconds(Math.max(1, Number(event.target.value) || 1))} disabled={submitting} className="w-28 focus-visible:ring-0 focus-visible:border-border-accent transition-colors" />
                <span className="text-muted-foreground">seconds</span>
              </div>
            </div>
            {error && <p className="text-xs text-status-danger">{error}</p>}
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