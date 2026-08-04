import { create } from 'zustand'

/**
 * Paseo ships one light theme and five dark tints. `system` follows the OS and
 * resolves to `light` or the user's preferred dark tint.
 *
 * The union stays named `ThemeMode` and the store keeps `mode`/`setMode` so the
 * existing call sites (settings page, command palette) don't have to change —
 * they just gained four more values to offer.
 */
export type ThemeMode = 'system' | ResolvedTheme
export type ResolvedTheme = 'light' | 'dark' | 'zinc' | 'midnight' | 'claude' | 'ghostty'

export const DARK_THEMES: ResolvedTheme[] = ['dark', 'zinc', 'midnight', 'claude', 'ghostty']
export const ALL_THEMES: ThemeMode[] = ['system', 'light', ...DARK_THEMES]

/** Swatch color per theme — the accent for dark tints, white for light. */
export const THEME_SWATCHES: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#2d8b62',
  zinc: '#808080',
  midnight: '#4a6ba8',
  claude: '#d97757',
  ghostty: '#8caaee',
}

const STORAGE_KEY = 'launcher:theme-mode'
const DARK_PREF_KEY = 'launcher:theme-dark-tint'

function isTheme(value: unknown): value is ResolvedTheme {
  return typeof value === 'string' && (value === 'light' || DARK_THEMES.includes(value as ResolvedTheme))
}

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'system' || isTheme(raw)) return raw
  } catch {}
  return 'system'
}

/** Which dark tint `system` resolves to. Remembered separately so switching to
 *  light and back doesn't lose a chosen tint. */
function readDarkTint(): ResolvedTheme {
  try {
    const raw = localStorage.getItem(DARK_PREF_KEY)
    if (isTheme(raw) && raw !== 'light') return raw
  } catch {}
  return 'dark'
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? readDarkTint() : 'light'
  return mode
}

function apply(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved === 'light' ? 'light' : 'dark'
}

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (m: ThemeMode) => void
  init: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStoredMode(),
  resolved: resolve(readStoredMode()),
  setMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode)
      if (mode !== 'system' && mode !== 'light') localStorage.setItem(DARK_PREF_KEY, mode)
    } catch {}
    const resolved = resolve(mode)
    apply(resolved)
    set({ mode, resolved })
  },
  init: () => {
    const { mode } = get()
    const resolved = resolve(mode)
    apply(resolved)
    set({ resolved })
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (): void => {
        if (get().mode !== 'system') return
        const r = resolve('system')
        apply(r)
        set({ resolved: r })
      }
      try { mq.addEventListener('change', handler) } catch {
        mq.addListener(handler)
      }
    }
  },
}))
