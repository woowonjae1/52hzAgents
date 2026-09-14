'use client';

import * as React from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * THE DROPDOWN THAT IS NOT THE OPERATING SYSTEM'S.
 *
 * Ten places in this app used a bare `<select>`. On Windows that opens a grey
 * Win32 listbox in Segoe UI with square corners and its own scrollbar; on
 * macOS it opens an Aqua popup that covers the trigger. Either way the one
 * control the user is actively operating is the only thing on screen that
 * belongs to a different program — and none of the theme reaches it: not the
 * radius, not `--surface-overlay`, not the type ramp, not dark mode.
 *
 * The styling deliberately matches `dropdown-menu.tsx` item-for-item. A menu
 * and a select are the same object to a user — a list that opens over the
 * window — so they must not be two different lists.
 *
 * `cursor-default` on items, not `cursor-pointer`: a pointing hand is a web
 * hyperlink's cursor. Native menus use the arrow.
 */

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  children,
  size = 'md',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background text-foreground shadow-xs shadow-black/5',
        'transition-[color,box-shadow,border-color] outline-none select-none',
        'focus-visible:ring-ring/30 focus-visible:border-ring focus-visible:ring-[3px]',
        'data-[placeholder]:text-muted-foreground/80',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'data-[state=open]:border-ring',
        '[&>span]:truncate [&>span]:text-start',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8.5 px-3 text-[0.8125rem]',
        size === 'lg' && 'h-10 px-4 text-sm',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          /* The floating-surface recipe — see dialog.tsx. */
          'relative z-50 max-h-96 min-w-32 overflow-hidden rounded-xl border border-border bg-surface-overlay/95 backdrop-blur-xl p-1.5 shadow-xl',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-foreground-extra-muted">
          <ChevronUp className="size-3.5" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn(
            position === 'popper' && 'min-w-[var(--radix-select-trigger-width)]',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-foreground-extra-muted">
          <ChevronDown className="size-3.5" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        'px-3 py-1.5 text-3xs font-semibold uppercase tracking-wider text-foreground-extra-muted select-none',
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'text-foreground relative flex w-full cursor-default select-none items-center gap-2 rounded-lg py-2 ps-8 pe-3 text-[13.5px] font-medium outline-hidden transition-colors',
        'focus:bg-surface2 dark:focus:bg-white/10',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute start-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4 text-primary" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('-mx-1.5 my-1.5 h-px bg-border', className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
