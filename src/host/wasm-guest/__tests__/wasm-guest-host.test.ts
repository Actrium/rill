import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostModuleDispatch, defineRillContract, implementHostModules, rpc } from '../../../contract';
import { ComponentRegistry } from '../../registry';
import { Receiver } from '../../receiver';
import { WasmGuestHost } from '../wasm-guest-host';

// A tiny host module defined IN the test: rill knows nothing about specific
// capabilities, so this proves the native-guest ABI generically.
function kvDispatch(options: { throwOnPut?: boolean } = {}) {
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
        get: rpc<{ k: string }, { v: string }>({
          schema: {
            parseInput: (x) => ({ k: String((x as { k?: unknown })?.k ?? '') }),
            parseOutput: (x) => ({ v: String((x as { v?: unknown })?.v ?? '') }),
          },
        }),
      },
    },
    guestExports: {},
  });
  const impl = implementHostModules(contract, {
    'host:kv': {
      put: async (i: { k: string; v: string }) => {
        if (options.throwOnPut) throw new Error('put exploded');
        store.set(i.k, i.v);
        return { version: store.size };
      },
      get: async (i: { k: string }) => ({ v: store.get(i.k) ?? '' }),
    },
  });
  return { table: createHostModuleDispatch(contract, impl), store };
}

const WASM = readFileSync(join(import.meta.dir, 'fixtures/roundtrip.wasm'));
// Real Rust guest built via the rill-guest SDK (crates/build.sh).
const RUST_GUEST = readFileSync(join(import.meta.dir, 'fixtures/kv-guest.wasm'));
// Rust guest that renders UI via the SDK's declarative builder.
const UI_GUEST = readFileSync(join(import.meta.dir, 'fixtures/ui-guest.wasm'));
// Rust guest making two sequential awaits (put then get) with escaped chars.
const SEQ_GUEST = readFileSync(join(import.meta.dir, 'fixtures/seq-guest.wasm'));
// Adversarial guests (hand-written .wat): malformed JSON, OOB pointer, bad batch.
const BAD_JSON = readFileSync(join(import.meta.dir, 'fixtures/bad-json.wasm'));
const OOB = readFileSync(join(import.meta.dir, 'fixtures/oob.wasm'));
const BAD_BATCH = readFileSync(join(import.meta.dir, 'fixtures/bad-batch.wasm'));
// Rust guest that receives host->guest events via rill_on_event.
const EVENT_GUEST = readFileSync(join(import.meta.dir, 'fixtures/event-guest.wasm'));
// Guest authored in C via the C SDK (sdk/c) — proves the ABI is language-neutral.
const C_GUEST = readFileSync(join(import.meta.dir, 'fixtures/c-guest.wasm'));
// Adversarial guest that over-allocates past its bump heap (allocation trap).
const HEAP_EXHAUST = readFileSync(join(import.meta.dir, 'fixtures/heap-exhaust-guest.wasm'));
// Adversarial guest that imports an undeclared function (must be rejected).
const BAD_IMPORT = readFileSync(join(import.meta.dir, 'fixtures/bad-import.wasm'));
// Adversarial guest whose rill_on_event traps.
const EVENT_TRAP = readFileSync(join(import.meta.dir, 'fixtures/event-trap.wasm'));

// --- tiny seeded PRNG + JSON generator for fuzzing (reproducible, no deps) ---
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
function makePrng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 0;
  };
}
// Adversarial chars incl. JSON metachars + multi-byte UTF-8 (u00e9 = 2 bytes,
// u{1F600} = 4 bytes / surrogate pair). Escapes keep the source ASCII-only.
const FUZZ_CHARS = ['a', 'Z', '0', ' ', '"', '\\', '\n', '\t', 'é', '\u{1F600}', ':', '{', '}', '[', ']'];
function randomString(rng: () => number): string {
  const n = rng() % 10;
  let out = '';
  for (let i = 0; i < n; i++) out += FUZZ_CHARS[rng() % FUZZ_CHARS.length];
  return out;
}
function randomJson(rng: () => number, depth: number): Json {
  switch (rng() % (depth > 2 ? 4 : 6)) {
    case 0:
      return randomString(rng);
    case 1:
      return (rng() % 2000) - 1000; // JSON-safe integer
    case 2:
      return rng() % 2 === 0;
    case 3:
      return null;
    case 4: {
      const arr: Json[] = [];
      for (let i = rng() % 4; i > 0; i--) arr.push(randomJson(rng, depth + 1));
      return arr;
    }
    default: {
      const obj: { [k: string]: Json } = {};
      for (let i = rng() % 4; i > 0; i--) obj[`k${i}`] = randomJson(rng, depth + 1);
      return obj;
    }
  }
}
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

describe('WasmGuestHost — adversarial / boundary (the trust boundary)', () => {
  it('fails closed (ok=0) on malformed JSON input, does not crash', async () => {
    const { table } = kvDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(BAD_JSON);
    await host.drain();
    expect((host.exports.resolve_ok as () => number)()).toBe(0);
  });

  it('fails closed (ok=0) on an out-of-bounds guest pointer, never reads OOB', async () => {
    const { table } = kvDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(OOB);
    await host.drain();
    expect((host.exports.resolve_ok as () => number)()).toBe(0);
  });

  it('drops a malformed render batch without crashing the host', async () => {
    let batchCount = 0;
    const host = new WasmGuestHost({
      dispatch: {},
      onRenderBatch: () => {
        batchCount++;
      },
    });
    await host.load(BAD_BATCH); // must not throw
    expect(batchCount).toBe(0); // the bad batch was dropped, not forwarded
  });

  it('fails closed (ok=0) when a host handler throws', async () => {
    const { table } = kvDispatch({ throwOnPut: true });
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(WASM);
    await host.drain();
    const { ok, result } = readResolve(host);
    expect(ok).toBe(0);
    expect(String(result.error)).toContain('exploded');
  });

  it('fails closed (ok=0) when the module exists but the method does not', async () => {
    const host = new WasmGuestHost({ dispatch: { 'host:kv': {} } }); // put missing
    await host.load(WASM);
    await host.drain();
    const { ok, result } = readResolve(host);
    expect(ok).toBe(0);
    expect(String(result.error)).toContain('not registered');
  });
});

describe('WasmGuestHost — SDK executor: sequential awaits + escaping', () => {
  it('drives two sequential host awaits (put then get) and round-trips escaped chars', async () => {
    const { table, store } = kvDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(SEQ_GUEST);
    await host.drain();

    // Both awaits completed, in order (STEP advances 0 -> 1 -> 2).
    expect((host.exports.step as () => number)()).toBe(2);
    // put escaped the value guest->host correctly: b " \ c
    expect(store.get('a')).toBe('b"\\c');
    // get round-tripped it host->guest.
    const ptr = (host.exports.got_ptr as () => number)();
    const len = (host.exports.got_len as () => number)();
    expect(JSON.parse(new TextDecoder().decode(host.readBytes(ptr, len)))).toEqual({ v: 'b"\\c' });
  });

  it('takes the guest Err branch (ok=0) when the capability is unavailable', async () => {
    const host = new WasmGuestHost({ dispatch: {} }); // host:kv not registered
    await host.load(RUST_GUEST);
    await host.drain();
    expect((host.exports.last_ok as () => number)()).toBe(0); // Rust matched Err(_)
  });
});

describe('WasmGuestHost — C guest via the C SDK (language-neutral ABI)', () => {
  it('loads a C-authored guest and materializes its render batch', async () => {
    const registry = new ComponentRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: opaque materializer, irrelevant here.
    registry.register('View', 'View' as any);
    // biome-ignore lint/suspicious/noExplicitAny: opaque materializer, irrelevant here.
    registry.register('Text', 'Text' as any);
    const receiver = new Receiver(
      registry,
      () => {},
      () => {}
    );
    const host = new WasmGuestHost({
      dispatch: {},
      onRenderBatch: (b) => receiver.applyBatch(b),
    });
    await host.load(C_GUEST);

    const tree = receiver.getComponentTree();
    expect(tree?.type).toBe('View');
    expect(tree?.children[0].props.text).toBe('hello from c');
  });
});

describe('WasmGuestHost — host->guest events (rill_on_event)', () => {
  it('delivers an event to a native guest handler with its payload', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(EVENT_GUEST);
    const count = () => (host.exports.count as () => number)();
    const lastPayload = () => {
      const ptr = (host.exports.last_ptr as () => number)();
      const len = (host.exports.last_len as () => number)();
      return len > 0 ? JSON.parse(new TextDecoder().decode(host.readBytes(ptr, len))) : null;
    };

    expect(count()).toBe(0);
    host.emitEvent('ping', { n: 42 });
    expect(count()).toBe(1);
    expect(lastPayload()).toEqual({ n: 42 });

    // Name filter: an unrelated event does not fire the "ping" handler.
    host.emitEvent('other', { x: 1 });
    expect(count()).toBe(1);

    // Repeat delivery works.
    host.emitEvent('ping', { n: 7 });
    expect(count()).toBe(2);
    expect(lastPayload()).toEqual({ n: 7 });
  });

  it('emitEvent is a no-op for a guest that does not export rill_on_event', async () => {
    // A .wat guest with no rill_on_event export — must not throw.
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(BAD_BATCH);
    expect(() => host.emitEvent('ping', { n: 1 })).not.toThrow();
  });

  it('is fail-closed when the guest rill_on_event traps (emitEvent never throws)', async () => {
    // event-trap.wasm exports a rill_on_event that traps. A hostile/broken guest
    // must not make host-side event delivery throw.
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(EVENT_TRAP);
    expect(() => host.emitEvent('anything', { n: 1 })).not.toThrow();
  });

  it('a one-shot handler that removes itself during dispatch is sound', async () => {
    // event-guest registers an "once" handler that calls events::off(self) while
    // it runs. The SDK snapshots handlers before dispatch, so this must not
    // corrupt the registry (no UAF) and must fire exactly once.
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(EVENT_GUEST);
    const onceCount = () => (host.exports.once_count as () => number)();
    expect(onceCount()).toBe(0);
    host.emitEvent('once', {});
    host.emitEvent('once', {}); // handler already removed itself
    expect(onceCount()).toBe(1);
  });
});

describe('WasmGuestHost — the seal is an import allowlist (automated)', () => {
  const ALLOWED = new Set(['rill_host_call', 'rill_send_batch', 'rill_log', 'rill_on_event']);
  const guests: Array<[string, Uint8Array]> = [
    ['roundtrip', WASM],
    ['kv-guest', RUST_GUEST],
    ['ui-guest', UI_GUEST],
    ['seq-guest', SEQ_GUEST],
    ['event-guest', EVENT_GUEST],
    ['c-guest', C_GUEST],
  ];
  for (const [name, bytes] of guests) {
    it(`${name}.wasm imports only host-provided functions (no fetch/socket/…)`, () => {
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
      for (const imp of imports) {
        expect(imp.module).toBe('env');
        expect(ALLOWED.has(imp.name)).toBe(true);
      }
    });
  }

  it('enforces the seal: a guest importing an undeclared function is rejected', async () => {
    // bad-import.wasm imports env.evil, which the host does NOT provide. This is
    // the actual enforcement (WebAssembly.instantiate -> LinkError), not just the
    // tautology above that our own guests happen to import only allowed names.
    const host = new WasmGuestHost({ dispatch: {} });
    let threw = false;
    try {
      await host.load(BAD_IMPORT);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('WasmGuestHost — fuzz + resilience (trust boundary)', () => {
  it('readBytes fuzz: OOB pointers always throw, in-bounds always return exactly len', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(WASM);
    const size = (host.exports.memory as WebAssembly.Memory).buffer.byteLength;
    const rng = makePrng(0xc0ffee);
    for (let i = 0; i < 400; i++) {
      const ptr = (rng() % (size + 100_000)) - 1000;
      const len = (rng() % (size + 100_000)) - 1000;
      if (ptr >= 0 && len >= 0 && ptr + len <= size) {
        expect(host.readBytes(ptr, len).length).toBe(len);
      } else {
        expect(() => host.readBytes(ptr, len)).toThrow();
      }
    }
  });

  it('emitEvent fuzz: arbitrary JSON payloads round-trip and never crash the guest', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(EVENT_GUEST);
    const lastPayload = () => {
      const ptr = (host.exports.last_ptr as () => number)();
      const len = (host.exports.last_len as () => number)();
      return JSON.parse(new TextDecoder().decode(host.readBytes(ptr, len)));
    };
    const rng = makePrng(0xd00d);
    for (let i = 1; i <= 150; i++) {
      const payload = randomJson(rng, 0);
      expect(() => host.emitEvent('ping', payload)).not.toThrow();
      expect((host.exports.count as () => number)()).toBe(i);
      expect(lastPayload()).toEqual(payload);
    }
  });

  it('a heap-exhausted guest fails to load with a catchable error; the host survives', async () => {
    const bad = new WasmGuestHost({ dispatch: {} });
    let threw = false;
    try {
      await bad.load(HEAP_EXHAUST);
    } catch {
      threw = true; // guest trapped -> catchable JS error, not a process crash
    }
    expect(threw).toBe(true);

    // The host process survived: a normal guest still loads and works.
    const { table, store } = kvDispatch();
    const ok = new WasmGuestHost({ dispatch: table });
    await ok.load(RUST_GUEST);
    await ok.drain();
    expect((ok.exports.last_ok as () => number)()).toBe(1);
    expect(store.get('a')).toBe('b');
  });
});
