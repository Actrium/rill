import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostModuleDispatch, defineRillContract, implementHostModules, rpc } from '../../../contract';
import { WasmGuestHost } from '../wasm-guest-host';

// Real Rust guest built via the rill-guest `asset` SDK (crates/build.sh). On init
// it drives host:asset.info -> allocate a Surface -> host:asset.blit, resolving an
// app-package asset to decoded RGBA in its OWN linear memory (the ④ pixera path).
// rill knows nothing about host:asset, so a test-local dispatch RECORDS what the
// guest emitted AND writes the decoded bytes back through the host's bounds-checked
// writeBytes — exactly the seam the platform late-binds onto host:asset.blit.
const ASSET_GUEST = readFileSync(join(import.meta.dir, 'fixtures/asset-guest.wasm'));

const asNum = (v: unknown): number => Number(v) || 0;
const asStr = (v: unknown): string => String(v ?? '');
const field = (o: Record<string, unknown>, k: string): unknown => o[k];

type Call = { method: string; input: Record<string, unknown> };

interface AssetDispatchOptions {
  /** Decoded width host:asset.info reports (blit writes width*height*4 bytes). */
  width?: number;
  /** Decoded height host:asset.info reports. */
  height?: number;
  /** info resolves an EMPTY object (no width/height) — the fail-closed case. */
  infoReturnsEmpty?: boolean;
}

// A test-local host:asset capability. `hostRef.host` is late-bound (the dispatch
// is built BEFORE the WasmGuestHost so the blit impl can reach writeBytes). Both
// schemas are pass-through so the test asserts the exact wire the guest sent.
function assetDispatch(hostRef: { host?: WasmGuestHost }, options: AssetDispatchOptions = {}) {
  const w = options.width ?? 2;
  const h = options.height ?? 2;
  const calls: Call[] = [];
  // The exact RGBA bytes the host blitted, for the round-trip assertion.
  let blitted: Uint8Array | null = null;

  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:asset': {
        info: rpc<Record<string, unknown>, Record<string, unknown>>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => (x ?? {}) as Record<string, unknown>,
          },
        }),
        blit: rpc<Record<string, unknown>, Record<string, unknown>>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => (x ?? {}) as Record<string, unknown>,
          },
        }),
      },
    },
    guestExports: {},
  });

  const impl = implementHostModules(contract, {
    'host:asset': {
      info: async (input: Record<string, unknown>) => {
        calls.push({ method: 'info', input });
        if (options.infoReturnsEmpty) return {};
        return { width: w, height: h };
      },
      blit: async (input: Record<string, unknown>) => {
        calls.push({ method: 'blit', input });
        const dstPtr = asNum(field(input, 'dstPtr'));
        const dstCap = asNum(field(input, 'dstCap'));
        const n = w * h * 4;
        // The host refuses a buffer smaller than the decoded raster (fail-closed).
        if (dstCap < n) return { ok: false };
        // WRITE the decoded RGBA straight into the guest's buffer (a deterministic
        // pattern stands in for a real decode) via the bounds-checked writeBytes.
        const bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) bytes[i] = (i * 7 + 1) & 0xff;
        hostRef.host?.writeBytes(dstPtr, bytes);
        blitted = bytes;
        return { ok: true, written: n };
      },
    },
  });

  return {
    table: createHostModuleDispatch(contract, impl),
    calls,
    getBlitted: () => blitted,
  };
}

describe('asset guest — ④ host:asset.info + host:asset.blit into guest memory', () => {
  it('resolves info, allocates a buffer, and the host-blitted bytes land in guest memory', async () => {
    const hostRef: { host?: WasmGuestHost } = {};
    const { table, calls, getBlitted } = assetDispatch(hostRef, { width: 2, height: 2 });
    const host = new WasmGuestHost({ dispatch: table });
    hostRef.host = host;
    await host.load(ASSET_GUEST);
    await host.drain();

    // info was called first, keyed on the guest's asset id.
    const info = calls.find((c) => c.method === 'info');
    expect(info).toBeDefined();
    expect(asStr(field(info?.input ?? {}, 'assetId'))).toBe('logo');

    // blit followed, with a real guest pointer + a cap big enough for w*h*4.
    const blit = calls.find((c) => c.method === 'blit');
    expect(blit).toBeDefined();
    expect(asStr(field(blit?.input ?? {}, 'assetId'))).toBe('logo');
    const dstPtr = asNum(field(blit?.input ?? {}, 'dstPtr'));
    const dstCap = asNum(field(blit?.input ?? {}, 'dstCap'));
    expect(dstPtr).toBeGreaterThan(0);
    expect(dstCap).toBeGreaterThanOrEqual(2 * 2 * 4);

    // The guest saw a successful load and reported the host's byte count + dims.
    expect((host.exports.loaded as () => number)()).toBe(1);
    expect((host.exports.written as () => number)()).toBe(2 * 2 * 4);
    expect((host.exports.width as () => number)()).toBe(2);
    expect((host.exports.height as () => number)()).toBe(2);

    // The bytes the HOST wrote actually landed in the guest's linear memory:
    // read them back at the guest-owned buffer ptr and compare to what blit wrote.
    const bufPtr = (host.exports.buf_ptr as () => number)();
    expect(bufPtr).toBe(dstPtr); // the guest handed the host its own buffer ptr
    const readBack = host.readBytes(bufPtr, 2 * 2 * 4);
    const written = getBlitted();
    expect(written).not.toBeNull();
    expect(Array.from(readBack)).toEqual(Array.from(written ?? new Uint8Array()));
  });

  it('round-trips a non-trivial (larger) asset: every host-written byte matches', async () => {
    const hostRef: { host?: WasmGuestHost } = {};
    // asset-guest fixes its id to "logo"; the host decides the dimensions. A
    // larger raster exercises a multi-KB blit through writeBytes end to end.
    const { table, calls, getBlitted } = assetDispatch(hostRef, { width: 16, height: 16 });
    const host = new WasmGuestHost({ dispatch: table });
    hostRef.host = host;
    await host.load(ASSET_GUEST);
    await host.drain();

    const n = 16 * 16 * 4;
    expect((host.exports.loaded as () => number)()).toBe(1);
    expect((host.exports.written as () => number)()).toBe(n);
    const blit = calls.find((c) => c.method === 'blit');
    expect(asNum(field(blit?.input ?? {}, 'dstCap'))).toBeGreaterThanOrEqual(n);

    const bufPtr = (host.exports.buf_ptr as () => number)();
    expect(Array.from(host.readBytes(bufPtr, n))).toEqual(Array.from(getBlitted() ?? new Uint8Array()));
  });

  it('fail-closed: info resolving {} (no dims) never blits and never crashes the guest', async () => {
    const hostRef: { host?: WasmGuestHost } = {};
    const { table, calls } = assetDispatch(hostRef, { infoReturnsEmpty: true });
    const host = new WasmGuestHost({ dispatch: table });
    hostRef.host = host;
    await host.load(ASSET_GUEST);
    await host.drain(); // must not throw

    // info was attempted, blit was NOT (info returned None -> guest bailed).
    expect(calls.some((c) => c.method === 'info')).toBe(true);
    expect(calls.some((c) => c.method === 'blit')).toBe(false);
    // The guest stayed fail-closed: nothing loaded, no buffer, no crash.
    expect((host.exports.loaded as () => number)()).toBe(0);
    expect((host.exports.buf_ptr as () => number)()).toBe(0);
  });

  it('fail-closed: an unregistered host:asset (ok=0 from info) does not crash the guest', async () => {
    // Empty dispatch -> host:asset.info is not registered -> resolves ok=0 ->
    // the SDK asset::info returns None -> the guest bails before blit.
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(ASSET_GUEST);
    await host.drain(); // must not throw

    expect((host.exports.loaded as () => number)()).toBe(0);
    expect((host.exports.buf_ptr as () => number)()).toBe(0);
    expect((host.exports.written as () => number)()).toBe(0);
  });

  it('the asset guest imports only host-provided functions (the seal)', () => {
    const allowed = new Set(['rill_host_call', 'rill_send_batch', 'rill_log', 'rill_on_event']);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(ASSET_GUEST));
    for (const imp of imports) {
      expect(imp.module).toBe('env');
      expect(allowed.has(imp.name)).toBe(true);
    }
  });
});
