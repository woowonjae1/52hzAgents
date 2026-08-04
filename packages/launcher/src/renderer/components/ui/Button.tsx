import * as React from "react"
import { cn } from "../../lib/utils"

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "outline" | "destructive" | "ghost" | "link"
  size?: "default" | "sm" | "lg" | "icon"
}

/**
 * Flat button set.
 *
 * No drop shadows and no colored glow: elevation is carried by the surface
 * tokens, and on a dark theme a shadow under a 28px control just reads as mud.
 * Only `primary` gets the accent fill — everything else is a bordered or bare
 * surface, so a dense row of actions has exactly one focal point.
 */
const variantClass: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default:
    "bg-transparent text-(--fg) border-(--border-c) hover:enabled:bg-(--surface-2) hover:enabled:border-(--border-accent)",
  primary:
    "bg-(--accent) text-(--accent-fg) font-medium border-transparent hover:enabled:brightness-110",
  // Alias of `default` — several call sites ask for it by name.
  outline:
    "bg-transparent text-(--fg) border-(--border-c) hover:enabled:bg-(--surface-2) hover:enabled:border-(--border-accent)",
  destructive:
    "bg-transparent text-(--destructive) border-(--border-c) hover:enabled:border-(--destructive) hover:enabled:bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)]",
  ghost: "bg-transparent border-transparent text-(--fg-muted) hover:enabled:bg-(--surface-2) hover:enabled:text-(--fg)",
  link: "border-transparent text-(--accent-bright) underline-offset-4 hover:enabled:underline px-0",
}

const sizeClass: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-8 px-3 text-[13px]",
  sm: "h-7 px-2.5 text-[12px]",
  lg: "h-9 px-4 text-[13px]",
  icon: "size-8 p-0",
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
        "rounded-(--r-lg) leading-none cursor-pointer select-none",
        "transition-colors duration-150 border outline-none",
        "focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-0",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = "Button"

export { Button }
