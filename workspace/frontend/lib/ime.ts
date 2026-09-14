/**
 * "ENTER" DURING IME COMPOSITION IS NOT "ENTER".
 *
 * With a Chinese, Japanese or Korean input method, the key that commits the
 * candidate you are looking at is Enter. The browser still dispatches a
 * `keydown` for it, with `key === 'Enter'` — so every handler in this app that
 * read `e.key === 'Enter'` and sent the message was sending half-typed pinyin
 * the moment the user picked a character. Same for the arrow keys, which move
 * the IME's candidate cursor and were being eaten by the @-mention popup.
 *
 * The signal is `isComposing` on the native event. It is true for every key
 * dispatched between `compositionstart` and `compositionend` — including the
 * committing Enter itself, which is the case that matters.
 *
 * `keyCode === 229` is the second half: Safari and some Windows IMEs dispatch
 * the pre-commit keydown with that sentinel and `isComposing` still false.
 * Checking both is what makes this work on all three platforms rather than
 * just on Chrome/macOS where it was tested.
 */

interface ComposableEvent {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * True while an input method is mid-composition. Guard every Enter / arrow-key
 * handler that sits on a text field with this.
 */
export function isComposing(e: ComposableEvent): boolean {
  const native = e.nativeEvent ?? e;
  return native.isComposing === true || native.keyCode === 229;
}
