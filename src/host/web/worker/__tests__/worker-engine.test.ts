/**
 * WorkerEngine integration tests (issue #19, L1).
 *
 * Spins up a real Web Worker (bun supports `new Worker(url, { type: 'module' })`) running the
 * QuickJS-WASM engine off-thread, and drives it through the main-thread WorkerEngine proxy.
 * Asserts the round-trips that define L1:
 *  - guest render batch crosses the worker (serialized) and decodes into the main Receiver tree;
 *  - guest→host messages surface on the main thread;
 *  - a guest callback (onPress) fires across the boundary, re-renders, and the new tree returns;
 *  - the watchdog hard-kills a guest that wedges the worker in a synchronous infinite loop.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  findNodeByTestId,
  getNodeText,
  simulatePress,
  waitFor,
} from '../../../__tests__/e2e/helpers/test-utils';
import { WorkerEngine } from '../worker-engine';

function makeWorker(): Worker {
  return new Worker(new URL('../worker-host.ts', import.meta.url).href, { type: 'module' });
}

function newEngine(opts: { watchdogTimeout?: number } = {}): WorkerEngine {
  return new WorkerEngine({
    sandbox: 'wasm-quickjs',
    createWorker: makeWorker,
    // Generous default so first-load WASM instantiation never trips the watchdog in CI.
    watchdogTimeout: opts.watchdogTimeout ?? 20000,
  });
}

const HELLO_BUNDLE = `
  const React = require('react');
  const { render } = require('rill/reconciler');
  function App() {
    return React.createElement(
      'View',
      { testID: 'root' },
      React.createElement('Text', { testID: 'title' }, 'Hello Worker')
    );
  }
  render(React.createElement(App), globalThis.__rill_sendBatch);
`;

const COUNTER_BUNDLE = `
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
          },
        },
        React.createElement('Text', { testID: 'counter' }, 'Count: ' + count)
      )
    );
  }
  render(React.createElement(App), globalThis.__rill_sendBatch);
`;

describe('WorkerEngine (off-main-thread)', () => {
  let engine: WorkerEngine | null = null;

  afterEach(() => {
    engine?.destroy();
    engine = null;
  });

  it('loads a guest bundle in the worker and renders into the main-thread receiver', async () => {
    engine = newEngine();
    const receiver = engine.createReceiver();

    await engine.loadBundle(HELLO_BUNDLE);
    await waitFor(() => receiver.nodeCount > 0, 10000);

    expect(engine.isLoaded).toBe(true);
    const root = findNodeByTestId(receiver, 'root');
    expect(root).toBeTruthy();
    expect(root?.type).toBe('View');
    const title = findNodeByTestId(receiver, 'title');
    expect(title?.type).toBe('Text');
    expect(getNodeText(receiver, title)).toContain('Hello Worker');
  });

  it('surfaces guest→host messages on the main thread', async () => {
    engine = newEngine();
    const received: Array<{ event: string; payload: unknown }> = [];
    engine.on('message', (m) => received.push(m));

    engine.createReceiver();
    await engine.loadBundle(COUNTER_BUNDLE);
    await waitFor(() => engine?.getReceiver()?.nodeCount! > 0, 10000);

    const button = findNodeByTestId(engine.getReceiver()!, 'button');
    await simulatePress(button);

    await waitFor(() => received.some((m) => m.event === 'PRESSED'), 10000);
    const pressed = received.find((m) => m.event === 'PRESSED');
    expect(pressed?.payload).toEqual({ count: 1 });
  });

  it('round-trips a guest callback (onPress) across the worker and re-renders', async () => {
    engine = newEngine();
    const receiver = engine.createReceiver();

    await engine.loadBundle(COUNTER_BUNDLE);
    await waitFor(() => receiver.nodeCount > 0, 10000);

    expect(getNodeText(receiver, findNodeByTestId(receiver, 'counter'))).toContain('Count: 0');

    // The decoded onPress is a proxy that posts an invoke to the worker; the guest runs setState
    // there, producing a fresh serialized batch that flows back and updates this receiver.
    await simulatePress(findNodeByTestId(receiver, 'button'));

    await waitFor(
      () => getNodeText(receiver, findNodeByTestId(receiver, 'counter')).includes('Count: 1'),
      10000
    );
    expect(getNodeText(receiver, findNodeByTestId(receiver, 'counter'))).toContain('Count: 1');
  });

  it('watchdog hard-kills a guest that wedges the worker in an infinite loop', async () => {
    engine = newEngine({ watchdogTimeout: 700 });
    engine.createReceiver();

    let fatal: Error | null = null;
    engine.on('fatalError', (e) => {
      fatal = e;
    });

    // Top-level infinite loop: the worker event loop is blocked, so no inner timeout can fire —
    // only the main-thread watchdog's terminate() can recover. loadBundle must reject.
    const RUNAWAY = 'while (true) {}';
    await expect(engine.loadBundle(RUNAWAY)).rejects.toThrow(/watchdog/);

    expect(engine.isDestroyed).toBe(true);
    expect(fatal).not.toBeNull();
    expect((fatal as unknown as Error).message).toMatch(/watchdog/);
  });
});
