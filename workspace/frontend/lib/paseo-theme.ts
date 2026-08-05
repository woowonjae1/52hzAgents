/**
 * Paseo's six themes — 1:1 with `ThemeName` / `THEME_SWATCHES` in
 * paseo/packages/app/src/styles/theme.ts.
 *
 * Paseo models these as one flat list: `light` plus five dark tints, and picking
 * a tint implies dark. Here `next-themes` keeps ownership of the `dark` class
 * (so the existing light/dark toggle and every `dark:` variant keep working) and
 * this module owns only the tint class on top of it. The default dark tint is
 * Paseo's own teal-green one, which needs no extra class.
 */

export type PaseoThemeName = 'light' | 'dark' | 'zinc' | 'midnight' | 'claude' | 'ghostty';

export interface PaseoThemeInfo {
  name: PaseoThemeName;
  label: string;
  /** Swatch shown in the picker — verbatim from Paseo's THEME_SWATCHES. */
  swatch: string;
  isDark: boolean;
  /** Class appended next to `dark`. Empty for light and the default dark tint. */
  tintClass: string;
}

export const PASEO_THEMES: PaseoThemeInfo[] = [
  { name: 'light', label: 'Light', swatch: '#ffffff', isDark: false, tintClass: '' },
  { name: 'dark', label: 'Paseo', swatch: '#2D8B62', isDark: true, tintClass: '' },
  { name: 'zinc', label: 'Zinc', swatch: '#808080', isDark: true, tintClass: 'theme-zinc' },
  { name: 'midnight', label: 'Midnight', swatch: '#4A6BA8', isDark: true, tintClass: 'theme-midnight' },
  { name: 'claude', label: 'Claude', swatch: '#D97757', isDark: true, tintClass: 'theme-claude' },
  { name: 'ghostty', label: 'Ghostty', swatch: '#8caaee', isDark: true, tintClass: 'theme-ghostty' },
];

const ALL_TINT_CLASSES = PASEO_THEMES.map((t) => t.tintClass).filter(Boolean);

const STORAGE_KEY = 'paseo-theme';

export function getPaseoTheme(name: string | null | undefined): PaseoThemeInfo {
  return PASEO_THEMES.find((t) => t.name === name) || PASEO_THEMES[0];
}

/** Read the stored selection. Returns null when nothing has been chosen yet. */
export function readStoredPaseoTheme(): PaseoThemeName | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && PASEO_THEMES.some((t) => t.name === stored) ? (stored as PaseoThemeName) : null;
  } catch {
    return null;
  }
}

export function storePaseoTheme(name: PaseoThemeName) {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Private mode / disabled storage — the class is still applied for this session.
  }
}

/**
 * Swap the tint class on <html>. Only ever touches `theme-*`; the `dark` class
 * belongs to next-themes and is left alone so the two cannot fight over it.
 */
export function applyPaseoTint(name: PaseoThemeName) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const { tintClass } = getPaseoTheme(name);
  for (const cls of ALL_TINT_CLASSES) {
    if (cls !== tintClass) root.classList.remove(cls);
  }
  if (tintClass) root.classList.add(tintClass);
}

/**
 * Derive the current selection from the stored value and next-themes' resolved
 * light/dark. A stored dark tint only applies while actually in dark mode, so
 * toggling to light and back restores the tint the user picked.
 */
export function resolvePaseoTheme(isDark: boolean): PaseoThemeName {
  if (!isDark) return 'light';
  const stored = readStoredPaseoTheme();
  if (stored && getPaseoTheme(stored).isDark) return stored;
  return 'dark';
}
