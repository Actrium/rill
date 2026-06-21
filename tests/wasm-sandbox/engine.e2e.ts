/**
 * Engine-in-browser useEffect e2e on real WASM (issue #10 — the full-scheduler slice).
 *
 * This is the one test that exercises the PRODUCTION path end-to-end: a real Engine on the
 * real wasm-quickjs provider, loading a real React component that uses useEffect + setTimeout
 * via the real react-reconciler scheduler. Before the #10 fix, callback arguments (the
 * scheduler's setImmediate/setTimeout, and the effect's own setTimeout) were dropped over the
 * JSON bridge, so the reconciler could not complete a render and no batch reached the host.
 *
 * Asserting >= 2 operation batches reach the host Receiver proves the whole chain works on
 * WASM through the engine: initial render commits (batch 1, itself scheduler-driven), the
 * effect runs after commit, its setTimeout fires across the bridge, setState re-renders, and
 * the update commits (batch 2).
 *
 * The bun unit suite cannot cover this (its mock react captures timers at import); the other
 * Playwright specs use a hand-rolled React shim + native C timers (not the engine path).
 */

import { expect, test } from '@playwright/test';

// biome-ignore lint/suspicious/noExplicitAny: Playwright page with window globals set in-page
type AnyWindow = any;

const GUEST_USE_EFFECT = `
  var React = require('react');
  var useState = React.useState;
  var useEffect = React.useEffect;
  var render = require('rill/reconciler').render;
  var h = React.createElement;
  function App() {
    var s = useState(0);
    var n = s[0], setN = s[1];
    useEffect(function () {
      // Deferred state update via a timer — the callback must cross the WASM bridge.
      setTimeout(function () { setN(42); }, 20);
    }, []);
    return h('View', { testID: 'root' }, h('Text', null, 'n=' + n));
  }
  render(h(App), globalThis.__rill_sendBatch);
`;

test.describe('Engine useEffect render on real WASM (issue #10)', () => {
  test('initial render and a useEffect+setTimeout-driven update both reach the host Receiver', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto('/engine-test.html');
    await page.waitForFunction(() => (window as AnyWindow).RillEngine !== undefined, null, {
      timeout: 20000,
    });

    // Create a real Engine on the WASM provider and drive a real useEffect component.
    await page.evaluate(async (guestCode) => {
      const w = window as AnyWindow;
      const Engine = w.RillEngine;
      const batches: unknown[] = [];
      w.__batches = batches;
      const mock = (p: unknown) => p;
      const engine = new Engine({ sandbox: 'wasm-quickjs' });
      engine.register({ View: mock, Text: mock });
      engine.on('operation', (b: unknown) => batches.push(b));
      engine.createReceiver();
      w.__engine = engine;
      try {
        await engine.loadBundle(guestCode);
        w.__loaded = true;
      } catch (e) {
        w.__engineErr = String((e as Error)?.stack || e);
      }
    }, GUEST_USE_EFFECT);

    // The initial render is batch 1; the effect's setTimeout-driven re-render is batch 2.
    // Poll (real async UI update — this is what Playwright waits are for, not a sleep).
    let timedOut = false;
    try {
      await page.waitForFunction(() => ((window as AnyWindow).__batches?.length ?? 0) >= 2, null, {
        timeout: 20000,
      });
    } catch {
      timedOut = true;
    }

    const result = await page.evaluate(() => {
      const w = window as AnyWindow;
      const r = w.__engine?.getReceiver?.();
      const nodes = r ? r.getNodes() : [];
      return {
        err: w.__engineErr || null,
        loaded: !!w.__loaded,
        batchCount: w.__batches ? w.__batches.length : -1,
        nodeCount: r ? r.nodeCount : -1,
        textHas42: nodes.some((nd: AnyWindow) => String(nd?.props?.text ?? '').includes('42')),
      };
    });

    const diag = JSON.stringify({ timedOut, ...result, consoleErrors });
    expect(result.err, `engine error; diag=${diag}`).toBeNull();
    expect(result.loaded, `not loaded; diag=${diag}`).toBe(true);
    expect(result.batchCount, `<2 batches; diag=${diag}`).toBeGreaterThanOrEqual(2);
    expect(result.nodeCount, `no nodes; diag=${diag}`).toBeGreaterThan(0);
    expect(result.textHas42, `no n=42; diag=${diag}`).toBe(true);
    expect(consoleErrors, `console errors; diag=${diag}`).toEqual([]);
  });
});

// A guest function PROP (onPress) reaching the host as a callable, invoking it host-side,
// and the resulting setState re-render coming back — the core interactive path. On WASM the
// host invokes the guest callback through the Bridge guestInvoker, which must NOT rely on
// extract() (the JSON bridge drops function refs); it falls back to in-realm eval.
const GUEST_ON_PRESS = `
  var React = require('react');
  var useState = React.useState;
  var render = require('rill/reconciler').render;
  var h = React.createElement;
  function App() {
    var s = useState(0);
    var n = s[0], setN = s[1];
    return h('View', { testID: 'root' },
      h('View', { testID: 'btn', onPress: function () { setN(99); } }),
      h('Text', null, 'n=' + n)
    );
  }
  render(h(App), globalThis.__rill_sendBatch);
`;

test.describe('Engine onPress-driven setState on real WASM (issue #17)', () => {
  test('a host-invoked onPress callback triggers setState and the update reaches the Receiver', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto('/engine-test.html');
    await page.waitForFunction(() => (window as AnyWindow).RillEngine !== undefined, null, {
      timeout: 20000,
    });

    await page.evaluate(async (guestCode) => {
      const w = window as AnyWindow;
      const Engine = w.RillEngine;
      const batches: unknown[] = [];
      w.__batches = batches;
      const mock = (p: unknown) => p;
      const engine = new Engine({ sandbox: 'wasm-quickjs' });
      engine.register({ View: mock, Text: mock });
      engine.on('operation', (b: unknown) => batches.push(b));
      engine.createReceiver();
      w.__engine = engine;
      try {
        await engine.loadBundle(guestCode);
        w.__loaded = true;
      } catch (e) {
        w.__engineErr = String((e as Error)?.stack || e);
      }
    }, GUEST_ON_PRESS);

    // Initial render must land first.
    await page.waitForFunction(() => ((window as AnyWindow).__batches?.length ?? 0) >= 1, null, {
      timeout: 20000,
    });

    // Simulate a press: invoke the decoded onPress callback from the HOST side. This routes
    // through the Bridge guestInvoker -> guest callback -> setState -> re-render.
    const pressed = await page.evaluate(() => {
      const w = window as AnyWindow;
      const r = w.__engine?.getReceiver?.();
      const nodes = r ? r.getNodes() : [];
      w.__preBatches = w.__batches.length;
      const btn = nodes.find((nd: AnyWindow) => typeof nd?.props?.onPress === 'function');
      if (!btn) return false;
      btn.props.onPress();
      return true;
    });

    let timedOut = false;
    try {
      await page.waitForFunction(
        () => ((window as AnyWindow).__batches?.length ?? 0) > (window as AnyWindow).__preBatches,
        null,
        { timeout: 20000 }
      );
    } catch {
      timedOut = true;
    }

    const result = await page.evaluate(() => {
      const w = window as AnyWindow;
      const r = w.__engine?.getReceiver?.();
      const nodes = r ? r.getNodes() : [];
      return {
        err: w.__engineErr || null,
        loaded: !!w.__loaded,
        preBatches: w.__preBatches,
        batchCount: w.__batches ? w.__batches.length : -1,
        textHas99: nodes.some((nd: AnyWindow) => String(nd?.props?.text ?? '').includes('99')),
      };
    });

    const diag = JSON.stringify({ timedOut, pressed, ...result, consoleErrors });
    expect(result.err, `engine error; diag=${diag}`).toBeNull();
    expect(pressed, `no onPress node found host-side; diag=${diag}`).toBe(true);
    expect(result.batchCount, `no re-render batch after press; diag=${diag}`).toBeGreaterThan(
      result.preBatches
    );
    expect(result.textHas99, `setState did not reach the host tree; diag=${diag}`).toBe(true);
    expect(consoleErrors, `console errors; diag=${diag}`).toEqual([]);
  });
});
