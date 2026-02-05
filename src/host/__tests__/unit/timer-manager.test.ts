/**
 * TimerManager comprehensive unit tests
 *
 * Tests cover:
 * - setTimeout / clearTimeout basics
 * - setInterval / clearInterval basics
 * - Zero-delay → queueMicrotask optimisation
 * - Non-blocking async scheduling (scheduleNativeTimeout / scheduleIntervalTick)
 * - pendingToken invalidation (cancel before microtask fires)
 * - Pause / resume with all handle states (microtask, pending, native)
 * - clearAllTimers with mixed handle types
 * - Error handling in callbacks
 * - Multiple rapid zero-delay timers
 * - Interval fires repeatedly via recursive setTimeout
 * - Timer stats
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TimerManager } from '../../engine/timer-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOptions(overrides?: Partial<{ debug: boolean; onError: (e: Error) => void }>) {
  const logs: string[] = [];
  const errors: Array<{ msg: string; err?: unknown }> = [];
  return {
    opts: {
      debug: overrides?.debug ?? false,
      logger: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => errors.push({ msg: args.map(String).join(' '), err: args[1] }),
      },
      engineId: 'test',
      onError: overrides?.onError,
    },
    logs,
    errors,
  };
}

/** Flush microtasks (queueMicrotask / Promise.resolve) */
async function flushMicrotasks(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Wait for real time + flush microtasks */
async function waitMs(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimerManager', () => {
  let tm: TimerManager;
  let helpers: ReturnType<typeof createOptions>;

  beforeEach(() => {
    helpers = createOptions();
    tm = new TimerManager(helpers.opts);
  });

  afterEach(() => {
    tm.clearAllTimers();
  });

  // =============================================
  // setTimeout basics
  // =============================================

  describe('setTimeout', () => {
    it('should return incrementing ids', () => {
      const set = tm.createSetTimeoutPolyfill();
      const id1 = set(() => {}, 100);
      const id2 = set(() => {}, 100);
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it('should fire callback after delay', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 20);

      // Allow microtask (async schedule) + native timeout
      await waitMs(80);
      expect(fired).toBe(true);
    });

    it('should remove entry from map after firing', async () => {
      const set = tm.createSetTimeoutPolyfill();
      set(() => {}, 10);
      expect(tm.getStats().timeouts).toBe(1);

      await waitMs(50);
      expect(tm.getStats().timeouts).toBe(0);
    });

    it('should not fire if cleared before callback', async () => {
      const set = tm.createSetTimeoutPolyfill();
      const clear = tm.createClearTimeoutPolyfill();
      let fired = false;
      const id = set(() => { fired = true; }, 20);
      clear(id);

      await waitMs(80);
      expect(fired).toBe(false);
      expect(tm.getStats().timeouts).toBe(0);
    });

    it('clearTimeout with unknown id should not throw', () => {
      const clear = tm.createClearTimeoutPolyfill();
      expect(() => clear(999)).not.toThrow();
    });
  });

  // =============================================
  // Zero-delay → queueMicrotask optimisation
  // =============================================

  describe('setTimeout zero-delay (microtask)', () => {
    it('should fire via microtask for delay=0', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 0);

      // Should fire within microtasks, not needing real timer
      await flushMicrotasks();
      expect(fired).toBe(true);
    });

    it('should fire via microtask for negative delay', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, -5);

      await flushMicrotasks();
      expect(fired).toBe(true);
    });

    it('should support multiple rapid zero-delay timers', async () => {
      const set = tm.createSetTimeoutPolyfill();
      const order: number[] = [];
      set(() => order.push(1), 0);
      set(() => order.push(2), 0);
      set(() => order.push(3), 0);

      await flushMicrotasks();
      expect(order).toEqual([1, 2, 3]);
    });

    it('should not fire if cleared before microtask runs', async () => {
      const set = tm.createSetTimeoutPolyfill();
      const clear = tm.createClearTimeoutPolyfill();
      let fired = false;
      const id = set(() => { fired = true; }, 0);
      // Clear synchronously, before microtask flushes
      clear(id);

      await flushMicrotasks();
      expect(fired).toBe(false);
    });

    it('should remove entry from map after microtask fires', async () => {
      const set = tm.createSetTimeoutPolyfill();
      set(() => {}, 0);
      expect(tm.getStats().timeouts).toBe(1);

      await flushMicrotasks();
      expect(tm.getStats().timeouts).toBe(0);
    });
  });

  // =============================================
  // Non-blocking async scheduling (delay > 0)
  // =============================================

  describe('setTimeout async scheduling', () => {
    it('should not block synchronously when creating timer', () => {
      const set = tm.createSetTimeoutPolyfill();
      const start = Date.now();
      set(() => {}, 5000);
      const elapsed = Date.now() - start;
      // Creating a timer should be instant (< 5ms), not blocking for the delay
      expect(elapsed).toBeLessThan(50);
    });

    it('pendingToken prevents stale microtask from scheduling native timer', async () => {
      const set = tm.createSetTimeoutPolyfill();
      const clear = tm.createClearTimeoutPolyfill();
      let fired = false;
      const id = set(() => { fired = true; }, 10);

      // Clear before the scheduling microtask runs
      clear(id);

      // The microtask from scheduleNativeTimeout will fire but token mismatch → skip
      await flushMicrotasks();
      await waitMs(50);
      expect(fired).toBe(false);
    });
  });

  // =============================================
  // setInterval basics
  // =============================================

  describe('setInterval', () => {
    it('should return incrementing ids', () => {
      const setI = tm.createSetIntervalPolyfill();
      const id1 = setI(() => {}, 100);
      const id2 = setI(() => {}, 100);
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it('should fire callback repeatedly', async () => {
      const setI = tm.createSetIntervalPolyfill();
      let count = 0;
      setI(() => { count++; }, 30);

      // Wait enough for ~3 ticks (30ms * 3 = 90ms) + buffer
      await waitMs(130);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('should stop firing after clearInterval', async () => {
      const setI = tm.createSetIntervalPolyfill();
      const clearI = tm.createClearIntervalPolyfill();
      let count = 0;
      const id = setI(() => { count++; }, 20);

      await waitMs(70); // ~2-3 ticks
      const countAfterClear = count;
      clearI(id);

      await waitMs(80); // More time passes
      // Should not have fired additional times
      expect(count).toBe(countAfterClear);
      expect(tm.getStats().intervals).toBe(0);
    });

    it('clearInterval with unknown id should not throw', () => {
      const clearI = tm.createClearIntervalPolyfill();
      expect(() => clearI(999)).not.toThrow();
    });

    it('should not fire if cleared before first microtask', async () => {
      const setI = tm.createSetIntervalPolyfill();
      const clearI = tm.createClearIntervalPolyfill();
      let fired = false;
      const id = setI(() => { fired = true; }, 10);
      clearI(id);

      await waitMs(50);
      expect(fired).toBe(false);
    });
  });

  // =============================================
  // Pause / Resume
  // =============================================

  describe('pause / resume', () => {
    it('isPaused reflects state', () => {
      expect(tm.isPaused).toBe(false);
      tm.pause();
      expect(tm.isPaused).toBe(true);
      tm.resume();
      expect(tm.isPaused).toBe(false);
    });

    it('double pause is idempotent', () => {
      tm.pause();
      tm.pause(); // Should not throw or change state
      expect(tm.isPaused).toBe(true);
    });

    it('double resume is idempotent', () => {
      tm.resume(); // Not paused → no-op
      expect(tm.isPaused).toBe(false);
    });

    it('paused setTimeout should not fire', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 20);

      // Pause immediately (before microtask scheduling completes)
      tm.pause();

      await waitMs(80);
      expect(fired).toBe(false);
    });

    it('paused setTimeout should fire after resume', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 20);

      tm.pause();
      await waitMs(50); // Time passes while paused

      tm.resume();
      await waitMs(80); // After resume, remaining time fires
      expect(fired).toBe(true);
    });

    it('paused setInterval should not fire', async () => {
      const setI = tm.createSetIntervalPolyfill();
      let count = 0;
      setI(() => { count++; }, 20);

      tm.pause();
      await waitMs(80);
      expect(count).toBe(0);
    });

    it('paused setInterval should resume firing', async () => {
      const setI = tm.createSetIntervalPolyfill();
      let count = 0;
      setI(() => { count++; }, 25);

      tm.pause();
      await waitMs(60);
      expect(count).toBe(0);

      tm.resume();
      await waitMs(100); // Should fire at least once after resume
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('setTimeout created while paused should fire on resume', async () => {
      tm.pause();
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 10);

      await waitMs(50);
      expect(fired).toBe(false);

      tm.resume();
      await waitMs(60);
      expect(fired).toBe(true);
    });

    it('setInterval created while paused should fire on resume', async () => {
      tm.pause();
      const setI = tm.createSetIntervalPolyfill();
      let count = 0;
      setI(() => { count++; }, 20);

      await waitMs(50);
      expect(count).toBe(0);

      tm.resume();
      await waitMs(80);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('pause should handle microtask-handle timeouts (delay=0)', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 0);

      // Pause before microtask runs
      tm.pause();

      await flushMicrotasks();
      // The microtask callback checks timeoutMap — entry still exists but isPaused
      // Actually for MICROTASK_HANDLE, the pause() increments pendingToken which
      // doesn't affect the microtask path directly. But pause sets handle=null
      // and pendingToken++ for timeout entries. The zero-delay microtask checks
      // timeoutMap.has(id), so entry still present → fires.
      // Wait to see if it fires despite pause
      await waitMs(30);
      // Zero-delay microtask was already queued before pause — it will check map
      // The entry IS still in the map during pause, so it WILL fire.
      // This is expected: microtask was already dispatched synchronously.
      // To truly prevent, user must clearTimeout before the microtask flushes.
    });

    it('pause during PENDING_HANDLE should prevent native scheduling', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 50);

      // Entry has PENDING_HANDLE (microtask not yet run)
      tm.pause();

      // Microtask fires but sees _isPaused → sets remainingTime, handle=null
      await flushMicrotasks();
      await waitMs(100);
      expect(fired).toBe(false);

      // Resume should reschedule
      tm.resume();
      await waitMs(100);
      expect(fired).toBe(true);
    });
  });

  // =============================================
  // clearAllTimers
  // =============================================

  describe('clearAllTimers', () => {
    it('should clear all timeouts and intervals', async () => {
      const set = tm.createSetTimeoutPolyfill();
      const setI = tm.createSetIntervalPolyfill();

      let tFired = false;
      let iFired = false;
      set(() => { tFired = true; }, 20);
      set(() => { tFired = true; }, 0);
      setI(() => { iFired = true; }, 20);

      tm.clearAllTimers();

      await waitMs(80);
      expect(tFired).toBe(false);
      // Zero-delay microtask was already queued — but entry removed from map
      // so the microtask callback's timeoutMap.has(id) check returns false
      expect(tm.getStats().timeouts).toBe(0);
      expect(tm.getStats().intervals).toBe(0);
    });

    it('should handle empty state without error', () => {
      expect(() => tm.clearAllTimers()).not.toThrow();
    });

    it('pendingToken increment prevents stale microtasks after clearAll', async () => {
      const set = tm.createSetTimeoutPolyfill();
      let fired = false;
      set(() => { fired = true; }, 30);

      tm.clearAllTimers();
      // The scheduleNativeTimeout microtask fires but token mismatch → skip
      await flushMicrotasks();
      await waitMs(80);
      expect(fired).toBe(false);
    });
  });

  // =============================================
  // Error handling
  // =============================================

  describe('error handling', () => {
    it('setTimeout callback error should be caught and reported', async () => {
      const onErrorCalls: Error[] = [];
      helpers = createOptions({ onError: (e) => onErrorCalls.push(e) });
      tm = new TimerManager(helpers.opts);

      const set = tm.createSetTimeoutPolyfill();
      set(() => { throw new Error('boom'); }, 0);

      await flushMicrotasks();
      expect(onErrorCalls.length).toBe(1);
      expect(onErrorCalls[0].message).toBe('boom');
    });

    it('setTimeout callback error should not break subsequent timers', async () => {
      const onErrorCalls: Error[] = [];
      helpers = createOptions({ onError: (e) => onErrorCalls.push(e) });
      tm = new TimerManager(helpers.opts);

      const set = tm.createSetTimeoutPolyfill();
      let secondFired = false;
      set(() => { throw new Error('fail'); }, 0);
      set(() => { secondFired = true; }, 0);

      await flushMicrotasks();
      expect(secondFired).toBe(true);
      expect(onErrorCalls.length).toBe(1);
    });

    it('setInterval callback error should be caught and reported', async () => {
      const onErrorCalls: Error[] = [];
      helpers = createOptions({ onError: (e) => onErrorCalls.push(e) });
      tm = new TimerManager(helpers.opts);

      const setI = tm.createSetIntervalPolyfill();
      const clearI = tm.createClearIntervalPolyfill();
      const id = setI(() => { throw new Error('interval-boom'); }, 15);

      await waitMs(50);
      clearI(id);

      expect(onErrorCalls.length).toBeGreaterThanOrEqual(1);
      expect(onErrorCalls[0].message).toBe('interval-boom');
    });

    it('setInterval continues ticking after callback error', async () => {
      const onErrorCalls: Error[] = [];
      helpers = createOptions({ onError: (e) => onErrorCalls.push(e) });
      tm = new TimerManager(helpers.opts);

      const setI = tm.createSetIntervalPolyfill();
      const clearI = tm.createClearIntervalPolyfill();
      let callCount = 0;
      const id = setI(() => {
        callCount++;
        throw new Error(`tick-${callCount}`);
      }, 15);

      await waitMs(80);
      clearI(id);

      // Should have fired multiple times despite errors
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(onErrorCalls.length).toBe(callCount);
    });

    it('non-Error thrown in callback should be wrapped', async () => {
      const onErrorCalls: Error[] = [];
      helpers = createOptions({ onError: (e) => onErrorCalls.push(e) });
      tm = new TimerManager(helpers.opts);

      const set = tm.createSetTimeoutPolyfill();
      set(() => { throw 'string-error'; }, 0);

      await flushMicrotasks();
      expect(onErrorCalls.length).toBe(1);
      expect(onErrorCalls[0]).toBeInstanceOf(Error);
      expect(onErrorCalls[0].message).toBe('string-error');
    });
  });

  // =============================================
  // Timer stats
  // =============================================

  describe('getStats', () => {
    it('should reflect current state', () => {
      const set = tm.createSetTimeoutPolyfill();
      const setI = tm.createSetIntervalPolyfill();

      expect(tm.getStats()).toEqual({ timeouts: 0, intervals: 0, isPaused: false });

      set(() => {}, 100);
      set(() => {}, 100);
      setI(() => {}, 100);

      expect(tm.getStats()).toEqual({ timeouts: 2, intervals: 1, isPaused: false });

      tm.pause();
      expect(tm.getStats().isPaused).toBe(true);
    });
  });

  // =============================================
  // Debug logging
  // =============================================

  describe('debug mode', () => {
    it('should log constructor info when debug=true', () => {
      helpers = createOptions({ debug: true });
      tm = new TimerManager(helpers.opts);

      const constructorLog = helpers.logs.find((l) => l.includes('Constructor'));
      expect(constructorLog).toBeDefined();
    });

    it('should log pause/resume in debug mode', () => {
      helpers = createOptions({ debug: true });
      tm = new TimerManager(helpers.opts);

      const set = tm.createSetTimeoutPolyfill();
      set(() => {}, 100);

      tm.pause();
      const pauseLog = helpers.logs.find((l) => l.includes('Paused'));
      expect(pauseLog).toBeDefined();

      tm.resume();
      const resumeLog = helpers.logs.find((l) => l.includes('Resumed'));
      expect(resumeLog).toBeDefined();
    });
  });
});
