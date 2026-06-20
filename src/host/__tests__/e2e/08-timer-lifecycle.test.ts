/**
 * E2E Timer Lifecycle Tests
 *
 * Tests timer behaviour through the full Engine → Guest → TimerManager pipeline:
 * - Zero-delay setTimeout (queueMicrotask optimisation)
 * - clearTimeout cancellation
 * - setInterval tick ordering
 * - Timer pause/resume via Engine
 * - Timer cleanup on Engine destroy
 * - Multiple concurrent timers
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { waitFor, waitForEvent, wait } from './helpers/test-utils';

describe('E2E Timer: Zero-delay setTimeout', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should fire setTimeout(fn, 0) promptly via microtask', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const t0 = Date.now();
      setTimeout(() => {
        const elapsed = Date.now() - t0;
        globalThis.__rill_emitEvent('ZERO_TIMEOUT', { elapsed });
      }, 0);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const event = await waitForEvent(ctx.events, 'ZERO_TIMEOUT', 3000);
    // Should fire fast — microtask, not 24s RCTTiming delay
    const elapsed = (event.payload as { elapsed: number }).elapsed;
    expect(elapsed).toBeLessThan(500);
  });

  it('should fire multiple setTimeout(fn, 0) in order', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const order = [];
      setTimeout(() => { order.push(1); }, 0);
      setTimeout(() => { order.push(2); }, 0);
      setTimeout(() => {
        order.push(3);
        globalThis.__rill_emitEvent('ORDER_DONE', { order });
      }, 0);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const event = await waitForEvent(ctx.events, 'ORDER_DONE', 3000);
    expect((event.payload as { order: number[] }).order).toEqual([1, 2, 3]);
  });
});

describe('E2E Timer: clearTimeout', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should cancel a pending setTimeout', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const id = setTimeout(() => {
        globalThis.__rill_emitEvent('SHOULD_NOT_FIRE');
      }, 30);
      clearTimeout(id);

      // Fire a later timer to confirm execution continues
      setTimeout(() => {
        globalThis.__rill_emitEvent('CONFIRM_CLEAR');
      }, 60);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'CONFIRM_CLEAR', 3000);
    expect(ctx.events.some((e) => e.event === 'SHOULD_NOT_FIRE')).toBe(false);
  });

  it('should cancel a zero-delay setTimeout', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const id = setTimeout(() => {
        globalThis.__rill_emitEvent('ZERO_CANCELLED');
      }, 0);
      clearTimeout(id);

      setTimeout(() => {
        globalThis.__rill_emitEvent('AFTER_CANCEL');
      }, 30);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'AFTER_CANCEL', 3000);
    expect(ctx.events.some((e) => e.event === 'ZERO_CANCELLED')).toBe(false);
  });
});

describe('E2E Timer: setInterval lifecycle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should fire setInterval repeatedly and stop on clearInterval', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      let count = 0;
      const id = setInterval(() => {
        count++;
        globalThis.__rill_emitEvent('TICK', { count });
        if (count >= 3) {
          clearInterval(id);
          globalThis.__rill_emitEvent('DONE', { totalTicks: count });
        }
      }, 25);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'DONE', 3000);
    const ticks = ctx.events.filter((e) => e.event === 'TICK');
    expect(ticks.length).toBe(3);
    expect((ticks[0].payload as { count: number }).count).toBe(1);
    expect((ticks[2].payload as { count: number }).count).toBe(3);
  });

  it('should not fire after clearInterval is called immediately', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const id = setInterval(() => {
        globalThis.__rill_emitEvent('SHOULD_NOT_TICK');
      }, 20);
      clearInterval(id);

      setTimeout(() => {
        globalThis.__rill_emitEvent('VERIFY_NO_TICKS');
      }, 100);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'VERIFY_NO_TICKS', 3000);
    expect(ctx.events.some((e) => e.event === 'SHOULD_NOT_TICK')).toBe(false);
  });
});

describe('E2E Timer: Pause / Resume', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should pause timers and resume them', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      setTimeout(() => {
        globalThis.__rill_emitEvent('TIMER_FIRED');
      }, 30);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Pause timers
    ctx.engine.pause();

    // Wait longer than the delay
    await wait(100);
    expect(ctx.events.some((e) => e.event === 'TIMER_FIRED')).toBe(false);

    // Resume
    ctx.engine.resume();

    await waitForEvent(ctx.events, 'TIMER_FIRED', 3000);
    expect(ctx.events.some((e) => e.event === 'TIMER_FIRED')).toBe(true);
  });

  it('should pause interval and resume ticking', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      let count = 0;
      setInterval(() => {
        count++;
        globalThis.__rill_emitEvent('ITICK', { count });
      }, 25);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Let a few ticks fire
    await wait(80);
    const ticksBeforePause = ctx.events.filter((e) => e.event === 'ITICK').length;
    expect(ticksBeforePause).toBeGreaterThanOrEqual(1);

    // Pause
    ctx.engine.pause();
    const countAtPause = ctx.events.filter((e) => e.event === 'ITICK').length;
    await wait(80);
    const countDuringPause = ctx.events.filter((e) => e.event === 'ITICK').length;
    // Should not have increased (or at most +1 from in-flight tick)
    expect(countDuringPause - countAtPause).toBeLessThanOrEqual(1);

    // Resume
    ctx.engine.resume();
    await wait(80);
    const countAfterResume = ctx.events.filter((e) => e.event === 'ITICK').length;
    expect(countAfterResume).toBeGreaterThan(countDuringPause);
  });
});

describe('E2E Timer: Cleanup on destroy', () => {
  it('should stop all timers when engine is destroyed', async () => {
    const ctx = createTestContext();

    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      setInterval(() => {
        globalThis.__rill_emitEvent('LEAK_TICK');
      }, 20);

      setTimeout(() => {
        globalThis.__rill_emitEvent('LEAK_TIMEOUT');
      }, 500);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Let interval fire a couple times
    await wait(60);

    // Destroy engine
    await ctx.engine.destroy();

    const eventsAtDestroy = ctx.events.length;

    // Wait — no more events should arrive
    await wait(200);
    expect(ctx.events.length).toBe(eventsAtDestroy);
  });
});

describe('E2E Timer: Concurrent timers', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle many concurrent timers with different delays', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const results = [];
      // 10 timers with staggered delays
      for (let i = 0; i < 10; i++) {
        setTimeout(() => {
          results.push(i);
          if (results.length === 10) {
            globalThis.__rill_emitEvent('ALL_FIRED', { results });
          }
        }, i * 10);
      }

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const event = await waitForEvent(ctx.events, 'ALL_FIRED', 5000);
    const results = (event.payload as { results: number[] }).results;
    expect(results.length).toBe(10);
    // Should fire in order of delay
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('should handle mixed setTimeout and setInterval concurrently', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const log = [];

      setTimeout(() => { log.push('T1'); }, 10);
      setTimeout(() => { log.push('T2'); }, 30);

      let iCount = 0;
      const iid = setInterval(() => {
        iCount++;
        log.push('I' + iCount);
        if (iCount >= 2) {
          clearInterval(iid);
          // Wait for T2 to finish
          setTimeout(() => {
            globalThis.__rill_emitEvent('MIXED_DONE', { log });
          }, 50);
        }
      }, 20);

      function App() {
        return React.createElement('View', { testID: 'root' });
      }
      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const event = await waitForEvent(ctx.events, 'MIXED_DONE', 5000);
    const log = (event.payload as { log: string[] }).log;
    // T1 (10ms) should fire before I1 (20ms)
    expect(log.indexOf('T1')).toBeLessThan(log.indexOf('I1'));
    // All should be present
    expect(log).toContain('T1');
    expect(log).toContain('T2');
    expect(log).toContain('I1');
    expect(log).toContain('I2');
  });
});
