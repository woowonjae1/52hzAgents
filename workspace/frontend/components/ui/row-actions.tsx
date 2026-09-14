'use client';

import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * ONE ROW'S ACTIONS — AND THEREFORE ITS RIGHT-CLICK MENU.
 *
 * `RowContextMenu` (components/layout/row-context-menu.tsx) turns a right-click
 * anywhere on a row into that row's own actions menu. It finds the menu by
 * looking for a dropdown trigger that is a DIRECT CHILD of the row, and opens
 * it at the pointer.
 *
 * Which means the feature was only ever live in three places. Threads,
 * sessions and agent cards had a `⋯` menu; Files, Inbox, Knowledge, Skills,
 * Tasks, the task board, Routines, Timers and the browser's tab list did not,
 * so right-clicking any of them fell through to the Electron shell's fallback
 * menu — a single "Select All", which is the most web-page thing a window can
 * do.
 *
 * Rather than nine hand-rolled dropdowns that each have to remember the
 * `stopPropagation`, the hover-reveal and the trigger-is-a-direct-child rule,
 * this is the one component. Drop it in a row, give it items, and the row has
 * both a visible menu button and a working right-click.
 *
 * TWO THINGS IT IS PARTICULAR ABOUT, both load-bearing:
 *
 *   1. It renders `<DropdownMenu>` with no wrapper of its own. The component
 *      emits no DOM, so the trigger's parent IS the row — which is the exact
 *      relationship RowContextMenu requires to tell this row's menu apart from
 *      the neighbouring rows' triggers it can also see.
 *   2. Every item stops propagation. A row is clickable; without this,
 *      choosing "Delete" from the menu also selects the row underneath it.
 */

export interface RowAction {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
  /** Renders in the destructive colour and sits below a separator. */
  destructive?: boolean;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
}

export interface RowActionsProps {
  items: RowAction[];
  /** Accessible name, e.g. "Actions for report.pdf". */
  label?: string;
  align?: 'start' | 'end';
  className?: string;
  /**
   * RIGHT-CLICKING THE EMPTY PART OF A LIST.
   *
   * A file manager answers a right-click on blank space with the list's own
   * actions — new folder, paste, refresh, select all. Here it answered with
   * the Electron shell's fallback menu, a single "Select All", because there
   * was no trigger anywhere up the ancestor chain.
   *
   * `background` renders the trigger visually hidden but still in the DOM and
   * still in the accessibility tree, as a direct child of the scroll
   * container. RowContextMenu then finds it the same way it finds a row's —
   * and because it walks UP from the click, a row's own menu still wins when
   * the click landed on a row.
   */
  background?: boolean;
}

export function RowActions({
  items,
  label = 'Row actions',
  align = 'end',
  className,
  background = false,
}: RowActionsProps) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          /*
            `data-[state=open]:opacity-100` is what keeps the button on screen
            while its own menu is open. Without it the button fades out the
            moment the pointer leaves it to travel to the menu, and the menu
            appears to be hanging off nothing.

            It is NOT hidden from the keyboard: opacity-0 still takes focus and
            still shows a ring, which is how a keyboard user reaches a row's
            actions at all.
          */
          className={cn(
            background
              // `sr-only` rather than `hidden`: a display:none trigger cannot
              // be opened, and Radix measures it to position the menu.
              ? 'sr-only'
              : [
                  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                  'transition-opacity p-1 rounded hover:bg-surface3 text-foreground-extra-muted hover:text-foreground shrink-0',
                ],
            className,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-48">
        {visible.map((item, i) => {
          const Icon = item.icon;
          return (
            <React.Fragment key={item.label}>
              {(item.separatorBefore || (item.destructive && i > 0 && !visible[i - 1].destructive)) && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuItem
                disabled={item.disabled}
                className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  item.onSelect();
                }}
              >
                {Icon && <Icon className="size-3.5" />}
                {item.label}
              </DropdownMenuItem>
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
