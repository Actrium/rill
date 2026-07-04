import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostModuleDispatch, defineRillContract, implementHostModules, rpc } from '../../../contract';
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
