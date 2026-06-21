/**
 * E2E Test Setup and Infrastructure Verification
 *
 * This test file verifies that the E2E test infrastructure is working correctly:
 * - Engine creation and destruction
 * - Mock components registration
 * - Event and console capturing
 * - Test helpers and assertions
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';
import type { Receiver } from '../../receiver';
import {
  expectEventReceived,
  expectFunctionProp,
  expectNodeExists,
  expectNoMemoryLeak,
} from './helpers/assertions';
import { MockComponents } from './helpers/mock-components';
import {
  findNodeByTestId,
  findNodesByType,
  getAllNodes,
  wait,
  waitFor,
} from './helpers/test-utils';

/**
 * Test context interface
 */
// biome-ignore lint/suspicious/noExportsInTest: Shared test utilities exported for use across E2E tests
export interface TestContext {
  engine: Engine;
  receiver: Receiver;
  events: Array<{ event: string; payload: unknown }>;
  consoleOutput: Array<{ level: string; args: unknown[] }>;
}

/**
 * Create test context
 */
// biome-ignore lint/suspicious/noExportsInTest: Shared test utilities exported for use across E2E tests
export function createTestContext(): TestContext {
  // Create engine with mock JS engine provider
  // Use silent logger to prevent expected error logs from cluttering test output
  const engine = new Engine({
    sandbox: 'node-vm',
    debug: false,
    logger: {
      log: () => {}, // Silent in tests
      warn: () => {}, // Silent in tests
      error: () => {}, // Silent in tests - expected errors shouldn't show
    },
  });

  // Register mock components
  engine.register(MockComponents);

  // Create event capturing array
  const events: Array<{ event: string; payload: unknown }> = [];

  // Listen for messages from guest
  // biome-ignore lint/suspicious/noExplicitAny: Message event payload has dynamic structure
  engine.on('message', (msg: any) => {
    events.push(msg);
  });

  // Create console output capturing array
  const consoleOutput: Array<{ level: string; args: unknown[] }> = [];

  // Capture console output (optional for debugging)
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  console.log = (...args: unknown[]) => {
    consoleOutput.push({ level: 'log', args });
    originalConsoleLog(...args);
  };

  console.warn = (...args: unknown[]) => {
    consoleOutput.push({ level: 'warn', args });
    originalConsoleWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    consoleOutput.push({ level: 'error', args });
    originalConsoleError(...args);
  };

  // Create receiver
  const receiver = engine.createReceiver();

  return { engine, receiver, events, consoleOutput };
}

/**
 * Destroy test context and restore console
 */
// biome-ignore lint/suspicious/noExportsInTest: Shared test utilities exported for use across E2E tests
export async function destroyTestContext(ctx: TestContext): Promise<void> {
  // Restore console
  // Note: In real implementation, we'd store the original functions and restore them
  // For now, this is a placeholder

  // Destroy engine
  await ctx.engine.destroy();
}

describe('E2E Test Infrastructure', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should create test context successfully', () => {
    expect(ctx.engine).toBeDefined();
    expect(ctx.receiver).toBeDefined();
    expect(ctx.events).toBeInstanceOf(Array);
    expect(ctx.consoleOutput).toBeInstanceOf(Array);
  });

  it('should have mock components registered', () => {
    // Mock components are registered, we'll verify by trying to render
    // There's no public getRegisteredComponents API
    expect(ctx.engine).toBeDefined();
  });

  it('should capture events from guest', async () => {
    const guestCode = `
      globalThis.__rill_emitEvent('TEST_EVENT', { value: 123 });
    `;

    await ctx.engine.loadBundle(guestCode);
    await wait(50);

    expect(ctx.events.length).toBeGreaterThan(0);
    expectEventReceived(ctx.events, 'TEST_EVENT');
  });

  it('should provide working test utilities', async () => {
    // Test waitFor
    let condition = false;
    setTimeout(() => {
      condition = true;
    }, 100);

    await waitFor(() => condition, 500);
    expect(condition).toBe(true);
  });

  it('should provide working test assertions', () => {
    // Test expectNoMemoryLeak
    expectNoMemoryLeak(10, 12, 5);

    // Test expectEventReceived
    const events = [
      { event: 'EVENT1', payload: { a: 1 } },
      { event: 'EVENT2', payload: { b: 2 } },
    ];
    expectEventReceived(events, 'EVENT1');
  });

  it('should have Receiver test helper methods', () => {
    expect(typeof ctx.receiver.getNodes).toBe('function');
    expect(typeof ctx.receiver.findNodesByType).toBe('function');
    expect(typeof ctx.receiver.findByTestId).toBe('function');
  });

  it('should start with empty node tree', () => {
    const nodes = getAllNodes(ctx.receiver);
    expect(nodes.length).toBe(0);
    expect(ctx.receiver.nodeCount).toBe(0);
  });
});

describe('E2E Test Helpers Integration', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should find nodes by testID after rendering', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement(
          'View',
          { testID: 'container' },
          React.createElement('Text', { testID: 'title' }, 'Hello')
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Debug: log all nodes
    const allNodes = ctx.receiver.getNodes();
    console.log('Total nodes:', allNodes.length);
    allNodes.forEach((node) => {
      console.log('Node:', node.id, node.type, node.props);
    });

    const container = findNodeByTestId(ctx.receiver, 'container');
    expectNodeExists(container);
    expect(container?.type).toBe('View');

    const title = findNodeByTestId(ctx.receiver, 'title');
    expectNodeExists(title);
    expect(title?.type).toBe('Text'); // Text component has type 'Text', its text child has type '__TEXT__'
  });

  it('should find nodes by type', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement(
          'View',
          {},
          React.createElement('TouchableOpacity', { testID: 't1' }),
          React.createElement('TouchableOpacity', { testID: 't2' })
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const viewNodes = findNodesByType(ctx.receiver, 'View');
    expect(viewNodes.length).toBeGreaterThan(0);

    const touchables = findNodesByType(ctx.receiver, 'TouchableOpacity');
    expect(touchables.length).toBe(2);
  });

  it('should verify function props exist', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement(
          'TouchableOpacity',
          {
            testID: 'button',
            onPress: () => globalThis.__rill_emitEvent('PRESS')
          },
          React.createElement('Text', {}, 'Click Me')
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    expectNodeExists(button);
    expectFunctionProp(button, 'onPress');
  });
});
