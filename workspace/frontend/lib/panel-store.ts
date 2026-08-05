/**
 * Sidebar sizing — 1:1 with paseo/packages/app/src/stores/panel-store/state.ts.
 *
 * The sidebar in Paseo is resizable, not a fixed rail: 320px by default, dragged
 * anywhere between 200 and 600, and remembered across launches. Keeping the
 * bounds here (rather than inline in the component) is what lets the sidebar and
 * the main-content spacer agree on one number.
 */

export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

const STORAGE_KEY = 'paseo-sidebar-width';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? clampSidebarWidth(Number(stored)) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function storeSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Private mode / disabled storage — the width still applies for this session.
  }
}
