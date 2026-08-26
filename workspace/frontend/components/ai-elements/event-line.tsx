'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useElapsedFrom } from '@/lib/use-elapsed';

/**
 * ONE LINE FOR ONE THING AN AGENT DID.
 *
 * Every agent-side event in a transcript draws through this: a tool call, a
 * reasoning block, a plan, a diff, a permission prompt, a citation list. The
 * point is that a bash command, an approval request and a refusal all read as
 * the same KIND of event, so the transcript keeps one rhythm no matter what the
 * agent happens to be doing.
 *
 * Before this existed each of those was its own component with its own frame,
 * and they had drifted into four outer margins (`my-2` / `my-2.5` / `my-3` /
 * none), three radii (`xl` / `2xl` / `full`), three shadow tiers, four status
 * palettes (amber+emerald+red / amber+emerald+rose / indigo / primary) and two
 * different hardcoded "dark terminal" backgrounds. Individually every one of
 * those was a defensible choice; together they are why the transcript read as
 * assembled rather than designed. The frame lives here now and nowhere else —
 * callers own their CONTENT, not their container.
 *
 * Four things are deliberate and easy to undo by accident:
 *
 * 1. `items-baseline`, not `items-center`. The glyphs sit on one baseline with
 *    the icon, instead of each box being centred independently. Centred boxes
 *    put the icon's optical middle a pixel or two off the text's, which is what
 *    makes a row look like it is floating rather than set.
 * 2. Native `<details>`, not React state + AnimatePresence. Tool renderers get
 *    re-invoked independently of any parent's state, so JS-owned open/closed
 *    state can be reset out from under the user mid-stream. The disclosure is
 *    also then keyboard- and find-in-page-accessible for free. The height
 *    animation is done in CSS on `::details-content` (see globals.css) rather
 *    than by measuring in JS.
 * 3. `detail` truncates, it never wraps. A single-line action rhythm is the
 *    whole effect; one event that wraps to three lines breaks the column for
 *    every event after it.
 * 4. THE ICON AND THE CHEVRON SHARE ONE SLOT. The disclosure arrow is not a
 *    separate column — it crossfades in over the semantic icon on hover, focus
 *    or open (see `.event-glyph` / `.event-chevron` in globals.css). A row
 *    therefore spends 16px on identity at rest instead of 16px on identity plus
 *    another on a permanently visible `▸`, and nothing moves when it opens.
 */

/**
 * `ok` is not a decorated state and has no colour. A tool that worked is the
 * default case and announcing it with a green badge spends the reader's
 * attention on the outcome they already assumed. Colour is reserved for the two
 * states that change what the reader should do next.
 *
 * `failed` vs `blocked` is a real distinction, carried by WORDING rather than by
 * two different hues: `failed` means it was permitted and did not work, so a
 * different request might; `blocked` means a policy said no and nothing the
 * agent does differently will help.
 *
 * `cancelled` is muted rather than coloured even though it is not a success:
 * the user is the one who stopped it, so it is not news to them and nothing is
 * wrong.
 */
export type EventState = 'idle' | 'running' | 'ok' | 'failed' | 'blocked' | 'cancelled';

export interface EventLineProps {
  /** Lucide node. Sized by this component — pass the bare icon, no className. */
  icon?: ReactNode;
  /** What was done, in a couple of words: "Ran command", "Read file", "Plan". */
  label: string;
  /** What it was done to. Truncated rather than wrapped, never more than a line. */
  detail?: string;
  /**
   * Whether `detail` is code — a command, a path, a pattern. True by default
   * because most of them are. Prose in a mono face reads as a machine quoting
   * itself, so a human-language detail (an answer that came back, a summary)
   * should pass false.
   */
  detailMono?: boolean;
  state?: EventState;
  /**
   * Right-aligned trailing text: a duration, a count, a progress fraction.
   * Tabular so it does not jitter as it updates in place.
   */
  meta?: ReactNode;
  /**
   * Epoch ms the event began. While `state` is `running` and no explicit `meta`
   * is given, the row shows a live clock here instead — so the same slot that
   * reports "took 8.8s" afterwards reports "4.2s and counting" during. The
   * number stays put rather than appearing at the end, which is what made the
   * old dots-then-duration handoff feel like two different rows.
   */
  startTime?: number | null;
  /** Controls that sit at the end of the row (copy, dismiss). Not the disclosure. */
  actions?: ReactNode;
  /**
   * Render the body without a disclosure — the row becomes a heading for content
   * that is always visible. Use when hiding the content would hide the point of
   * the event (a permission prompt nobody can answer while collapsed).
   */
  alwaysOpen?: boolean;
  defaultOpen?: boolean;
  /** Body. Without it the row is not expandable. */
  children?: ReactNode;
  className?: string;
}

/**
 * The one place a state turns into words. Callers pass their own `label` and the
 * state; how a failure is phrased is decided here so all six event kinds phrase
 * it the same way.
 */
function stateLabel(label: string, state: EventState): string {
  if (state === 'blocked') return 'Blocked';
  if (state === 'failed') return `${label}, didn't work`;
  if (state === 'cancelled') return `${label}, cancelled`;
  return label;
}

/**
 * The 16px slot at the head of every row.
 *
 * `expandable` decides whether a chevron is stacked over the icon at all — a row
 * with nothing behind it must not suggest it can be opened. When there is no
 * icon to crossfade with, the chevron is left permanently visible instead
 * (`.event-glyph-empty`): a bare row with an invisible-until-hover arrow gives a
 * keyboard or touch user nothing to aim at.
 */
function GlyphSlot({ icon, expandable }: { icon?: ReactNode; expandable: boolean }) {
  if (!expandable) {
    return icon ? (
      <span className="w-4 shrink-0 translate-y-px [&>svg]:size-3.5" aria-hidden>
        {icon}
      </span>
    ) : (
      <span className="w-4 shrink-0" aria-hidden />
    );
  }

  return (
    <span
      className={cn('relative w-4 shrink-0 translate-y-px', !icon && 'event-glyph-empty')}
      aria-hidden
    >
      {icon && (
        <span className="event-glyph block transition-opacity duration-100 [&>svg]:size-3.5">
          {icon}
        </span>
      )}
      <span
        className={cn(
          'event-chevron block text-foreground-extra-muted transition-[opacity,transform] duration-150',
          // Absolute only when it has an icon to sit on top of, so the slot
          // still reserves its 16px when the chevron is the only occupant.
          icon && 'absolute inset-0'
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </span>
  );
}

export function EventLine({
  icon,
  label,
  detail,
  detailMono = true,
  state = 'idle',
  meta,
  startTime,
  actions,
  alwaysOpen = false,
  defaultOpen = false,
  children,
  className,
}: EventLineProps) {
  const isBad = state === 'failed' || state === 'blocked';
  const running = state === 'running';
  // Only subscribes to the shared ticker while this row is actually running, so
  // a settled transcript of 200 events holds no timers at all.
  const live = useElapsedFrom(running ? startTime : null, running);
  const trailingMeta = meta ?? (running ? live : null);
  const expandable = Boolean(children) && !alwaysOpen;

  const row = (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full flex-1 items-baseline gap-1.5 text-xs',
        isBad ? 'text-destructive' : 'text-foreground-muted',
        // The shimmer is the ONLY running signal. No spinner, no pulsing badge,
        // no glowing border — see the `.event-running` note in globals.css.
        running && 'event-running'
      )}
    >
      <GlyphSlot icon={icon} expandable={expandable} />
      <span className={cn('shrink-0', !isBad && 'text-foreground font-medium')}>
        {stateLabel(label, state)}
      </span>
      {detail && (
        /*
         * A chip, not bare text. It separates "what was done" from "what it was
         * done to" using a surface rather than a second colour — which matters
         * because colour here is reserved for the two states that need it. The
         * chip is also where truncation visibly happens, so a 400-character
         * command reads as a clipped object instead of a sentence that stops.
         */
        <span
          className={cn(
            'min-w-0 truncate rounded-base border border-border bg-surface2 px-1.5',
            'text-foreground-muted',
            detailMono && 'font-mono'
          )}
        >
          {detail}
        </span>
      )}
    </span>
  );

  const trailing = (trailingMeta || actions) && (
    <span className="ml-auto flex shrink-0 items-baseline gap-2 pl-2">
      {trailingMeta && (
        <span className="text-3xs font-mono tabular-nums text-foreground-extra-muted">
          {trailingMeta}
        </span>
      )}
      {actions}
    </span>
  );

  // A row with nothing behind it, or one whose body must stay visible.
  if (!children || alwaysOpen) {
    return (
      <div className={cn('my-1.5 min-w-0', className)}>
        <div className="flex min-w-0 items-baseline">
          {row}
          {trailing}
        </div>
        {children && <EventLineBody>{children}</EventLineBody>}
      </div>
    );
  }

  return (
    <details className={cn('event-line my-1.5 min-w-0', className)} open={defaultOpen}>
      <summary className="flex min-w-0 cursor-pointer list-none items-baseline">
        {row}
        {trailing}
      </summary>
      <EventLineBody>{children}</EventLineBody>
    </details>
  );
}

/**
 * The body treatment, shared so an expanded tool call and an expanded diff are
 * indented the same way off the same rail.
 *
 * The rail is a centred 1px column in a `1rem` grid track, NOT a `border-l` on
 * an indented box. Both draw a vertical line; only this one is guaranteed to
 * land on the centre of the 16px glyph slot in the row above, because it is the
 * same track width. Eyeballing an `ml-*` until it looks close is how a rail ends
 * up one pixel off its own icon on half the rows.
 *
 * The heading clamp is not cosmetic. Bodies here carry markdown that a server or
 * a model wrote for another model, where a `#` is a section marker inside a tool
 * result — not the title of a page. Left alone, one tool that returns
 * `# Results` renders a 34px heading inside a 12px transcript and the column's
 * rhythm is gone for that message.
 */
export function EventLineBody({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 grid min-w-0 grid-cols-[1rem_1fr] gap-x-1.5">
      <span aria-hidden className="mx-auto h-full w-px bg-border" />
      <div
        className={cn(
          'min-w-0 pb-0.5',
          'text-xs [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs',
          '[&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium [&_h4]:font-medium'
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Preformatted output — tool stdout, arguments, raw diffs.
 *
 * Exists so there is one answer to "what colour is a terminal". There were two
 * hardcoded ones (`bg-[#09090c]` in the tool card, `bg-neutral-950` in the
 * approval prompt) sitting two components apart in the same transcript. This
 * reads `--surface-diff-empty`, so it tracks the theme instead of pinning a
 * near-black that only works in one of them.
 */
export function EventLinePre({
  children,
  tone = 'default',
  className,
}: {
  children: ReactNode;
  tone?: 'default' | 'bad';
  className?: string;
}) {
  return (
    <pre
      className={cn(
        'overflow-x-auto overflow-y-auto rounded-base border p-2.5',
        'max-h-64 font-mono text-2xs leading-relaxed',
        tone === 'bad'
          ? 'border-destructive/25 bg-destructive/[0.06] text-destructive'
          : 'border-border bg-surface-diff-empty text-foreground-muted',
        className
      )}
    >
      {children}
    </pre>
  );
}

/**
 * A quiet trailing control for the row (copy, open, dismiss). Kept here so six
 * callers stop inventing six hover treatments for the same affordance.
 */
export function EventLineAction({
  onClick,
  title,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-base px-1 py-0.5',
        'text-3xs text-foreground-extra-muted transition-colors',
        'hover:bg-surface2 hover:text-foreground',
        'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2'
      )}
    >
      {children}
    </button>
  );
}
