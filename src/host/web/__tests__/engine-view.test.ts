/**
 * WebEngineView tests (issue #19, L2).
 *
 * react-test-renderer over a mock Engine: asserts the DOM-container render path
 * (loading → loaded), that the guest bundle is loaded with source/initialProps, and that a
 * receiver is created. Mirrors the RN engine-view.test.ts harness.
 */

import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: react-test-renderer JSON node is loosely typed
type Json = any;

describe('WebEngineView', () => {
  let React: typeof import('react');
  let TestRenderer: typeof import('react-test-renderer');
  let act: typeof import('react-test-renderer').act;
  let WebEngineView: typeof import('../engine-view').WebEngineView;

  beforeAll(() => {
    // React 19 requires this flag for act() to properly batch/flush effects and contain
    // async effect rejections (otherwise a rejected loadBundle escapes to the test runner).
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const ReactCjs = require('../../../../node_modules/react/index.js') as typeof import('react');
    mock.module('react', () => ({ ...ReactCjs, default: ReactCjs }));
    React = ReactCjs;
    // biome-ignore lint/suspicious/noExplicitAny: test renderer module interop
    const trm = require('react-test-renderer') as any;
    TestRenderer = trm.default ?? trm;
    act = TestRenderer.act;
    WebEngineView = (require('../engine-view') as typeof import('../engine-view')).WebEngineView;
  });

  // biome-ignore lint/suspicious/noExplicitAny: mock engine is structurally typed for the test
  let mockEngine: any;
  let loadBundleMock: ReturnType<typeof mock>;
  let createReceiverMock: ReturnType<typeof mock>;

  beforeEach(() => {
    loadBundleMock = mock(() => Promise.resolve());
    const receiver = {
      render: () => React.createElement('span', { 'data-testid': 'guest' }, 'Guest Content'),
    };
    createReceiverMock = mock(() => receiver);
    // biome-ignore lint/suspicious/noExplicitAny: listener registry for the mock
    const listeners = new Map<string, Set<(arg?: any) => void>>();
    mockEngine = {
      isLoaded: false,
      isDestroyed: false,
      loadBundle: loadBundleMock,
      createReceiver: createReceiverMock,
      getReceiver: mock(() => receiver),
      // biome-ignore lint/suspicious/noExplicitAny: event listener with dynamic args
      on: mock((event: string, listener: (arg?: any) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        return () => listeners.get(event)?.delete(listener);
      }),
    };
  });

  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('renders a loading container first, then the guest content once loaded', async () => {
    let renderer: import('react-test-renderer').ReactTestRenderer | undefined;
    // Sync act captures the first paint before the async loadBundle resolves.
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(WebEngineView, { engine: mockEngine, source: 'code;' })
      );
    });
    let tree = renderer?.toJSON() as Json;
    expect(tree.type).toBe('div');
    expect(tree.props['data-rill-state']).toBe('loading');

    // Settle the load inside act, then assert the loaded tree.
    await act(async () => {
      await flushPromises();
    });
    tree = renderer?.toJSON() as Json;
    expect(tree.props['data-rill-state']).toBe('loaded');
    const child = Array.isArray(tree.children) ? tree.children[0] : tree.children;
    expect(child.type).toBe('span');
    expect(child.props['data-testid']).toBe('guest');

    act(() => renderer?.unmount());
  });

  it('loads the bundle with source + initialProps and creates a receiver', async () => {
    const initialProps = { theme: 'dark' };
    let renderer: import('react-test-renderer').ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(WebEngineView, { engine: mockEngine, source: 'code;', initialProps })
      );
      await flushPromises();
    });
    expect(loadBundleMock).toHaveBeenCalledWith('code;', initialProps);
    expect(createReceiverMock).toHaveBeenCalled();
    act(() => renderer?.unmount());
  });

  it('renders a custom error UI when load fails', async () => {
    loadBundleMock = mock(() => {
      const p = Promise.reject(new Error('boom'));
      // Mark handled for the runtime's unhandled-rejection detector; useEngineView's
      // loadGuest still catches it via `await` and drives the error state.
      p.catch(() => {});
      return p;
    });
    mockEngine.loadBundle = loadBundleMock;
    const onError = mock();
    let renderer: import('react-test-renderer').ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(WebEngineView, {
          engine: mockEngine,
          source: 'code;',
          onError,
          renderError: (e: Error) =>
            React.createElement('span', { 'data-testid': 'err' }, e.message),
        })
      );
      await flushPromises();
    });
    const tree = renderer?.toJSON() as Json;
    expect(tree.props['data-rill-state']).toBe('error');
    expect(onError).toHaveBeenCalled();
    act(() => renderer?.unmount());
  });
});
