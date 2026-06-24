/**
 * Web keyboard bridge — host capture (issue #19, L3).
 *
 * Captures physical keyboard events on a DOM target and forwards them to the guest, mirroring
 * the guest's `useKeyboard` hook. The hard part it solves: a guest that wants to consume a key
 * the browser also acts on (Space, arrows, Tab, '/') needs the host to call `preventDefault`,
 * but `preventDefault` only works synchronously — the host cannot await the sandboxed guest
 * before the browser performs its default action. So the guest declares its intent up front
 * (`KBD_SUBSCRIBE` with `keys` + `preventDefault`); the host keeps that registry and decides
 * synchronously on each keystroke, then forwards the (now structured) event asynchronously.
 *
 * This is mechanism, not policy: which keys to globally block lives with the integrator via
 * `preventDefaultKeys`. Attaching the bridge at all is opt-in.
 */

import {
  KBD_EVENT,
  KBD_SUBSCRIBE,
  KBD_UNSUBSCRIBE,
  type KeyboardSubscribePayload,
  type KeyboardUnsubscribePayload,
  type RillKeyEvent,
} from '../../shared/keyboard';
import type { Engine, GuestMessage } from '../engine';

/**
 * Minimal engine surface the keyboard bridge needs. The real {@link Engine} satisfies it; the
 * narrow shape keeps the bridge decoupled and trivially mockable in tests.
 */
export interface KeyboardBridgeEngine {
  on(event: 'message', listener: (message: GuestMessage) => void): () => void;
  // Reason: matches Engine.sendEvent; payload is any serializable host->guest value
  sendEvent(eventName: string, payload?: unknown): void;
}

/** The DOM target capable of receiving keyboard events (element, document, or window). */
export interface KeyboardTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Options for {@link attachKeyboard}. */
export interface AttachKeyboardOptions {
  /**
   * DOM target to capture keydown/keyup on. Defaults to the global `window`. Pass the engine
   * view's container element to scope capture to the embedded UI.
   */
  target?: KeyboardTarget;
  /**
   * Keys the host always calls `preventDefault` on, regardless of whether a guest subscribed —
   * an integrator escape hatch for keys that must never reach the browser (e.g. a host-level
   * shortcut). These keys are still forwarded to the guest.
   */
  preventDefaultKeys?: string[];
}

/** Handle returned by {@link attachKeyboard}; call {@link KeyboardAttachment.detach} to stop. */
export interface KeyboardAttachment {
  /** Remove the DOM listeners, drop the message subscription, and clear all guest subscriptions. */
  detach(): void;
}

interface Subscription {
  /** `null` means "every key". */
  keys: Set<string> | null;
  preventDefault: boolean;
}

function resolveTarget(target: KeyboardTarget | undefined): KeyboardTarget {
  if (target) {
    return target;
  }
  const win = (globalThis as { window?: KeyboardTarget }).window;
  if (win && typeof win.addEventListener === 'function') {
    return win;
  }
  throw new Error(
    '[rill/host/web] attachKeyboard: no DOM target available; pass options.target explicitly'
  );
}

/**
 * Bridge a DOM target's keyboard to a rill engine's guest. Returns a handle whose `detach()`
 * fully unwinds the bridge.
 *
 * @example
 * ```ts
 * const kbd = attachKeyboard(engine, { target: window, preventDefaultKeys: ['Tab'] });
 * // ... later
 * kbd.detach();
 * ```
 */
export function attachKeyboard(
  engine: KeyboardBridgeEngine | Engine,
  options: AttachKeyboardOptions = {}
): KeyboardAttachment {
  const target = resolveTarget(options.target);
  const alwaysPrevent = new Set(options.preventDefaultKeys ?? []);

  // Guest-declared subscriptions, keyed by the guest hook instance's id.
  const subscriptions = new Map<string, Subscription>();

  const offMessage = (engine as KeyboardBridgeEngine).on('message', (message) => {
    if (message.event === KBD_SUBSCRIBE) {
      const payload = message.payload as KeyboardSubscribePayload;
      subscriptions.set(payload.id, {
        keys: payload.keys === null ? null : new Set(payload.keys),
        preventDefault: payload.preventDefault === true,
      });
    } else if (message.event === KBD_UNSUBSCRIBE) {
      const payload = message.payload as KeyboardUnsubscribePayload;
      subscriptions.delete(payload.id);
    }
  });

  // Does any active subscription care about this key (so it should be forwarded)?
  function isSubscribed(key: string): boolean {
    if (alwaysPrevent.has(key)) {
      return true;
    }
    for (const sub of subscriptions.values()) {
      if (sub.keys === null || sub.keys.has(key)) {
        return true;
      }
    }
    return false;
  }

  // Decide synchronously whether the browser default for this key must be suppressed.
  function shouldPreventDefault(key: string): boolean {
    if (alwaysPrevent.has(key)) {
      return true;
    }
    for (const sub of subscriptions.values()) {
      if (sub.preventDefault && (sub.keys === null || sub.keys.has(key))) {
        return true;
      }
    }
    return false;
  }

  function handle(type: 'keydown' | 'keyup', event: KeyboardEvent): void {
    const { key } = event;
    if (!isSubscribed(key)) {
      return;
    }
    // preventDefault must happen now, on the capture turn — before the forwarded (async)
    // event ever reaches the guest.
    if (shouldPreventDefault(key)) {
      event.preventDefault();
    }
    const forwarded: RillKeyEvent = {
      type,
      key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
    };
    (engine as KeyboardBridgeEngine).sendEvent(KBD_EVENT, forwarded);
  }

  const onKeyDown = (event: Event) => handle('keydown', event as KeyboardEvent);
  const onKeyUp = (event: Event) => handle('keyup', event as KeyboardEvent);
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  return {
    detach() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      offMessage();
      subscriptions.clear();
    },
  };
}
