/**
 * WASM provider guest-execution timeout (deadline interrupt)
 *
 * Before the fix, wasm_bindings.c never called JS_SetInterruptHandler, so a guest
 * `while(true){}` hung the host thread forever and the provider's options.timeout
 * (default 5000ms) was stored but never consumed. Now every synchronous entry into
 * guest code (eval, host->guest callback dispatch, pending-jobs drain) arms a
 * C-side deadline via qjs_set_deadline(); the QuickJS interrupt handler aborts the
 * interpreter once it expires and the provider surfaces a timeout error.
 *
 * The timeout is a PER-ENTRY budget, not an app-lifetime one: a context must stay
 * fully usable after an interrupt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';
import type { JSEngineRuntime, SandboxScope } from '../types/provider';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

const TIMEOUT_MS = 200;
// Generous CI-safe ceiling: proves the loop was interrupted near the deadline
// instead of running unbounded.
const MAX_ELAPSED_MS = 3000;

describeIfWASM('QuickJSNativeWASMProvider guest execution timeout', () => {
  let provider: QuickJSNativeWASMProvider;
  let runtime: JSEngineRuntime;
  let context: SandboxScope;

  beforeEach(async () => {
    provider = new QuickJSNativeWASMProvider({ debug: false, timeout: TIMEOUT_MS });
    runtime = await provider.createRuntime();
    context = runtime.createContext();
  });

  afterEach(() => {
    context?.dispose();
    runtime?.dispose();
  });

  it('interrupts a guest while(true){} near the timeout and throws a timeout error', () => {
    const started = Date.now();
    expect(() => context.eval('while(true){}')).toThrow(`exceeded timeout of ${TIMEOUT_MS}ms`);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(MAX_ELAPSED_MS);
  });

  it('keeps the context fully usable after an interrupt', () => {
    expect(() => context.eval('globalThis.counter = 0; while(true){ counter++; }')).toThrow(
      'exceeded timeout'
    );

    // Same context, same engine: subsequent evaluation must work normally.
    expect(context.eval('1 + 2')).toBe(3);
    context.inject('afterInterrupt', { ok: true });
    expect(context.eval('afterInterrupt.ok')).toBe(true);
    // Side effects applied before the interrupt are visible (state, not corruption).
    expect(context.eval('typeof counter')).toBe('number');

    // A second runaway is interrupted again (the deadline re-arms per entry).
    expect(() => context.eval('while(true){}')).toThrow('exceeded timeout');
    expect(context.eval('"still" + " alive"')).toBe('still alive');
  });

  it('interrupts a runaway microtask during the pending-jobs drain', () => {
    const started = Date.now();
    expect(() => context.eval('Promise.resolve().then(function(){ while(true){} }); 1')).toThrow(
      'exceeded timeout'
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(MAX_ELAPSED_MS);

    expect(context.eval('2 + 2')).toBe(4);
  });

  it('interrupts a runaway guest callback dispatched from the host (top-level entry)', () => {
    // Capture the host-side proxy the bridge builds for a guest function argument
    // (the same mechanism TimerManager uses to fire guest timer callbacks).
    let proxy: (() => void) | undefined;
    context.inject('__capture', (cb: unknown) => {
      proxy = cb as () => void;
    });
    context.eval('globalThis.__capture(function(){ while(true){} })');
    expect(typeof proxy).toBe('function');

    const started = Date.now();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(() => proxy!()).toThrow('exceeded timeout');
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);

    expect(context.eval('40 + 2')).toBe(42);
  });

  it('bounds a runaway callback in a NESTED guest entry without breaking the outer eval', () => {
    // The host fn synchronously invokes the guest callback: a nested guest entry.
    // Its runaway loop is interrupted after its own budget, but nested dispatch
    // must NOT throw across the outer eval's live wasm frames — the outer eval
    // resumes (each re-entry re-arms a fresh per-entry budget) and completes.
    let dispatched = false;
    context.inject('__invokeNow', (cb: unknown) => {
      (cb as () => void)();
      dispatched = true;
    });

    const started = Date.now();
    const result = context.eval(
      'globalThis.__invokeNow(function(){ while(true){} }); "outer done"'
    );
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    expect(result).toBe('outer done');
    expect(dispatched).toBe(true);
    expect(context.eval('7 * 6')).toBe(42);
  });

  it('still interrupts the OUTER eval when it keeps running away after a host re-entry', () => {
    context.inject('__invokeNow', (cb: unknown) => {
      (cb as () => void)();
    });

    const started = Date.now();
    expect(() =>
      context.eval('globalThis.__invokeNow(function(){ while(true){} }); while(true){}')
    ).toThrow('exceeded timeout');
    // Two consecutive budgets at most (nested entry + re-armed outer), never unbounded.
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);

    expect(context.eval('2 * 21')).toBe(42);
  });
});

describeIfWASM('QuickJSNativeWASMProvider default timeout leaves normal code unaffected', () => {
  it('runs bounded work well under the default 5000ms budget', async () => {
    const provider = new QuickJSNativeWASMProvider({ debug: false });
    const runtime = await provider.createRuntime();
    const context = runtime.createContext();
    try {
      expect(context.eval('var s = 0; for (var i = 0; i < 1000000; i++) { s += i; } s')).toBe(
        499999500000
      );
      expect(context.eval('[1,2,3].map(function(x){ return x * 2; })')).toEqual([2, 4, 6]);
      // Microtasks still drain normally under the armed deadline.
      expect(
        context.eval('globalThis.done = 0; Promise.resolve().then(function(){ done = 1; }); 1')
      ).toBe(1);
      expect(context.eval('done')).toBe(1);
      // Repeated entries: the per-entry deadline arms/disarms cleanly every time.
      for (let i = 0; i < 50; i++) {
        expect(context.eval(`${i} + 1`)).toBe(i + 1);
      }
    } finally {
      context.dispose();
      runtime.dispose();
    }
  });
});
