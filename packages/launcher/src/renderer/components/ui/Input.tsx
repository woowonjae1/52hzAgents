import * as React from "react"
import { cn } from "../../lib/utils"

/**
 * Text input.
 *
 * Focus is signalled by the border alone — the old version added a 2px cyan
 * glow, which on a form with six fields turned the focused row into the loudest
 * thing on screen.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex w-full rounded-(--r-lg) border border-(--border-c) bg-(--surface-1)",
        "px-3 py-1.5 text-[13px] text-(--fg) outline-none",
        "placeholder:text-(--fg-x-muted) transition-colors duration-150",
        "hover:border-(--border-accent)",
        "focus:border-(--accent) focus:bg-(--surface-2)",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = "Input"

export { Input }
