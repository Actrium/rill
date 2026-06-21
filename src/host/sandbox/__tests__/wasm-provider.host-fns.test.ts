/**
 * WASM provider by-name host-function bridge (issue #8)
 *
 * Before the fix, the WASM provider's inject(name, fn) installed a single broken
 * stub for ANY function: a guest shim that called the (non-existent, self-referential)
 * `__rill_sendBatch("CALL_HOST_FN", ...)`. That made the render channel and every
 * by-name host->guest function (__rill_sendBatch / __rill_emitEvent / __rill_getConfig
 * / __rill_sendOperation / __rill_registerComponentType) unreachable on web, and
 * injecting `__rill_sendBatch` produced infinite self-recursion (Out of bounds memory
 * access). These tests drive the bridge directly on the real WASM provider.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';
import type { JSEngineRuntime, SandboxScope } from '../types/provider';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

describeIfWASM('QuickJSNativeWASMProvider by-name host-fn bridge', () => {
  let provider: QuickJSNativeWASMProvider;
  let runtime: JSEngineRuntime;
  let context: SandboxScope;

  beforeEach(async () => {
    provider = new QuickJSNativeWASMProvider({ debug: false });
    runtime = await provider.createRuntime();
    context = runtime.createContext();
  });

  afterEach(() => {
    context?.dispose();
    runtime?.dispose();
  });

  it('routes a one-way host fn (the render channel) to the host with the args intact', () => {
    // biome-ignore lint/suspicious/noExplicitAny: captured render batches
    const batches: any[] = [];
    context.inject('__rill_sendBatch', (batch: unknown) => {
      batches.push(batch);
    });

    context.eval(
      'globalThis.__rill_sendBatch({ version: 1, batchId: 7, operations: [{ op: "CREATE", id: 1, type: "View" }] })'
    );

    expect(batches).toEqual([
      { version: 1, batchId: 7, operations: [{ op: 'CREATE', id: 1, type: 'View' }] },
    ]);
  });

  it('does NOT self-recurse / crash when __rill_sendBatch is injected then called', () => {
    let calls = 0;
    context.inject('__rill_sendBatch', () => {
      calls++;
    });
    // Before the fix this threw "Out of bounds memory access" (infinite self-recursion).
    expect(() => context.eval('globalThis.__rill_sendBatch({ batchId: 1 })')).not.toThrow();
    expect(calls).toBe(1);
  });

  it('returns a host fn result synchronously to the guest (config hook)', () => {
    context.inject('__rill_getConfig', () => ({ title: 'hello', n: 42 }));
    const result = context.eval(
      'var c = globalThis.__rill_getConfig(); c.title + ":" + c.n'
    );
    expect(result).toBe('hello:42');
  });

  it('passes guest arguments through to the host fn and returns a computed value', () => {
    context.inject('__add', (a: number, b: number) => a + b);
    expect(context.eval('globalThis.__add(2, 40)')).toBe(42);
  });

  it('supports multiple distinct injected host fns', () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    context.inject('__rill_emitEvent', (name: string, payload: unknown) => {
      events.push({ name, payload });
    });
    context.inject('__rill_getConfig', () => ({ theme: 'dark' }));

    const theme = context.eval('globalThis.__rill_getConfig().theme');
    context.eval('globalThis.__rill_emitEvent("PING", { ok: 1 })');

    expect(theme).toBe('dark');
    expect(events).toEqual([{ name: 'PING', payload: { ok: 1 } }]);
  });

  it('fails closed when an injected host fn throws (guest gets null, no crash)', () => {
    context.inject('__boom', () => {
      throw new Error('host fn exploded');
    });
    // The host swallows the throw and writes null back; the guest must not crash
    // (this is the exact failure class — host-fn error reaching the guest realm — #8 guards).
    let result: unknown;
    expect(() => {
      result = context.eval('globalThis.__boom()');
    }).not.toThrow();
    expect(result).toBeNull();
    // sandbox still usable afterwards
    expect(context.eval('1 + 1')).toBe(2);
  });

  it('fails closed when an injected host fn returns a non-serializable value', () => {
    context.inject('__circular', () => {
      const o: Record<string, unknown> = {};
      o.self = o;
      return o;
    });
    let result: unknown;
    expect(() => {
      result = context.eval('globalThis.__circular()');
    }).not.toThrow();
    expect(result).toBeNull();
    expect(context.eval('"still alive"')).toBe('still alive');
  });

  // ---- callback ARGUMENTS across the bridge (issue #10, approach B) ----
  // A function arg can't cross the JSON bridge; the guest shim registers it in
  // __rill.callbacks and passes a {__rill_cb:id} marker, the host reconstructs a proxy
  // that invokes the guest callback by id. This is what makes the engine's TimerManager
  // setTimeout/setImmediate polyfills work on WASM.

  it('passes a guest function argument to the host as a callable proxy (invoked synchronously)', () => {
    context.inject('__withCb', (cb: (n: number) => void) => {
      cb(7);
    });
    context.eval(`globalThis.__got = null; globalThis.__withCb(function(x){ globalThis.__got = x; });`);
    expect(context.extract('__got')).toBe(7);
  });

  it('lets the host STORE a guest callback and invoke it LATER (the deferred/timer case)', () => {
    let stored: ((...a: unknown[]) => void) | null = null;
    context.inject('__defer', (cb: (...a: unknown[]) => void) => {
      stored = cb;
    });
    context.eval(`globalThis.__late = null; globalThis.__defer(function(x){ globalThis.__late = x; });`);
    // Not invoked yet — the proxy outlives the original __sendToHost call.
    expect(context.extract('__late')).toBeNull();
    expect(typeof stored).toBe('function');
    stored?.('late');
    expect(context.extract('__late')).toBe('late');
  });

  it('preserves argument order when only some args are functions', () => {
    context.inject('__mix', (a: number, cb: (n: number) => void, b: number) => {
      cb(a + b);
    });
    context.eval(`globalThis.__sum = null; globalThis.__mix(2, function(x){ globalThis.__sum = x; }, 40);`);
    expect(context.extract('__sum')).toBe(42);
  });

  it('one-shot timer callback self-removes from the registry after firing (no leak)', () => {
    let stored: ((...a: unknown[]) => void) | null = null;
    // A host fn named 'setTimeout' gets the one-shot shim shape.
    context.inject('setTimeout', (cb: (...a: unknown[]) => void) => {
      stored = cb;
      return 123; // stand-in host timer id
    });
    expect(context.eval(`globalThis.__fired = false; globalThis.setTimeout(function(){ globalThis.__fired = true; }, 5);`)).toBe(123);
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(1);
    expect(context.eval("globalThis.__rill.__timerCb['setTimeout:123'] != null")).toBe(true);

    stored?.(); // host fires the one-shot
    expect(context.extract('__fired')).toBe(true);
    // self-removed: registry empty again, host-id map entry cleared
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(0);
    expect(context.eval("globalThis.__rill.__timerCb['setTimeout:123'] == null")).toBe(true);
  });

  it('one-shot shim leaves no stale __timerCb entry if the callback fires synchronously', () => {
    // A host fn that invokes the callback INLINE runs the wrapper before the shim has
    // assigned hostId. The `fired` guard must skip the post-send map write so no stale
    // entry is left pointing at an already-removed callback.
    context.inject('setTimeout', (cb: (...a: unknown[]) => void) => {
      cb(); // synchronous fire, inside __sendToHost
      return 55;
    });
    context.eval(`globalThis.__n = 0; globalThis.setTimeout(function(){ globalThis.__n++; }, 0);`);
    expect(context.extract('__n')).toBe(1); // fired
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(0); // self-removed
    expect(context.eval('Object.keys(globalThis.__rill.__timerCb).length')).toBe(0); // no leak
  });

  it('namespaces timer callbacks by family so colliding host ids do not cross-cancel', () => {
    // setTimeout / setInterval / setImmediate use INDEPENDENT id counters that all start at
    // 1, so different families return the same numeric host id. A flat id->cb map would let
    // clearTimeout(1) release a setInterval(1) callback. Namespacing by family prevents it.
    let intervalCb: ((...a: unknown[]) => void) | null = null;
    let clearedTimeout: number | null = null;
    context.inject('setTimeout', (_cb: (...a: unknown[]) => void) => 1); // host id 1
    context.inject('setInterval', (cb: (...a: unknown[]) => void) => {
      intervalCb = cb;
      return 1; // SAME numeric host id, different family
    });
    context.inject('clearTimeout', (id: number) => {
      clearedTimeout = id;
    });

    context.eval(`
      globalThis.__iFired = 0;
      globalThis.setTimeout(function(){}, 5);
      globalThis.setInterval(function(){ globalThis.__iFired++; }, 5);
    `);
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(2);

    // Clearing the timeout (host id 1) must NOT touch the interval (also host id 1).
    context.eval('globalThis.clearTimeout(1)');
    expect(clearedTimeout).toBe(1);
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(1); // only the timeout cb released
    intervalCb?.();
    expect(context.extract('__iFired')).toBe(1); // interval still alive
  });

  it('repeating timer callback persists across fires and is released only on clear', () => {
    let stored: ((...a: unknown[]) => void) | null = null;
    let clearedId: number | null = null;
    context.inject('setInterval', (cb: (...a: unknown[]) => void) => {
      stored = cb;
      return 7;
    });
    context.inject('clearInterval', (id: number) => {
      clearedId = id;
    });
    context.eval(`globalThis.__ticks = 0; globalThis.setInterval(function(){ globalThis.__ticks++; }, 5);`);
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(1);

    stored?.();
    stored?.();
    expect(context.extract('__ticks')).toBe(2);
    // not one-shot: still registered after firing
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(1);

    context.eval('globalThis.clearInterval(7)');
    expect(clearedId).toBe(7);
    // released on clear — and a later fire reaches no one
    expect(context.eval('globalThis.__rill.callbacks.size')).toBe(0);
    stored?.();
    expect(context.extract('__ticks')).toBe(2);
  });
});
