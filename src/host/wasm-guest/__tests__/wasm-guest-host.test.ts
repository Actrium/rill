import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostModuleDispatch, defineRillContract, implementHostModules, rpc } from '../../../contract';
import { ComponentRegistry } from '../../registry';
import { Receiver } from '../../receiver';
import { WasmGuestHost } from '../wasm-guest-host';

// A tiny host module defined IN the test: rill knows nothing about specific
// capabilities, so this proves the native-guest ABI generically.
function kvDispatch() {
  const store = new Map<string, string>();
  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:kv': {
        put: rpc<{ k: string; v: string }, { version: number }>({
          schema: {
            parseInput: (x) => ({ k: String((x as { k?: unknown })?.k ?? ''), v: String((x as { v?: unknown })?.v ?? '') }),
            parseOutput: (x) => ({ version: Number((x as { version?: unknown })?.version) || 0 }),
          },
        }),
      },
    },
    guestExports: {},
  });
  const impl = implementHostModules(contract, {
    'host:kv': {
      put: async (i: { k: string; v: string }) => {
        store.set(i.k, i.v);
        return { version: store.size };
      },
    },
  });
  return { table: createHostModuleDispatch(contract, impl), store };
}

const WASM = readFileSync(join(import.meta.dir, 'fixtures/roundtrip.wasm'));
// Real Rust guest built via the rill-guest SDK (crates/build.sh).
const RUST_GUEST = readFileSync(join(import.meta.dir, 'fixtures/kv-guest.wasm'));
// Rust guest that renders UI via the SDK's declarative builder.
const UI_GUEST = readFileSync(join(import.meta.dir, 'fixtures/ui-guest.wasm'));
const readResolve = (host: WasmGuestHost) => {
  const ok = (host.exports.resolve_ok as () => number)();
  const ptr = (host.exports.resolve_ptr as () => number)();
  const len = (host.exports.resolve_len as () => number)();
  const result = len > 0 ? JSON.parse(new TextDecoder().decode(host.readBytes(ptr, len))) : null;
  return { ok, result };
};

describe('WasmGuestHost — native (non-JS) guest host:* ABI', () => {
  it('round-trips a host call through linear memory (guest -> host:* -> guest resolve)', async () => {
    const { table, store } = kvDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(WASM);
    await host.drain();

    const { ok, result } = readResolve(host);
    expect(ok).toBe(1);
    expect(result).toEqual({ version: 1 }); // real host:* impl ran, went through parseOutput
    expect(store.get('a')).toBe('b'); // the guest's write actually landed in the store
  });

  it('is fail-closed: an undeclared host module resolves ok=0 (the seal)', async () => {
    const host = new WasmGuestHost({ dispatch: {} }); // test:kv not registered
    await host.load(WASM);
    await host.drain();

    const { ok, result } = readResolve(host);
    expect(ok).toBe(0);
    expect(String(result.error)).toContain('not registered');
  });
});

describe('WasmGuestHost — real Rust guest via the rill-guest SDK', () => {
  it('drives an async Rust guest (store::put("a","b").await) end to end', async () => {
    const { table, store } = kvDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(RUST_GUEST);
    await host.drain();

    // The guest's async continuation ran after rill_resolve and stashed the outcome.
    expect((host.exports.last_ok as () => number)()).toBe(1);
    const ptr = (host.exports.result_ptr as () => number)();
    const len = (host.exports.result_len as () => number)();
    expect(JSON.parse(new TextDecoder().decode(host.readBytes(ptr, len)))).toEqual({ version: 1 });
    expect(store.get('a')).toBe('b');
  });
});

describe('WasmGuestHost — native guest renders UI via the receiver', () => {
  it('materializes a Rust guest render batch into the real receiver tree', async () => {
    const registry = new ComponentRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: registry stores an opaque materializer; irrelevant here.
    registry.register('View', 'View' as any);
    // biome-ignore lint/suspicious/noExplicitAny: registry stores an opaque materializer; irrelevant here.
    registry.register('Text', 'Text' as any);
    const receiver = new Receiver(
      registry,
      () => {},
      () => {}
    );

    // The guest's render batch (JSON wire) is decoded by the host and applied
    // to the real receiver — the same materialization path JS guests use.
    const host = new WasmGuestHost({
      dispatch: {},
      onRenderBatch: (batch) => receiver.applyBatch(batch),
    });
    await host.load(UI_GUEST);

    // ui-guest renders: View > [ Text("hello from rust"), View > Text("nested") ]
    const tree = receiver.getComponentTree();
    expect(tree?.type).toBe('View');
    expect(tree?.children).toHaveLength(2);
    expect(tree?.children[0].type).toBe('Text');
    expect(tree?.children[0].props.text).toBe('hello from rust');
    expect(tree?.children[1].type).toBe('View');
    expect(tree?.children[1].children[0].props.text).toBe('nested');
  });
});
