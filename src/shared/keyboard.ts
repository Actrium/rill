/**
 * Web keyboard bridge protocol (issue #19, L3) — shared by the guest hook (`rill/guest`
 * useKeyboard) and the web host capture (`rill/host/web` attachKeyboard).
 *
 * Direction:
 *  - host → guest: `KBD_EVENT` carries a structured key event the guest dispatches.
 *  - guest → host: `KBD_SUBSCRIBE` / `KBD_UNSUBSCRIBE` declare which keys a guest consumes so
 *    the host can SYNCHRONOUSLY preventDefault exactly those (it can't await the guest before
 *    deciding — a correctness requirement, not an optimization).
 */

/** Host → guest: a structured physical-keyboard event. */
export const KBD_EVENT = '__rill_kbd';
/** Guest → host: declare a key subscription (and whether to preventDefault its keys). */
export const KBD_SUBSCRIBE = '__rill_kbd_subscribe';
/** Guest → host: drop a previously declared subscription. */
export const KBD_UNSUBSCRIBE = '__rill_kbd_unsubscribe';

/**
 * A structured keyboard event forwarded from the host to the guest. Carries the fields apps
 * actually need: `keydown`/`keyup` (deprecated `keypress` is skipped), `key` + `code`,
 * modifier flags, and `repeat` (games need keyup + code + repeat; shortcuts need modifiers).
 */
export interface RillKeyEvent {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** Guest → host subscription payload. `keys: null` means "every key". */
export interface KeyboardSubscribePayload {
  id: string;
  keys: string[] | null;
  preventDefault: boolean;
}

/** Guest → host unsubscribe payload. */
export interface KeyboardUnsubscribePayload {
  id: string;
}
