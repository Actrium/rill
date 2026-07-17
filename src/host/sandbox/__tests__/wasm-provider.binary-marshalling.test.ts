/**
 * QuickJS shell first-class binary marshalling ({"$bin":id} staging table)
 *
 * The in-tree QuickJS provider is a SYNCHRONOUS JSON STRING BRIDGE, not postMessage:
 * __sendToHost JSON.stringify's guest args and resolveHostCall JSON.stringify's host
 * results. An ArrayBuffer crossing that bridge naively degrades to "{}" and a view to a
 * `{"0":..}` index object — bytes destroyed or bloated ~4-6x, never arriving as binary.
 *
 * The staging codec fixes this without ever putting bytes in the JSON: each
 * ArrayBuffer/view is parked in a C-side table in wasm LINEAR MEMORY and referenced from
 * the JSON as {"$bin":id} (+ {"$view":kind} for typed-array views). Every id is consumed
 * exactly once by the receiving side; senders blanket-free their payload's ids in a
 * finally. These tests assert:
 *   - both directions deliver REAL binary values (parity with the wasm RBS1 path),
 *   - typed-array view type AND window (byteOffset/byteLength) are preserved,
 *   - nesting inside objects/arrays, empty and large buffers survive,
 *   - the on-wire JSON carries {"$bin":id} — no byte bloat,
 *   - the staging table is EMPTY after every round-trip and every failure path
 *     (qjs_binary_count() === 0: the zero-leak discipline).
 */

import { describe, expect, it } from 'bun:test';
import {
  createHostModuleDispatch,
  defineRillContract,
  type HostModuleDispatchTable,
  rpc,
  type RillContractShape,
} from '../../../contract';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

/** The staging-table export the leak assertions need (subset of the wasm module). */
interface BinaryTableModule {
  _qjs_binary_count: () => number;
}

function buildContract(): RillContractShape {
  return defineRillContract({
    version: '1.0.0',
    hostModules: {
      'host:store': {
        // Binary in, binary out: value rides as bytes both ways.
        putBytes: rpc<{ key: string; value: Uint8Array }, { value: Uint8Array; version: number }>(),
        getBytes: rpc<{ key: string }, { value: Uint8Array } | null>(),
        // A text capability that carries NO binary — used to prove non-binary calls are
        // byte-identical on the wire (no $bin fork taken).
        putText: rpc<{ key: string; text: string }, { version: number }>(),
        // Type-agnostic echo: whatever binary shape the guest sends comes straight back,
        // so view-kind fidelity can be asserted on both sides of the bridge.
        echo: rpc<{ value: unknown }, { value: unknown }>(),
      },
    },
    guestExports: {},
  });
}

interface HostObservation {
  putBytesValueIsU8: boolean | null;
  putBytesValueBytes: number[] | null;
  echoSeen: unknown;
}

describeIfWASM('QuickJSNativeWASMProvider first-class binary marshalling', () => {
  // Spin up a fresh context wired to a mock host:store that records what the handler saw
  // and echoes bytes back. `wire` captures every __rill_host_invoke payload string the
  // guest sent across the JSON bridge (via debug console), so we can inspect the
  // transport. `binaryCount` reads the C staging table for the zero-leak assertions.
  async function setup() {
    const wire: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes('Host callback: __rill_host_invoke') &&
        typeof args[1] === 'string'
      ) {
        wire.push(args[1]);
      }
    };

    // Capture the wasm module instance so tests can interrogate the staging table.
    let wasmModule: BinaryTableModule | null = null;
    const provider = new QuickJSNativeWASMProvider({
      debug: true,
      // Reason: the provider's factory type is module-private; the loader's real module
      // shape is asserted structurally where the test needs it.
      wasmFactory: (async (moduleArg?: unknown) => {
        const factory = (await import('../wasm/quickjs-sandbox.js')) as {
          default: (arg?: unknown) => Promise<unknown>;
        };
        const instance = await factory.default(moduleArg);
        wasmModule = instance as BinaryTableModule;
        return instance;
      }) as never,
    });
    const runtime = await provider.createRuntime();
    const context = runtime.createContext();
    const contract = buildContract();

    const obs: HostObservation = {
      putBytesValueIsU8: null,
      putBytesValueBytes: null,
      echoSeen: undefined,
    };
    const backing = new Map<string, Uint8Array>();

    const table: HostModuleDispatchTable = createHostModuleDispatch(contract, {
      'host:store': {
        putBytes: async (input) => {
          const v = input.value as unknown;
          obs.putBytesValueIsU8 = v instanceof Uint8Array;
          obs.putBytesValueBytes = v instanceof Uint8Array ? Array.from(v) : null;
          backing.set(input.key, input.value);
          // Echo the exact bytes back so the guest can assert a full round-trip.
          return { value: input.value, version: 1 };
        },
        getBytes: async (input) => {
          const stored = backing.get(input.key);
          return stored ? { value: stored } : null;
        },
        putText: async (input) => {
          backing.set(input.key, new TextEncoder().encode(input.text));
          return { version: 2 };
        },
        echo: async (input) => {
          obs.echoSeen = input.value;
          return { value: input.value };
        },
      },
    });

    context.installHostModules?.(table, contract);

    const binaryCount = (): number => {
      if (!wasmModule) throw new Error('wasm module not captured');
      return wasmModule._qjs_binary_count();
    };

    const teardown = () => {
      console.log = originalLog;
      context.dispose();
      runtime.dispose();
    };

    return { context, obs, wire, binaryCount, teardown };
  }

  it('guest Uint8Array round-trips through putBytes with wasm-parity semantics', async () => {
    const { context, obs, wire, binaryCount, teardown } = await setup();
    try {
      // Guest passes a real Uint8Array (0x00 and 0xFF at the edges) through the platform
      // host-module stub and inspects what it gets back — all inside the guest realm.
      context.eval(`
        globalThis.__pr = undefined;
        (async function () {
          var input = new Uint8Array([0, 1, 127, 128, 254, 255]);
          var res = await globalThis.__rill.hostModules['host:store'].putBytes({ key: 'k', value: input });
          var v = res.value;
          globalThis.__pr = {
            isU8: v instanceof Uint8Array,
            bytes: v instanceof Uint8Array ? Array.from(v) : v,
            version: res.version
          };
        })();
      `);
      await context.flushHostModuleCalls?.();

      // The host handler saw a REAL Uint8Array with the exact bytes (parity with wasm path).
      expect(obs.putBytesValueIsU8).toBe(true);
      expect(obs.putBytesValueBytes).toEqual([0, 1, 127, 128, 254, 255]);

      // The guest received a REAL Uint8Array back with 0x00/0xFF intact.
      const pr = context.extract('__pr') as { isU8: boolean; bytes: number[]; version: number };
      expect(pr.isU8).toBe(true);
      expect(pr.bytes).toEqual([0, 1, 127, 128, 254, 255]);
      expect(pr.version).toBe(1);

      // The on-wire payload carries a staged-binary reference, NOT the bytes themselves.
      // Assert the sentinel (with its view kind) is present and no number-array /
      // index-object / base64 form of the bytes leaked into the JSON.
      const invoke = wire.find((w) => w.includes('putBytes'));
      expect(invoke).toBeDefined();
      expect(invoke).toMatch(/"\$bin":\d+/);
      expect(invoke).toContain('"$view":"Uint8Array"');
      expect(invoke).not.toContain('$b64');
      expect(invoke).not.toContain('254,255');
      expect(invoke).not.toContain('"0":0');
      expect(invoke).not.toContain('[0,1,127');

      // Zero-leak: every staged id was consumed exactly once.
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('getBytes returns the stored Uint8Array to the guest (host->guest revive)', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__gr = undefined;
        (async function () {
          await globalThis.__rill.hostModules['host:store'].putBytes({ key: 'g', value: new Uint8Array([0, 255, 0, 255]) });
          var got = await globalThis.__rill.hostModules['host:store'].getBytes({ key: 'g' });
          var v = got && got.value;
          globalThis.__gr = { isU8: v instanceof Uint8Array, bytes: v instanceof Uint8Array ? Array.from(v) : v };
        })();
      `);
      await context.flushHostModuleCalls?.();

      const gr = context.extract('__gr') as { isU8: boolean; bytes: number[] };
      expect(gr.isU8).toBe(true);
      expect(gr.bytes).toEqual([0, 255, 0, 255]);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('an empty Uint8Array survives the round-trip', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__er = undefined;
        (async function () {
          var res = await globalThis.__rill.hostModules['host:store'].putBytes({ key: 'e', value: new Uint8Array(0) });
          var v = res.value;
          globalThis.__er = { isU8: v instanceof Uint8Array, len: v instanceof Uint8Array ? v.length : -1 };
        })();
      `);
      await context.flushHostModuleCalls?.();

      const er = context.extract('__er') as { isU8: boolean; len: number };
      expect(er.isU8).toBe(true);
      expect(er.len).toBe(0);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('a full 0..255 byte range round-trips byte-for-byte', async () => {
    const { context, obs, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__fr = undefined;
        (async function () {
          var input = new Uint8Array(256);
          for (var i = 0; i < 256; i++) input[i] = i;
          var res = await globalThis.__rill.hostModules['host:store'].putBytes({ key: 'f', value: input });
          var v = res.value;
          globalThis.__fr = { isU8: v instanceof Uint8Array, bytes: v instanceof Uint8Array ? Array.from(v) : v };
        })();
      `);
      await context.flushHostModuleCalls?.();

      const expected = Array.from({ length: 256 }, (_, i) => i);
      expect(obs.putBytesValueBytes).toEqual(expected);
      const fr = context.extract('__fr') as { isU8: boolean; bytes: number[] };
      expect(fr.isU8).toBe(true);
      expect(fr.bytes).toEqual(expected);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('a large buffer (512 KiB) round-trips intact', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__lr = undefined;
        (async function () {
          var input = new Uint8Array(512 * 1024);
          for (var i = 0; i < input.length; i++) input[i] = (i * 31) & 255;
          var res = await globalThis.__rill.hostModules['host:store'].putBytes({ key: 'big', value: input });
          var v = res.value;
          var ok = v instanceof Uint8Array && v.length === input.length;
          if (ok) { for (var j = 0; j < v.length; j++) { if (v[j] !== ((j * 31) & 255)) { ok = false; break; } } }
          globalThis.__lr = { ok: ok, len: v instanceof Uint8Array ? v.length : -1 };
        })();
      `);
      await context.flushHostModuleCalls?.();

      const lr = context.extract('__lr') as { ok: boolean; len: number };
      expect(lr.len).toBe(512 * 1024);
      expect(lr.ok).toBe(true);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('preserves typed-array view kind and window (byteOffset/byteLength) through echo', async () => {
    const { context, obs, binaryCount, teardown } = await setup();
    try {
      // An Int16Array window carved out of a larger backing buffer: only the window
      // bytes may cross, and the peer must rebuild an Int16Array, not a Uint8Array.
      context.eval(`
        globalThis.__vr = undefined;
        (async function () {
          var backing = new ArrayBuffer(16);
          var all = new Int16Array(backing);
          for (var i = 0; i < all.length; i++) all[i] = (i + 1) * 100;
          var win = new Int16Array(backing, 4, 3); // elements [300, 400, 500]
          var res = await globalThis.__rill.hostModules['host:store'].echo({ value: win });
          var v = res.value;
          globalThis.__vr = {
            isI16: v instanceof Int16Array,
            len: v && v.length,
            byteOffset: v && v.byteOffset,
            values: v ? Array.prototype.slice.call(v) : null
          };
        })();
      `);
      await context.flushHostModuleCalls?.();

      // Host side saw a real Int16Array holding ONLY the window elements.
      expect(obs.echoSeen).toBeInstanceOf(Int16Array);
      expect(Array.from(obs.echoSeen as Int16Array)).toEqual([300, 400, 500]);
      // The received view owns its (copied) buffer: the window starts at offset 0.
      expect((obs.echoSeen as Int16Array).byteOffset).toBe(0);
      expect((obs.echoSeen as Int16Array).buffer.byteLength).toBe(6);

      const vr = context.extract('__vr') as {
        isI16: boolean;
        len: number;
        byteOffset: number;
        values: number[];
      };
      expect(vr.isI16).toBe(true);
      expect(vr.len).toBe(3);
      expect(vr.byteOffset).toBe(0);
      expect(vr.values).toEqual([300, 400, 500]);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('a bare ArrayBuffer stays an ArrayBuffer on both sides', async () => {
    const { context, obs, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__ar = undefined;
        (async function () {
          var ab = new Uint8Array([10, 20, 30]).buffer;
          var res = await globalThis.__rill.hostModules['host:store'].echo({ value: ab });
          var v = res.value;
          globalThis.__ar = {
            isAB: v instanceof ArrayBuffer,
            bytes: v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : null
          };
        })();
      `);
      await context.flushHostModuleCalls?.();

      expect(obs.echoSeen).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(obs.echoSeen as ArrayBuffer))).toEqual([10, 20, 30]);

      const ar = context.extract('__ar') as { isAB: boolean; bytes: number[] };
      expect(ar.isAB).toBe(true);
      expect(ar.bytes).toEqual([10, 20, 30]);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('a DataView round-trips as a DataView with its exact window', async () => {
    const { context, obs, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__dr = undefined;
        (async function () {
          var backing = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
          var dv = new DataView(backing, 2, 3); // bytes [1, 2, 3]
          var res = await globalThis.__rill.hostModules['host:store'].echo({ value: dv });
          var v = res.value;
          globalThis.__dr = {
            isDV: v instanceof DataView,
            bytes: v instanceof DataView ? [v.getUint8(0), v.getUint8(1), v.getUint8(2)] : null,
            byteLength: v && v.byteLength
          };
        })();
      `);
      await context.flushHostModuleCalls?.();

      expect(obs.echoSeen).toBeInstanceOf(DataView);
      const hostDv = obs.echoSeen as DataView;
      expect(hostDv.byteLength).toBe(3);
      expect([hostDv.getUint8(0), hostDv.getUint8(1), hostDv.getUint8(2)]).toEqual([1, 2, 3]);

      const dr = context.extract('__dr') as { isDV: boolean; bytes: number[]; byteLength: number };
      expect(dr.isDV).toBe(true);
      expect(dr.byteLength).toBe(3);
      expect(dr.bytes).toEqual([1, 2, 3]);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('buffers nested inside objects and arrays round-trip in place', async () => {
    const { context, obs, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__nr = undefined;
        (async function () {
          var payload = {
            meta: 'nested',
            list: [new Uint8Array([1, 2]), { inner: new Uint8Array([3, 4, 5]).buffer }],
            plain: 42
          };
          var res = await globalThis.__rill.hostModules['host:store'].echo({ value: payload });
          var v = res.value;
          var first = v && v.list && v.list[0];
          var inner = v && v.list && v.list[1] && v.list[1].inner;
          globalThis.__nr = {
            meta: v && v.meta,
            plain: v && v.plain,
            firstIsU8: first instanceof Uint8Array,
            firstBytes: first instanceof Uint8Array ? Array.from(first) : null,
            innerIsAB: inner instanceof ArrayBuffer,
            innerBytes: inner instanceof ArrayBuffer ? Array.from(new Uint8Array(inner)) : null
          };
        })();
      `);
      await context.flushHostModuleCalls?.();

      const seen = obs.echoSeen as {
        meta: string;
        list: [Uint8Array, { inner: ArrayBuffer }];
        plain: number;
      };
      expect(seen.meta).toBe('nested');
      expect(seen.plain).toBe(42);
      expect(seen.list[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(seen.list[0])).toEqual([1, 2]);
      expect(seen.list[1].inner).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(seen.list[1].inner))).toEqual([3, 4, 5]);

      const nr = context.extract('__nr') as {
        meta: string;
        plain: number;
        firstIsU8: boolean;
        firstBytes: number[];
        innerIsAB: boolean;
        innerBytes: number[];
      };
      expect(nr.meta).toBe('nested');
      expect(nr.plain).toBe(42);
      expect(nr.firstIsU8).toBe(true);
      expect(nr.firstBytes).toEqual([1, 2]);
      expect(nr.innerIsAB).toBe(true);
      expect(nr.innerBytes).toEqual([3, 4, 5]);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('non-binary calls carry no $bin sentinel and reach the handler unchanged', async () => {
    const { context, wire, binaryCount, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__tr = undefined;
        globalThis.__rill.hostModules['host:store'].putText({ key: 't', text: 'hello' }).then(function (r) { globalThis.__tr = r; });
      `);
      await context.flushHostModuleCalls?.();

      expect(context.extract('__tr')).toEqual({ version: 2 });

      // The text call's wire payload is plain JSON: no $bin fork, exactly the args as sent.
      const invoke = wire.find((w) => w.includes('putText'));
      expect(invoke).toBeDefined();
      expect(invoke).not.toContain('$bin');
      expect(invoke).toContain('"text":"hello"');
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('inject() delivers real binary into the guest and extract() returns real binary to the host', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      // Host -> guest: injected global holds a real Uint8Array, not an index object.
      context.inject('__cfgBlob', { name: 'icon', data: new Uint8Array([7, 0, 255]) });
      const ir = context.eval(`
        (function () {
          var d = globalThis.__cfgBlob.data;
          return { isU8: d instanceof Uint8Array, bytes: d instanceof Uint8Array ? Array.from(d) : null };
        })();
      `) as { isU8: boolean; bytes: number[] };
      expect(ir.isU8).toBe(true);
      expect(ir.bytes).toEqual([7, 0, 255]);

      // Guest -> host: extract() revives a view WINDOW (byteOffset respected) into a
      // host-realm Uint8Array carrying exactly the window bytes.
      context.eval(`
        var backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        globalThis.__exp = { win: new Uint8Array(backing.buffer, 2, 4) };
      `);
      const exp = context.extract('__exp') as { win: Uint8Array };
      expect(exp.win).toBeInstanceOf(Uint8Array);
      expect(Array.from(exp.win)).toEqual([3, 4, 5, 6]);
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('by-name host fns carry binary in args, return values and callback args', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      // Guest -> host, multi-arg (does NOT take the single-arg fast channel).
      let sinkKey: string | null = null;
      let sinkValue: unknown = null;
      context.inject('__sink2', (key: string, value: unknown) => {
        sinkKey = key;
        sinkValue = value;
        return null;
      });
      context.eval(`__sink2('blob', new Uint8Array([11, 22, 33]));`);
      expect(sinkKey).toBe('blob');
      expect(sinkValue).toBeInstanceOf(Uint8Array);
      expect(Array.from(sinkValue as Uint8Array)).toEqual([11, 22, 33]);

      // Host -> guest, synchronous return value.
      context.inject('__getBlob', () => ({ data: new Uint8Array([9, 0, 128]) }));
      const rr = context.eval(`
        (function () {
          var r = __getBlob();
          var d = r && r.data;
          return { isU8: d instanceof Uint8Array, bytes: d instanceof Uint8Array ? Array.from(d) : null };
        })();
      `) as { isU8: boolean; bytes: number[] };
      expect(rr.isU8).toBe(true);
      expect(rr.bytes).toEqual([9, 0, 128]);

      // Host -> guest callback args (issue #10 marker path).
      let cbProxy: ((v: unknown) => void) | null = null;
      context.inject('__grabCb', (cb: (v: unknown) => void) => {
        cbProxy = cb;
        return null;
      });
      context.eval(`
        globalThis.__cbGot = undefined;
        __grabCb(function (v) {
          globalThis.__cbGot = { isU8: v instanceof Uint8Array, bytes: v instanceof Uint8Array ? Array.from(v) : null };
        });
      `);
      expect(cbProxy).not.toBeNull();
      (cbProxy as unknown as (v: unknown) => void)(new Uint8Array([5, 6, 7]));
      const cbGot = context.extract('__cbGot') as { isU8: boolean; bytes: number[] };
      expect(cbGot.isU8).toBe(true);
      expect(cbGot.bytes).toEqual([5, 6, 7]);

      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('frees staged binary when the target host module is not registered (guest->host failure path)', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      // Bypass the typed stubs and invoke an unregistered capability with binary args:
      // the host must reject the call AND release the staged bytes.
      context.eval(`
        globalThis.__rej = undefined;
        globalThis.__rill.__invokeHostRpc('host:nope', 'missing', { v: new Uint8Array([1, 2, 3]) })
          .catch(function (e) { globalThis.__rej = String(e && e.message); });
      `);
      await context.flushHostModuleCalls?.();

      const rej = context.extract('__rej') as string;
      expect(rej).toContain('Host module not registered');
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });

  it('frees staged binary when a host fn result is not serializable (host->guest failure path)', async () => {
    const { context, binaryCount, teardown } = await setup();
    try {
      // The result contains binary (staged first) AND a cycle (stringify throws after
      // staging): the guest must see null and the staged block must be released.
      context.inject('__cyclic', () => {
        const result: Record<string, unknown> = { data: new Uint8Array([1, 2, 3]) };
        result.self = result;
        return result;
      });
      expect(context.eval('__cyclic()')).toBeNull();
      expect(binaryCount()).toBe(0);
    } finally {
      teardown();
    }
  });
});
