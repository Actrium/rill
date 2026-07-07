/**
 * QuickJS shell `$b64` binary sidecar parity (store-net-bytes.DESIGN §B.5)
 *
 * The in-tree QuickJS provider is a SYNCHRONOUS JSON STRING BRIDGE, not postMessage:
 * __sendToHost JSON.stringify's guest args and resolveHostCall JSON.stringify's host
 * results. A Uint8Array crossing that bridge naively degrades into a `{"0":..}` index
 * object (~4-6x bloat) and arrives as a plain object, NOT a Uint8Array.
 *
 * The `$b64` codec fixes this additively: Uint8Array fields are wrapped as {"$b64":"…"}
 * (base64, ~1.33x) at the shell boundary and revived to a real Uint8Array on the other
 * side. This test asserts a JS/QuickJS guest passing a Uint8Array through
 * host:store.putBytes/getBytes against a mock host sees the SAME semantics as the wasm
 * (RBS1) path: the host handler gets a real Uint8Array, the guest gets one back, 0x00/0xFF
 * survive, and the on-wire payload carries base64 — NOT an array of numbers.
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

function buildContract(): RillContractShape {
  return defineRillContract({
    version: '1.0.0',
    hostModules: {
      'host:store': {
        // Binary in, binary out: value rides as bytes both ways.
        putBytes: rpc<{ key: string; value: Uint8Array }, { value: Uint8Array; version: number }>(),
        getBytes: rpc<{ key: string }, { value: Uint8Array } | null>(),
        // A text capability that carries NO binary — used to prove non-binary calls are
        // byte-identical on the wire (no $b64 fork taken).
        putText: rpc<{ key: string; text: string }, { version: number }>(),
      },
    },
    guestExports: {},
  });
}

interface HostObservation {
  putBytesValueIsU8: boolean | null;
  putBytesValueBytes: number[] | null;
}

describeIfWASM('QuickJSNativeWASMProvider $b64 binary sidecar', () => {
  // Spin up a fresh context wired to a mock host:store that records what the handler saw
  // and echoes bytes back. `wire` captures every __rill_host_invoke payload string the
  // guest sent across the JSON bridge (via debug console), so we can inspect the transport.
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

    const provider = new QuickJSNativeWASMProvider({ debug: true });
    const runtime = await provider.createRuntime();
    const context = runtime.createContext();
    const contract = buildContract();

    const obs: HostObservation = { putBytesValueIsU8: null, putBytesValueBytes: null };
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
      },
    });

    context.installHostModules?.(table, contract);

    const teardown = () => {
      console.log = originalLog;
      context.dispose();
      runtime.dispose();
    };

    return { context, obs, wire, teardown };
  }

  it('guest Uint8Array round-trips through putBytes with wasm-parity semantics', async () => {
    const { context, obs, wire, teardown } = await setup();
    try {
      // Guest passes a real Uint8Array (0x00 and 0xFF at the edges) through the platform
      // host-module stub and inspects what it gets back — all inside the guest realm, since
      // extract() would re-serialize a Uint8Array into an index object.
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

      // The on-wire payload carries base64, NOT an array of numbers. The value bytes are
      // [0,1,127,128,254,255] -> base64 "AAF/gP7/". Assert the sentinel is present and no
      // number-array / index-object form of the bytes leaked into the JSON.
      const invoke = wire.find((w) => w.includes('putBytes'));
      expect(invoke).toBeDefined();
      expect(invoke).toContain('"$b64":"AAF/gP7/"');
      // No number-array bloat: the raw byte sequence must not appear as JSON numbers, and
      // no index-object form ("0":0,"1":1) either.
      expect(invoke).not.toContain('254,255');
      expect(invoke).not.toContain('"0":0');
      expect(invoke).not.toContain('[0,1,127');
    } finally {
      teardown();
    }
  });

  it('getBytes returns the stored Uint8Array to the guest (host->guest revive)', async () => {
    const { context, teardown } = await setup();
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
    } finally {
      teardown();
    }
  });

  it('an empty Uint8Array survives the round-trip', async () => {
    const { context, teardown } = await setup();
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
    } finally {
      teardown();
    }
  });

  it('a full 0..255 byte range round-trips byte-for-byte', async () => {
    const { context, obs, teardown } = await setup();
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
    } finally {
      teardown();
    }
  });

  it('non-binary calls carry no $b64 sentinel and reach the handler unchanged', async () => {
    const { context, wire, teardown } = await setup();
    try {
      context.eval(`
        globalThis.__tr = undefined;
        globalThis.__rill.hostModules['host:store'].putText({ key: 't', text: 'hello' }).then(function (r) { globalThis.__tr = r; });
      `);
      await context.flushHostModuleCalls?.();

      expect(context.extract('__tr')).toEqual({ version: 2 });

      // The text call's wire payload is plain JSON: no $b64 fork, exactly the args as sent.
      const invoke = wire.find((w) => w.includes('putText'));
      expect(invoke).toBeDefined();
      expect(invoke).not.toContain('$b64');
      expect(invoke).toContain('"text":"hello"');
    } finally {
      teardown();
    }
  });
});
