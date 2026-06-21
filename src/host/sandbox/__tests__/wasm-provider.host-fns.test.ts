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
});
