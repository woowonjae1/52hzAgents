/**
 * The SignalMark body colour — same shape as panel-store.ts: bounds and storage
 * live here so the settings UI and the pre-paint script in app/layout.tsx agree
 * on one key and one default.
 *
 * The mark is driven by a CSS variable rather than a React prop because it is
 * rendered in 11 places (sidebar, empty states, share page, chat bubbles) and
 * none of them are in one tree. A variable on <html> repaints all of them
 * without a single re-render, and it is the only mechanism that can also be set
 * before first paint.
 */

export interface MarkColorPreset {
  /** The `--signal-mark-body` value. */
  value: string;
  label: string;
  sublabel: string;
}

/**
 * Every preset sits in a narrow mid-tone band on purpose. The mark's features —
 * eyes and mouth — are a fixed near-black (#0B1013), so a body that goes too
 * dark loses the face, and one that goes too light stops holding its edge on a
 * white ground. These eight all read on both grounds with the same features.
 *
 * INVARIANT: values are lower-case. `normalizeMarkColor` lower-cases everything
 * it returns, so a preset written in caps here would never equal the stored
 * value and the grid would show no selection while the colour applied fine —
 * which is exactly how this was first written.
 */
export const MARK_COLOR_PRESETS: MarkColorPreset[] = [
  { value: '#1c6ea4', label: '信号蓝', sublabel: 'Signal' },
  { value: '#137d74', label: '深青', sublabel: 'Teal' },
  { value: '#4a7c3f', label: '松绿', sublabel: 'Moss' },
  { value: '#b7791f', label: '琥珀', sublabel: 'Amber' },
  { value: '#c4562b', label: '赤陶', sublabel: 'Terracotta' },
  { value: '#b03a48', label: '绛红', sublabel: 'Crimson' },
  { value: '#8b5ca8', label: '玫紫', sublabel: 'Mauve' },
  { value: '#5a6b78', label: '石板', sublabel: 'Slate' },
];

/** The mark's original colour, and the fallback baked into the SVG fills. */
export const DEFAULT_MARK_COLOR = MARK_COLOR_PRESETS[0].value;

export const MARK_COLOR_STORAGE_KEY = '52hz-mark-color';
export const MARK_COLOR_CSS_VAR = '--signal-mark-body';

/**
 * Anything that is not a 6-digit hex is rejected rather than clamped. This value
 * goes straight into a style property, so an unvalidated string read back out of
 * localStorage is the one place this could carry something it shouldn't.
 */
export function normalizeMarkColor(value: string | null | undefined): string {
  if (typeof value !== 'string') return DEFAULT_MARK_COLOR;
  const hex = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : DEFAULT_MARK_COLOR;
}

export function readStoredMarkColor(): string {
  if (typeof window === 'undefined') return DEFAULT_MARK_COLOR;
  try {
    return normalizeMarkColor(window.localStorage.getItem(MARK_COLOR_STORAGE_KEY));
  } catch {
    return DEFAULT_MARK_COLOR;
  }
}

export function applyMarkColor(color: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(MARK_COLOR_CSS_VAR, normalizeMarkColor(color));
}

const listeners = new Set<(color: string) => void>();

/**
 * Notifies every mounted `useMarkColor` — the settings panel is not the only
 * possible reader (the dialog and the full page can both be open), and without
 * this the swatch grid in one would keep showing a stale selection.
 */
export function storeMarkColor(color: string) {
  const next = normalizeMarkColor(color);
  try {
    window.localStorage.setItem(MARK_COLOR_STORAGE_KEY, next);
  } catch {
    // Private mode / disabled storage — the colour still applies for this session.
  }
  applyMarkColor(next);
  listeners.forEach((fn) => fn(next));
}

export function subscribeMarkColor(fn: (color: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Inlined into <head> and run before first paint. Without it the mark renders
 * once in the default blue and then swaps, which on a logo is a visible flicker
 * on every page load — the same reason a theme needs a pre-paint script.
 *
 * Kept as a string literal (not a function serialised with .toString()) because
 * minification would rename the constants it closes over.
 */
export const MARK_COLOR_PREPAINT_SCRIPT = `(function(){try{var v=localStorage.getItem('${MARK_COLOR_STORAGE_KEY}');if(v&&/^#[0-9a-fA-F]{6}$/.test(v))document.documentElement.style.setProperty('${MARK_COLOR_CSS_VAR}',v);}catch(e){}})();`;
