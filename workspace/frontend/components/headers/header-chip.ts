import { cn } from '@/lib/utils';

/**
 * ONE RECIPE FOR THE STATUS CHIPS IN A VIEW HEADER.
 *
 * The thread header carries five controls on one 48px row — orchestration
 * mode, the quota/context capsule, the git branch, the Studio toggle and the
 * overflow menu — and they were built in four different files, so they arrived
 * in four different shapes. `AgentQuotaCapsule` and `ContextHealthIndicator`
 * had already converged on `px-2.5 py-1 rounded-full … border-border` (by
 * copy, not by reference); `GitChip` used the same padding with `rounded-lg`
 * and `border-border-accent`. Same size, different corners, different rule
 * weight, sitting 8px apart.
 *
 * That is the composer's bottom row all over again, and it has the same fix:
 * the shape is a decision, so it lives in one place and the call sites import
 * it. What each chip still owns is its own CONTENT and its own semantic
 * states — a warning tint, a dirty-branch colour — because those say something
 * the shape does not.
 *
 * `rounded-full` over `rounded-lg`: these are status objects, not buttons that
 * perform an action, and the pill reads that way next to the two square icon
 * buttons at the end of the row. The header's own grouping relies on that
 * contrast — pills report, squares act — so a chip that squares itself off
 * quietly breaks the one thing organising the row.
 */
export const headerChipClass = cn(
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-2xs font-medium select-none',
  'border border-border text-foreground bg-surface2/80 hover:bg-surface3/90',
  'ui-transition duration-200',
  'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
);

/**
 * The two icon buttons at the end of the same row. Square, so they read as
 * actions against the pills that report. Both were already `size-7.5
 * rounded-lg`; this is here so the pair cannot drift apart the way the chips
 * did, and so the active state is written once.
 */
export const headerIconButtonClass = cn(
  'size-7.5 rounded-lg flex items-center justify-center transition-colors',
  'text-foreground-muted hover:text-foreground hover:bg-surface2',
  'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
);
