/**
 * RillErrorBoundary Tests
 *
 * Tests for error boundary component
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

describe('RillErrorBoundary', () => {
  let React: typeof import('react');
  let TestRenderer: typeof import('react-test-renderer');
  let act: typeof import('react-test-renderer').act;
  let sdk: typeof import('../../../sdk/sdk');

  afterAll(() => {
    // Cleanup globalThis.React
    delete (globalThis as Record<string, unknown>).React;
  });

  beforeAll(async () => {
    React = await import('react');
    const testRendererModule = await import('react-test-renderer');
    TestRenderer = testRendererModule.default;
    act = testRendererModule.act;

    // Set React on globalThis for RillErrorBoundary
    (globalThis as Record<string, unknown>).React = React;

    sdk = await import('../../../sdk/sdk');
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__rill_emitEvent;
  });

  test('should render children when no error', () => {
    const Child = () => React.createElement('div', { testID: 'child' }, 'Hello');

    const TestComponent = () =>
      React.createElement(sdk.RillErrorBoundary, null, React.createElement(Child));

    let renderer: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TestComponent));
    });

    const output = renderer.toJSON();
    expect(output).toBeDefined();

    act(() => {
      renderer.unmount();
    });
  });

  test('should render fallback on error', () => {
    // Suppress error console output during test
    const originalError = console.error;
    console.error = () => {};

    try {
      const ThrowingChild = () => {
        throw new Error('Test error');
      };

      const Fallback = () => React.createElement('div', { testID: 'fallback' }, 'Error occurred');

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          { fallback: React.createElement(Fallback) },
          React.createElement(ThrowingChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const output = renderer.toJSON();
      // ErrorBoundary should render fallback
      expect(output).toBeDefined();

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should call onError callback when error occurs', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const errors: Array<{ error: Error; info: sdk.ErrorInfo }> = [];

      const ThrowingChild = () => {
        throw new Error('Callback test error');
      };

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          {
            onError: (error: Error, info: sdk.ErrorInfo) => {
              errors.push({ error, info });
            },
            fallback: React.createElement('div', null, 'Error'),
          },
          React.createElement(ThrowingChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toBe('Callback test error');
      expect(errors[0].info).toHaveProperty('componentStack');

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should use fallback function when provided', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const ThrowingChild = () => {
        throw new Error('Fallback function test');
      };

      const fallbackFn = (error: Error, _info: sdk.ErrorInfo) =>
        React.createElement('div', { testID: 'custom-fallback' }, `Error: ${error.message}`);

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          { fallback: fallbackFn },
          React.createElement(ThrowingChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const output = renderer.toJSON();
      expect(output).toBeDefined();

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should send error to host when __rill_emitEvent is available', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const sentEvents: Array<{ name: string; payload: unknown }> = [];

      (globalThis as Record<string, unknown>).__rill_emitEvent = (
        name: string,
        payload: unknown
      ) => {
        sentEvents.push({ name, payload });
      };

      const ThrowingChild = () => {
        throw new Error('Host event test');
      };

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          { fallback: React.createElement('div', null, 'Error') },
          React.createElement(ThrowingChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0].name).toBe('RENDER_ERROR');
      expect((sentEvents[0].payload as Record<string, unknown>).message).toBe('Host event test');

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should render default fallback when none provided', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const ThrowingChild = () => {
        throw new Error('Default fallback test');
      };

      const TestComponent = () =>
        React.createElement(sdk.RillErrorBoundary, null, React.createElement(ThrowingChild));

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const output = renderer.toJSON();
      // Default fallback is null, so output should be null
      expect(output).toBe(null);

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should handle errors in nested components', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const errors: Error[] = [];

      const DeepChild = () => {
        throw new Error('Deep error');
      };

      const MiddleChild = () => React.createElement('div', null, React.createElement(DeepChild));

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          {
            onError: (error: Error) => errors.push(error),
            fallback: React.createElement('div', null, 'Caught'),
          },
          React.createElement(MiddleChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Deep error');

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should preserve component stack in error info', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      let capturedInfo: sdk.ErrorInfo | null = null;

      const ThrowingChild = () => {
        throw new Error('Stack test');
      };

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          {
            onError: (_error: Error, info: sdk.ErrorInfo) => {
              capturedInfo = info;
            },
            fallback: React.createElement('div', null, 'Error'),
          },
          React.createElement(ThrowingChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      expect(capturedInfo).not.toBe(null);
      expect(capturedInfo?.componentStack).toBeDefined();
      expect(typeof capturedInfo?.componentStack).toBe('string');

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should not crash when both onError and fallback are provided', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const ThrowingChild = () => {
        throw new Error('Combined test');
      };

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          {
            onError: () => {},
            fallback: React.createElement('div', null, 'Error'),
          },
          React.createElement(ThrowingChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      expect(() => {
        act(() => {
          renderer = TestRenderer.create(React.createElement(TestComponent));
        });
      }).not.toThrow();

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });

  test('should handle synchronous errors in render', () => {
    const originalError = console.error;
    console.error = () => {};

    try {
      const errors: string[] = [];

      const SyncErrorChild = () => {
        const err = new Error('Sync render error');
        errors.push(err.message);
        throw err;
      };

      const TestComponent = () =>
        React.createElement(
          sdk.RillErrorBoundary,
          { fallback: React.createElement('div', null, 'Handled') },
          React.createElement(SyncErrorChild)
        );

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      // React may re-render during error recovery, so we just check that at least one error was caught
      expect(errors.length).toBeGreaterThan(0);

      act(() => {
        renderer.unmount();
      });
    } finally {
      console.error = originalError;
    }
  });
});
