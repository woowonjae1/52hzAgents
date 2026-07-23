import * as React from "react"
import { cn } from "../../lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref} type={type}
      className={cn(
        "flex w-full rounded-xl border border-zinc-800/80 bg-zinc-950/40",
        "text-zinc-100 px-3.5 py-2 text-[13px] outline-none",
        "placeholder:text-zinc-500 transition-all duration-200",
        "focus:border-cyan-500/50 focus:bg-zinc-900/60 focus:shadow-[0_0_0_2px_rgba(6,182,212,0.15)]",
        "hover:border-zinc-700/80 hover:bg-zinc-900/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = "Input"

export { Input }
