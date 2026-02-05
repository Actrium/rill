/**
 * E2E Memory Leak Tests
 *
 * Critical tests to detect and prevent memory leaks in:
 * - Function callback registry
 * - Timer management
 * - Event listener management
 *
 * These tests verify the fix for the memory leak issue described in
 * /tmp/rill_architecture_review.md
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { expectNodeExists, expectNoMemoryLeak } from './helpers/assertions';
import { findNodeByTestId, simulatePress, wait, waitFor } from './helpers/test-utils';

describe('E2E Memory Leak: Function Callbacks', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should not leak functions on rapid updates', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(0);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'button',
              onPress: () => {
                globalThis.__rill_emitEvent('CLICK', { count });
                setCount(count + 1);
              }
            },
            React.createElement('Text', {}, 'Count: ' + count)
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Guest callbacks are now tracked in Guest's globalCallbackRegistry
    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Initial callback registry size:', initialSize);
    expect(initialSize).toBeGreaterThan(0);

    // Trigger 50 rapid updates
    for (let i = 0; i < 50; i++) {
      const button = findNodeByTestId(ctx.receiver, 'button');
      expectNodeExists(button);
      await simulatePress(button);
      await wait(10);
    }

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Final callback registry size:', finalSize);
    console.log('Leaked functions:', finalSize - initialSize);

    // ❌ Current implementation will fail: finalSize >> initialSize (≈50 leaked functions)
    // ✅ After fix should pass: leaked should be close to 0 or a small constant
    expectNoMemoryLeak(initialSize, finalSize, 10);
  });

  it('should not leak functions with multiple function props', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(0);

        return React.createElement(
          'View',
          {
            testID: 'view',
            onLayout: () => globalThis.__rill_emitEvent('LAYOUT'),
            onTouchStart: () => globalThis.__rill_emitEvent('TOUCH_START'),
            onTouchEnd: () => globalThis.__rill_emitEvent('TOUCH_END'),
          },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'button',
              onPress: () => setCount(count + 1),
              onPressIn: () => globalThis.__rill_emitEvent('PRESS_IN'),
              onPressOut: () => globalThis.__rill_emitEvent('PRESS_OUT'),
            },
            React.createElement('Text', {}, 'Count: ' + count)
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Initial registry size (multiple props):', initialSize);

    // Trigger 30 updates
    for (let i = 0; i < 30; i++) {
      const button = findNodeByTestId(ctx.receiver, 'button');
      await simulatePress(button);
      await wait(10);
    }

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Final registry size (multiple props):', finalSize);
    console.log('Leaked functions:', finalSize - initialSize);

    // Each update creates 5 new functions (onLayout, onTouchStart, onTouchEnd, onPress, onPressIn, onPressOut)
    // ❌ Without fix: ~150 functions leaked
    // ✅ With fix: < 20 functions (only current functions + some tolerance)
    expectNoMemoryLeak(initialSize, finalSize, 20);
  });

  it('should clean up functions on component unmount', async () => {
    const guestCode = `
      const React = require('react');
      const { render, unmount } = require('rill/reconciler');

      function App() {
        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'button',
              onPress: () => globalThis.__rill_emitEvent('CLICK')
            },
            React.createElement('Text', {}, 'Button')
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);

      // Expose unmount
      globalThis.__unmountApp = () => {
        unmount(globalThis.__rill_sendBatch);
      };
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Registry size before unmount:', initialSize);
    expect(initialSize).toBeGreaterThan(0);

    // Unmount the app
    await ctx.engine.context?.extract('__unmountApp')?.();
    await wait(100);

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Registry size after unmount:', finalSize);

    // ❌ Without fix: finalSize === initialSize (functions not cleaned up)
    // ✅ With fix: finalSize === 0 or close to 0
    expect(finalSize).toBe(0);
  });

  it('should handle function in nested structures', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(0);

        return React.createElement(
          'View',
          {
            testID: 'view',
            callbacks: {
              onSuccess: () => globalThis.__rill_emitEvent('SUCCESS'),
              onError: (err) => globalThis.__rill_emitEvent('ERROR', err),
            },
            handlers: [
              () => globalThis.__rill_emitEvent('HANDLER_0'),
              () => globalThis.__rill_emitEvent('HANDLER_1'),
            ]
          },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'button',
              onPress: () => setCount(count + 1)
            },
            React.createElement('Text', {}, 'Count: ' + count)
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Initial registry size (nested):', initialSize);

    // Trigger 20 updates
    for (let i = 0; i < 20; i++) {
      const button = findNodeByTestId(ctx.receiver, 'button');
      await simulatePress(button);
      await wait(10);
    }

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Final registry size (nested):', finalSize);
    console.log('Leaked functions:', finalSize - initialSize);

    // Each update creates 4 nested functions (2 in callbacks, 2 in handlers)
    // ❌ Without fix: ~80 functions leaked (20 * 4)
    // ✅ With fix: < 15 functions
    expectNoMemoryLeak(initialSize, finalSize, 15);
  });
});

describe('E2E Memory Leak: List Rendering', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should not leak functions when re-rendering lists', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [items, setItems] = useState([1, 2, 3, 4, 5]);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'refresh',
              onPress: () => setItems([...items]) // Force re-render
            },
            React.createElement('Text', {}, 'Refresh')
          ),
          ...items.map((item) =>
            React.createElement(
              'TouchableOpacity',
              {
                key: item,
                testID: 'item-' + item,
                onPress: () => globalThis.__rill_emitEvent('ITEM_CLICK', { item })
              },
              React.createElement('Text', {}, 'Item ' + item)
            )
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Initial registry size (list):', initialSize);

    // Trigger 30 re-renders of the list
    for (let i = 0; i < 30; i++) {
      const refresh = findNodeByTestId(ctx.receiver, 'refresh');
      await simulatePress(refresh);
      await wait(10);
    }

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Final registry size (list):', finalSize);
    console.log('Leaked functions:', finalSize - initialSize);

    // Each re-render creates 6 new functions (1 refresh + 5 items)
    // ❌ Without fix: ~180 functions leaked (30 * 6)
    // ✅ With fix: < 20 functions
    expectNoMemoryLeak(initialSize, finalSize, 20);
  });

  it('should clean up functions when list items are removed', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [items, setItems] = useState([1, 2, 3, 4, 5]);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'remove',
              onPress: () => setItems(items.slice(0, -1)) // Remove last item
            },
            React.createElement('Text', {}, 'Remove Last')
          ),
          ...items.map((item) =>
            React.createElement(
              'TouchableOpacity',
              {
                key: item,
                testID: 'item-' + item,
                onPress: () => globalThis.__rill_emitEvent('ITEM_CLICK', { item })
              },
              React.createElement('Text', {}, 'Item ' + item)
            )
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Initial registry size (before removal):', initialSize);

    // Remove all items one by one
    for (let i = 0; i < 5; i++) {
      const remove = findNodeByTestId(ctx.receiver, 'remove');
      await simulatePress(remove);
      await wait(50);
    }

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Final registry size (after removal):', finalSize);

    // ✅ After removing all items, only the "remove" button's onPress should remain
    // Should be much smaller than initial size
    expect(finalSize).toBeLessThan(initialSize);
  });
});

describe('E2E Memory Leak: Edge Cases', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should not leak when replacing component tree', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function ComponentA() {
        return React.createElement(
          'TouchableOpacity',
          {
            testID: 'component-a',
            onPress: () => globalThis.__rill_emitEvent('A_PRESSED')
          },
          React.createElement('Text', {}, 'Component A')
        );
      }

      function ComponentB() {
        return React.createElement(
          'TouchableOpacity',
          {
            testID: 'component-b',
            onPress: () => globalThis.__rill_emitEvent('B_PRESSED')
          },
          React.createElement('Text', {}, 'Component B')
        );
      }

      function App() {
        const [showA, setShowA] = useState(true);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'toggle',
              onPress: () => setShowA(!showA)
            },
            React.createElement('Text', {}, 'Toggle')
          ),
          showA
            ? React.createElement(ComponentA)
            : React.createElement(ComponentB)
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    console.log('Initial registry size (component replacement):', initialSize);

    // Toggle between components 20 times
    for (let i = 0; i < 20; i++) {
      const toggle = findNodeByTestId(ctx.receiver, 'toggle');
      await simulatePress(toggle);
      await wait(50);
    }

    const finalSize = ctx.engine.guestCallbackCount;
    console.log('Final registry size (component replacement):', finalSize);
    console.log('Leaked functions:', finalSize - initialSize);

    // ✅ Should not leak functions when replacing components
    expectNoMemoryLeak(initialSize, finalSize, 10);
  });
});
