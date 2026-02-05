/**
 * E2E Map/Set Serialization Tests
 *
 * Tests Map and Set serialization across the boundary:
 * - Simple Map/Set with primitives
 * - Nested Map/Set
 * - Map/Set with complex values
 * - Map/Set in callbacks
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { findNodeByTestId, wait, waitFor } from './helpers/test-utils';

describe('E2E Map Serialization: Basic', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should serialize Map with primitive keys and values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const config = new Map([
        ['theme', 'dark'],
        ['locale', 'zh-CN'],
        ['fontSize', 14]
      ]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          config: config
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    expect(container).toBeDefined();

    const config = container?.props.config;
    expect(config).toBeInstanceOf(Map);
    expect(config?.get('theme')).toBe('dark');
    expect(config?.get('locale')).toBe('zh-CN');
    expect(config?.get('fontSize')).toBe(14);
    expect(config?.size).toBe(3);
  });

  it('should serialize Map with number keys', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const scores = new Map([
        [1, 100],
        [2, 85],
        [3, 92]
      ]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          scores: scores
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const scores = container?.props.scores;

    expect(scores).toBeInstanceOf(Map);
    expect(scores?.get(1)).toBe(100);
    expect(scores?.get(2)).toBe(85);
    expect(scores?.get(3)).toBe(92);
  });

  it('should serialize Map with object values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const users = new Map([
        ['user1', { name: 'Alice', age: 25 }],
        ['user2', { name: 'Bob', age: 30 }]
      ]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          users: users
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const users = container?.props.users;

    expect(users).toBeInstanceOf(Map);
    expect(users?.get('user1')).toEqual({ name: 'Alice', age: 25 });
    expect(users?.get('user2')).toEqual({ name: 'Bob', age: 30 });
  });
});

describe('E2E Set Serialization: Basic', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should serialize Set with primitive values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const tags = new Set(['urgent', 'important', 'reviewed']);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          tags: tags
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const tags = container?.props.tags;

    expect(tags).toBeInstanceOf(Set);
    expect(tags?.has('urgent')).toBe(true);
    expect(tags?.has('important')).toBe(true);
    expect(tags?.has('reviewed')).toBe(true);
    expect(tags?.has('unknown')).toBe(false);
    expect(tags?.size).toBe(3);
  });

  it('should serialize Set with number values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const ids = new Set([1, 2, 3, 5, 8, 13]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          ids: ids
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const ids = container?.props.ids;

    expect(ids).toBeInstanceOf(Set);
    expect(ids?.has(1)).toBe(true);
    expect(ids?.has(5)).toBe(true);
    expect(ids?.has(13)).toBe(true);
    expect(ids?.has(4)).toBe(false);
    expect(ids?.size).toBe(6);
  });
});

describe('E2E Map/Set Serialization: Nested Structures', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should serialize nested Map within object', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const data = {
        metadata: {
          settings: new Map([
            ['darkMode', true],
            ['notifications', false]
          ])
        },
        version: '1.0.0'
      };

      function App() {
        return React.createElement('View', {
          testID: 'container',
          data: data
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const data = container?.props.data;

    expect(data?.version).toBe('1.0.0');
    expect(data?.metadata?.settings).toBeInstanceOf(Map);
    expect(data?.metadata?.settings?.get('darkMode')).toBe(true);
    expect(data?.metadata?.settings?.get('notifications')).toBe(false);
  });

  it('should serialize Map with Set values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const permissions = new Map([
        ['admin', new Set(['read', 'write', 'delete'])],
        ['user', new Set(['read'])]
      ]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          permissions: permissions
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const permissions = container?.props.permissions;

    expect(permissions).toBeInstanceOf(Map);

    const adminPerms = permissions?.get('admin');
    expect(adminPerms).toBeInstanceOf(Set);
    expect(adminPerms?.has('read')).toBe(true);
    expect(adminPerms?.has('write')).toBe(true);
    expect(adminPerms?.has('delete')).toBe(true);

    const userPerms = permissions?.get('user');
    expect(userPerms).toBeInstanceOf(Set);
    expect(userPerms?.has('read')).toBe(true);
    expect(userPerms?.has('write')).toBe(false);
  });

  it('should serialize Set with array values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const coords = new Set([
        [0, 0],
        [1, 1],
        [2, 2]
      ]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          coords: coords
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const coords = container?.props.coords;

    expect(coords).toBeInstanceOf(Set);
    expect(coords?.size).toBe(3);

    // Convert to array to check values
    const coordsArray = Array.from(coords as Set<number[]>);
    expect(coordsArray).toContainEqual([0, 0]);
    expect(coordsArray).toContainEqual([1, 1]);
    expect(coordsArray).toContainEqual([2, 2]);
  });
});

describe('E2E Map/Set Serialization: With Functions', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should serialize Map with function values', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      const handlers = new Map([
        ['onClick', () => globalThis.__rill_emitEvent('CLICK')],
        ['onHover', () => globalThis.__rill_emitEvent('HOVER')]
      ]);

      function App() {
        return React.createElement('View', {
          testID: 'container',
          handlers: handlers
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    const handlers = container?.props.handlers;

    expect(handlers).toBeInstanceOf(Map);

    const onClick = handlers?.get('onClick');
    const onHover = handlers?.get('onHover');

    expect(typeof onClick).toBe('function');
    expect(typeof onHover).toBe('function');

    // Invoke the functions
    await onClick?.();
    await wait(50);
    expect(ctx.events.some((e) => e.event === 'CLICK')).toBe(true);

    await onHover?.();
    await wait(50);
    expect(ctx.events.some((e) => e.event === 'HOVER')).toBe(true);
  });
});

describe('E2E Map/Set Serialization: Dynamic Updates', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should handle Map updates via state', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [items, setItems] = useState(new Map([['a', 1]]));

        const addItem = () => {
          const newItems = new Map(items);
          newItems.set('b', 2);
          setItems(newItems);
          globalThis.__rill_emitEvent('ITEM_ADDED', { size: newItems.size });
        };

        return React.createElement(
          'View',
          { testID: 'container', items: items },
          React.createElement('TouchableOpacity', {
            testID: 'add-button',
            onPress: addItem
          })
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Initial state
    let container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.items?.size).toBe(1);
    expect(container?.props.items?.get('a')).toBe(1);

    // Add item
    const addButton = findNodeByTestId(ctx.receiver, 'add-button');
    await addButton?.props.onPress();
    await wait(100);

    // Updated state
    container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.items?.size).toBe(2);
    expect(container?.props.items?.get('b')).toBe(2);
  });

  it('should handle Set updates via state', async () => {
    const guestCode = `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [selectedIds, setSelectedIds] = useState(new Set([1]));

        const toggleId = (id) => {
          const newSet = new Set(selectedIds);
          if (newSet.has(id)) {
            newSet.delete(id);
          } else {
            newSet.add(id);
          }
          setSelectedIds(newSet);
          globalThis.__rill_emitEvent('SELECTION_CHANGED', {
            size: newSet.size,
            selected: Array.from(newSet)
          });
        };

        return React.createElement(
          'View',
          { testID: 'container', selectedIds: selectedIds },
          React.createElement('TouchableOpacity', {
            testID: 'toggle-2',
            onPress: () => toggleId(2)
          }),
          React.createElement('TouchableOpacity', {
            testID: 'toggle-1',
            onPress: () => toggleId(1)
          })
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Initial state
    let container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.selectedIds?.has(1)).toBe(true);
    expect(container?.props.selectedIds?.size).toBe(1);

    // Add id 2
    const toggle2 = findNodeByTestId(ctx.receiver, 'toggle-2');
    await toggle2?.props.onPress();
    await wait(100);

    container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.selectedIds?.has(1)).toBe(true);
    expect(container?.props.selectedIds?.has(2)).toBe(true);
    expect(container?.props.selectedIds?.size).toBe(2);

    // Remove id 1
    const toggle1 = findNodeByTestId(ctx.receiver, 'toggle-1');
    await toggle1?.props.onPress();
    await wait(100);

    container = findNodeByTestId(ctx.receiver, 'container');
    expect(container?.props.selectedIds?.has(1)).toBe(false);
    expect(container?.props.selectedIds?.has(2)).toBe(true);
    expect(container?.props.selectedIds?.size).toBe(1);
  });
});
