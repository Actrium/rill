import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostModuleDispatch, defineRillContract, implementHostModules, rpc } from '../../../contract';
import { decodeEnvelope, isRbs1, reviveSentinels } from '../../wire/store-net-envelope';
import { WasmGuestHost } from '../wasm-guest-host';

// A hand-written guest that sends an RBS1 request (host:store.putBytes with a
// byte-stream `value` segment) and stashes the RBS1 return the host writes back.
const RBS1_GUEST = readFileSync(join(import.meta.dir, 'fixtures/rbs1-guest.wasm'));

// A host:store contract with a binary `putBytes` capability: `value` is a byte
// stream in BOTH directions. rill is contract-agnostic on the wire, but the
// dispatch backstop asserts the declared fields are real Uint8Arrays.
function bytesDispatch() {
  const seen: { value?: Uint8Array } = {};
  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:store': {
        putBytes: rpc<{ value: Uint8Array }, { value: Uint8Array; version: number }>({
          binary: { input: ['value'], output: ['value'] },
        }),
      },
    },
    guestExports: {},
  });
  const impl = implementHostModules(contract, {
    'host:store': {
      putBytes: async (input: { value: Uint8Array }) => {
        seen.value = input.value;
        // Echo the bytes back reversed, plus a version — a byte-carrying result
        // so the host's RETURN fork must emit an RBS1 envelope.
        return { value: new Uint8Array([...input.value].reverse()), version: 1 };
      },
    },
  });
  return { table: createHostModuleDispatch(contract, impl), seen };
}

describe('WasmGuestHost — RBS1 binary-value envelope (both directions)', () => {
  it('decodes an RBS1 request into a Uint8Array and returns an RBS1 envelope', async () => {
    const { table, seen } = bytesDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(RBS1_GUEST);
    await host.drain();

    // Receive fork: the guest's {"value":{"$b":0}} + segment [1,2,3] was decoded
    // and the sentinel revived into a real Uint8Array before dispatch.
    expect(seen.value).toBeInstanceOf(Uint8Array);
    expect([...(seen.value as Uint8Array)]).toEqual([1, 2, 3]);

    // Return fork: the byte-carrying result came back as an RBS1 frame.
    const ok = (host.exports.resolve_ok as () => number)();
    const ptr = (host.exports.resolve_ptr as () => number)();
    const len = (host.exports.resolve_len as () => number)();
    expect(ok).toBe(1);
    const raw = host.readBytes(ptr, len);
    expect(isRbs1(raw)).toBe(true);

    const { json, segments } = decodeEnvelope(raw);
    const revived = reviveSentinels(JSON.parse(new TextDecoder().decode(json)), segments) as {
      value: Uint8Array;
      version: number;
    };
    expect([...revived.value]).toEqual([3, 2, 1]); // reversed by the handler
    expect(revived.version).toBe(1);
  });

  it('a non-binary result on the same host is still a plain JSON reply (back-compat)', async () => {
    // Prove the return fork does NOT wrap a segment-free result: reuse the store
    // contract's text path by returning a plain object (no Uint8Array).
    const contract = defineRillContract({
      version: '1',
      hostModules: {
        'host:store': {
          putBytes: rpc<{ value: Uint8Array }, { version: number }>({ binary: { input: ['value'] } }),
        },
      },
      guestExports: {},
    });
    const impl = implementHostModules(contract, {
      'host:store': { putBytes: async () => ({ version: 7 }) },
    });
    const host = new WasmGuestHost({ dispatch: createHostModuleDispatch(contract, impl) });
    await host.load(RBS1_GUEST);
    await host.drain();

    const ptr = (host.exports.resolve_ptr as () => number)();
    const len = (host.exports.resolve_len as () => number)();
    const raw = host.readBytes(ptr, len);
    // No byte stream in the result => raw JSON, byte-for-byte, NOT an RBS1 frame.
    expect(isRbs1(raw)).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual({ version: 7 });
  });
});
