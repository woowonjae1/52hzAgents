export function uid(): string {
  return (Date.now() + Math.floor(Math.random() * 1000)).toString();
}

export function getInitials(
  name: string | null | undefined,
  count?: number,
): string {
  if (!name || typeof name !== 'string') {
    return '';
  }

  const initials = name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase());

  return count && count > 0
    ? initials.slice(0, count).join('')
    : initials.join('');
}

export function timeAgo(date: Date | string | number | null | undefined): string {
  if (date === null || date === undefined) return '';
  const now = new Date();
  // Accept Date, ISO string, or epoch milliseconds. Coerce anything else
  // safely so a bad value renders as empty instead of throwing.
  const inputDate = date instanceof Date ? date : new Date(date);
  const ms = inputDate.getTime();
  if (Number.isNaN(ms)) return '';
  const diff = Math.floor((now.getTime() - ms) / 1000);

  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600)
    return `${Math.floor(diff / 60)} minute${Math.floor(diff / 60) > 1 ? 's' : ''} ago`;
  if (diff < 86400)
    return `${Math.floor(diff / 3600)} hour${Math.floor(diff / 3600) > 1 ? 's' : ''} ago`;
  if (diff < 604800)
    return `${Math.floor(diff / 86400)} day${Math.floor(diff / 86400) > 1 ? 's' : ''} ago`;
  if (diff < 2592000)
    return `${Math.floor(diff / 604800)} week${Math.floor(diff / 604800) > 1 ? 's' : ''} ago`;
  if (diff < 31536000)
    return `${Math.floor(diff / 2592000)} month${Math.floor(diff / 2592000) > 1 ? 's' : ''} ago`;

  return `${Math.floor(diff / 31536000)} year${Math.floor(diff / 31536000) > 1 ? 's' : ''} ago`;
}

export function formatDate(input: Date | string | number): string {
  const date = new Date(input);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Agent freshness ──

/** Threshold in ms — offline agents older than this are hidden from sidebar. */
const STALE_AGENT_THRESHOLD = 60 * 60 * 1000; // 1 hour

/** Returns true if agent should be visible in sidebar (online or recently seen). */
export function isRecentAgent(agent: { status: string; agentType?: string | null; lastHeartbeatAt: string | null }): boolean {
  if (agent.status === 'online') return true;
  if (agent.agentType?.startsWith('cloud:')) return true;
  if (!agent.lastHeartbeatAt) return false;
  const elapsed = Date.now() - new Date(agent.lastHeartbeatAt).getTime();
  return elapsed < STALE_AGENT_THRESHOLD;
}

// ── Multi-agent visual differentiation ──
//
// There is no per-agent palette here any more. `lib/identity-colors.ts` is the
// single source: it derives a stable colour from the agent's NAME, where this
// file derived one from the agent's INDEX in the roster — so every agent's
// colour shifted whenever somebody joined or left. Import `deriveIdentityColor`
// instead of reintroducing a parallel set of Tailwind classes here.
/**
 * A THREAD ROW'S TIMESTAMP, IN FOUR CHARACTERS WHERE POSSIBLE.
 *
 * The sidebar used `timeAgo`, which produces "2 weeks ago", "3 weeks ago" —
 * eleven characters of right-aligned text on every row. Two things were wrong
 * with that once the list grew date bands of its own:
 *
 *   - it says the same thing the band above the row already said, and
 *   - it took 30-40% of the row's width to do it, which is why titles were
 *     being cut to a dozen characters and an ellipsis.
 *
 * The band answers "roughly when"; the row only has to answer "which one", so
 * the format narrows as the band widens. Today needs the clock, this week
 * needs the day, older needs a date — and none of them needs a sentence.
 *
 * Mail clients have converged on exactly this, for exactly this reason.
 */
export function formatRowTime(ms: number, now: number = Date.now()): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayStart = startOfToday.getTime();

  // Today — the clock, because that is what tells two of today's threads apart.
  if (ms >= dayStart) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  // The last week — the weekday name, which people navigate by far better than
  // "5 days ago" and which is shorter.
  if (ms >= dayStart - 6 * 86_400_000) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  // Older — a date. The year only when it is not this one.
  return d.toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: d.getFullYear() === startOfToday.getFullYear() ? undefined : '2-digit',
  });
}
