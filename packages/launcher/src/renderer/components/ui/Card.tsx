import * as React from "react"
import { cn } from "../../lib/utils"

/**
 * Flat card.
 *
 * Elevation comes from the surface step, not from a shadow, and hover only moves
 * the border. A grid of shadowed, lifting cards is the single biggest reason the
 * old management screens read as a dashboard demo rather than a tool.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { noPadding?: boolean }>(
  ({ className, noPadding, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "bg-(--surface-1) border border-(--border-c) rounded-(--r-xl)",
        "transition-colors duration-150 ease-(--ease) hover:border-(--border-accent)",
        !noPadding && "px-4 py-3.5",
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("mb-2.5 flex flex-col gap-1", className)} {...props} />
  ),
)
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("m-0 text-[13px] font-medium text-(--fg)", className)} {...props} />
  ),
)
CardTitle.displayName = "CardTitle"

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn(className)} {...props} />,
)
CardContent.displayName = "CardContent"

export { Card, CardHeader, CardTitle, CardContent }
