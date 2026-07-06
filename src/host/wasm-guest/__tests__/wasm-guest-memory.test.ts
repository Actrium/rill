/**
 * Memory-seam tests for the native (non-JS) WASM guest boundary.
 *
 * These cover the BOUNDS-CHECKED WRITE path that the canvas/asset/gpu guest SDK
 * relies on: WasmGuestHost.writeBytes (the host:asset `blit` / host:gpu upload
 * counterpart of readBytes) and the WasmGuestView.readGuestMemory /
 * writeGuestMemory arrow fields the platform late-binds onto host:canvas /
 * host:asset. Every ptr/len that reaches these is GUEST-SUPPLIED and untrusted,
 * so the load-bearing property is: a hostile ptr/len ALWAYS throws (fail-closed)
 * and NEVER reads or writes past the guest's linear memory.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type HostModuleImplementationMap,
  type RillContractShape,
  defineRillContract,
  implementHostModules,
  rpc,
} from '../../../contract';
import { WasmGuestHost } from '../wasm-guest-host';
import { WasmGuestView } from '../wasm-guest-view';

// A real guest gives us a real WebAssembly.Memory to write into. roundtrip.wasm
// calls host:kv on init; whether or not host:kv is wired, load() sets up memory,
// which is all these tests need.
const WASM = readFileSync(join(import.meta.dir, 'fixtures/roundtrip.wasm'));

// --- tiny seeded PRNG (reproducible, no deps) — same shape as the host test's ---
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

// A minimal host:kv contract + impl so a WasmGuestView can be constructed the
// same way an Engine would (contract + hostModules, dispatch built internally).
// The impl is irrelevant to the memory tests; roundtrip.wasm just needs load()
// to succeed so the view owns a live WasmGuestHost + memory.
function kvContract(): { contract: RillContractShape; hostModules: HostModuleImplementationMap } {
  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:kv': {
        put: rpc<{ k: string; v: string }, { version: number }>({
          schema: {
            parseInput: (x) => ({
              k: String((x as { k?: unknown })?.k ?? ''),
              v: String((x as { v?: unknown })?.v ?? ''),
            }),
            parseOutput: (x) => ({ version: Number((x as { version?: unknown })?.version) || 0 }),
          },
        }),
      },
    },
    guestExports: {},
  });
  const hostModules = implementHostModules(contract, {
    'host:kv': {
      put: async () => ({ version: 1 }),
    },
  });
  return { contract, hostModules };
}

describe('WasmGuestHost.writeBytes — bounds-checked write (host:asset.blit / host:gpu)', () => {
  it('round-trips an in-bounds write through readBytes (mid-memory)', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(WASM);
    const size = (host.exports.memory as WebAssembly.Memory).buffer.byteLength;

    const ptr = Math.floor(size / 2);
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;

    host.writeBytes(ptr, bytes);
    expect(Array.from(host.readBytes(ptr, bytes.length))).toEqual(Array.from(bytes));
  });

  it('fuzz: OOB ptr/len ALWAYS throw, in-bounds ALWAYS round-trip (never writes past memory)', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(WASM);
    const memory = host.exports.memory as WebAssembly.Memory;
    const size = memory.buffer.byteLength;
    const rng = makePrng(0xba5eba11);

    for (let i = 0; i < 300; i++) {
      // The only OOB knobs a real writeBytes caller has are the ptr and the
      // byte-array length (a Uint8Array length is always >= 0), so fuzz the ptr
      // across / past the memory bounds and classify on ptr + bytes.length.
      const ptr = (rng() % (size + 100_000)) - 1000;
      const len = rng() % 512;
      const bytes = new Uint8Array(len);
      for (let j = 0; j < len; j++) bytes[j] = rng() & 0xff;
      const inBounds = ptr >= 0 && ptr + len <= size;

      if (inBounds) {
        // A canary just past the write proves we wrote EXACTLY len bytes, no more.
        const tailPtr = ptr + len;
        const tail = tailPtr < size ? host.readBytes(tailPtr, 1)[0] : null;

        host.writeBytes(ptr, bytes);
        expect(Array.from(host.readBytes(ptr, len))).toEqual(Array.from(bytes));
        if (tail !== null) expect(host.readBytes(tailPtr, 1)[0]).toBe(tail);
      } else {
        // Snapshot the whole memory; a rejected OOB write must not mutate a byte.
        const before = new Uint8Array(memory.buffer.slice(0, size));
        expect(() => host.writeBytes(ptr, bytes)).toThrow();
        expect(Array.from(new Uint8Array(memory.buffer.slice(0, size)))).toEqual(Array.from(before));
      }
    }
  });

  it('zero-length write is a no-op that does not throw (incl. at ptr === size)', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(WASM);
    const size = (host.exports.memory as WebAssembly.Memory).buffer.byteLength;

    expect(() => host.writeBytes(0, new Uint8Array(0))).not.toThrow();
    expect(() => host.writeBytes(Math.floor(size / 2), new Uint8Array(0))).not.toThrow();
    // ptr exactly at the end with len 0 is in-bounds (ptr + 0 === size).
    expect(() => host.writeBytes(size, new Uint8Array(0))).not.toThrow();
    // one past the end is not, even for a zero-length write.
    expect(() => host.writeBytes(size + 1, new Uint8Array(0))).toThrow();
  });

  it('a negative / non-integer ptr throws (assertInBounds rejects it)', async () => {
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(WASM);
    const bytes = new Uint8Array(4);

    expect(() => host.writeBytes(-1, bytes)).toThrow();
    expect(() => host.writeBytes(1.5, bytes)).toThrow();
    expect(() => host.writeBytes(Number.NaN, bytes)).toThrow();
    expect(() => host.writeBytes(Number.POSITIVE_INFINITY, bytes)).toThrow();
  });
});

describe('WasmGuestView.readGuestMemory / writeGuestMemory — delegate to the bounds-checked seam', () => {
  // NOTE / compromise: WasmGuestView does not expose its memory size (the host is
  // private), so we cannot compute the exact boundary through the view. We instead
  // use a conservatively-in-bounds ptr (well inside the guaranteed 64 KiB minimum
  // page) and a clearly-OOB ptr (> 4 GiB). That is sufficient to prove the arrow
  // fields DELEGATE to the bounds-checked read/write path — the byte-exact
  // boundary is already exhaustively fuzzed against WasmGuestHost above.
  const IN_PTR = 1024;
  const OOB_PTR = 0x1_0000_0000; // 4 GiB, past any wasm32 linear memory
  const N = 32;

  async function makeView(): Promise<WasmGuestView> {
    const { contract, hostModules } = kvContract();
    const view = new WasmGuestView({
      wasmBytes: WASM,
      contract,
      hostModules,
      components: {},
    });
    view.createReceiver();
    await view.loadBundle();
    expect(view.isLoaded).toBe(true);
    return view;
  }

  it('readGuestMemory returns a bounds-checked slice-copy of the requested length', async () => {
    const view = await makeView();
    const out = view.readGuestMemory(IN_PTR, N);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(N);
  });

  it('readGuestMemory throws on an out-of-bounds pointer (delegates to readBytes)', async () => {
    const view = await makeView();
    expect(() => view.readGuestMemory(OOB_PTR, N)).toThrow();
    expect(() => view.readGuestMemory(-1, N)).toThrow();
    expect(() => view.readGuestMemory(1.5, N)).toThrow();
  });

  it('writeGuestMemory writes in-bounds and round-trips through readGuestMemory', async () => {
    const view = await makeView();
    const bytes = new Uint8Array(N);
    for (let i = 0; i < N; i++) bytes[i] = (i * 5 + 1) & 0xff;

    view.writeGuestMemory(IN_PTR, bytes);
    expect(Array.from(view.readGuestMemory(IN_PTR, N))).toEqual(Array.from(bytes));
  });

  it('writeGuestMemory throws on an out-of-bounds pointer (delegates to writeBytes)', async () => {
    const view = await makeView();
    const bytes = new Uint8Array(N);
    expect(() => view.writeGuestMemory(OOB_PTR, bytes)).toThrow();
    expect(() => view.writeGuestMemory(-1, bytes)).toThrow();
    expect(() => view.writeGuestMemory(1.5, bytes)).toThrow();
  });

  it('the arrow fields survive being passed by reference (bound to the view)', async () => {
    const view = await makeView();
    // Late-bound the way canvasRegistry.bindGuestMemory / host:asset would take them.
    const read = view.readGuestMemory;
    const write = view.writeGuestMemory;
    const bytes = new Uint8Array([9, 8, 7, 6]);

    write(IN_PTR, bytes);
    expect(Array.from(read(IN_PTR, bytes.length))).toEqual([9, 8, 7, 6]);
    expect(() => write(OOB_PTR, bytes)).toThrow();
    expect(() => read(OOB_PTR, 4)).toThrow();
  });
});
