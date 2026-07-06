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
 *   wire: request/response bytes are UTF-8 JSON in the guest's linear memory,
 *         addressed by (ptr,len); the host reads guest memory zero-copy.
 */
import type { HostModuleDispatchTable } from '../../contract';
import type { OperationBatch } from '../../shared/types';

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

  constructor(options: WasmGuestHostOptions) {
    this.dispatch = options.dispatch;
    this.onLog = options.onLog;
    this.onRenderBatch = options.onRenderBatch;
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
        const input = il > 0 ? JSON.parse(this.readString(ip, il)) : undefined;
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
      const bytes = new TextEncoder().encode(JSON.stringify(result));
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
