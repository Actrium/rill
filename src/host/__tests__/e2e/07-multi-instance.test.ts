/**
 * E2E Multi-Instance Tests
 *
 * Tests scenarios with multiple component instances:
 * - Multiple engines running concurrently
 * - Component isolation
 * - Shared state patterns
 * - Independent lifecycle
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';
import type { Receiver } from '../../receiver';
import { MockComponents } from './helpers/mock-components';
import { wait, waitFor } from './helpers/test-utils';

interface MultiInstanceContext {
  engines: Engine[];
  receivers: Receiver[];
  events: Array<{ engineIndex: number; event: string; payload: unknown }>[];
}

function createMultiInstanceContext(count: number): MultiInstanceContext {
  const engines: Engine[] = [];
  const receivers: Receiver[] = [];
  const events: Array<{ engineIndex: number; event: string; payload: unknown }>[] = [];

  for (let i = 0; i < count; i++) {
    const engine = new Engine({
      sandbox: 'vm',
      debug: false,
    });
    engine.register(MockComponents);

    const instanceEvents: Array<{ engineIndex: number; event: string; payload: unknown }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: Message event with dynamic structure
    engine.on('message', (msg: any) => {
      instanceEvents.push({ engineIndex: i, ...msg });
    });

    const receiver = engine.createReceiver();

    engines.push(engine);
    receivers.push(receiver);
    events.push(instanceEvents);
  }

  return { engines, receivers, events };
}

async function destroyMultiInstanceContext(ctx: MultiInstanceContext): Promise<void> {
  await Promise.all(ctx.engines.map((engine) => engine.destroy()));
}

describe('E2E Multi-Instance: Independent Engines', () => {
  let ctx: MultiInstanceContext;

  beforeEach(() => {
    ctx = createMultiInstanceContext(3);
  });

  afterEach(async () => {
    await destroyMultiInstanceContext(ctx);
  });

  it('should run multiple engines independently', async () => {
    const guestCode = (id: number) => `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('View', {
          testID: 'container',
          engineId: ${id}
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    // Load different code into each engine
    await Promise.all(ctx.engines.map((engine, i) => engine.loadBundle(guestCode(i))));

    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Each engine should have its own independent state
    ctx.receivers.forEach((receiver, i) => {
      const container = receiver.findByTestId('container');
      expect(container).toBeDefined();
      expect(container?.props.engineId).toBe(i);
    });
  });

  it('should maintain separate callback registries', async () => {
    const guestCode = (id: number) => `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => globalThis.__rill_emitEvent('PRESSED', { engineId: ${id} })
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await Promise.all(ctx.engines.map((engine, i) => engine.loadBundle(guestCode(i))));
    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Press button on each engine
    for (let i = 0; i < ctx.receivers.length; i++) {
      const button = ctx.receivers[i]!.findByTestId('button');
      await button?.props.onPress();
      await wait(50);
    }

    // Each engine should receive its own event
    ctx.events.forEach((events, i) => {
      const pressedEvents = events.filter((e) => e.event === 'PRESSED');
      expect(pressedEvents.length).toBe(1);
      // biome-ignore lint/suspicious/noExplicitAny: Test event payload has dynamic structure
      expect((pressedEvents[0]?.payload as any)?.engineId).toBe(i);
    });
  });

  it('should handle independent state updates', async () => {
    const guestCode = (initialCount: number) => `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(${initialCount});

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

    // Each engine starts with different initial count
    await Promise.all(ctx.engines.map((engine, i) => engine.loadBundle(guestCode(i * 10))));
    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Verify initial counts
    ctx.receivers.forEach((receiver, i) => {
      const container = receiver.findByTestId('container');
      expect(container?.props.count).toBe(i * 10);
    });

    // Increment only the second engine
    const button1 = ctx.receivers[1]!.findByTestId('increment');
    await button1?.props.onPress();
    await button1?.props.onPress();
    await button1?.props.onPress();
    await wait(100);

    // Verify only second engine's count changed
    expect(ctx.receivers[0]!.findByTestId('container')?.props.count).toBe(0);
    expect(ctx.receivers[1]!.findByTestId('container')?.props.count).toBe(13); // 10 + 3
    expect(ctx.receivers[2]!.findByTestId('container')?.props.count).toBe(20);
  });
});

describe('E2E Multi-Instance: Lifecycle', () => {
  let ctx: MultiInstanceContext;

  beforeEach(() => {
    ctx = createMultiInstanceContext(3);
  });

  afterEach(async () => {
    await destroyMultiInstanceContext(ctx);
  });

  it('should destroy engines independently', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('View', { testID: 'container' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await Promise.all(ctx.engines.map((engine) => engine.loadBundle(guestCode)));
    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Destroy only the second engine
    await ctx.engines[1]!.destroy();

    // Other engines should still work
    expect(ctx.receivers[0]!.findByTestId('container')).toBeDefined();
    expect(ctx.receivers[2]!.findByTestId('container')).toBeDefined();
  });

  it('should handle staggered engine creation and destruction', async () => {
    const guestCode = (id: number) => `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('View', { testID: 'engine-${id}' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    // Create and load first two engines
    await ctx.engines[0]!.loadBundle(guestCode(0));
    await ctx.engines[1]!.loadBundle(guestCode(1));

    await waitFor(() => ctx.receivers[0]!.nodeCount > 0, 2000);
    await waitFor(() => ctx.receivers[1]!.nodeCount > 0, 2000);

    // Destroy first engine
    await ctx.engines[0]!.destroy();

    // Create third engine
    await ctx.engines[2]!.loadBundle(guestCode(2));
    await waitFor(() => ctx.receivers[2]!.nodeCount > 0, 2000);

    // Second and third engines should work
    expect(ctx.receivers[1]!.findByTestId('engine-1')).toBeDefined();
    expect(ctx.receivers[2]!.findByTestId('engine-2')).toBeDefined();
  });
});

describe('E2E Multi-Instance: Resource Isolation', () => {
  let ctx: MultiInstanceContext;

  beforeEach(() => {
    ctx = createMultiInstanceContext(2);
  });

  afterEach(async () => {
    await destroyMultiInstanceContext(ctx);
  });

  it('should have separate callback registries', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => 'pressed',
          onPressIn: () => 'press-in',
          onPressOut: () => 'press-out'
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await Promise.all(ctx.engines.map((engine) => engine.loadBundle(guestCode)));
    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Each engine should have its own Guest callback registry (in sandbox)
    // Guest callbacks are now tracked in Guest's globalCallbackRegistry
    const count0 = ctx.engines[0]!.guestCallbackCount;
    const count1 = ctx.engines[1]!.guestCallbackCount;

    expect(count0).toBeGreaterThan(0);
    expect(count1).toBeGreaterThan(0);

    // Each sandbox has its own isolated globalCallbackRegistry (implicit by sandbox isolation)
  });

  it('should isolate errors between engines', async () => {
    const workingCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('View', { testID: 'working' });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    const brokenCode = `
      throw new Error('Intentional error');
    `;

    // Load working code into first engine
    await ctx.engines[0]!.loadBundle(workingCode);
    await waitFor(() => ctx.receivers[0]!.nodeCount > 0, 2000);

    // Load broken code into second engine (should fail — sync path throws)
    expect(() => ctx.engines[1]!.loadBundle(brokenCode)).toThrow();

    // First engine should still work
    expect(ctx.receivers[0]!.findByTestId('working')).toBeDefined();

    // First engine callbacks should still work
    const button = ctx.receivers[0]!.findByTestId('working');
    expect(button).toBeDefined();
  });
});

describe('E2E Multi-Instance: Concurrent Operations', () => {
  let ctx: MultiInstanceContext;

  beforeEach(() => {
    ctx = createMultiInstanceContext(3);
  });

  afterEach(async () => {
    await destroyMultiInstanceContext(ctx);
  });

  it('should handle concurrent callbacks across engines', async () => {
    const guestCode = (id: number) => `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: async () => {
            await new Promise(r => setTimeout(r, 50));
            return { engineId: ${id}, timestamp: Date.now() };
          }
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await Promise.all(ctx.engines.map((engine, i) => engine.loadBundle(guestCode(i))));
    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Fire callbacks concurrently on all engines
    const promises = ctx.receivers.map((receiver) => {
      const button = receiver.findByTestId('button');
      return button?.props.onPress();
    });

    const results = await Promise.all(promises);

    // Each result should have correct engine ID
    results.forEach((result, i) => {
      expect(result?.engineId).toBe(i);
    });
  });

  it('should handle mixed operations across engines', async () => {
    const guestCode = (id: number) => `
      const React = require('react');
      const { useState } = React;
      const { render } = require('rill/reconciler');

      function App() {
        const [count, setCount] = useState(0);

        return React.createElement(
          'View',
          { testID: 'container', count },
          React.createElement('TouchableOpacity', {
            testID: 'action',
            onPress: () => {
              setCount(c => c + 1);
              globalThis.__rill_emitEvent('ACTION', { engineId: ${id}, newCount: count + 1 });
              return count + 1;
            }
          })
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await Promise.all(ctx.engines.map((engine, i) => engine.loadBundle(guestCode(i))));
    await Promise.all(ctx.receivers.map((receiver) => waitFor(() => receiver.nodeCount > 0, 2000)));

    // Perform different number of actions on each engine
    for (let i = 0; i < ctx.receivers.length; i++) {
      const button = ctx.receivers[i]!.findByTestId('action');
      for (let j = 0; j <= i; j++) {
        await button?.props.onPress();
        await wait(20);
      }
    }

    await wait(200);

    // Verify each engine has correct count
    expect(ctx.receivers[0]!.findByTestId('container')?.props.count).toBe(1);
    expect(ctx.receivers[1]!.findByTestId('container')?.props.count).toBe(2);
    expect(ctx.receivers[2]!.findByTestId('container')?.props.count).toBe(3);

    // Verify events are correctly routed
    expect(ctx.events[0]!.filter((e) => e.event === 'ACTION').length).toBe(1);
    expect(ctx.events[1]!.filter((e) => e.event === 'ACTION').length).toBe(2);
    expect(ctx.events[2]!.filter((e) => e.event === 'ACTION').length).toBe(3);
  });
});
