/**
 * Cross-provider sandbox contract suite.
 *
 * The same core Engine<->sandbox contracts run against EVERY available provider, so a
 * provider-specific regression (the #3 / #5 / #8 class: "works on vm, broken on WASM")
 * turns the matching cell red instead of slipping through. Today this parametrizes vm
 * and wasm-quickjs (both run in Node/bun); native JSI providers (jsc/quickjs/hermes)
 * are covered by the on-device e2e suites.
 *
 * Contracts asserted per provider:
 * - eval returns primitives / objects / arrays
 * - inject(object) + extract round-trip
 * - inject(host fn) one-way: a guest call reaches the host with its args intact
 * - inject(host fn) with return value: the guest receives it synchronously
 * - render channel: a guest __rill_sendBatch(batch) reaches the host
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { NodeVMProvider } from '../providers/node-vm-provider';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';
import type { JSEngineProvider, JSEngineRuntime, SandboxScope } from '../types/provider';

interface ProviderCase {
  name: string;
  make: () => JSEngineProvider;
}

const PROVIDERS: ProviderCase[] = [{ name: 'node-vm', make: () => new NodeVMProvider() }];
if (typeof WebAssembly !== 'undefined') {
  PROVIDERS.push({ name: 'wasm-quickjs', make: () => new QuickJSNativeWASMProvider({ debug: false }) });
}

for (const providerCase of PROVIDERS) {
  describe(`sandbox provider contract: ${providerCase.name}`, () => {
    let runtime: JSEngineRuntime;
    let context: SandboxScope;

    beforeEach(async () => {
      const provider = providerCase.make();
      runtime = await provider.createRuntime();
      context = runtime.createContext();
    });

    afterEach(() => {
      context?.dispose();
      runtime?.dispose();
    });

    it('eval returns primitives, objects, and arrays', () => {
      expect(context.eval('1 + 2')).toBe(3);
      expect(context.eval('"a" + "b"')).toBe('ab');
      expect(context.eval('({ x: 1, y: [2, 3] })')).toEqual({ x: 1, y: [2, 3] });
    });

    it('inject(object) + extract round-trip', () => {
      context.inject('cfg', { a: 1, b: 'two' });
      expect(context.eval('cfg.a + cfg.b')).toBe('1two');
      context.eval('globalThis.__out = { ok: true, items: [1, 2] }');
      expect(context.extract('__out')).toEqual({ ok: true, items: [1, 2] });
    });

    it('inject(host fn) one-way: a guest call reaches the host with args intact', () => {
      const received: unknown[] = [];
      context.inject('__hostSink', (arg: unknown) => {
        received.push(arg);
      });
      context.eval('globalThis.__hostSink({ n: 42, s: "x" })');
      expect(received).toEqual([{ n: 42, s: 'x' }]);
    });

    it('inject(host fn) with return value: the guest receives it synchronously', () => {
      context.inject('__hostGet', () => ({ v: 7, label: 'ok' }));
      expect(context.eval('var r = globalThis.__hostGet(); r.label + ":" + r.v')).toBe('ok:7');
    });

    it('render channel: a guest __rill_sendBatch reaches the host with the batch intact', () => {
      // biome-ignore lint/suspicious/noExplicitAny: captured render batches
      const batches: any[] = [];
      context.inject('__rill_sendBatch', (batch: unknown) => {
        batches.push(batch);
      });
      context.eval(
        'globalThis.__rill_sendBatch({ version: 1, batchId: 9, operations: [{ op: "CREATE", id: 1, type: "View" }] })'
      );
      expect(batches).toEqual([
        { version: 1, batchId: 9, operations: [{ op: 'CREATE', id: 1, type: 'View' }] },
      ]);
    });
  });
}
