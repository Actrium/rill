/**
 * E2E Callback Return Value Tests
 *
 * Tests that callback return values are properly passed back to Host:
 * - Primitive return values
 * - Object return values
 * - Async return values
 * - Complex type return values (Date, Error, Map, Set)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { findNodeByTestId, waitFor } from './helpers/test-utils';

describe('E2E Callback Returns: Primitives', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should return string from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => 'hello world'
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toBe('hello world');
  });

  it('should return number from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => 42
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toBe(42);
  });

  it('should return boolean from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => true
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toBe(true);
  });

  it('should return null from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => null
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toBe(null);
  });

  it('should return undefined from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => undefined
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toBe(undefined);
  });
});

describe('E2E Callback Returns: Objects', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should return plain object from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => ({
            success: true,
            data: { id: 123, name: 'Test' }
          })
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toEqual({
      success: true,
      data: { id: 123, name: 'Test' },
    });
  });

  it('should return array from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => [1, 2, 3, { nested: true }]
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result).toEqual([1, 2, 3, { nested: true }]);
  });

  it('should return deeply nested object from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => ({
            level1: {
              level2: {
                level3: {
                  level4: {
                    value: 'deep'
                  }
                }
              }
            }
          })
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result?.level1?.level2?.level3?.level4?.value).toBe('deep');
  });
});

describe('E2E Callback Returns: Complex Types', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should return Date from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => new Date('2024-06-15T10:30:00Z')
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    // Cross-VM boundary: instanceof may fail, verify behavior instead
    expect(typeof (result as Date).toISOString).toBe('function');
    expect((result as Date).toISOString()).toBe('2024-06-15T10:30:00.000Z');
  });

  it('should return Map from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => new Map([['a', 1], ['b', 2]])
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    // Cross-VM boundary: instanceof may fail, verify behavior instead
    expect(typeof (result as Map<string, number>).get).toBe('function');
    expect((result as Map<string, number>).get('a')).toBe(1);
    expect((result as Map<string, number>).get('b')).toBe(2);
  });

  it('should return Set from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => new Set(['x', 'y', 'z'])
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    // Cross-VM boundary: instanceof may fail, verify behavior instead
    expect(typeof (result as Set<string>).has).toBe('function');
    expect((result as Set<string>).has('x')).toBe(true);
    expect((result as Set<string>).has('y')).toBe(true);
    expect((result as Set<string>).has('z')).toBe(true);
  });

  it('should return RegExp from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: () => /^test[0-9]+$/i
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    // Cross-VM boundary: instanceof may fail, verify behavior instead
    expect(typeof (result as RegExp).test).toBe('function');
    expect((result as RegExp).test('Test123')).toBe(true);
    expect((result as RegExp).test('invalid')).toBe(false);
  });
});

describe('E2E Callback Returns: Async', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should return resolved promise value from async callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        return React.createElement('TouchableOpacity', {
          testID: 'button',
          onPress: async () => {
            await new Promise(r => setTimeout(r, 50));
            return { processed: true, timestamp: Date.now() };
          }
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const button = findNodeByTestId(ctx.receiver, 'button');
    const result = await button?.props.onPress();

    expect(result?.processed).toBe(true);
    expect(typeof result?.timestamp).toBe('number');
  });

  it('should handle callback that computes return value', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        const processData = (input) => {
          return {
            original: input,
            uppercase: input.toUpperCase(),
            length: input.length,
            reversed: input.split('').reverse().join('')
          };
        };

        return React.createElement('TextInput', {
          testID: 'input',
          onSubmitEditing: (text) => processData(text)
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const input = findNodeByTestId(ctx.receiver, 'input');
    const result = await input?.props.onSubmitEditing('hello');

    expect(result).toEqual({
      original: 'hello',
      uppercase: 'HELLO',
      length: 5,
      reversed: 'olleh',
    });
  });
});

describe('E2E Callback Returns: Form Validation Pattern', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should return validation result from form submit callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        const validateAndSubmit = async (formData) => {
          // Simulate validation
          const errors = [];

          if (!formData.email?.includes('@')) {
            errors.push({ field: 'email', message: 'Invalid email format' });
          }

          if (formData.password?.length < 8) {
            errors.push({ field: 'password', message: 'Password too short' });
          }

          if (errors.length > 0) {
            return { success: false, errors };
          }

          // Simulate async submission
          await new Promise(r => setTimeout(r, 20));

          return {
            success: true,
            userId: 'user_' + Date.now()
          };
        };

        return React.createElement('View', {
          testID: 'form',
          onSubmit: validateAndSubmit
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const form = findNodeByTestId(ctx.receiver, 'form');

    // Test invalid form data
    const invalidResult = await form?.props.onSubmit({
      email: 'invalid',
      password: '123',
    });

    expect(invalidResult?.success).toBe(false);
    expect(invalidResult?.errors).toHaveLength(2);
    expect(invalidResult?.errors[0].field).toBe('email');
    expect(invalidResult?.errors[1].field).toBe('password');

    // Test valid form data
    const validResult = await form?.props.onSubmit({
      email: 'test@example.com',
      password: 'securePassword123',
    });

    expect(validResult?.success).toBe(true);
    expect(validResult?.userId).toMatch(/^user_\d+$/);
  });

  it('should return data transformation result from callback', async () => {
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        const transformItems = (items) => {
          const transformed = items.map(item => ({
            ...item,
            displayName: item.firstName + ' ' + item.lastName,
            initials: item.firstName[0] + item.lastName[0]
          }));

          return {
            items: transformed,
            count: transformed.length,
            summary: new Map(transformed.map(t => [t.id, t.displayName]))
          };
        };

        return React.createElement('View', {
          testID: 'transformer',
          onTransform: transformItems
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const transformer = findNodeByTestId(ctx.receiver, 'transformer');
    const result = await transformer?.props.onTransform([
      { id: 1, firstName: 'John', lastName: 'Doe' },
      { id: 2, firstName: 'Jane', lastName: 'Smith' },
    ]);

    expect(result?.count).toBe(2);
    expect(result?.items[0].displayName).toBe('John Doe');
    expect(result?.items[0].initials).toBe('JD');
    expect(result?.items[1].displayName).toBe('Jane Smith');
    // Cross-VM boundary: instanceof may fail, verify behavior instead
    expect(typeof result?.summary.get).toBe('function');
    expect(result?.summary.get(1)).toBe('John Doe');
    expect(result?.summary.get(2)).toBe('Jane Smith');
  });
});
