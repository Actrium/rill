/**
 * E2E Stress Tests
 *
 * Tests system behavior under heavy load:
 * - Large data volumes
 * - Many concurrent callbacks
 * - Rapid state updates
 * - Deep component trees
 * - Large lists
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { findNodeByTestId, wait, waitFor } from './helpers/test-utils';

describe('E2E Stress: Large Data Volumes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle large object props', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      // Create large data object
      const largeData = {};
      for (let i = 0; i < 1000; i++) {
        largeData['key_' + i] = {
          id: i,
          name: 'Item ' + i,
          description: 'This is a description for item ' + i,
          metadata: {
            created: new Date().toISOString(),
            tags: ['tag1', 'tag2', 'tag3']
          }
        };
      }

      function App() {
        return React.createElement('View', {
          testID: 'container',
          data: largeData
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
      globalThis.__rill_emitEvent('RENDERED', { keyCount: Object.keys(largeData).length });
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 5000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container).toBeDefined();
    expect(Object.keys(container?.props.data || {}).length).toBe(1000);
    expect(container?.props.data?.key_500?.id).toBe(500);
  });

  it('should handle large array props', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const items = Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        value: Math.random()
      }));

      function App() {
        return React.createElement('View', {
          testID: 'container',
          items: items
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 5000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.items?.length).toBe(5000);
  });

  it('should handle deeply nested structures', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      // Create deeply nested object
      const createNested = (depth) => {
        if (depth === 0) return { value: 'leaf' };
        return { nested: createNested(depth - 1), depth };
      };

      const deepData = createNested(50);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          data: deepData
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 5000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.data?.depth).toBe(50);

    // Traverse to leaf
    let current = container?.props.data;
    let traversed = 0;
    while (current?.nested) {
      current = current.nested;
      traversed++;
    }
    expect(current?.value).toBe('leaf');
    expect(traversed).toBe(50);
  });
});

describe('E2E Stress: Concurrent Operations', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle many concurrent callback invocations', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      let callCount = 0;

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => {
            callCount++;
            return callCount;
          }
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');

    // Fire 100 concurrent callbacks
    const promises = Array.from({ length: 100 }, () => button?.props.onPress());

    const results = await Promise.all(promises);

    // All callbacks should have been called
    expect(results.length).toBe(100);
    // Results should be sequential (each callback increments counter)
    expect(results[results.length - 1]).toBe(100);
  });

  it('should handle rapid sequential updates', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(0);

        return React.createElement(
          'View',
          { testID: 'container', count },
          React.createElement('TouchableOpacity', {
            testID: 'increment',
            onPress: () => setCount(c => c + 1)
          })
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'increment');

    // Rapid fire 50 updates
    for (let i = 0; i < 50; i++) {
      await button?.props.onPress();
    }

    await wait(500);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.count).toBe(50);
  });
});

describe('E2E Stress: Large Component Trees', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle wide component tree', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const ITEM_COUNT = 100;

      function App() {
        const children = Array.from({ length: ITEM_COUNT }, (_, i) =>
          React.createElement('Text', { key: i, testID: 'item-' + i }, 'Item ' + i)
        );

        return React.createElement(
          'View',
          { testID: 'container' },
          ...children
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 50, 5000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container).toBeDefined();

    // Check some items exist
    expect(findNodeByTestId(ctx.receiver, 'item-0')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'item-50')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'item-99')).toBeDefined();
  });

  it('should handle deep component tree', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const MAX_DEPTH = 30;

      function Nested({ depth }) {
        if (depth >= MAX_DEPTH) {
          return React.createElement('Text', { testID: 'leaf-' + depth }, 'Leaf');
        }

        return React.createElement(
          'View',
          { testID: 'level-' + depth },
          React.createElement(Nested, { depth: depth + 1 })
        );
      }

      function App() {
        return React.createElement(Nested, { depth: 0 });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 5000);

    // Verify deep nesting
    expect(findNodeByTestId(ctx.receiver, 'level-0')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'level-15')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'level-29')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'leaf-30')).toBeDefined();
  });
});

describe('E2E Stress: Memory Pressure', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should clean up callbacks after component updates', async () => {
    const guestCode = `
      const React = require('react');
      const { useState, useCallback } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [version, setVersion] = useState(0);

        // Create new callback on each render
        const handlePress = useCallback(() => {
          return 'v' + version;
        }, [version]);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement('TouchableOpacity', {
            testID: 'button',
            onPress: handlePress
          }),
          React.createElement('TouchableOpacity', {
            testID: 'update',
            onPress: () => setVersion(v => v + 1)
          })
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialRegistrySize = ctx.engine.guestCallbackCount;

    // Trigger many updates
    const updateButton = findNodeByTestId(ctx.receiver, 'update');
    for (let i = 0; i < 20; i++) {
      await updateButton?.props.onPress();
      await wait(10);
    }

    await wait(200);

    const finalRegistrySize = ctx.engine.guestCallbackCount;

    // Registry size should not grow significantly (callbacks should be cleaned up)
    const growth = finalRegistrySize - initialRegistrySize;
    expect(growth).toBeLessThanOrEqual(5); // Allow small variance
  });

  it('should handle component mount/unmount cycles', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function Child({ id }) {
        return React.createElement('View', {
          testID: 'child-' + id,
          onLayout: () => console.log('Layout child ' + id)
        });
      }

      function App() {
        const [items, setItems] = useState([1, 2, 3]);

        const shuffle = () => {
          setItems(prev => {
            const shuffled = [...prev].sort(() => Math.random() - 0.5);
            // Add or remove random items
            if (Math.random() > 0.5 && prev.length < 10) {
              shuffled.push(Math.max(...prev) + 1);
            } else if (prev.length > 2) {
              shuffled.splice(Math.floor(Math.random() * shuffled.length), 1);
            }
            return shuffled;
          });
        };

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement('TouchableOpacity', {
            testID: 'shuffle',
            onPress: shuffle
          }),
          ...items.map(id =>
            React.createElement(Child, { key: id, id })
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialRegistrySize = ctx.engine.guestCallbackCount;

    // Trigger many shuffles (causes mounts/unmounts)
    const shuffleButton = findNodeByTestId(ctx.receiver, 'shuffle');
    for (let i = 0; i < 30; i++) {
      await shuffleButton?.props.onPress();
      await wait(20);
    }

    await wait(500);

    const finalRegistrySize = ctx.engine.guestCallbackCount;

    // Registry should not grow unboundedly
    const growth = finalRegistrySize - initialRegistrySize;
    expect(growth).toBeLessThan(20);
  });
});

describe('E2E Stress: Serialization Performance', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle large Map serialization', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const largeMap = new Map();
      for (let i = 0; i < 1000; i++) {
        largeMap.set('key_' + i, { value: i, data: 'x'.repeat(100) });
      }

      function App() {
        return React.createElement('View', {
          testID: 'container',
          data: largeMap
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    const startTime = Date.now();
    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 10000);
    const elapsed = Date.now() - startTime;

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.data).toBeInstanceOf(Map);
    expect(container?.props.data?.size).toBe(1000);

    // Should complete within reasonable time
    expect(elapsed).toBeLessThan(5000);
  });

  it('should handle large Set serialization', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const largeSet = new Set();
      for (let i = 0; i < 5000; i++) {
        largeSet.add('item_' + i);
      }

      function App() {
        return React.createElement('View', {
          testID: 'container',
          data: largeSet
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    const startTime = Date.now();
    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 10000);
    const elapsed = Date.now() - startTime;

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.data).toBeInstanceOf(Set);
    expect(container?.props.data?.size).toBe(5000);

    // Should complete within reasonable time
    expect(elapsed).toBeLessThan(5000);
  });
});
