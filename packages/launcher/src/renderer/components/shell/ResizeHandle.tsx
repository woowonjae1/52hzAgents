import React from "react"
import { cn } from "../../lib/utils"

/**
 * Vertical drag handle between two panes.
 *
 * The visible seam is the 1px border of the neighbouring pane; this element is
 * a 7px transparent strip centered on it, because a 1px hit target is a
 * frustration and a 7px one is invisible. Pointer capture keeps the drag alive
 * when the cursor outruns the handle, which it always does.
 */
export default function ResizeHandle({
  onDrag,
  onDragEnd,
  onReset,
  className,
  ariaLabel,
}: {
  /** Absolute pointer x for the current move event. */
  onDrag: (clientX: number) => void
  onDragEnd?: () => void
  /** Double-click restores the default width. */
  onReset?: () => void
  className?: string
  ariaLabel?: string
}): React.JSX.Element {
  const [dragging, setDragging] = React.useState(false)

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    onDrag(event.clientX)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {}
    setDragging(false)
    onDragEnd?.()
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      className={cn(
        "relative z-10 w-[7px] shrink-0 cursor-col-resize select-none sidebar-no-drag",
        "-mx-[3px]",
        className,
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          dragging ? "bg-[var(--accent)]" : "bg-transparent hover:bg-[var(--border-accent)]",
        )}
      />
    </div>
  )
}
