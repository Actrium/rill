/**
 * E2E Async Operations Tests
 *
 * Tests asynchronous behavior:
 * - Promise handling across boundary
 * - Async callbacks
 * - Concurrent operations
 * - Timer operations (setTimeout, setInterval)
 *
 * NOTE: useEffect-based tests have been moved to Playwright E2E:
 * @see tests/wasm-sandbox/rill-useeffect.e2e.ts
 *
 * The mock environment cannot test useEffect because react-reconciler
 * captures setTimeout at module import time, before Engine's polyfill.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { findNodeByTestId, wait, waitFor, waitForEvent } from './helpers/test-utils';

describe('E2E Async: Callback with Async Return', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle async callback that returns a promise', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        const handleSubmit = async (data) => {
          await new Promise(resolve => setTimeout(resolve, 50));
          globalThis.__rill_emitEvent('SUBMIT_PROCESSED', { result: data.toUpperCase() });
          return { success: true, result: data.toUpperCase() };
        };

        return React.createElement('TextInput', {
          testID: 'input',
          onSubmitEditing: handleSubmit
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const input = findNodeByTestId(ctx.receiver, 'input');
    expect(input).toBeDefined();

    // Call the async callback
    const result = await input?.props.onSubmitEditing('hello');
    await wait(100);

    expect(result).toEqual({ success: true, result: 'HELLO' });
    expect(ctx.events.some((e) => e.event === 'SUBMIT_PROCESSED')).toBe(true);
  });

  it('should handle sequential async callbacks', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [queue, setQueue] = useState([]);

        const processItem = async (item) => {
          await new Promise(resolve => setTimeout(resolve, 20));
          const result = { processed: item, timestamp: Date.now() };
          setQueue(prev => [...prev, result]);
          globalThis.__rill_emitEvent('ITEM_PROCESSED', result);
          return result;
        };

        return React.createElement('TouchableOpacity', {
          testID: 'processor',
          onPress: processItem
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const processor = findNodeByTestId(ctx.receiver, 'processor');

    // Process items sequentially
    await processor?.props.onPress('item1');
    await processor?.props.onPress('item2');
    await processor?.props.onPress('item3');

    await wait(200);

    const processed = ctx.events.filter((e) => e.event === 'ITEM_PROCESSED');
    expect(processed.length).toBe(3);
  });
});

describe('E2E Async: Error Handling in Async Code', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle rejected promises in callbacks', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        const handlePress = async () => {
          await new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Async rejection')), 20)
          );
        };

        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: handlePress
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    await expect(button?.props.onPress()).rejects.toThrow('Async rejection');
  });

  it('should handle try/catch in async callbacks', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        const handlePress = async () => {
          try {
            await new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Caught error')), 20)
            );
          } catch (e) {
            globalThis.__rill_emitEvent('ERROR_CAUGHT', { message: e.message });
            return { error: e.message };
          }
        };

        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: handlePress
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toEqual({ error: 'Caught error' });
    expect(ctx.events.some((e) => e.event === 'ERROR_CAUGHT')).toBe(true);
  });
});

/**
 * Direct Timer Tests (no useEffect)
 *
 * These tests verify timer functionality by using top-level IIFE async code
 * instead of useEffect, which avoids the scheduling issue in mock environment.
 */
describe('E2E Async: Direct Timer Tests', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle setTimeout at top level', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      // Direct timer (not in useEffect)
      setTimeout(() => {
        globalThis.__rill_emitEvent('TIMEOUT_FIRED');
      }, 50);

      function App() {
        return React.createElement('View', { testID: 'container' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'TIMEOUT_FIRED', 3000);
    expect(ctx.events.some((e) => e.event === 'TIMEOUT_FIRED')).toBe(true);
  });

  it('should handle async IIFE with Promise and setTimeout', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      // Async IIFE (not in useEffect)
      (async () => {
        globalThis.__rill_emitEvent('ASYNC_START');
        await new Promise(resolve => setTimeout(resolve, 30));
        globalThis.__rill_emitEvent('ASYNC_DONE');
      })();

      function App() {
        return React.createElement('View', { testID: 'container' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'ASYNC_DONE', 3000);

    const events = ctx.events.map((e) => e.event);
    expect(events).toContain('ASYNC_START');
    expect(events).toContain('ASYNC_DONE');
  });

  it('should handle Promise.all with timers', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      (async () => {
        const promises = [
          new Promise(resolve => setTimeout(() => resolve('A'), 30)),
          new Promise(resolve => setTimeout(() => resolve('B'), 20)),
          new Promise(resolve => setTimeout(() => resolve('C'), 10))
        ];

        const values = await Promise.all(promises);
        globalThis.__rill_emitEvent('ALL_RESOLVED', { values });
      })();

      function App() {
        return React.createElement('View', { testID: 'container' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const event = await waitForEvent(ctx.events, 'ALL_RESOLVED', 3000);
    // biome-ignore lint/suspicious/noExplicitAny: Test event payload has dynamic structure
    expect((event.payload as any).values).toEqual(['A', 'B', 'C']);
  });

  it('should handle Promise.race with timers', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      (async () => {
        const result = await Promise.race([
          new Promise(resolve => setTimeout(() => resolve('slow'), 100)),
          new Promise(resolve => setTimeout(() => resolve('fast'), 10))
        ]);
        globalThis.__rill_emitEvent('RACE_WINNER', { winner: result });
      })();

      function App() {
        return React.createElement('View', { testID: 'container' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const event = await waitForEvent(ctx.events, 'RACE_WINNER', 3000);
    // biome-ignore lint/suspicious/noExplicitAny: Test event payload has dynamic structure
    expect((event.payload as any).winner).toBe('fast');
  });

  it('should handle setInterval with clearInterval', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      let count = 0;
      const interval = setInterval(() => {
        count++;
        globalThis.__rill_emitEvent('TICK', { count });

        if (count >= 3) {
          clearInterval(interval);
          globalThis.__rill_emitEvent('INTERVAL_STOPPED');
        }
      }, 20);

      function App() {
        return React.createElement('View', { testID: 'container' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    await waitForEvent(ctx.events, 'INTERVAL_STOPPED', 3000);

    const ticks = ctx.events.filter((e) => e.event === 'TICK');
    expect(ticks.length).toBe(3);
  });
});
