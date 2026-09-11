/**
 * THE KEYMAP IS DECLARED ONCE, HERE.
 *
 * Before this file the app advertised shortcuts in three places and
 * implemented them in none of them:
 *
 *   - the command palette printed `G T`, `G A`, `G M`, `G S`, `G L` badges,
 *     and nothing in the app ever listened for a `g` prefix;
 *   - the empty chat pane and the sidebar's "New chat" row both printed
 *     `Ctrl+N`, and nothing listened for it either;
 *   - the Studio panel's close button says "Close Studio (Esc)", and Esc
 *     closed the artifact canvas only.
 *
 * A badge that lies is worse than no badge: it teaches a key, the key does
 * nothing, and the user concludes the app's keyboard support is broken
 * everywhere. So the list below is the source of truth for BOTH the handler
 * (components/layout/global-shortcuts.tsx) and every surface that prints a
 * key — the help sheet, the palette badges, the empty-state hints.
 *
 * If you add a binding, add it here first. If you delete a binding, the badge
 * disappears with it.
 */

export type ShortcutGroup =
  | 'General'
  | 'Navigation'
  | 'Threads'
  | 'Panels';

export interface ShortcutSpec {
  id: string;
  group: ShortcutGroup;
  label: string;
  /**
   * Display tokens. `Mod` renders as ⌘ on Apple platforms and `Ctrl`
   * everywhere else; a lone token that is not a named key renders verbatim.
   * A `then` token renders as "then" — that is how the `g` sequences read.
   */
  keys: string[];
  /** When the binding only applies in part of the app, say so. */
  scope?: string;
}

/** `g`-prefixed navigation sequences, keyed by the second key pressed. */
export const GOTO_SEQUENCE: Record<string, { view: string; label: string }> = {
  t: { view: 'threads', label: 'Threads' },
  a: { view: 'tasks', label: 'Tasks' },
  m: { view: 'mission', label: 'Agent Dashboard' },
  f: { view: 'files', label: 'Files' },
  k: { view: 'knowledge', label: 'Knowledge' },
  e: { view: 'skills', label: 'Skills' },
  r: { view: 'routines', label: 'Routines' },
  i: { view: 'inbox', label: 'Inbox' },
  b: { view: 'browser', label: 'Browser' },
  n: { view: 'connect', label: 'Connect agents' },
  s: { view: 'settings', label: 'Settings' },
};

export const SHORTCUTS: ShortcutSpec[] = [
  // ── General ──
  { id: 'palette', group: 'General', label: 'Command palette', keys: ['Mod', 'K'] },
  { id: 'help', group: 'General', label: 'Keyboard shortcuts', keys: ['?'] },
  { id: 'new-chat', group: 'General', label: 'New chat', keys: ['C'] },
  { id: 'settings', group: 'General', label: 'Settings', keys: ['Mod', ','] },
  { id: 'theme', group: 'General', label: 'Toggle light / dark', keys: ['Mod', 'Shift', 'L'] },

  // ── Navigation ──
  {
    id: 'goto',
    group: 'Navigation',
    label: 'Go to — threads (t), tasks (a), mission (m), files (f), knowledge (k), skills (e), routines (r), inbox (i), browser (b), connect (n), settings (s)',
    keys: ['G', 'then', 'key'],
  },
  { id: 'thread-n', group: 'Navigation', label: 'Open the Nth thread', keys: ['1'], scope: 'Thread list' },

  // ── Threads ──
  { id: 'thread-next', group: 'Threads', label: 'Next thread', keys: ['J'], scope: 'Thread list' },
  { id: 'thread-prev', group: 'Threads', label: 'Previous thread', keys: ['K'], scope: 'Thread list' },
  { id: 'thread-search', group: 'Threads', label: 'Search threads', keys: ['/'], scope: 'Thread list' },
  { id: 'compose', group: 'Threads', label: 'Focus the message box', keys: ['I'], scope: 'Thread list' },
  { id: 'send', group: 'Threads', label: 'Send message', keys: ['Enter'], scope: 'Message box' },
  { id: 'newline', group: 'Threads', label: 'New line', keys: ['Shift', 'Enter'], scope: 'Message box' },
  { id: 'edit-last', group: 'Threads', label: 'Edit your last message', keys: ['↑'], scope: 'Empty message box' },

  // ── Panels ──
  { id: 'sidebar', group: 'Panels', label: 'Toggle sidebar', keys: ['Mod', 'B'] },
  { id: 'studio', group: 'Panels', label: 'Toggle Studio panel', keys: ['Mod', '\\'] },
  { id: 'escape', group: 'Panels', label: 'Close the topmost panel', keys: ['Esc'] },
];

/**
 * True on Apple hardware. Reads `data-platform` first — the desktop shell
 * stamps it on <html> before first paint (lib/desktop.ts) and knows the real
 * OS — and only falls back to sniffing the browser.
 */
export function isApplePlatform(): boolean {
  if (typeof document === 'undefined') return false;
  const stamped = document.documentElement.getAttribute('data-platform');
  if (stamped) return stamped === 'darwin';
  const nav = typeof navigator === 'undefined' ? null : navigator;
  if (!nav) return false;
  const platform =
    (nav as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    nav.platform ||
    '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const NAMED: Record<string, string> = {
  Shift: '⇧',
  Alt: '⌥',
  Enter: '↵',
  Esc: 'Esc',
  then: 'then',
};

/** One display token → what the user should see on this platform. */
export function formatKeyToken(token: string): string {
  if (token === 'Mod') return isApplePlatform() ? '⌘' : 'Ctrl';
  if (token === 'Alt') return isApplePlatform() ? '⌥' : 'Alt';
  if (token === 'Shift') return isApplePlatform() ? '⇧' : 'Shift';
  return NAMED[token] ?? token;
}

/** Whole binding → a single flat string, for `title=` and toast copy. */
export function formatShortcut(keys: string[]): string {
  return keys
    .map(formatKeyToken)
    .join(isApplePlatform() ? '' : '+')
    .replace(/\+?then\+?/, ' then ');
}

/** Look a binding up by id so callers never hardcode a key. */
export function shortcutKeys(id: string): string[] {
  return SHORTCUTS.find((s) => s.id === id)?.keys ?? [];
}

/** `formatShortcut` by id — the form most call sites want. */
export function shortcutFor(id: string): string {
  return formatShortcut(shortcutKeys(id));
}
