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

  /** Copy `len` bytes at `ptr` out of the guest's linear memory. */
  readBytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.memory.buffer.slice(ptr, ptr + len));
  }

  private readString(ptr: number, len: number): string {
    return new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  // --- render channel: guest rill_send_batch -> host onRenderBatch (-> receiver) ---
  private onSendBatch(ptr: number, len: number): void {
    if (!this.onRenderBatch) return;
    const batch = JSON.parse(this.readString(ptr, len)) as OperationBatch;
    this.onRenderBatch(batch);
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
    const moduleId = this.readString(mp, ml);
    const method = this.readString(xp, xl);
    // Copy the input synchronously — the async dispatch must not read a buffer
    // that a later rill_alloc could have detached by growing memory.
    const inputBytes = this.readBytes(ip, il);
    const task = (async () => {
      try {
        const input = il > 0 ? JSON.parse(new TextDecoder().decode(inputBytes)) : undefined;
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
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    const ptr = (this.instance.exports.rill_alloc as (n: number) => number)(bytes.length) >>> 0;
    // Re-read the buffer after alloc in case the guest grew its memory.
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    (
      this.instance.exports.rill_resolve as (
        cb: number,
        ok: number,
        ptr: number,
        len: number
      ) => void
    )(cb, ok, ptr, bytes.length);
  }
}
