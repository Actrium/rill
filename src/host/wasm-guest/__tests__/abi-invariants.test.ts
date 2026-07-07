import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHostModuleDispatch,
  defineRillContract,
  type HostModuleDispatchTable,
  implementHostModules,
  rpc,
} from '../../../contract';
import { createWasmGuestEngine } from '../wasm-guest-view';
import { WasmGuestHost } from '../wasm-guest-host';

// Real Rust guest (rill-guest SDK) — now exports rill_abi_version() -> 1.
const KV_GUEST = readFileSync(join(import.meta.dir, 'fixtures/kv-guest.wasm'));
// Render-only Rust guest (also exports rill_abi_version() -> 1).
const UI_GUEST = readFileSync(join(import.meta.dir, 'fixtures/ui-guest.wasm'));
// Rust guest that receives host->guest events; counts zero-alloc "tick" events.
const EVENT_GUEST = readFileSync(join(import.meta.dir, 'fixtures/event-guest.wasm'));
// Hand-written .wat: declares a FUTURE ABI version (2) the host does not support.
const ABI_V2 = readFileSync(join(import.meta.dir, 'fixtures/abi-v2.wasm'));
// Hand-written .wat: no rill_abi_version export (pre-versioning) + sync-resolve probe.
const SYNC_PROBE = readFileSync(join(import.meta.dir, 'fixtures/sync-probe.wasm'));

// A tiny host:store dispatch table mirroring the platform's putText/getText
// shapes (same as wasm-guest-host.test.ts), so the kv-guest's put resolves.
function storeDispatch() {
  const store = new Map<string, string>();
  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:store': {
        putText: rpc<{ key: string; text: string }, { version: number }>({
          schema: {
            parseInput: (x) => ({
              key: String((x as { key?: unknown })?.key ?? ''),
              text: String((x as { text?: unknown })?.text ?? ''),
            }),
            parseOutput: (x) => ({ version: Number((x as { version?: unknown })?.version) || 0 }),
          },
        }),
        getText: rpc<{ key: string }, { text: string; version: number } | null>({
          schema: {
            parseInput: (x) => ({ key: String((x as { key?: unknown })?.key ?? '') }),
            parseOutput: (x) => {
              if (x == null) return null;
              const r = x as { text?: unknown; version?: unknown };
              return { text: String(r.text ?? ''), version: Number(r.version) || 0 };
            },
          },
        }),
      },
    },
    guestExports: {},
  });
  const impl = implementHostModules(contract, {
    'host:store': {
      putText: async (i: { key: string; text: string }) => {
        store.set(i.key, i.text);
        return { version: store.size };
      },
      getText: async (i: { key: string }) => {
        const text = store.get(i.key);
        return text === undefined ? null : { text, version: store.size };
      },
    },
  });
  return createHostModuleDispatch(contract, impl);
}

describe('rill_abi_version', () => {
  it('reads the version a versioned guest declares (SDK exports 1)', async () => {
    const host = new WasmGuestHost({ dispatch: storeDispatch() });
    await host.load(KV_GUEST);
    expect(host.guestAbiVersion).toBe(1);
  });

  it('tolerates a pre-versioning guest (no export) as null', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(SYNC_PROBE); // exports no rill_abi_version
    expect(host.guestAbiVersion).toBe(null);
  });

  it('rejects an unsupported ABI version at load (fail-closed, before rill_init)', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await expect(host.load(ABI_V2)).rejects.toThrow(/unsupported guest ABI version: 2/);
    // The rejection happened BEFORE rill_init: the instance is assigned (exports
    // are readable), and the guest's rill_init never ran.
    expect((host.exports.init_ran as () => number)()).toBe(0);
  });

  it('surfaces the version through the view engine (createWasmGuestEngine)', async () => {
    const engine = createWasmGuestEngine({
      wasmBytes: UI_GUEST,
      contract: defineRillContract({ version: '1', hostModules: {}, guestExports: {} }),
      hostModules: {},
      // biome-ignore lint/suspicious/noExplicitAny: opaque materializers, irrelevant here.
      components: { View: 'View' as any, Text: 'Text' as any },
    });
    expect(engine.guestAbiVersion).toBe(null); // null before load
    engine.createReceiver();
    await engine.loadBundle();
    expect(engine.guestAbiVersion).toBe(1);
  });
});

describe('host never resolves a guest call synchronously', () => {
  // These nail the presence of `await Promise.resolve()` in wasm-guest-host.ts
  // onHostCall: delete it and `resolved_during_call` becomes 1, turning these
  // red. The probe snapshots its resolve counter synchronously inside rill_init
  // (right after rill_host_call returns), so no sleep / scheduler timing is
  // involved — a re-entrant rill_resolve would be observed immediately.
  it('defers resolution even when the dispatch handler is fully synchronous', async () => {
    // A literal dispatch table whose handler returns synchronously — the stub
    // that would 'try to resolve synchronously' if the host let it.
    const dispatch: HostModuleDispatchTable = {
      'host:store': { getText: () => ({ text: 'x', version: 1 }) },
    };
    const host = new WasmGuestHost({ dispatch });
    await host.load(SYNC_PROBE);
    const during = (host.exports.resolved_during_call as () => number)();
    expect(during).toBe(0); // THE invariant: no re-entrant rill_resolve inside rill_host_call
    await host.drain();
    expect((host.exports.resolved_count as () => number)()).toBe(1);
    expect((host.exports.resolved_during_call as () => number)()).toBe(0);
    expect((host.exports.last_ok as () => number)()).toBe(1);
  });

  it('defers the error path too when the handler throws synchronously', async () => {
    const dispatch: HostModuleDispatchTable = {
      'host:store': {
        getText: () => {
          throw new Error('boom');
        },
      },
    };
    const host = new WasmGuestHost({ dispatch });
    await host.load(SYNC_PROBE);
    expect((host.exports.resolved_during_call as () => number)()).toBe(0);
    await host.drain();
    expect((host.exports.resolved_count as () => number)()).toBe(1);
    expect((host.exports.resolved_during_call as () => number)()).toBe(0);
    expect((host.exports.last_ok as () => number)()).toBe(0);
  });
});

describe('wire buffers are recycled per turn (leak regression)', () => {
  it('delivers 8000 x 512B events without exhausting the 1 MiB guest heap', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(EVENT_GUEST);
    await host.drain();
    const payload = 'x'.repeat(512);
    const n = 8000; // wire total ~4.1 MiB >> the SDK's 1 MiB bump heap:
    // passes ONLY if the wire arena recycles per turn.
    for (let i = 0; i < n; i++) host.emitEvent('tick', payload);
    expect((host.exports.tick_count as () => number)()).toBe(n);
  });
});
