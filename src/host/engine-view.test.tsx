/**
 * EngineView Tests
 *
 * Uses react-test-renderer for React Native compatible testing
 * react-native imports are mocked via tsconfig paths -> src/__mocks__/react-native.ts
 */

import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

describe('EngineView', () => {
  // Dynamic imports for test isolation
  let React: typeof import('react');
  let EngineView: typeof import('./preset/engine-view').EngineView;
  let Engine: typeof import('./engine').Engine;
  let TestRenderer: typeof import('react-test-renderer');
  let act: typeof import('react-test-renderer').act;

  beforeAll(async () => {
    React = await import('react');
    const engineViewModule = await import('./preset/engine-view');
    EngineView = engineViewModule.EngineView;
    const engineModule = await import('./engine');
    Engine = engineModule.Engine;
    const testRendererModule = await import('react-test-renderer');
    TestRenderer = testRendererModule.default;
    act = testRendererModule.act;
  });

  let mockEngine: InstanceType<typeof Engine>;
  let loadBundleMock: ReturnType<typeof mock>;
  let createReceiverMock: ReturnType<typeof mock>;
  let getReceiverMock: ReturnType<typeof mock>;

  beforeEach(() => {
    // Setup mocks
    loadBundleMock = mock(() => Promise.resolve());
    createReceiverMock = mock(() => {
      return {
        render: () => React.createElement('View', { testID: 'guest-content' }, 'Guest Content'),
      };
    });
    getReceiverMock = mock(() => ({
      render: () => React.createElement('View', { testID: 'guest-content' }, 'Guest Content'),
    }));

    // Create a mock Engine instance for testing
    const storedListeners = new Map<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: Mock listener with dynamic args
      Set<(arg?: any) => void>
    >();

    mockEngine = {
      isLoaded: false,
      isDestroyed: false,
      loadBundle: loadBundleMock,
      createReceiver: createReceiverMock,
      getReceiver: getReceiverMock,
      // biome-ignore lint/suspicious/noExplicitAny: Mock event listener with dynamic args
      on: mock((event: string, listener: (arg?: any) => void) => {
        if (!storedListeners.has(event)) {
          storedListeners.set(event, new Set());
        }
        storedListeners.get(event)!.add(listener);
        return mock(() => {
          storedListeners.get(event)?.delete(listener);
        });
      }),
      // biome-ignore lint/suspicious/noExplicitAny: Mock emit with dynamic args
      emit: mock((event: string, arg?: any) => {
        storedListeners.get(event)?.forEach((listener) => listener(arg));
      }),
      destroy: mock(() => {}),
      options: {
        debug: false,
        timeout: 5000,
        logger: console,
        requireWhitelist: new Set(),
        receiverMaxBatchSize: 5000,
      },
      register: mock(() => {}),
      sendEvent: mock(() => {}),
      updateConfig: mock(() => {}),
      getRegistry: mock(() => ({})),
      getDiagnostics: mock(() => ({
        id: 'test',
        health: {
          loaded: false,
          destroyed: false,
          errorCount: 0,
          lastErrorAt: null,
          receiverNodes: 0,
          batching: false,
        },
        resources: { timers: 0, nodes: 0, callbacks: 0 },
        activity: { windowMs: 5000, opsPerSecond: 0, batchesPerSecond: 0, totalBatches: 0, totalOps: 0, lastBatch: null },
        receiver: null,
        host: { lastEventName: null, lastEventAt: null, lastPayloadBytes: null },
        guest: { lastEventName: null, lastEventAt: null, lastPayloadBytes: null, sleeping: null, sleepingAt: null },
      })),
    } as unknown as InstanceType<typeof Engine>;
  });

  // Helper to wait for promises to resolve
  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

  describe('Initialization and Loading', () => {
    it('should show default loading indicator initially', async () => {
      let renderer: import('react-test-renderer').ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
      });

      const tree = renderer!.toJSON() as import('react-test-renderer').ReactTestRendererJSON;
      expect(tree).toBeTruthy();
      expect(tree.type).toBe('View');
    });

    it('should call engine.loadBundle with bundleUrl', async () => {
      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
        await flushPromises();
      });

      expect(loadBundleMock).toHaveBeenCalledWith('https://example.com/bundle.js', undefined);
    });

    it('should pass initialProps to loadBundle', async () => {
      const initialProps = { theme: 'dark', userId: 123 };

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            initialProps,
          })
        );
        await flushPromises();
      });

      expect(loadBundleMock).toHaveBeenCalledWith('https://example.com/bundle.js', initialProps);
    });

    it('should call onLoad callback after successful load', async () => {
      const onLoad = mock();

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            onLoad,
          })
        );
        await flushPromises();
      });

      expect(onLoad).toHaveBeenCalled();
    });

    it('should call createReceiver', async () => {
      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
        await flushPromises();
      });

      expect(createReceiverMock).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should call onError callback when loadBundle fails', async () => {
      const error = new Error('Bundle load failed');
      loadBundleMock = mock(() => Promise.reject(error));
      // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime property override
      (mockEngine as any).loadBundle = loadBundleMock;

      const onError = mock();

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            onError,
          })
        );
        await flushPromises();
      });

      expect(onError).toHaveBeenCalledWith(error);
    });

    it('should convert non-Error exceptions to Error objects', async () => {
      loadBundleMock = mock(() => Promise.reject('String error'));
      // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime property override
      (mockEngine as any).loadBundle = loadBundleMock;

      const onError = mock();

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            onError,
          })
        );
        await flushPromises();
      });

      expect(onError).toHaveBeenCalled();
      const capturedError = onError.mock.calls[0][0];
      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedError.message).toBe('String error');
    });
  });

  describe('Engine Event Listeners', () => {
    it('should handle engine error events', async () => {
      const onError = mock();

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            onError,
          })
        );
        await flushPromises();
      });

      // Emit error event
      const runtimeError = new Error('Runtime error');
      await act(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime method call
        (mockEngine as any).emit('error', runtimeError);
      });

      expect(onError).toHaveBeenCalledWith(runtimeError);
    });

    it('should handle engine destroy events', async () => {
      const onDestroy = mock();

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            onDestroy,
          })
        );
        await flushPromises();
      });

      // Emit destroy event
      await act(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime method call
        (mockEngine as any).emit('destroy');
      });

      expect(onDestroy).toHaveBeenCalled();
    });
  });

  describe('Lifecycle Management', () => {
    it('should not reload when engine is already loaded', async () => {
      Object.defineProperty(mockEngine, 'isLoaded', {
        get: () => true,
        configurable: true,
      });

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
        await flushPromises();
      });

      expect(loadBundleMock).not.toHaveBeenCalled();
    });

    it('should not load when engine is destroyed', async () => {
      Object.defineProperty(mockEngine, 'isDestroyed', {
        get: () => true,
        configurable: true,
      });

      await act(async () => {
        TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
        await flushPromises();
      });

      expect(loadBundleMock).not.toHaveBeenCalled();
    });

    it('should not throw when unmounted during load', async () => {
      let renderer: import('react-test-renderer').ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
      });

      // Unmount immediately
      await act(async () => {
        renderer!.unmount();
      });

      // Should not throw
      await flushPromises();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty bundleUrl', async () => {
      await act(async () => {
        TestRenderer.create(React.createElement(EngineView, { engine: mockEngine, source: '' }));
        await flushPromises();
      });

      expect(loadBundleMock).toHaveBeenCalledWith('', undefined);
    });

    it('should handle receiver returning null', async () => {
      getReceiverMock = mock(() => ({
        render: () => null,
      }));
      // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime property override
      (mockEngine as any).getReceiver = getReceiverMock;

      let renderer: import('react-test-renderer').ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
        await flushPromises();
      });

      // Should not crash
      expect(renderer!.toJSON()).toBeTruthy();
    });

    it('should handle getReceiver returning null', async () => {
      getReceiverMock = mock(() => null);
      // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime property override
      (mockEngine as any).getReceiver = getReceiverMock;

      let renderer: import('react-test-renderer').ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
          })
        );
        await flushPromises();
      });

      // Should render loading or empty state
      expect(renderer!.toJSON()).toBeTruthy();
    });
  });

  describe('Custom Fallback and Error Rendering', () => {
    it('should render custom fallback', async () => {
      const customFallback = React.createElement('View', { testID: 'custom-loader' }, 'Loading...');

      let renderer: import('react-test-renderer').ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            fallback: customFallback,
          })
        );
      });

      // Initially shows fallback
      const tree = renderer!.toJSON() as import('react-test-renderer').ReactTestRendererJSON;
      expect(tree).toBeTruthy();
    });

    it('should render custom error UI', async () => {
      loadBundleMock = mock(() => Promise.reject(new Error('Failed')));
      // biome-ignore lint/suspicious/noExplicitAny: Mock engine requires runtime property override
      (mockEngine as any).loadBundle = loadBundleMock;

      const renderError = (err: Error) =>
        React.createElement('View', { testID: 'custom-error' }, `Error: ${err.message}`);

      let renderer: import('react-test-renderer').ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(EngineView, {
            engine: mockEngine,
            source: 'https://example.com/bundle.js',
            renderError,
          })
        );
        await flushPromises();
      });

      const tree = renderer!.toJSON() as import('react-test-renderer').ReactTestRendererJSON;
      expect(tree).toBeTruthy();
    });
  });
});
