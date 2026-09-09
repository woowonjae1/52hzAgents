'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * THE HOVER HINT ON A CONTROL — one word or two, saying what a button does.
 *
 * This exists because the shell had 154 of them written as the native `title`
 * attribute and 8 files using the real Tooltip, i.e. the same affordance
 * implemented twice, and the version that won by 20:1 was the one the design
 * system cannot touch:
 *
 *   - It renders in the OS chrome, so it ignores the theme, the type ramp, the
 *     radius and the elevation ramp. On a dark workspace it is a pale rectangle
 *     in a 10px system font.
 *   - It appears after the browser's own ~1.5s dwell, which is long enough that
 *     a user scanning a toolbar of icon buttons never sees one.
 *   - It never appears on keyboard focus, and never on touch at all.
 *
 * `asChild` on the trigger is what makes this a drop-in: the child button IS
 * the trigger, so NO WRAPPER DOM NODE ENTERS THE TREE. That is what keeps it
 * safe at 154 call sites — every `flex` child order, `space-x-*` sibling
 * selector, `group-hover` relationship and `[&>button]` rule around those
 * buttons still sees exactly what it saw before.
 *
 * `delayDuration={450}`: the app-wide provider is set to 0 because it was
 * serving deliberate, sparse tooltips. At 154 controls a zero delay means every
 * pass of the cursor across a toolbar flashes hints; 450ms is long enough to
 * require intent and short enough to feel immediate when you have it.
 *
 * The content is PORTALLED. Most of these controls live inside scroll
 * containers, panel rails and `overflow-hidden` cards — rendered in place, a
 * hint on the top row of a scrolling list gets clipped by the list.
 *
 * A disabled child does not receive pointer events, so a hint on a disabled
 * control does not open — the same behaviour as every other design system, and
 * the reason `label` should describe what the control does rather than explain
 * why it is currently unavailable. That belongs in the body of the view.
 */
export interface HintProps
  extends Omit<React.ComponentProps<typeof TooltipTrigger>, 'children' | 'asChild'> {
  /** What the control does. A word or two — this is not documentation. */
  label?: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipContent>['side'];
  /** Suppress the hint without unwrapping the child. */
  hintDisabled?: boolean;
  children: React.ReactNode;
}

/**
 * FORWARDS ITS PROPS AND REF ONTO THE CHILD, because seven of these sit
 * directly inside another Radix `asChild` trigger:
 *
 *   <DropdownMenuTrigger asChild>
 *     <Hint label="…"><button/></Hint>
 *
 * `asChild` clones its single child and merges props and a ref into it. A plain
 * function component swallows both, so the dropdown, popover or dialog simply
 * stops opening — and nothing in `tsc` says a word about it. Spreading `rest`
 * onto `TooltipTrigger` (itself `asChild`) hands them down the chain to the
 * button, and Radix's Slot composes the two triggers' handlers.
 *
 * For the same reason the Root and Trigger are rendered even when there is no
 * `label`: bailing out to a bare Fragment would break that clone in exactly the
 * cases where a label is conditional.
 */
export const Hint = React.forwardRef<HTMLButtonElement, HintProps>(function Hint(
  { label, side, hintDisabled, children, ...rest },
  ref,
) {
  const show = !hintDisabled && label !== null && label !== undefined && label !== '';

  /*
   * THE HINT IS ALSO THE ACCESSIBLE NAME, and it has to be — otherwise this
   * refactor would have made the app less accessible, not more.
   *
   * `title` doubles as an accessible name: a screen reader reads `<button
   * title="Refresh"><RefreshCw/></button>` as "Refresh, button". A Radix
   * tooltip does not — it wires the trigger up with `aria-describedby`, which
   * is a DESCRIPTION of a control that is assumed to already have a name. So
   * lifting `title` out of 154 icon-only buttons and into a tooltip would have
   * left every one of them announced as just "button".
   *
   * Only when `label` is a plain string, and only when the caller has not
   * named the control itself — an explicit `aria-label` at the call site wins,
   * and a ReactNode label (an element, a fragment) is not a name.
   */
  const nameProps =
    show && typeof label === 'string' && rest['aria-label'] === undefined
      ? { 'aria-label': label }
      : undefined;

  /*
   * CARRIES ITS OWN PROVIDER. `TooltipPrimitive.Root` throws "`Tooltip` must be
   * used within `TooltipProvider`" without one, and the app's only provider
   * lives in `layout-context`. Inside the workspace shell that is fine — but
   * `app/page.tsx` and `app/quickbar/page.tsx` are their own route trees with
   * four of these between them, and each would have been a blank screen with a
   * client-side exception. tsc is silent about it; the throwaway
   * `app/hintcheck` page is what surfaced it.
   *
   * The delay belongs on the PROVIDER, not the Root: `skipDelayDuration` (how
   * long a neighbouring hint opens instantly after one closes) is a provider
   * concept, and it is the thing that makes moving along a toolbar feel like
   * one control rather than five separate waits.
   */
  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipTrigger asChild ref={ref} {...nameProps} {...rest}>
          {children}
        </TooltipTrigger>
        {show && (
          <TooltipPrimitive.Portal>
            <TooltipContent side={side}>{label}</TooltipContent>
          </TooltipPrimitive.Portal>
        )}
      </TooltipPrimitive.Root>
    </TooltipProvider>
  );
});
