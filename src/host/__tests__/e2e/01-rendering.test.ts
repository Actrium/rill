/**
 * E2E Rendering Lifecycle Tests
 *
 * Tests the complete rendering flow:
 * - JSX → Reconciler → Bridge → Receiver → React Elements
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { expectEventReceived, expectNodeExists } from './helpers/assertions';
import { findNodeByTestId, getNodeText, simulatePress, wait, waitFor } from './helpers/test-utils';

describe('E2E Rendering: Basic Rendering', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should mount component and render initial UI', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement(
          'View',
          { testID: 'root' },
          React.createElement('Text', { testID: 'title' }, 'Hello World')
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const root = findNodeByTestId(ctx.receiver, 'root');
    expectNodeExists(root);
    expect(root?.type).toBe('View');

    const title = findNodeByTestId(ctx.receiver, 'title');
    expectNodeExists(title);
    expect(title?.type).toBe('Text');
    expect(getNodeText(ctx.receiver, title)).toContain('Hello World');
  });

  it('should update component on state change', async () => {
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
                setCount(count + 1);
                globalThis.__rill_emitEvent('PRESSED', { count: count + 1 });
              }
            },
            React.createElement('Text', { testID: 'counter' }, 'Count: ' + count)
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Verify initial state
    let counter = findNodeByTestId(ctx.receiver, 'counter');
    expectNodeExists(counter);
    expect(getNodeText(ctx.receiver, counter)).toContain('Count: 0');

    // Trigger state update
    const button = findNodeByTestId(ctx.receiver, 'button');
    expectNodeExists(button);
    await simulatePress(button);
    await wait(100);

    // Verify updated state
    counter = findNodeByTestId(ctx.receiver, 'counter');
    expect(getNodeText(ctx.receiver, counter)).toContain('Count: 1');

    // Verify event was sent
    // biome-ignore lint/suspicious/noExplicitAny: Test event payload validation with dynamic structure
    expectEventReceived(ctx.events, 'PRESSED', (payload: any) => payload.count === 1);
  });

  it('should unmount and clean up', async () => {
    const guestCode = `
      const React = require('react');
      const { render, unmount } = require('rill/reconciler');

      function App() {
        return React.createElement(
          'TouchableOpacity',
          {
            testID: 'button',
            onPress: () => globalThis.__rill_emitEvent('CLICK')
          },
          React.createElement('Text', {}, 'Button')
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);

      // Expose unmount function
      globalThis.__unmountApp = () => {
        unmount(globalThis.__rill_sendBatch);
      };
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const initialSize = ctx.engine.guestCallbackCount;
    expect(initialSize).toBeGreaterThan(0);

    // Unmount the app
    await ctx.engine.context?.extract('__unmountApp')?.();
    await wait(100);

    // Verify cleanup
    expect(ctx.receiver.nodeCount).toBe(0);
  });
});

describe('E2E Rendering: Conditional Rendering', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle conditional rendering', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [visible, setVisible] = useState(false);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'toggle',
              onPress: () => setVisible(!visible)
            },
            React.createElement('Text', {}, 'Toggle')
          ),
          visible && React.createElement('Text', { testID: 'message' }, 'I am visible!')
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Initially not visible
    let message = findNodeByTestId(ctx.receiver, 'message');
    expect(message).toBeUndefined();

    // Toggle visibility
    const toggle = findNodeByTestId(ctx.receiver, 'toggle');
    expectNodeExists(toggle);
    await simulatePress(toggle);
    await wait(100);

    // Now visible
    message = findNodeByTestId(ctx.receiver, 'message');
    expectNodeExists(message);
    expect(getNodeText(ctx.receiver, message)).toContain('I am visible!');

    // Toggle again to hide
    await simulatePress(toggle);
    await wait(100);

    // Hidden again
    message = findNodeByTestId(ctx.receiver, 'message');
    expect(message).toBeUndefined();
  });
});

describe('E2E Rendering: List Rendering', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should render lists of items', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const items = [
        { id: 1, text: 'Item 1' },
        { id: 2, text: 'Item 2' },
        { id: 3, text: 'Item 3' },
      ];

      function App() {
        return React.createElement(
          'View',
          { testID: 'container' },
          ...items.map(item =>
            React.createElement(
              'View',
              { key: item.id, testID: 'item-' + item.id },
              React.createElement('Text', {}, item.text)
            )
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const item1 = findNodeByTestId(ctx.receiver, 'item-1');
    const item2 = findNodeByTestId(ctx.receiver, 'item-2');
    const item3 = findNodeByTestId(ctx.receiver, 'item-3');

    expectNodeExists(item1);
    expectNodeExists(item2);
    expectNodeExists(item3);

    expect(ctx.receiver.nodeCount).toBeGreaterThan(6); // container + 3 items + 3 texts
  });

  it('should update list dynamically', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [items, setItems] = useState([1, 2, 3]);

        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement(
            'TouchableOpacity',
            {
              testID: 'add-button',
              onPress: () => setItems([...items, items.length + 1])
            },
            React.createElement('Text', {}, 'Add Item')
          ),
          ...items.map(item =>
            React.createElement(
              'View',
              { key: item, testID: 'item-' + item },
              React.createElement('Text', {}, 'Item ' + item)
            )
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Initially 3 items
    expect(findNodeByTestId(ctx.receiver, 'item-1')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'item-2')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'item-3')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'item-4')).toBeUndefined();

    // Add an item
    const addButton = findNodeByTestId(ctx.receiver, 'add-button');
    expectNodeExists(addButton);
    await simulatePress(addButton);
    await wait(100);

    // Now 4 items
    expect(findNodeByTestId(ctx.receiver, 'item-4')).toBeDefined();
  });
});

describe('E2E Rendering: Deep Nesting', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle deeply nested components', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function Nested({ depth, maxDepth }) {
        if (depth >= maxDepth) {
          return React.createElement('Text', { testID: 'leaf' }, 'Leaf at depth ' + depth);
        }

        return React.createElement(
          'View',
          { testID: 'level-' + depth },
          React.createElement(Nested, { depth: depth + 1, maxDepth })
        );
      }

      function App() {
        return React.createElement(Nested, { depth: 0, maxDepth: 10 });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Verify deep nesting
    const level0 = findNodeByTestId(ctx.receiver, 'level-0');
    const level5 = findNodeByTestId(ctx.receiver, 'level-5');
    const level9 = findNodeByTestId(ctx.receiver, 'level-9');
    const leaf = findNodeByTestId(ctx.receiver, 'leaf');

    expectNodeExists(level0);
    expectNodeExists(level5);
    expectNodeExists(level9);
    expectNodeExists(leaf);

    expect(getNodeText(ctx.receiver, leaf)).toContain('Leaf at depth 10');
    expect(ctx.receiver.nodeCount).toBe(12); // 10 Views + 1 Text + 1 __TEXT__
  });
});
