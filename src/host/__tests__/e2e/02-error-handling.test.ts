/**
 * E2E Error Handling Tests
 *
 * Tests error scenarios:
 * - Guest code runtime errors
 * - Callback function errors
 * - Error propagation across boundary
 * - Error serialization and deserialization
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { findNodeByTestId, wait, waitFor } from './helpers/test-utils';

describe('E2E Error Handling: Guest Runtime Errors', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should capture synchronous errors in guest code', async () => {
    const guestCode = `
      throw new Error('Intentional sync error');
    `;

    // Engine captures the error — loadBundle throws synchronously (sync path)
    expect(() => ctx.engine.loadBundle(guestCode)).toThrow('Intentional sync error');
  });

  it('should continue running after catching guest error', async () => {
    // First, load broken code
    const brokenCode = `
      throw new Error('First error');
    `;

    expect(() => ctx.engine.loadBundle(brokenCode)).toThrow();

    // Then load working code - engine should still work
    const workingCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('View', { testID: 'recovered' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(workingCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const node = findNodeByTestId(ctx.receiver, 'recovered');
    expect(node).toBeDefined();
  });

  it('should handle undefined variable errors', async () => {
    const guestCode = `
      const value = undefinedVariable.property;
    `;

    expect(() => ctx.engine.loadBundle(guestCode)).toThrow();
  });

  it('should handle type errors', async () => {
    const guestCode = `
      null.someMethod();
    `;

    expect(() => ctx.engine.loadBundle(guestCode)).toThrow();
  });
});

/**
 * Callback Error Handling
 *
 * NOTE: The Engine catches callback errors and logs them, returning undefined.
 * This is by design to prevent Guest errors from crashing the Host.
 * Errors are NOT propagated as rejections.
 */
describe('E2E Error Handling: Callback Errors', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should catch sync callback errors without crashing', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => {
            throw new Error('Callback error from guest');
          }
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    expect(button).toBeDefined();

    // Engine catches callback errors and returns undefined
    const result = await button?.props.onPress();
    expect(result).toBeUndefined();
  });

  it('should propagate async callback errors as rejections', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            throw new Error('Async callback error');
          }
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    expect(button).toBeDefined();

    // Async callback errors are propagated as rejections
    await expect(button?.props.onPress()).rejects.toThrow('Async callback error');
  });

  it('should continue working after callback error', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(0);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement('TouchableOpacity', {
            testID: 'error-button',
            onPress: () => {
              throw new Error('This should not crash the app');
            }
          }),
          React.createElement('TouchableOpacity', {
            testID: 'safe-button',
            onPress: () => {
              setCount(count + 1);
              globalThis.__rill_emitEvent('COUNT_UPDATED', { count: count + 1 });
            }
          }),
          React.createElement('Text', { testID: 'counter' }, 'Count: ' + count)
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const errorButton = findNodeByTestId(ctx.receiver, 'error-button');
    const safeButton = findNodeByTestId(ctx.receiver, 'safe-button');

    // Trigger error callback - should throw but not crash
    try {
      await errorButton?.props.onPress();
    } catch {
      // Expected
    }

    // Safe button should still work
    await safeButton?.props.onPress();
    await wait(100);

    expect(ctx.events.some((e) => e.event === 'COUNT_UPDATED')).toBe(true);
  });
});

describe('E2E Error Handling: Error Serialization', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should serialize Error objects with all properties', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const customError = new Error('Test error message');
      customError.name = 'CustomError';

      function App() {
        return React.createElement('View', {
          testID: 'container',
          error: customError
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container).toBeDefined();

    const error = container?.props.error;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('Test error message');
    expect(error?.name).toBe('CustomError');
  });

  it('should serialize different error types', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('View', {
          testID: 'container',
          typeError: new TypeError('Type mismatch'),
          rangeError: new RangeError('Out of range'),
          syntaxError: new SyntaxError('Invalid syntax')
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.typeError).toBeInstanceOf(Error);
    expect(container?.props.rangeError).toBeInstanceOf(Error);
    expect(container?.props.syntaxError).toBeInstanceOf(Error);
  });
});

/**
 * Component Render Errors
 *
 * NOTE: In the mock environment, React's error handling during render/commit
 * works differently. Some tests are skipped because useEffect scheduling
 * doesn't work properly with the mock JS engine.
 */
describe('E2E Error Handling: Component Render Errors', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  // NOTE: React catches render errors internally - use Error Boundaries in real apps
  // NOTE: useEffect error handling tests moved to Playwright E2E:
  // @see tests/wasm-sandbox/rill-useeffect.e2e.ts
});
