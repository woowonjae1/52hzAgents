import React from "react"
import { Search } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "../lib/utils"

interface Props {
  /** Kept for call-site compatibility; the shell's title bar and the tab label
   *  already name the page, so rendering it a third time here was pure noise. */
  title?: React.ReactNode
  subtitle?: React.ReactNode
  /** Action buttons rendered on the right (before the search affordance). */
  actions?: React.ReactNode
  /** When true, shows a compact Cmd+K search trigger on the right. */
  showSearch?: boolean
  className?: string
}

/**
 * Slim action row for a management screen.
 *
 * Was an 18px bold `<h1>` plus a 260px search box in a 4-unit-tall header. Inside
 * the tabbed shell that produced three stacked copies of the same page name and
 * ate the top fifth of every screen, so the title is gone and what's left is the
 * row's actual job: page actions.
 */
export function TopBar({ subtitle, actions, showSearch = false, className }: Props): React.JSX.Element | null {
  const { t } = useTranslation()

  // A row holding nothing but a ⌘K button is a 44px empty band — the palette is
  // reachable by keyboard from anywhere, so it doesn't justify the row on its own.
  if (!subtitle && !actions) return null

  const triggerPalette = (): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true }))
  }

  return (
    <header
      className={cn(
        "shrink-0 flex h-11 items-center justify-between gap-4 px-6",
        "border-b border-(--border-c)",
        className,
      )}
    >
      <div className="min-w-0 truncate text-[12px] text-(--fg-muted)">{subtitle}</div>

      <div className="flex shrink-0 items-center gap-1.5">
        {actions}
        {showSearch && (
          <button
            type="button"
            onClick={triggerPalette}
            className={cn(
              "flex items-center gap-1.5 rounded-(--r-lg) px-2 py-1",
              "text-(--fg-muted) hover:bg-(--surface-2) hover:text-(--fg)",
              "cursor-pointer transition-colors",
            )}
            title={t("ui.topBar.openCommandPalette")}
          >
            <Search className="size-3.5" />
            <kbd className="rounded-(--r-base) bg-(--surface-2) px-1.5 py-0.5 text-[10px] text-(--fg-muted)">
              ⌘K
            </kbd>
          </button>
        )}
      </div>
    </header>
  )
}
