import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('RillErrorBoundary', () => {
  let React: typeof import('react');
  let RillErrorBoundary: typeof import('../../../sdk/sdk').RillErrorBoundary;

  afterAll(() => {
    // Cleanup globalThis.React
    delete (globalThis as Record<string, unknown>).React;
  });

  beforeAll(async () => {
    React = await import('react');
    // Set React on globalThis for RillErrorBoundary
    (globalThis as Record<string, unknown>).React = React;
    const sdk = await import('../../../sdk/sdk');
    RillErrorBoundary = sdk.RillErrorBoundary;
  });

  describe('getDerivedStateFromError', () => {
    it('should return state with hasError=true and captured error', () => {
      const error = new Error('Test error');
      const newState = RillErrorBoundary.getDerivedStateFromError(error);

      expect(newState).toEqual({
        hasError: true,
        error,
      });
    });

    it('should work with TypeError', () => {
      const error = new TypeError('Type error');
      const newState = RillErrorBoundary.getDerivedStateFromError(error);

      expect(newState.hasError).toBe(true);
      expect(newState.error).toBe(error);
    });

    it('should work with generic Error', () => {
      const error = new Error('Generic error');
      const newState = RillErrorBoundary.getDerivedStateFromError(error);

      expect(newState.hasError).toBe(true);
      expect(newState.error instanceof Error).toBe(true);
      expect(newState.error.message).toBe('Generic error');
    });
  });

  describe('component instance behavior', () => {
    it('should exist as a class', () => {
      expect(typeof RillErrorBoundary).toBe('function');
      expect(RillErrorBoundary.name).toBe('RillErrorBoundary');
    });

    it('should have getDerivedStateFromError as static method', () => {
      expect(typeof RillErrorBoundary.getDerivedStateFromError).toBe('function');
    });

    it('should have componentDidCatch in prototype', () => {
      expect(typeof RillErrorBoundary.prototype.componentDidCatch).toBe('function');
    });

    it('should have render in prototype', () => {
      expect(typeof RillErrorBoundary.prototype.render).toBe('function');
    });
  });

  describe('componentDidCatch error info handling', () => {
    let originalSendToHost: unknown;

    beforeEach(() => {
      const g = globalThis as Record<string, unknown>;
      originalSendToHost = g.__rill_emitEvent;
    });

    afterEach(() => {
      const g = globalThis as Record<string, unknown>;
      if (originalSendToHost !== undefined) {
        g.__rill_emitEvent = originalSendToHost;
      } else {
        delete g.__rill_emitEvent;
      }
    });

    it('should send RENDER_ERROR event when __rill_emitEvent exists', () => {
      const sentEvents: Array<{ name: string; payload: unknown }> = [];

      const g = globalThis as Record<string, unknown>;
      g.__rill_emitEvent = (name: string, payload: unknown) => {
        sentEvents.push({ name, payload });
      };

      // Create a mock instance with minimal mocking
      const mockInstance = {
        props: {
          children: 'Hello',
          onError: undefined as
            | ((error: Error, errorInfo: { componentStack: string }) => void)
            | undefined,
        },
        state: {
          hasError: false,
          error: null,
          errorInfo: null,
        },
        setState(newState: Partial<typeof mockInstance.state>) {
          Object.assign(mockInstance.state, newState);
        },
      };

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n  at Component';
      const errorInfo = { componentStack: 'at Component\n  at Parent' };

      // Call componentDidCatch with mock context
      RillErrorBoundary.prototype.componentDidCatch.call(mockInstance, error, errorInfo);

      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0].name).toBe('RENDER_ERROR');
      expect(sentEvents[0].payload).toEqual({
        message: 'Test error',
        stack: 'Error: Test error\n  at Component',
        componentStack: 'at Component\n  at Parent',
      });

      // State should be updated
      expect(mockInstance.state.errorInfo).toEqual({
        componentStack: 'at Component\n  at Parent',
      });
    });

    it('should call onError prop if provided', () => {
      let capturedError: Error | null = null;
      let capturedInfo: { componentStack: string } | null = null;

      const mockInstance = {
        props: {
          children: 'Hello',
          onError: (err: Error, info: { componentStack: string }) => {
            capturedError = err;
            capturedInfo = info;
          },
        },
        state: {
          hasError: false,
          error: null,
          errorInfo: null,
        },
        setState(newState: Partial<typeof mockInstance.state>) {
          Object.assign(mockInstance.state, newState);
        },
      };

      const error = new Error('Callback test');
      const errorInfo = { componentStack: 'at TestComponent' };

      RillErrorBoundary.prototype.componentDidCatch.call(mockInstance, error, errorInfo);

      expect(capturedError).toBe(error);
      expect(capturedInfo).toEqual({ componentStack: 'at TestComponent' });
    });

    it('should not crash when __rill_emitEvent is not present', () => {
      const g = globalThis as Record<string, unknown>;
      delete g.__rill_emitEvent;

      const mockInstance = {
        props: { children: 'Hello', onError: undefined },
        state: { hasError: false, error: null, errorInfo: null },
        setState(_newState: unknown) {},
      };

      const error = new Error('No host');
      const errorInfo = { componentStack: 'at Component' };

      expect(() => {
        RillErrorBoundary.prototype.componentDidCatch.call(mockInstance, error, errorInfo);
      }).not.toThrow();
    });
  });

  describe('render method', () => {
    it('should render children when hasError is false', () => {
      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: undefined,
        },
        state: {
          hasError: false,
          error: null,
          errorInfo: null,
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);
      expect(result).toBe('Test Child');
    });

    it('should render static fallback when error occurs', () => {
      const fallbackNode = React.createElement('div', null, 'Error occurred');
      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: fallbackNode,
        },
        state: {
          hasError: true,
          error: new Error('Test'),
          errorInfo: { componentStack: 'at Component' },
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);
      expect(result).toEqual(fallbackNode);
    });

    it('should call function fallback with error and errorInfo', () => {
      let calledWithError: Error | null = null;
      let calledWithInfo: { componentStack: string } | null = null;

      const fallbackFn = (err: Error, info: { componentStack: string }) => {
        calledWithError = err;
        calledWithInfo = info;
        return React.createElement('div', null, 'Error fallback');
      };

      const error = new Error('Function test');
      const errorInfo = { componentStack: 'at TestComponent' };

      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: fallbackFn,
        },
        state: {
          hasError: true,
          error,
          errorInfo,
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);

      // Verify fallback was called with correct arguments
      expect(calledWithError).toBe(error);
      expect(calledWithInfo).toEqual(errorInfo);

      // Verify it returned a fallback element
      expect(result).toBeDefined();
    });

    it('should render null when no fallback provided', () => {
      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: undefined,
        },
        state: {
          hasError: true,
          error: new Error('No fallback'),
          errorInfo: { componentStack: 'at Component' },
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);
      expect(result).toBe(null);
    });

    it('should not call function fallback when error is null', () => {
      const fallbackFn = () => React.createElement('div', null, 'Should not render');

      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: fallbackFn,
        },
        state: {
          hasError: true,
          error: null,
          errorInfo: null,
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);
      // Function fallback requires both error and errorInfo, so should return null
      expect(result).toBe(null);
    });

    it('should not call function fallback when errorInfo is null', () => {
      const fallbackFn = () => React.createElement('div', null, 'Should not render');

      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: fallbackFn,
        },
        state: {
          hasError: true,
          error: new Error('Test'),
          errorInfo: null,
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);
      expect(result).toBe(null);
    });

    it('should render static fallback even if error/errorInfo is null', () => {
      const fallbackNode = React.createElement('div', null, 'Static error');

      const mockInstance = {
        props: {
          children: 'Test Child',
          fallback: fallbackNode,
        },
        state: {
          hasError: true,
          error: null,
          errorInfo: null,
        },
      };

      const result = RillErrorBoundary.prototype.render.call(mockInstance);
      expect(result).toEqual(fallbackNode);
    });
  });
});
