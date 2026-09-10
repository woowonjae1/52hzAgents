'use client';

import * as React from 'react';

/**
 * RIGHT-CLICKING A ROW OPENS THAT ROW'S OWN ACTIONS MENU.
 *
 * Every list in this app — threads, sessions, files, tasks, agents — already
 * has per-row actions (rename, archive, delete). They live in a Radix dropdown
 * behind a `⋯` button that only appears on hover. So the actions exist; the
 * only way in is a target you cannot see until you are already on top of it,
 * and which a keyboard or touch user reaches last.
 *
 * Meanwhile right-clicking any of those rows produced the browser's text menu —
 * "Copy", "Select All" — because Electron's native `context-menu` handler is
 * the only thing listening. In a desktop application a right-click on a list
 * item is the primary way to act on it; getting a text menu instead is the
 * single loudest signal that a window is a web page wearing a title bar.
 *
 * This closes that gap without touching a single row. One listener, mounted
 * once, in the capture phase:
 *
 *   right-click → is there a dropdown trigger inside the row I am on?
 *                 → yes: open it, suppress the native menu
 *                 → no:  do nothing, Electron shows its own menu
 *
 * WHY NOT A PROP ON EVERY ROW. The alternative is a hook threaded through
 * every list component, which is a dozen edits that must each be kept in sync
 * as rows are added. A row that grows an actions menu should get a right-click
 * for free, not as a second thing someone remembers to wire.
 *
 * THREE THINGS IT DELIBERATELY REFUSES TO HIJACK:
 *
 *  1. A live text selection. If the user has selected something, they want the
 *     native Copy, not a row menu — that is what right-click means there.
 *  2. Editable fields. Inputs and textareas need the native undo/cut/paste
 *     menu, which this cannot reproduce.
 *  3. Rows with no menu of their own. Nothing to open, so the native menu
 *     stands. This is why the search is scoped to the ancestor chain rather
 *     than to the document.
 *
 * The trigger is clicked rather than positioned at the cursor, so the menu
 * anchors to the `⋯` button. That is a deliberate simplification: it reuses
 * the existing Radix positioning, collision handling and focus management
 * exactly as the button does, and the menu appears on the row you clicked.
 */
export function RowContextMenu() {
  React.useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // Editable fields keep the native menu — see (2) above.
      if (target.closest('input, textarea, [contenteditable="true"]')) return;

      // A selection means the user is after Copy — see (1) above.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;

      /*
       * Walk UP from the click looking for a container that holds a dropdown
       * trigger. Bounded to a handful of levels: a row is a shallow structure,
       * and without a bound this would eventually find the page-level "new
       * thread" menu and open that from anywhere in the app.
       */
      let node: HTMLElement | null = target;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        // Annotated rather than inferred: with two `continue`s in the loop,
        // TypeScript's flow analysis of the reassigned `node` makes the
        // inferred type circular (TS7022).
        const trigger: HTMLElement | null = node.querySelector('[data-slot="dropdown-menu-trigger"]');
        if (!trigger) continue;
        /*
          THE TRIGGER HAS TO BE THIS ROW'S OWN, and `querySelector` does not
          care whose it is. Walking up from a row that has NO menu eventually
          reaches the list container, which contains the triggers belonging to
          every OTHER row -- so the first version suppressed the native menu on
          every plain row in the app and opened nothing in its place. Verified,
          and caught, only by driving all three cases in a browser.

          A row renders `<DropdownMenu>` as a direct child (the component emits
          no DOM of its own), so its trigger's parent IS the row. Requiring
          that exact relationship rejects a neighbour's trigger while still
          matching every row shaped like the ones in this app.
        */
        if (trigger.parentElement !== node) continue;
        /*
          POINTERDOWN, NOT CLICK. Radix's DropdownMenu.Trigger opens on
          `onPointerDown`; a synthesised `click()` does nothing to it. The
          first version of this called `.click()`, which passed tsc, read
          correctly, and shipped a right-click that suppressed the native menu
          and then opened nothing — strictly worse than before it existed.
          Only driving it in the browser showed that.

          `button: 0`, because Radix ignores a pointerdown from the secondary
          button — it is listening for a normal press on the trigger, which is
          what we are simulating.
        */
        event.preventDefault();
        trigger.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerType: 'mouse',
          }),
        );
        return;
      }
    };

    // Capture, so this runs before any row's own onContextMenu and before the
    // event reaches Electron's handler on the webContents.
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  return null;
}
