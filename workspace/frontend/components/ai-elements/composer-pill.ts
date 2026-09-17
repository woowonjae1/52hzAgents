import { cn } from '@/lib/utils';

/**
 * 底部控制条上的紧凑胶囊按钮样式 (Micro-pill tactile style)
 *
 * ONE RECIPE FOR THE COMPOSER'S BOTTOM CONTROL ROW.
 *
 * Four controls sit on that row — the agent/model switcher, Agent, Schedule
 * and attach — and they had three different treatments between them: the same
 * `h-7 px-2.5 rounded-full` geometry, but each with its own fill, its own
 * border alpha, and one of them carrying a `shadow-xs` the others did not.
 * That is the kind of thing that reads as unfinished without anyone being able
 * to name it, and it happened because the switcher lives in `components/chat`
 * and the other three are inline in `prompt-composer`.
 *
 * It is its own module rather than an export from either of those files
 * because `prompt-composer` renders `AgentModelSwitcher`: exporting from there
 * and importing back would be a cycle.
 *
 * The fill sits a layer DOWN, not up. These are on the composer, which is
 * `--surface2`; a `surface2/60` pill on a `surface2` ground is invisible in
 * light mode, which is what made the row read as loose text with stray
 * outlines around it. A control inset into a raised surface is darker than it,
 * hence `--surface1`. Dark keeps a white wash for the same reason the dark
 * elevation ramp does — there is nothing below `#18181e` to recede into.
 *
 * The focus ring is `--ring`, like every other focusable thing in the app,
 * rather than the `primary/40` this used to invent for itself.
 */
export const composerPillClass = cn(
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full select-none text-2xs font-medium',
  'text-muted-foreground hover:text-foreground bg-surface1 hover:bg-surface3 dark:bg-white/[0.05] dark:hover:bg-white/[0.10]',
  'border border-border/60 hover:border-border transition-all duration-150 active:scale-95',
  'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
);
