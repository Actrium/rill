/**
 * Engine cross-provider contract suite.
 *
 * The recurring bug class (#3 / #5 / #8) was "works on vm, broken on the WASM provider"
 * slipping through because the Engine-level suite only ever drove sandbox:'vm'. This
 * runs the same core host<->guest contracts against BOTH in-process providers
 * (node-vm + wasm-quickjs), end-to-end through a real Engine, with host-side assertions:
 *
 * - render: a guest __rill_sendBatch reaches the host Receiver ('operation' event)
 * - host event: engine HOST_EVENT message reaches a guest __rill_onHostEvent listener
 * - config: initialProps are readable by the guest via __rill_getConfig()
 * - callback: a host CALL_FUNCTION message invokes a registered guest callback
 *
 * Delivery is awaited deterministically via engine.sendToSandbox (no timers/sleeps).
 */

import { describe, expect, it } from 'bun:test';
import { HostMsg } from '../../../shared';
import { Engine } from '../../engine';

const SANDBOXES: Array<'node-vm' | 'wasm-quickjs'> = ['node-vm'];
if (typeof WebAssembly !== 'undefined') {
  SANDBOXES.push('wasm-quickjs');
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the private sandbox scope for assertions
function scope(engine: Engine): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return (engine as any).context;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock component
const mockComponent = ((p: any) => p) as any;

for (const sandbox of SANDBOXES) {
  describe(`Engine contract on ${sandbox}`, () => {
    it('render batch reaches the host Receiver', async () => {
      const engine = new Engine({ sandbox });
      engine.register({ View: mockComponent });
      // biome-ignore lint/suspicious/noExplicitAny: captured batches
      const batches: any[] = [];
      engine.on('operation', (b) => batches.push(b));
      engine.createReceiver();

      await engine.loadBundle(`
        globalThis.__rill_sendBatch({
          version: 1, batchId: 3,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: {} },
            { op: 'APPEND', parentId: 0, childId: 1 }
          ]
        });
      `);

      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0]?.batchId).toBe(3);
      engine.destroy();
    });

    it('a host event reaches a guest __rill_onHostEvent listener', async () => {
      const engine = new Engine({ sandbox });
      await engine.loadBundle(`
        globalThis.__pingPayload = null;
        globalThis.__rill_onHostEvent('PING', function(p){ globalThis.__pingPayload = p; });
      `);

      // Deterministic delivery: await the message round-trip (no sleep).
      await engine.sendToSandbox({
        type: HostMsg.HOST_EVENT,
        eventName: 'PING',
        // biome-ignore lint/suspicious/noExplicitAny: BridgeValue payload
        payload: { ok: 1 } as any,
      });

      expect(scope(engine).extract('__pingPayload')).toEqual({ ok: 1 });
      engine.destroy();
    });

    it('initial config is readable by the guest via __rill_getConfig()', async () => {
      const engine = new Engine({ sandbox });
      await engine.loadBundle('globalThis.__cfg = globalThis.__rill_getConfig();', {
        title: 'hi',
        n: 7,
      });
      expect(scope(engine).extract('__cfg')).toEqual({ title: 'hi', n: 7 });
      engine.destroy();
    });

    it('a host CALL_FUNCTION message invokes a registered guest callback', async () => {
      const engine = new Engine({ sandbox });
      await engine.loadBundle(`
        if (!globalThis.__rill) globalThis.__rill = {};
        if (!globalThis.__rill.callbacks) globalThis.__rill.callbacks = new Map();
        if (typeof globalThis.__rill.invokeCallback !== 'function') {
          globalThis.__rill.invokeCallback = function(id, args){
            var f = globalThis.__rill.callbacks.get(id);
            if (f) return f.apply(null, args || []);
          };
        }
        globalThis.__cbResult = null;
        globalThis.__rill.callbacks.set('fn_test', function(x){ globalThis.__cbResult = x; });
      `);

      await engine.sendToSandbox({
        type: HostMsg.CALL_FUNCTION,
        fnId: 'fn_test',
        // biome-ignore lint/suspicious/noExplicitAny: serialized args
        args: [{ pressed: true }] as any,
      });

      expect(scope(engine).extract('__cbResult')).toEqual({ pressed: true });
      engine.destroy();
    });

    it('guest console.error/warn reach the host logger', async () => {
      const errors: unknown[][] = [];
      const warns: unknown[][] = [];
      const engine = new Engine({
        sandbox,
        logger: {
          log: () => {},
          warn: (...a) => warns.push(a),
          error: (...a) => errors.push(a),
        },
      });

      // console.error/warn always forward to the host logger (console.log is debug-gated).
      // A non-serializable arg must degrade gracefully (sanitized), not throw.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await engine.loadBundle(`
        var c = {}; c.self = c;
        console.error('guest-error', { a: 1 }, c);
        console.warn('guest-warn');
      `);

      const flat = (rows: unknown[][]) => rows.map((r) => r.map(String).join(' '));
      expect(flat(errors).some((line) => line.includes('guest-error'))).toBe(true);
      expect(flat(warns).some((line) => line.includes('guest-warn'))).toBe(true);
      engine.destroy();
    });

    it('a DESTROY message clears the guest host-event listeners', async () => {
      const engine = new Engine({ sandbox });
      await engine.loadBundle(`
        globalThis.__pings = 0;
        globalThis.__rill_onHostEvent('PING', function(){ globalThis.__pings++; });
      `);

      expect(scope(engine).eval('globalThis.__rill.eventListeners.size')).toBeGreaterThan(0);

      await engine.sendToSandbox({
        type: HostMsg.HOST_EVENT,
        eventName: 'PING',
        // biome-ignore lint/suspicious/noExplicitAny: BridgeValue payload
        payload: {} as any,
      });
      expect(scope(engine).extract('__pings')).toBe(1);

      // Drive the guest DESTROY handler directly. sendToSandbox({type:DESTROY}) would also
      // call engine.destroy() and dispose the context, preventing host-side inspection of
      // the cleared guest state — this isolates the guest-side cleanup (#7).
      scope(engine).eval("globalThis.__rill_handleMessage({ type: 'DESTROY' })");
      expect(scope(engine).eval('globalThis.__rill.eventListeners.size')).toBe(0);

      engine.destroy();
    });

    it('updateConfig makes the new config visible to the guest', async () => {
      const engine = new Engine({ sandbox });
      await engine.loadBundle('globalThis.__noop = 1;', { mode: 'a', n: 1 });

      // __rill_getConfig returns the live host config; after updateConfig the merged
      // value must be readable by the guest on the isolated realm too.
      engine.updateConfig({ n: 2, extra: true });
      // updateConfig delivers CONFIG_UPDATE via a fire-and-forget sendToSandbox. Await a
      // subsequent round-trip (FIFO) so that delivery settles before destroy() tears the
      // context down — no timers/sleeps, and no post-destroy floating rejection.
      await engine.sendToSandbox({
        type: HostMsg.HOST_EVENT,
        eventName: '__drain',
        // biome-ignore lint/suspicious/noExplicitAny: BridgeValue payload
        payload: {} as any,
      });
      expect(scope(engine).eval('globalThis.__rill_getConfig()')).toEqual({
        mode: 'a',
        n: 2,
        extra: true,
      });

      engine.destroy();
    });

    it('pause queues host events; resume flushes them to the guest', async () => {
      const engine = new Engine({ sandbox });
      await engine.loadBundle(`
        globalThis.__events = [];
        globalThis.__rill_onHostEvent('TICK', function(p){ globalThis.__events.push(p); });
      `);

      engine.pause();
      engine.sendEvent('TICK', { n: 1 });
      // Paused: the event is held host-side and never reaches the guest.
      expect(scope(engine).extract('__events')).toEqual([]);

      engine.resume();
      // resume() flushes queued events via a fire-and-forget sendToSandbox. Await a
      // subsequent round-trip through the same bridge (FIFO) to flush deterministically —
      // no timers/sleeps. The drain event has no listener, so it is a harmless no-op.
      await engine.sendToSandbox({
        type: HostMsg.HOST_EVENT,
        eventName: '__drain',
        // biome-ignore lint/suspicious/noExplicitAny: BridgeValue payload
        payload: {} as any,
      });
      expect(scope(engine).extract('__events')).toEqual([{ n: 1 }]);

      engine.destroy();
    });
  });
}
