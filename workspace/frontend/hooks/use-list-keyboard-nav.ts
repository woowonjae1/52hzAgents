'use client';

import * as React from 'react';

/**
 * ARROW KEYS IN A LIST.
 *
 * Before this hook exactly one list in the app — the thread list — could be
 * walked from the keyboard, and it did it with a hand-rolled j/k handler.
 * Files, tasks, the inbox, knowledge and skills were mouse-only: no ↑/↓, no
 * Home/End, no Page keys, no Shift+↑/↓ to extend a selection. In a desktop
 * list every one of those is assumed, and their absence is the difference
 * between "a list" and "a page with rows on it".
 *
 * Scoped, not global: the handler is attached to a container element, so two
 * lists on screen at once do not both answer the same key press. The container
 * needs `tabIndex={-1}` (or a focusable child) for it to receive keys at all —
 * `listNavProps` supplies that.
 *
 * The hook owns only the CURSOR (which row is highlighted). Selection, opening
 * and range-extension are the caller's, because what "open" means differs per
 * list — a file previews, a task edits, a thread switches channel.
 */
export interface ListKeyboardNavOptions {
  /** How many rows there are right now. */
  count: number;
  /** Row the cursor starts on, and the one it returns to when the list changes. */
  initialIndex?: number;
  /** Enter / double-click equivalent. */
  onActivate?: (index: number) => void;
  /** Shift+↑/↓ — extend a selection from the anchor to `index`. */
  onExtend?: (index: number) => void;
  /** Space — toggle the row at `index` in a multi-selection. */
  onToggle?: (index: number) => void;
  /** Delete / Backspace on the cursor row. */
  onDelete?: (index: number) => void;
  /** Rows visible at once; Page Up/Down move by this. */
  pageSize?: number;
  /** Turn the whole thing off (e.g. while a dialog owns the keyboard). */
  disabled?: boolean;
  /**
   * For 2D grid layouts: number of columns.
   * When columns > 1, ArrowLeft/Right moves by 1, and ArrowUp/Down strides by columns.
   */
  columns?: number;
}

export function useListKeyboardNav({
  count,
  initialIndex = -1,
  onActivate,
  onExtend,
  onToggle,
  onDelete,
  pageSize = 10,
  disabled = false,
  columns = 1,
}: ListKeyboardNavOptions) {
  const [cursor, setCursor] = React.useState(initialIndex);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  // A list that shrinks under the cursor must not leave it pointing past the
  // end — that is how Enter ends up doing nothing with a row highlighted.
  React.useEffect(() => {
    setCursor((c) => (c >= count ? count - 1 : c));
  }, [count]);

  // Keep the cursor row on screen, and give it the focus. Rows opt in with
  // `data-list-row`.
  React.useEffect(() => {
    if (cursor < 0) return;
    const container = containerRef.current;
    const el = container?.querySelector<HTMLElement>(`[data-list-row="${cursor}"]`);
    if (!el) return;

    el.scrollIntoView({ block: 'nearest' });

    /*
      FOCUS FOLLOWS THE CURSOR — but only while the list already has it.

      Without this the arrow keys moved a highlight and nothing else: focus
      stayed on whichever row was clicked first, so a screen reader announced
      that one row forever while the visible cursor walked away from it, and
      the roving tabindex pointed at a row that was not focused.

      The containment check is what keeps this from stealing focus. The cursor
      also moves when the list re-renders under it (a row deleted, a filter
      applied), and grabbing focus out of the search box the user is typing in
      would be worse than the bug being fixed.
    */
    if (container && container.contains(document.activeElement) && document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
  }, [cursor]);

  const move = React.useCallback(
    (next: number, extend: boolean) => {
      const clamped = Math.max(0, Math.min(count - 1, next));
      setCursor(clamped);
      if (extend) onExtend?.(clamped);
    },
    [count, onExtend],
  );

  const cols = Math.max(1, columns || 1);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || count === 0) return;

      // A field inside the list (an inline rename, a filter box) owns its keys.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      const from = cursor < 0 ? -1 : cursor;

      switch (e.key) {
        case 'ArrowRight':
          if (cols > 1) {
            e.preventDefault();
            move(from + 1, e.shiftKey);
          }
          return;
        case 'ArrowLeft':
          if (cols > 1) {
            e.preventDefault();
            move(from <= 0 ? 0 : from - 1, e.shiftKey);
          }
          return;
        case 'ArrowDown':
          e.preventDefault();
          move(from + cols, e.shiftKey);
          return;
        case 'ArrowUp':
          e.preventDefault();
          move(from - cols < 0 ? 0 : from - cols, e.shiftKey);
          return;
        case 'Home':
          e.preventDefault();
          move(0, e.shiftKey);
          return;
        case 'End':
          e.preventDefault();
          move(count - 1, e.shiftKey);
          return;
        case 'PageDown':
          e.preventDefault();
          move(from + pageSize, e.shiftKey);
          return;
        case 'PageUp':
          e.preventDefault();
          move(from - pageSize, e.shiftKey);
          return;
        case 'Enter':
          if (from >= 0 && onActivate) {
            e.preventDefault();
            onActivate(from);
          }
          return;
        case ' ':
          if (from >= 0 && onToggle) {
            e.preventDefault();
            onToggle(from);
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (from >= 0 && onDelete) {
            e.preventDefault();
            onDelete(from);
          }
          return;
        default:
      }
    },
    [disabled, count, cursor, move, onActivate, onToggle, onDelete, pageSize],
  );

  /** Spread onto the scroll container. */
  const listNavProps = {
    ref: containerRef,
    tabIndex: -1,
    onKeyDown,
    /*
      A LIST HAS TO SAY IT IS A LIST.

      Every row in this app is a `<div onClick>`. That is invisible to a screen
      reader, and — the reason it shows up as a desktop-feel problem rather
      than only an accessibility one — it is invisible to the Tab key too: the
      whole app had exactly one `tabIndex` in it, on the sidebar's resize
      handle. You could not reach a single list row without a mouse.

      `listbox` + `option` is the right pair here rather than `grid` or `tree`:
      these are flat lists of selectable things, some of which allow more than
      one selection at a time.
    */
    role: 'listbox',
    'aria-multiselectable': !!onToggle,
    // Without this the container shows a focus ring the moment a row is
    // clicked, which no native list does.
    className: 'outline-none',
  } as const;

  /**
   * Spread onto each row. Carries `data-list-row`, which is what the cursor
   * uses to scroll the right row into view, so a row that takes these props
   * must not also declare it.
   *
   * ROVING TABINDEX: exactly one row is in the tab order at a time — the one
   * the cursor is on — and the arrows move between them. Giving every row
   * `tabIndex={0}` would make Tab walk a hundred files one press at a time,
   * which is the failure mode that makes people turn keyboard navigation off.
   * With the cursor unplaced the first row takes the slot, so Tab can get in.
   */
  const rowProps = React.useCallback(
    (index: number, selected?: boolean) => ({
      'data-list-row': index,
      role: 'option',
      'aria-selected': !!selected,
      tabIndex: (cursor < 0 ? index === 0 : cursor === index) ? 0 : -1,
      // Clicking a row moves the cursor there, so the next arrow press
      // continues from what the user just pointed at rather than from
      // wherever the keyboard left off.
      onFocus: () => setCursor(index),
    }),
    [cursor],
  );

  return { cursor, setCursor, containerRef, onKeyDown, listNavProps, rowProps };
}
