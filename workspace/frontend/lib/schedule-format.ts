import type { RoutineItem } from './types';
import { localTimezone } from './api/planning';

/** Stored day indices are 0 = Monday … 6 = Sunday, not JavaScript's 0 = Sunday. */
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const WEEKDAYS = [0, 1, 2, 3, 4];
const WEEKEND = [5, 6];

/** Short zone label for display, e.g. "GMT+8" — the full IANA name is too long for a row. */
export function timezoneLabel(timezone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value || timezone;
  } catch {
    return timezone;
  }
}

/**
 * Renders a routine's timing in the zone it was scheduled for.
 *
 * This deliberately shows the routine's own timezone rather than the viewer's:
 * a schedule created in Asia/Shanghai keeps firing at 09:00 Shanghai time no
 * matter who is looking at it, and rewriting the number to the reader's local
 * clock would make two people describe the same routine differently. The zone
 * suffix is dropped when it matches the viewer's, which is the common case.
 */
export function formatSchedule(r: RoutineItem): string {
  if (r.scheduleIntervalMinutes) {
    const mins = r.scheduleIntervalMinutes;
    if (mins % 1440 === 0) {
      const days = mins / 1440;
      return days === 1 ? 'Every 24h' : `Every ${days} days`;
    }
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `Every ${h}h${m ? ` ${m}m` : ''}`;
    }
    return `Every ${mins}m`;
  }

  const zone = r.timezone || 'UTC';
  const clock = `${String(r.scheduleHour).padStart(2, '0')}:${String(r.scheduleMinute).padStart(2, '0')}`;
  const suffix = zone === localTimezone() ? '' : ` ${timezoneLabel(zone)}`;
  const time = `${clock}${suffix}`;

  const days = r.scheduleDays;
  if (!days || days.length === 0 || days.length === 7) return `Daily at ${time}`;
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return `Weekdays at ${time}`;
  if (days.length === 2 && WEEKEND.every((d) => days.includes(d))) return `Weekends at ${time}`;
  return `${[...days].sort().map((d) => DAY_NAMES[d] ?? String(d)).join(', ')} at ${time}`;
}

/**
 * Human countdown to an instant. `now` is passed in so a list of countdowns
 * re-renders off one clock tick instead of each row reading Date.now() itself.
 */
export function timeUntil(dateStr: string, now: number = Date.now()): string {
  const target = new Date(dateStr).getTime();
  if (!Number.isFinite(target)) return '—';
  const diff = target - now;
  if (diff <= 0) return 'due now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/** Absolute local rendering of an instant, for tooltips. */
export function formatAbsolute(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Relative "3m ago" phrasing shared by the task and run lists. */
export function timeAgo(dateStr: string | null, now: number = Date.now()): string {
  if (!dateStr) return '';
  const then = new Date(dateStr).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Elapsed wall time of a run; open runs report time-so-far. */
export function formatDuration(startStr: string, endStr: string | null, now: number = Date.now()): string {
  const start = new Date(startStr).getTime();
  if (!Number.isFinite(start)) return '—';
  const end = endStr ? new Date(endStr).getTime() : now;
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ${sec % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
