'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import type { RoutineItem, WorkspaceAgent } from '@/lib/types';
import { localTimezone } from '@/lib/api/planning';
import { timezoneLabel } from '@/lib/schedule-format';

export interface RoutineDraft {
  name: string;
  message: string;
  source: string;
  hour?: number;
  minute?: number;
  days?: number[];
  interval_minutes?: number;
  timezone?: string;
  conversation_history?: string;
}

interface CreateRoutineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: WorkspaceAgent[];
  conversationHistory?: string;
  onCreateRoutine: (params: RoutineDraft) => Promise<void>;
  /**
   * When set, the dialog edits this routine instead of creating one. The agent
   * and the routine's identity are fixed at that point — only its instruction
   * and timing are editable.
   */
  routine?: RoutineItem | null;
  onUpdateRoutine?: (
    routineId: string,
    patch: {
      name?: string;
      message?: string;
      scheduleMode?: 'daily' | 'interval';
      hour?: number;
      minute?: number;
      days?: number[];
      intervalMinutes?: number;
      timezone?: string;
    }
  ) => Promise<void>;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];
const WEEKEND = [5, 6];
const INTERVAL_PRESETS = [
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '4h', value: 240 },
];

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((d) => b.includes(d));
}

export function CreateRoutineDialog({
  open,
  onOpenChange,
  agents,
  conversationHistory,
  onCreateRoutine,
  routine,
  onUpdateRoutine,
}: CreateRoutineDialogProps) {
  const isEditing = Boolean(routine);
  const onlineAgents = agents.filter((a) => a.status === 'online');
  const defaultAgent = onlineAgents.find((a) => a.role === 'master')?.agentName || onlineAgents[0]?.agentName || '';

  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [nameManual, setNameManual] = useState(false);
  const [source, setSource] = useState(defaultAgent);
  const [scheduleType, setScheduleType] = useState<'daily' | 'interval'>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [days, setDays] = useState<Set<number>>(new Set(ALL_DAYS));
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [timezone, setTimezone] = useState(localTimezone());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setError(null);

    if (routine) {
      setMessage(routine.message);
      setName(routine.name);
      setNameManual(true);
      setSource(routine.createdBy);
      setTimezone(routine.timezone || 'UTC');
      if (routine.scheduleIntervalMinutes) {
        setScheduleType('interval');
        setIntervalMinutes(routine.scheduleIntervalMinutes);
        setHour(9);
        setMinute(0);
        setDays(new Set(ALL_DAYS));
      } else {
        setScheduleType('daily');
        setHour(routine.scheduleHour ?? 9);
        setMinute(routine.scheduleMinute ?? 0);
        setDays(new Set(routine.scheduleDays?.length ? routine.scheduleDays : ALL_DAYS));
        setIntervalMinutes(60);
      }
      return;
    }

    setMessage('');
    setName('');
    setNameManual(false);
    setSource(defaultAgent);
    setScheduleType('daily');
    setHour(9);
    setMinute(0);
    setDays(new Set(ALL_DAYS));
    setIntervalMinutes(60);
    setTimezone(localTimezone());
  }, [open, defaultAgent, routine]);

  const handleMessageChange = useCallback((value: string) => {
    setMessage(value);
    if (!nameManual) {
      const words = value.trim().split(/\s+/).slice(0, 6).join(' ');
      setName(words.length > 50 ? words.slice(0, 50) : words);
    }
  }, [nameManual]);

  const toggleDay = (day: number) => {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) {
        if (next.size > 1) next.delete(day);
      } else {
        next.add(day);
      }
      return next;
    });
  };

  const selectedDays = useMemo(() => Array.from(days).sort((a, b) => a - b), [days]);

  // Named presets carry the intent ("every weekday") that a row of seven
  // toggles makes the reader reconstruct.
  const dayPreset = useMemo(() => {
    if (sameDays(selectedDays, ALL_DAYS)) return 'daily';
    if (sameDays(selectedDays, WEEKDAYS)) return 'weekdays';
    if (sameDays(selectedDays, WEEKEND)) return 'weekends';
    return 'custom';
  }, [selectedDays]);

  const handleSubmit = async () => {
    if (!message.trim() || !name.trim() || !source) return;
    setSubmitting(true);
    setError(null);
    try {
      if (routine && onUpdateRoutine) {
        await onUpdateRoutine(routine.id, {
          name: name.trim(),
          message: message.trim(),
          scheduleMode: scheduleType,
          timezone,
          ...(scheduleType === 'interval'
            ? { intervalMinutes }
            : { hour, minute, days: selectedDays }),
        });
      } else {
        const params: RoutineDraft = {
          name: name.trim(),
          message: message.trim(),
          source: source.includes(':') ? source : `52hz:${source}`,
          timezone,
          ...(conversationHistory ? { conversation_history: conversationHistory } : {}),
        };
        if (scheduleType === 'interval') {
          params.interval_minutes = intervalMinutes;
        } else {
          params.hour = hour;
          params.minute = minute;
          params.days = selectedDays;
        }
        await onCreateRoutine(params);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routine');
    } finally {
      setSubmitting(false);
    }
  };

  const isValid = Boolean(message.trim() && name.trim() && source);
  const zoneLabel = timezoneLabel(timezone);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{isEditing ? 'Edit Schedule' : 'Create Routine'}</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          {isEditing
            ? `Update ${routine?.shortId || 'this schedule'}. Its run history is kept.`
            : 'Set up a recurring task for an agent.'}
        </DialogDescription>

        <div className="mt-3 space-y-4">
          {/* Task description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">What should the agent do?</label>
            <textarea
              value={message}
              onChange={(e) => handleMessageChange(e.target.value)}
              placeholder="e.g. Check the deployment status and report any issues"
              rows={3}
              disabled={submitting}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card focus:outline-none focus:border-border-accent transition-colors resize-none"
            />
          </div>

          {/* Routine name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Routine name</label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setNameManual(true); }}
              placeholder="Short label for this routine"
              disabled={submitting}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-border bg-card focus:outline-none focus:border-border-accent transition-colors"
            />
          </div>

          {/* Agent selector — fixed once the routine exists, since its message
              channel and run history belong to that agent. */}
          {isEditing ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Agent</label>
              <p className="text-sm text-foreground">{source}</p>
            </div>
          ) : (
            onlineAgents.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Agent</label>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  disabled={submitting}
                  className="w-full text-sm rounded-lg border border-border bg-card px-3 py-2 focus:outline-none focus:border-border-accent transition-colors"
                >
                  {onlineAgents.map((a) => (
                    <option key={a.agentName} value={a.agentName}>{a.agentName}</option>
                  ))}
                </select>
              </div>
            )
          )}

          {/* Schedule type toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Schedule</label>
            <div className="flex gap-1 p-0.5 rounded-lg bg-surface2">
              {(['daily', 'interval'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setScheduleType(type)}
                  disabled={submitting}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors capitalize',
                    scheduleType === type
                      ? 'bg-card shadow-xs text-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Daily schedule config */}
          {scheduleType === 'daily' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <label className="text-2xs text-muted-foreground">Hour</label>
                  <select
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                    disabled={submitting}
                    className="w-full text-sm rounded-lg border border-border bg-card px-2 py-1.5 focus:outline-none focus:border-border-accent transition-colors"
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 space-y-1">
                  <label className="text-2xs text-muted-foreground">Minute</label>
                  <select
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                    disabled={submitting}
                    className="w-full text-sm rounded-lg border border-border bg-card px-2 py-1.5 focus:outline-none focus:border-border-accent transition-colors"
                  >
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                      <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* The zone the time is interpreted in. Naming it here is what
                  makes "09:00" unambiguous; the field used to be labelled
                  "Hour (UTC)" while the server ignored the user's zone. */}
              <div className="space-y-1">
                <label className="text-2xs text-muted-foreground">Timezone</label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  disabled={submitting}
                  className="w-full text-sm rounded-lg border border-border bg-card px-2 py-1.5 focus:outline-none focus:border-border-accent transition-colors"
                >
                  {Array.from(new Set([localTimezone(), timezone, 'UTC'])).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz === localTimezone() ? `${tz} (local)` : tz} · {timezoneLabel(tz)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-2xs text-muted-foreground">Days</label>
                <div className="flex gap-1">
                  {([
                    { id: 'daily', label: 'Every day', value: ALL_DAYS },
                    { id: 'weekdays', label: 'Weekdays', value: WEEKDAYS },
                    { id: 'weekends', label: 'Weekends', value: WEEKEND },
                  ] as const).map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => setDays(new Set(preset.value))}
                      disabled={submitting}
                      className={cn(
                        'flex-1 text-3xs font-medium py-1 rounded-md border transition-colors',
                        dayPreset === preset.id
                          ? 'bg-surface3 border-border-accent text-foreground font-semibold'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {DAY_LABELS.map((label, i) => (
                    <button
                      key={i}
                      onClick={() => toggleDay(i)}
                      disabled={submitting}
                      className={cn(
                        'flex-1 text-3xs font-medium py-1.5 rounded-md transition-colors border',
                        days.has(i)
                          // text-primary-foreground, not text-white: in dark mode
                          // --primary is near-white, so a hardcoded white label
                          // left the selected days as blank blocks.
                          ? 'bg-primary border-primary text-primary-foreground font-semibold'
                          : 'border-border text-muted-foreground hover:bg-surface2 hover:text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-3xs text-muted-foreground">
                  Runs at {String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')} {zoneLabel}
                  {dayPreset === 'daily'
                    ? ' every day'
                    : ` on ${selectedDays.map((d) => DAY_LABELS[d]).join(', ')}`}
                </p>
              </div>
            </div>
          )}

          {/* Interval schedule config */}
          {scheduleType === 'interval' && (
            <div className="space-y-2">
              <div className="flex gap-1.5">
                {INTERVAL_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    onClick={() => setIntervalMinutes(preset.value)}
                    disabled={submitting}
                    className={cn(
                      'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors border',
                      intervalMinutes === preset.value
                        ? 'bg-primary border-primary text-primary-foreground font-semibold'
                        : 'border-border text-muted-foreground hover:bg-surface2 hover:text-foreground'
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Every</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))}
                  disabled={submitting}
                  className="w-20 px-2 py-1.5 text-sm rounded-lg border border-border bg-card focus:outline-none focus:border-border-accent transition-colors"
                />
                <span className="text-xs text-muted-foreground">minutes</span>
              </div>
              <p className="text-3xs text-muted-foreground">
                First run starts one interval from now.
              </p>
            </div>
          )}

          {/* Error display */}
          {error && (
            <p className="text-xs text-status-danger">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!isValid || submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin mr-1.5" />
                {isEditing ? 'Saving...' : 'Creating...'}
              </>
            ) : isEditing ? (
              'Save Changes'
            ) : (
              'Create Routine'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
