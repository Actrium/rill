/**
 * Web keyboard bridge — host capture tests (issue #19, L3).
 *
 * Pure logic: a fake DOM target + fake KeyboardEvent + a mock engine. Asserts the synchronous
 * preventDefault decision (the correctness-critical part) and the structured forwarding, plus
 * subscription lifecycle and detach cleanup.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  KBD_EVENT,
  KBD_SUBSCRIBE,
  KBD_UNSUBSCRIBE,
  type RillKeyEvent,
} from '../../../shared/keyboard';
import type { GuestMessage } from '../../engine';
import { attachKeyboard, type KeyboardBridgeEngine, type KeyboardTarget } from '../keyboard';

interface FakeKeyEventInit {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

class FakeKeyboardEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented = false;

  constructor(init: FakeKeyEventInit) {
    this.key = init.key;
    this.code = init.code ?? init.key;
    this.ctrlKey = init.ctrlKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.repeat = init.repeat ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeTarget implements KeyboardTarget {
  private handlers = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.get(type)?.delete(listener);
  }

  /** Dispatch a fake event and return it (so the caller can inspect defaultPrevented). */
  dispatch(type: 'keydown' | 'keyup', init: FakeKeyEventInit): FakeKeyboardEvent {
    const event = new FakeKeyboardEvent(init);
    this.handlers.get(type)?.forEach((h) => h(event as unknown as Event));
    return event;
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

interface MockEngine extends KeyboardBridgeEngine {
  emitMessage(message: GuestMessage): void;
  sent: Array<{ name: string; payload: unknown }>;
  messageListenerCount: number;
}

function createMockEngine(): MockEngine {
  const listeners = new Set<(message: GuestMessage) => void>();
  const sent: Array<{ name: string; payload: unknown }> = [];
  return {
    sent,
    get messageListenerCount() {
      return listeners.size;
    },
    on(_event: 'message', listener: (message: GuestMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendEvent(name: string, payload?: unknown) {
      sent.push({ name, payload });
    },
    emitMessage(message: GuestMessage) {
      listeners.forEach((l) => l(message));
    },
  };
}

describe('attachKeyboard', () => {
  let engine: MockEngine;
  let target: FakeTarget;

  beforeEach(() => {
    engine = createMockEngine();
    target = new FakeTarget();
  });

  const sub = (id: string, keys: string[] | null, preventDefault: boolean) => {
    engine.emitMessage({ event: KBD_SUBSCRIBE, payload: { id, keys, preventDefault } });
  };
  const unsub = (id: string) => {
    engine.emitMessage({ event: KBD_UNSUBSCRIBE, payload: { id } });
  };

  it('forwards a subscribed key and preventDefaults it when requested', () => {
    attachKeyboard(engine, { target });
    sub('k1', ['Enter'], true);

    const event = target.dispatch('keydown', { key: 'Enter', code: 'Enter' });

    expect(event.defaultPrevented).toBe(true);
    expect(engine.sent).toHaveLength(1);
    expect(engine.sent[0]?.name).toBe(KBD_EVENT);
    const forwarded = engine.sent[0]?.payload as RillKeyEvent;
    expect(forwarded).toEqual({
      type: 'keydown',
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    });
  });

  it('does not preventDefault when the subscription opts out', () => {
    attachKeyboard(engine, { target });
    sub('k1', ['Enter'], false);

    const event = target.dispatch('keydown', { key: 'Enter' });

    expect(event.defaultPrevented).toBe(false);
    expect(engine.sent).toHaveLength(1);
  });

  it('ignores keys no subscription cares about', () => {
    attachKeyboard(engine, { target });
    sub('k1', ['Enter'], true);

    const event = target.dispatch('keydown', { key: 'Escape' });

    expect(event.defaultPrevented).toBe(false);
    expect(engine.sent).toHaveLength(0);
  });

  it('forwards every key for a null (all-keys) subscription', () => {
    attachKeyboard(engine, { target });
    sub('k1', null, false);

    target.dispatch('keydown', { key: 'a' });
    target.dispatch('keyup', { key: 'ArrowDown' });

    expect(engine.sent.map((s) => (s.payload as RillKeyEvent).key)).toEqual(['a', 'ArrowDown']);
    expect((engine.sent[1]?.payload as RillKeyEvent).type).toBe('keyup');
  });

  it('preventDefaultKeys always suppress and forward, even without a guest subscription', () => {
    attachKeyboard(engine, { target, preventDefaultKeys: ['Tab'] });

    const event = target.dispatch('keydown', { key: 'Tab' });

    expect(event.defaultPrevented).toBe(true);
    expect(engine.sent).toHaveLength(1);
    expect((engine.sent[0]?.payload as RillKeyEvent).key).toBe('Tab');
  });

  it('preventDefault is the OR across subscriptions for the same key', () => {
    attachKeyboard(engine, { target });
    sub('a', ['x'], false);
    sub('b', ['x'], true);

    const event = target.dispatch('keydown', { key: 'x' });

    expect(event.defaultPrevented).toBe(true);
  });

  it('stops forwarding a key after its subscription unsubscribes', () => {
    attachKeyboard(engine, { target });
    sub('k1', ['Enter'], true);
    unsub('k1');

    const event = target.dispatch('keydown', { key: 'Enter' });

    expect(event.defaultPrevented).toBe(false);
    expect(engine.sent).toHaveLength(0);
  });

  it('carries modifier flags and repeat through unchanged', () => {
    attachKeyboard(engine, { target });
    sub('k1', null, false);

    target.dispatch('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      metaKey: true,
      repeat: true,
    });

    expect(engine.sent[0]?.payload).toEqual({
      type: 'keydown',
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: true,
      repeat: true,
    });
  });

  it('detach removes listeners, drops the message subscription, and stops forwarding', () => {
    const handle = attachKeyboard(engine, { target });
    sub('k1', ['Enter'], true);
    expect(target.listenerCount('keydown')).toBe(1);
    expect(target.listenerCount('keyup')).toBe(1);
    expect(engine.messageListenerCount).toBe(1);

    handle.detach();

    expect(target.listenerCount('keydown')).toBe(0);
    expect(target.listenerCount('keyup')).toBe(0);
    expect(engine.messageListenerCount).toBe(0);

    target.dispatch('keydown', { key: 'Enter' });
    expect(engine.sent).toHaveLength(0);
  });

  it('throws when no target is given and no global window exists', () => {
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g;
    const saved = g.window;
    delete g.window;
    try {
      expect(() => attachKeyboard(engine)).toThrow(/no DOM target/);
    } finally {
      if (hadWindow) {
        g.window = saved;
      }
    }
  });
});
