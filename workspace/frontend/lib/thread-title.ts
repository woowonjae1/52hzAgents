'use client';

/**
 * WHAT A THREAD IS CALLED.
 *
 * The old rule was: if the session has no explicit title, take the LAST
 * message, strip markdown, cut at 24 characters. Three things went wrong with
 * that, and they compound.
 *
 * 1. THE TITLE WAS NOT STABLE. Reading from the last message means the thread
 *    renames itself every turn. The same conversation is called
 *    "I will list the contents..." at one moment and "Claude error: You've
 *    hit..." a minute later. A name that moves cannot be remembered, and the
 *    spatial memory people build of a sidebar — "the Java migration one is
 *    about two thirds down" — never forms.
 *
 * 2. IT NAMED THREADS AFTER FAILURES. Whatever an agent said most recently
 *    became the thread's identity, so a channel was titled with a stack of
 *    crash text: "OpenCode couldn't run...", "Task interrupted — daemo...".
 *    The sidebar read as a crash dump of a system, rather than a list of
 *    things a person is working on.
 *
 * 3. THE FALLBACK COLLIDED WITH ITSELF. With no usable message, the last
 *    resort is the project folder's name — so every unnamed thread in one
 *    folder was called `java-to-go`, eight times in a column, mutually
 *    indistinguishable.
 *
 * THE FIX IS THE FIRST USER MESSAGE, not a better filter on the last one.
 * What a person asked for at the start is what the thread is about, it does
 * not change, and errors and tool chatter are almost never the opening line.
 * A blocklist of error shapes can only ever chase the formats it has already
 * seen; this sidesteps the chase.
 *
 * WHY A CACHE. The sessions list does not carry any message — only the newest
 * one, via a separate map — so the first user message is knowable only while
 * the thread is open and its transcript is loaded. ChatView records it there
 * (once, the first time it can), the sidebar reads it, and a thread that has
 * never been opened falls back to the filtered heuristic below. Server-side
 * summarisation is the real answer and this module is where it would land.
 */

const CACHE_KEY = 'thread-derived-titles-v1';
const MAX_TITLE = 32;

type TitleCache = Record<string, string>;

function readCache(): TitleCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as TitleCache) : {};
  } catch {
    return {};
  }
}

let cache: TitleCache | null = null;
const listeners = new Set<() => void>();

function getCache(): TitleCache {
  if (cache === null) cache = readCache();
  return cache;
}

export function getDerivedTitle(sessionId: string): string | undefined {
  return getCache()[sessionId];
}

/**
 * Record a thread's derived title. Written once and never overwritten — that
 * is the whole point of the exercise, so a later turn cannot rename the thread.
 */
export function rememberDerivedTitle(sessionId: string, title: string): void {
  const c = getCache();
  if (!sessionId || !title || c[sessionId]) return;
  c[sessionId] = title;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {}
  listeners.forEach((fn) => fn());
}

/** The sidebar subscribes so a title recorded while reading appears at once. */
export function subscribeToTitles(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Text that must never become a title.
 *
 * Used only for the fallback path — a thread nobody has opened, where the
 * newest message is all there is. The first-person forms are the giveaway for
 * an agent narrating itself ("I will check the .claude directory"), which
 * reads as a title but names an action rather than a subject.
 */
const UNUSABLE = [
  /^thinking(\.{0,3})?$/i,
  /^<think/i,
  /^using tool/i,
  /^sse-probe/i,
  // Failures. These were what made the list read as a crash log.
  /^[^\n]{0,40}\b(error|exception|failed|failure|traceback)\b/i,
  /couldn't|could not|cannot |unable to /i,
  /\binterrupted\b/i,
  /you've hit|rate limit|quota|timed? ?out/i,
  // An agent narrating its own next step.
  /^(i will|i'll|i am going to|i'm going to|let me|正在执行|我将|我会|让我)/i,
  // Bare tool/queue plumbing.
  /^\[(pipeline|system|queue)/i,
];

export function isUnusableTitleSource(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return UNUSABLE.some((re) => re.test(t));
}

/** Markdown, emoji and whitespace out; one line in. */
export function cleanTitleText(raw: string): string {
  const stripped = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_#~>]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  /*
    @mentions are addressing, not subject matter.

    A title taken from the first message kept them, so threads read
    "@openclaw 查询湖南天气 @antigravity" — two of the three words naming who
    was asked rather than what was asked. In the list the agents are already
    shown as avatars beside the title, so the names were being said twice and
    the actual topic was what got truncated away.

    Only stripped when something survives: "@pi" alone is a thread whose whole
    subject IS the agent, and an empty title is worse than a redundant one.
  */
  const withoutMentions = stripped.replace(/(^|\s)@[\w.\-]+/g, '$1').replace(/\s+/g, ' ').trim();
  return withoutMentions.length >= 2 ? withoutMentions : stripped;
}

export function truncateTitle(text: string, max = MAX_TITLE): string {
  return text.length > max ? text.slice(0, max).trim() + '…' : text;
}

/**
 * The first thing the user asked for, cleaned and cut.
 *
 * Deliberately NOT the first message of any kind: a channel often opens with a
 * system or join notice, and naming the thread after that is the same mistake
 * in a different place.
 */
export function deriveTitleFromMessages(
  messages: Array<{ senderType?: string; content?: string; messageType?: string }>,
): string | null {
  for (const m of messages) {
    const isHuman = m.senderType === 'human' || m.senderType === 'user';
    if (!isHuman) continue;
    if (m.messageType === 'status' || m.messageType === 'thinking') continue;
    const clean = cleanTitleText(m.content || '');
    if (!clean || clean.length < 2) continue;
    return truncateTitle(clean);
  }
  return null;
}
