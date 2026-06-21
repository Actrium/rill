/**
 * Timer non-blocking behavior tests
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

describe('Engine Timer Non-Blocking', () => {
  let engine: Engine;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
  });

  afterEach(() => {
    engine?.destroy();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it('should not synchronously block when native setTimeout is slow', async () => {
    let nativeCalls = 0;
    const blockingSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      nativeCalls++;
      const start = Date.now();
      while (Date.now() - start < 200) {}
      return (originalSetTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(
        handler,
        timeout,
        ...args
      );
    }) as typeof setTimeout;

    globalThis.setTimeout = blockingSetTimeout;

    engine = new Engine({ sandbox: 'node-vm', debug: false });
    await engine.loadBundle(`// init`);

    const guestSetTimeout = (await engine.context?.extract('setTimeout')) as (
      fn: () => void,
      delay: number
    ) => number;

    const syncStart = Date.now();
    guestSetTimeout(() => {}, 10);
    const syncDuration = Date.now() - syncStart;

    expect(syncDuration).toBeLessThan(100);

    await Promise.resolve();
    expect(nativeCalls).toBe(1);
  });

  it('should cancel pending interval before native scheduling', async () => {
    let nativeTimeoutCalls = 0;
    const countingSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      nativeTimeoutCalls++;
      return (originalSetTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(
        handler,
        timeout,
        ...args
      );
    }) as typeof setTimeout;

    globalThis.setTimeout = countingSetTimeout;
    engine = new Engine({ sandbox: 'node-vm', debug: false });
    await engine.loadBundle(`// init`);

    const guestSetInterval = (await engine.context?.extract('setInterval')) as (
      fn: () => void,
      delay: number
    ) => number;
    const guestClearInterval = (await engine.context?.extract('clearInterval')) as (
      id: number
    ) => void;

    const id = guestSetInterval(() => {}, 1000);
    guestClearInterval(id);

    await Promise.resolve();
    expect(nativeTimeoutCalls).toBe(0);
  });
});
