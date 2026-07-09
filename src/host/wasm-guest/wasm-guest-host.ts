/**
 * WasmGuestHost — the host side of rill's native (non-JS) WASM guest boundary.
 *
 * A native guest is the app compiled straight to `.wasm` (Rust / C / Zig / …),
 * not JS running inside QuickJS. This host instantiates that module, injects the
 * host:* capabilities as WASM imports, and drives the linear-memory ABI:
 *
 *   guest --(rill_host_call)-->  host  --(dispatch)-->  host:* impl
 *   guest <--(rill_resolve)----  host  <--(result)----
 *
 * It **reuses the existing capability dispatch** (`createHostModuleDispatch`), so
 * a host:* implemented once serves both JS (QuickJS) and native guests — this is
 * purely additive to the QuickJS path (see docs/native-guest.zh.md). The async
 * model mirrors the QuickJS bridge's callback-resolve: a call returns at once and
 * the result comes back later via rill_resolve(cb_id, …).
 *
 * Seal: the guest can only reach what this importObject provides. No fetch /
 * socket / RTC (WASM has no ambient network; the host doesn't import them), and
 * an undeclared host module fails closed. The WASM import model *is* the sandbox.
 *
 * ABI v0 (headless / foundation):
 *   host  -> guest imports:  env.rill_host_call(mod_ptr,mod_len, method_ptr,method_len, in_ptr,in_len, cb_id)
 *                            env.rill_log(ptr,len)
 *   guest -> host  exports:  memory, rill_alloc(size)->ptr, rill_resolve(cb,ok,ptr,len), rill_init()
 *   guest -> host  exports (optional): rill_abi_version() -> u32
 *   wire: request/response bytes are UTF-8 JSON in the guest's linear memory,
 *         addressed by (ptr,len); the host reads guest memory bounds-checked
 *         (results are copied out).
 */
import type { HostModuleDispatchTable } from '../../contract';
import type { OperationBatch } from '../../shared/types';
import {
  decodeRequest as decodeRbs1Request,
  encodeResult as encodeRbs1Result,
  isRbs1,
} from '../wire/store-net-envelope';

/**
 * Guest ABI versions this host understands. A guest may declare its version via
 * the optional `rill_abi_version()` export; the host rejects any version outside
 * this set at load (fail-closed) and tolerates a guest that omits the export
 * (pre-versioning — the ABI v0/v1 wire is identical).
 */
export const SUPPORTED_GUEST_ABI_VERSIONS: ReadonlySet<number> = new Set([1]);

export interface WasmGuestHostOptions {
  /** Capability dispatch table from `createHostModuleDispatch(contract, impl)`. */
  dispatch: HostModuleDispatchTable;
  /** Sink for guest `rill_log` calls. */
  onLog?: (message: string) => void;
  /**
   * Sink for guest render batches (`rill_send_batch`). The batch wire is UTF-8
   * JSON in guest memory; the host decodes it to an `OperationBatch` and hands
   * it off — typically to `receiver.applyBatch`. Keeping this a callback leaves
   * `WasmGuestHost` decoupled from the receiver.
   */
  onRenderBatch?: (batch: OperationBatch) => void;
}

export class WasmGuestHost {
  private instance!: WebAssembly.Instance;
  private memory!: WebAssembly.Memory;
  private readonly dispatch: HostModuleDispatchTable;
  private readonly onLog?: (message: string) => void;
  private readonly onRenderBatch?: (batch: OperationBatch) => void;
  private readonly inflight = new Set<Promise<void>>();
  private abiVersion: number | null = null;

  constructor(options: WasmGuestHostOptions) {
    this.dispatch = options.dispatch;
    this.onLog = options.onLog;
    this.onRenderBatch = options.onRenderBatch;
  }

  /**
   * The ABI version the loaded guest declared via `rill_abi_version()`, or
   * `null` when the guest predates the export (tolerated). Undefined until
   * `load()` runs.
   */
  get guestAbiVersion(): number | null {
    return this.abiVersion;
  }

  /** Instantiate the guest `.wasm`, wire host imports, and run its entry. */
  async load(wasmBytes: BufferSource): Promise<void> {
    const importObject: WebAssembly.Imports = {
      env: {
        rill_host_call: (
          mp: number,
          ml: number,
          xp: number,
          xl: number,
          ip: number,
          il: number,
          cb: number
        ) => this.onHostCall(mp >>> 0, ml >>> 0, xp >>> 0, xl >>> 0, ip >>> 0, il >>> 0, cb >>> 0),
        rill_log: (ptr: number, len: number) => this.onLog?.(this.readString(ptr >>> 0, len >>> 0)),
        rill_send_batch: (ptr: number, len: number) => this.onSendBatch(ptr >>> 0, len >>> 0),
      },
    };
    const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
    this.instance = instance;
    this.memory = instance.exports.memory as WebAssembly.Memory;

    // ABI version gate BEFORE rill_init: a guest that declares an unsupported
    // version must not run its entry (fail-closed). A guest that omits the
    // export is a pre-versioning guest and is tolerated.
    const versionExport = instance.exports.rill_abi_version;
    if (typeof versionExport === 'function') {
      // May trap (guest code): let it propagate — a guest whose version probe
      // traps must not run (same fail-closed posture as a failed instantiate).
      const version = (versionExport as () => number)() >>> 0;
      if (!SUPPORTED_GUEST_ABI_VERSIONS.has(version)) {
        throw new Error(
          `unsupported guest ABI version: ${version} (host supports: ${[...SUPPORTED_GUEST_ABI_VERSIONS].join(', ')})`
        );
      }
      this.abiVersion = version;
    } else {
      this.abiVersion = null; // pre-versioning guest (ABI v0/v1 wire is identical): tolerated
    }

    (instance.exports.rill_init as (() => void) | undefined)?.();
  }

  /** Resolve once every in-flight host call has run its rill_resolve. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  get exports(): WebAssembly.Exports {
    return this.instance.exports;
  }

  /**
   * Deliver an event (name + JSON payload) to the guest's `rill_on_event`
   * export. No-op if the guest doesn't export it. One-way, like the render
   * channel — this is how input / lifecycle events reach a native guest.
   */
  // Reason: an event payload is any JSON-serializable value, only stringified here.
  emitEvent(name: string, payload?: unknown): void {
    const onEvent = this.instance.exports.rill_on_event as
      | ((np: number, nl: number, pp: number, pl: number) => void)
      | undefined;
    if (typeof onEvent !== 'function') return;
    try {
      const nameBytes = new TextEncoder().encode(name);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload ?? null));
      const np = this.allocWrite(nameBytes);
      const pp = this.allocWrite(payloadBytes);
      onEvent(np, nameBytes.length, pp, payloadBytes.length);
    } catch {
      // Delivery is guest-mediated (rill_alloc can hand back a bad pointer,
      // rill_on_event can trap). A hostile/broken guest must not make event
      // delivery throw into the host — drop the event. Same fail-closed
      // contract as onHostCall / onSendBatch.
    }
  }

  /** Allocate guest memory via rill_alloc and copy `bytes` in; returns the ptr. */
  private allocWrite(bytes: Uint8Array): number {
    const ptr = (this.instance.exports.rill_alloc as (n: number) => number)(bytes.length) >>> 0;
    // rill_alloc returning 0 (NULL) is the allocator's failure signal (e.g. the
    // SDK's bump heap is exhausted). Address 0 is IN bounds, so without this
    // check the write below would silently corrupt whatever the guest keeps at
    // the bottom of its linear memory. Fail closed instead.
    if (ptr === 0 && bytes.length > 0) {
      throw new Error(`guest rill_alloc failed (returned 0) for ${bytes.length} bytes`);
    }
    // rill_alloc is guest code: a broken/exhausted allocator can hand back a
    // pointer that doesn't fit. Validate before writing (re-reads the buffer,
    // which may have grown during alloc). Fails closed instead of writing OOB.
    this.assertInBounds(ptr, bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  }

  /** Copy `len` bytes at `ptr` out of the guest's linear memory (bounds-checked). */
  readBytes(ptr: number, len: number): Uint8Array {
    this.assertInBounds(ptr, len);
    return new Uint8Array(this.memory.buffer.slice(ptr, ptr + len));
  }

  /**
   * Copy `bytes` INTO the guest's linear memory at `ptr` (bounds-checked, the
   * WRITE counterpart of readBytes — the host:asset `blit` path). `ptr`/len are
   * guest-supplied and UNTRUSTED: assertInBounds fails closed (throws, caught by
   * the caller) so a hostile ptr/cap can NEVER write past guest memory. The write
   * targets a LIVE view over `memory.buffer` (unlike readBytes' slice-copy) — that
   * is the point, we are handing decoded bytes to the guest — but the bounds check
   * re-reads `memory.buffer.byteLength` first, so a memory.grow that happened
   * during the async decode is accounted for before the write lands.
   */
  writeBytes(ptr: number, bytes: Uint8Array): void {
    this.assertInBounds(ptr, bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
  }

  private readString(ptr: number, len: number): string {
    this.assertInBounds(ptr, len);
    return new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  /**
   * Reject guest-supplied (ptr, len) that fall outside linear memory. The guest
   * is untrusted, so a bad pointer must fail here (caught by the call site and
   * turned into a fail-closed result), not read OOB or crash the host.
   */
  private assertInBounds(ptr: number, len: number): void {
    if (
      !Number.isInteger(ptr) ||
      !Number.isInteger(len) ||
      ptr < 0 ||
      len < 0 ||
      ptr + len > this.memory.buffer.byteLength
    ) {
      throw new Error(`guest pointer out of bounds: ptr=${ptr} len=${len}`);
    }
  }

  // --- render channel: guest rill_send_batch -> host onRenderBatch (-> receiver) ---
  private onSendBatch(ptr: number, len: number): void {
    if (!this.onRenderBatch) return;
    try {
      const batch = JSON.parse(this.readString(ptr, len)) as OperationBatch;
      this.onRenderBatch(batch);
    } catch {
      // A hostile/malformed batch (bad pointer, non-JSON, wrong shape) must not
      // crash the host — drop it.
    }
  }

  // --- ABI bridge: guest rill_host_call -> host dispatch -> guest rill_resolve ---
  private onHostCall(
    mp: number,
    ml: number,
    xp: number,
    xl: number,
    ip: number,
    il: number,
    cb: number
  ): void {
    // Everything guest-controlled (pointers, bytes, JSON) is read inside the try
    // so a hostile or malformed call fails closed (resolve ok=0) instead of
    // crashing the host.
    const task = (async () => {
      try {
        // MEMORY-SAFETY CRITICAL (cross-crate invariant): the host must never
        // resolve synchronously inside a guest-initiated call. rill_resolve
        // re-enters the guest's single-task executor, and re-polling a future
        // that is still mid-poll is not merely a stack overflow — it aliases
        // `&mut` on the guest's `static mut TASK`, i.e. undefined behavior in the
        // guest. Yielding here defers all reads + resolve to a microtask after
        // the guest has parked (it is suspended until then, so its buffer is
        // stable and no future is mid-poll). Do not remove this await.
        await Promise.resolve();
        const moduleId = this.readString(mp, ml);
        const method = this.readString(xp, xl);
        // Payload framing fork (canvas-wire.DESIGN.md §1.4 + store-net-bytes
        // §B.2). Each binary wire has a DISTINCT 4-byte magic, all sharing byte 0
        // (0x52 'R'), so the fork compares the FULL u32 — never byte 0 alone:
        //   - 'RCNV' (52 43 4E 56) -> hand RAW BYTES to a binary-aware capability
        //     (host:canvas.draw) to decode itself.
        //   - 'RBS1' (52 42 53 31) -> decode the RBS1 envelope here and revive
        //     each {"$b":N} sentinel into a Uint8Array, then hand the
        //     contract-agnostic args to dispatch (the codec is self-describing —
        //     no per-module knowledge). A malformed frame throws and fails closed.
        //   - anything else -> the legacy JSON.parse path, byte-for-byte
        //     unchanged (a JSON body '{…}'/'[…]' matches no magic). Genuinely
        //     malformed input still throws here and fails closed (ok=0).
        // Reason: the guest-supplied call input is untrusted bytes until a magic fork decodes it.
        let input: unknown;
        if (il > 0) {
          const raw = this.readBytes(ip, il);
          const isCanvasBinary =
            raw.length >= 4 &&
            raw[0] === 0x52 &&
            raw[1] === 0x43 &&
            raw[2] === 0x4e &&
            raw[3] === 0x56;
          if (isCanvasBinary) {
            input = raw;
          } else if (isRbs1(raw)) {
            input = decodeRbs1Request(raw);
          } else {
            input = JSON.parse(new TextDecoder().decode(raw));
          }
        } else {
          input = undefined;
        }
        const handler = this.dispatch[moduleId]?.[method];
        if (typeof handler !== 'function') {
          throw new Error(`host module not registered: ${moduleId}.${method}`);
        }
        const result = await handler(input);
        this.resolve(cb, 1, result === undefined ? null : result);
      } catch (err) {
        this.resolve(cb, 0, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }

  /** Write a JSON result into guest memory (via rill_alloc) and hand it back. */
  // Reason: a host module result is any JSON-serializable value, only stringified here.
  private resolve(cb: number, ok: number, result: unknown): void {
    // Writing the result back is guest-mediated (rill_alloc can return a bad
    // pointer, the rill_resolve export can trap). Absorb any failure here so it
    // never escapes the async task — otherwise the catch in onHostCall would
    // call resolve() again, throw again, and reject drain(). On failure the cb
    // is simply abandoned (the guest never sees a resolution), staying fail-closed.
    try {
      // Return framing fork (store-net-bytes §B.3), symmetric with the receive
      // fork. When the handler result carries at least one Uint8Array, encode an
      // RBS1 envelope (hoisting each byte stream to a segment + a {"$b":N}
      // sentinel); when it carries none, `encodeRbs1Result` returns null and the
      // reply is the IDENTICAL JSON.stringify bytes as today — no behaviour
      // change for any existing (non-binary) capability. Contract-agnostic: the
      // hoist is driven by the runtime type (Uint8Array), not per-module config.
      const envelope = encodeRbs1Result(result);
      const bytes = envelope ?? new TextEncoder().encode(JSON.stringify(result));
      const ptr = this.allocWrite(bytes);
      (
        this.instance.exports.rill_resolve as (
          cb: number,
          ok: number,
          ptr: number,
          len: number
        ) => void
      )(cb, ok, ptr, bytes.length);
    } catch {
      // guest-mediated write failed; abandon this cb.
    }
  }
}
