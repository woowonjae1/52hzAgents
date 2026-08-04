import * as React from "react"
import { cn } from "../../lib/utils"

const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex w-full rounded-(--r-lg) border border-(--border-c)",
        "bg-(--surface-1) text-(--fg) px-3 py-1.5 text-[13px] outline-none",
        "transition-colors duration-150 hover:border-(--border-accent)",
        "focus:border-(--accent) focus:bg-(--surface-2)",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
)
Select.displayName = "Select"

export { Select }
