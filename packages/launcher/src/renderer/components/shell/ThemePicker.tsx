import React from "react"
import { Check, Palette } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import {
  ALL_THEMES,
  THEME_SWATCHES,
  useThemeStore,
  type ThemeMode,
} from "../../store/theme"

/**
 * Theme picker for the sidebar footer. Paseo ships one light theme and five
 * dark tints, so a two-state light/dark toggle can't express the choice —
 * hence a swatch list rather than a cycling button.
 */
export default function ThemePicker(): React.JSX.Element {
  const { t } = useTranslation()
  const { mode, resolved, setMode } = useThemeStore(
    useShallow((s) => ({ mode: s.mode, resolved: s.resolved, setMode: s.setMode })),
  )
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("shell.theme.tooltip", { theme: t(`shell.theme.names.${mode}`) })}
        aria-label={t("shell.theme.label")}
        className="grid size-7 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
        style={{ color: "var(--fg-muted)" }}
      >
        <Palette className="size-3.5" />
      </button>

      {open && (
        <div
          className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-44 overflow-hidden rounded-[var(--r-xl)] border py-1"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-c)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {ALL_THEMES.map((theme: ThemeMode) => {
            const selected = mode === theme
            const swatch =
              theme === "system" ? THEME_SWATCHES[resolved] : THEME_SWATCHES[theme]
            return (
              <button
                key={theme}
                type="button"
                onClick={() => {
                  setMode(theme)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--surface-3)]"
              >
                <span
                  className="size-3 shrink-0 rounded-full border"
                  style={{ background: swatch, borderColor: "var(--border-accent)" }}
                />
                <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--fg)" }}>
                  {t(`shell.theme.names.${theme}`)}
                </span>
                {selected && <Check className="size-3.5 shrink-0" style={{ color: "var(--accent-bright)" }} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
