import * as React from "react"
import { cn } from "../../lib/utils"

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  id?: string
  disabled?: boolean
  className?: string
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, id, disabled, className }, ref) => (
    <button
      ref={ref} id={id} type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex items-center shrink-0 outline-none border-none p-0 cursor-pointer",
        "w-11 h-6 rounded-full transition-colors duration-200 ease-in-out",
        checked ? "bg-(--accent)" : "bg-(--surface-3) hover:bg-(--surface-4)",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-[left] duration-200 ease-in-out",
          checked ? "left-[22px]" : "left-[2px]",
        )}
      />
    </button>
  ),
)
Switch.displayName = "Switch"

export { Switch }
