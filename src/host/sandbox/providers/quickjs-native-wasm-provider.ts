/**
 * QuickJSNativeWASMProvider - Native QuickJS compiled to WASM
 *
 * Uses C API bindings (wasm_bindings.c) to interface with QuickJS.
 * Provides true isolated sandbox where setTimeout/timers work correctly.
 *
 * Build:
 *   cd rill/native/quickjs
 *   ./build-wasm.sh release
 *
 * Output:
 *   quickjs-sandbox.{js,wasm} → copied to rill/src/host/sandbox/wasm/
 */

import type { HostModuleDispatchTable, RillContractShape } from '../../../contract';
import type { ReviewedUnknown } from '../../types';
import type { JSEngineProvider, JSEngineRuntime, SandboxScope } from '../types/provider';

/**
 * Type definitions for the WASM module C API
 */
interface QuickJSWASMModule {
  // Emscripten utilities
  ccall: (
    name: string,
    returnType: string | null,
    argTypes: string[],
    args: ReviewedUnknown[]
  ) => ReviewedUnknown;
  cwrap: (
    name: string,
    returnType: string | null,
    argTypes: string[]
  ) => (...args: ReviewedUnknown[]) => ReviewedUnknown;
  // biome-ignore lint/complexity/noBannedTypes: Emscripten API requires Function type
  addFunction: (fn: Function, signature: string) => number;
  removeFunction: (ptr: number) => void;
  UTF8ToString: (ptr: number) => string;
  stringToUTF8: (str: string, outPtr: number, maxBytes: number) => void;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;

  // QuickJS C API bindings
  _qjs_init: () => number;
  _qjs_destroy: () => void;
  /** Arm the guest execution deadline (ms from now); <= 0 clears it. */
  _qjs_set_deadline: (msFromNow: number) => void;
  _qjs_eval: (codePtr: number) => number;
  _qjs_eval_void: (codePtr: number) => number;
  _qjs_inject_json: (namePtr: number, valuePtr: number) => number;
  _qjs_extract_json: (namePtr: number) => number;
  _qjs_set_host_callback: (fnPtr: number) => void;
  _qjs_set_host_binary_callback: (fnPtr: number) => void;
  _qjs_binary_stage: (ptr: number, len: number) => number;
  _qjs_binary_ptr: (id: number) => number;
  _qjs_binary_len: (id: number) => number;
  _qjs_binary_free: (id: number) => void;
  _qjs_binary_count: () => number;
  _qjs_install_host_functions: () => void;
  _qjs_set_timer_callback: (fnPtr: number) => void;
  _qjs_install_timer_functions: () => void;
  _qjs_fire_timer: (timerId: number) => void;
  _qjs_install_console: () => void;
  _qjs_execute_pending_jobs: () => number;
  _qjs_free_string: (ptr: number) => void;
  _qjs_get_memory_usage: () => number;
}

/**
 * Factory function exported by Emscripten
 */
type QuickJSWASMFactoryModuleArg = {
  locateFile?: (path: string, scriptDirectory?: string) => string;
  // Provide the .wasm bytes directly so the loader instantiates from memory and
  // never fetches — required under a strict CSP (connect-src 'none').
  wasmBinary?: Uint8Array | ArrayBuffer;
};

type QuickJSWASMFactory = (moduleArg?: QuickJSWASMFactoryModuleArg) => Promise<QuickJSWASMModule>;

/**
 * Provider options
 */
export interface QuickJSNativeWASMProviderOptions {
  /**
   * Path to WASM loader module (Emscripten-generated JS).
   * Must be a valid module specifier for dynamic `import()`.
   *
   * @default '../wasm/quickjs-sandbox.js'
   */
  loaderPath?: string;

  /**
   * Override the `.wasm` binary location.
   *
   * If not set, the loader resolves `quickjs-sandbox.wasm` relative to itself.
   */
  wasmPath?: string;

  /**
   * Provide the `.wasm` bytes directly. When set, the loader instantiates from
   * these bytes and performs NO network fetch — required to run under a strict
   * CSP such as `connect-src 'none'`. Takes precedence over `wasmPath`.
   */
  wasmBinary?: Uint8Array | ArrayBuffer;

  /**
   * Custom WASM module factory
   */
  wasmFactory?: QuickJSWASMFactory;

  /**
   * Execution timeout in milliseconds — the budget for a SINGLE synchronous
   * entry into guest code (eval, callback dispatch, microtask drain), not the
   * app lifetime. Runaway guest code (e.g. `while(true){}`) is interrupted
   * once the budget is exceeded.
   *
   * @default 5000
   */
  timeout?: number;

  /**
   * Debug logging
   */
  debug?: boolean;
}

// Timer/microtask host functions whose FIRST argument is a guest callback. The isolated
// WASM realm can't pass a function reference over the JSON bridge, so the guest shim
// registers the callback in __rill.callbacks (the same registry the reconciler uses for
// function props) and sends a {__rill_cb:id} marker instead (issue #10). Release lifetimes
// differ, so the timer family gets per-shape shims.
const ONE_SHOT_CALLBACK_FNS = new Set(['setTimeout', 'setImmediate', 'queueMicrotask']);
const REPEATING_CALLBACK_FNS = new Set(['setInterval']);
const CLEAR_TIMER_FNS = new Set(['clearTimeout', 'clearInterval', 'clearImmediate']);
// A clear maps to the family it cancels. The host timer id -> cb id map is keyed by
// "<family>:<hostId>" because setTimeout/setInterval/setImmediate use INDEPENDENT id
// counters that all start at 1 — a flat numeric key would let a clearTimeout(1) release
// an unrelated setInterval(1) callback (cross-family collision).
const CLEAR_TO_FAMILY: Record<string, string> = {
  clearTimeout: 'setTimeout',
  clearInterval: 'setInterval',
  clearImmediate: 'setImmediate',
};

// Guest-side preamble: ensure the callback registry exists. The timer/console shims are
// injected before the guest runtime helpers eval, so a host fn may be called before
// RUNTIME_HELPERS_CODE defines the registry — this seeds a compatible one (same Map, same
// 'fn_N' id scheme, idempotent) so a callback argument is never silently dropped.
const ENSURE_CB_REGISTRY = `
  var R = globalThis.__rill || (globalThis.__rill = {});
  if (!R.callbacks) { R.callbacks = new Map(); }
  if (typeof R.callbackId !== 'number') { R.callbackId = 0; }
  if (typeof R.registerCallback !== 'function') { R.registerCallback = function(fn){ var id = 'fn_' + (++R.callbackId); R.callbacks.set(id, fn); return id; }; }
  if (typeof R.invokeCallback !== 'function') { R.invokeCallback = function(id, args){ var fn = R.callbacks.get(id); if (fn) return fn.apply(null, args || []); }; }
  if (typeof R.removeCallback !== 'function') { R.removeCallback = function(id){ R.callbacks.delete(id); }; }
  if (!R.__timerCb) { R.__timerCb = {}; }`;

// ---- First-class binary marshalling for the JSON string bridge ({"$bin":id}) ----
//
// The QuickJS shell is a SYNCHRONOUS JSON STRING BRIDGE, not postMessage: guest args are
// JSON.stringify'd by __sendToHost (wasm_bindings.c js_send_to_host) and host results are
// JSON.stringify'd here (resolveHostCall). An ArrayBuffer crossing that bridge naively
// degrades to "{}" and a view to a `{"0":..}` index object — the bytes are destroyed or
// bloated ~4-6x and never arrive as real binary.
//
// Fix: bytes never ride inside the JSON at all. Each ArrayBuffer / view is parked in a
// C-side staging table in wasm LINEAR MEMORY (wasm_bindings.c) and referenced from the
// JSON as the reserved sentinel {"$bin":id} — plus {"$view":kind} for views, so the
// receiving side rebuilds the same view type over the same byte window.
//
//   guest -> host: the guest codec calls the native __rill_stageBinary(view) -> id; after
//     JSON.parse the host copies each referenced window out of HEAPU8 and frees the id.
//   host -> guest: the host _malloc's the bytes into linear memory and parks them via
//     qjs_binary_stage(ptr,len); the guest codec's __rill_takeBinary(id) adopts the block
//     into a JS ArrayBuffer (zero-copy) and removes the entry.
//
// Lifecycle discipline: every id is consumed EXACTLY ONCE, and consumption frees the
// table entry. Senders blanket-free all ids of a payload in a finally (a no-op for
// consumed ids), so a failed crossing cannot leak; qjs_destroy clears any remainder and
// qjs_binary_count() lets tests assert zero leakage. Non-binary values are returned by
// identity (same reference), so their JSON.stringify output is byte-for-byte unchanged.

/** Reserved JSON sentinel for a staged binary payload. */
interface BinSentinel {
  $bin: number;
  $view?: string;
}

// Typed-array view kinds that cross the bridge with their type intact. A sentinel with an
// unknown or unavailable $view falls back to Uint8Array — the bytes stay exact either way.
const VIEW_CONSTRUCTORS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  ...(typeof BigInt64Array === 'function' ? { BigInt64Array } : {}),
  ...(typeof BigUint64Array === 'function' ? { BigUint64Array } : {}),
  DataView,
};

/**
 * The exact byte window of an ArrayBuffer or view — byteOffset/byteLength respected,
 * never the whole backing buffer. Returns null for non-binary values.
 */
function binaryWindowOf(value: ReviewedUnknown): { bytes: Uint8Array; view?: string } | null {
  if (value instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(value) };
  }
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return {
      bytes: new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength),
      view: Object.prototype.toString.call(v).slice(8, -1),
    };
  }
  return null;
}

/**
 * Copy `bytes` into wasm linear memory and park them in the C staging table, which takes
 * ownership of the block. Returns the id for the {"$bin":id} sentinel. Throws on
 * allocation failure — the caller's finally releases any ids staged before the throw.
 */
function stageHostBinary(module: QuickJSWASMModule, bytes: Uint8Array): number {
  let ptr = 0;
  if (bytes.byteLength > 0) {
    ptr = module._malloc(bytes.byteLength);
    if (!ptr) {
      throw new Error(`[QuickJSWASM] _malloc(${bytes.byteLength}) failed while staging binary`);
    }
    // Re-read HEAPU8 AFTER _malloc: allocation may grow (and re-create) the heap view.
    module.HEAPU8.set(bytes, ptr);
  }
  const id = module._qjs_binary_stage(ptr, bytes.byteLength);
  if (!id) {
    // qjs_binary_stage freed the block on failure; nothing left to release here.
    throw new Error('[QuickJSWASM] binary staging table insert failed');
  }
  return id;
}

/**
 * Copy a staged block out of wasm linear memory and free the table entry (consume-once).
 * slice() copies BEFORE the free, so the returned buffer is host-owned. An unknown or
 * already-consumed id yields an empty buffer.
 */
function takeStagedBinary(module: QuickJSWASMModule, id: number): ArrayBuffer {
  const ptr = module._qjs_binary_ptr(id);
  const len = module._qjs_binary_len(id);
  const bytes = module.HEAPU8.slice(ptr, ptr + len);
  module._qjs_binary_free(id);
  return bytes.buffer as ArrayBuffer;
}

/**
 * Failure-path cleanup: free every staged id of a payload. Freeing a consumed id is a
 * no-op in C, so this is safe to run unconditionally in a finally.
 */
function freeStagedIds(module: QuickJSWASMModule, ids: number[]): void {
  for (const id of ids) {
    module._qjs_binary_free(id);
  }
}

/** Detect the reserved sentinel shape: sole key $bin (number), optionally plus $view. */
function asBinSentinel(value: ReviewedUnknown): BinSentinel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, ReviewedUnknown>;
  if (typeof obj.$bin !== 'number') return null;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === '$bin') return obj as unknown as BinSentinel;
  if (
    keys.length === 2 &&
    typeof obj.$view === 'string' &&
    keys.includes('$bin') &&
    keys.includes('$view')
  ) {
    return obj as unknown as BinSentinel;
  }
  return null;
}

/**
 * Replace every ArrayBuffer / view in `value` with a {"$bin":id} sentinel, staging the
 * bytes into wasm memory and recording each id in `stagedIds` (for finally cleanup).
 * Identity-preserving: containers are only re-allocated when a descendant changes, so a
 * value with no binary is returned by the same reference and stringifies unchanged.
 * Throws a TypeError on circular structures (like JSON.stringify would — but the walk
 * runs first, so it must not recurse forever); the caller's finally releases whatever
 * was staged before the throw.
 */
function encodeBinaryValue(
  module: QuickJSWASMModule,
  value: ReviewedUnknown,
  stagedIds: number[],
  stack: WeakSet<object> = new WeakSet()
): ReviewedUnknown {
  const win = binaryWindowOf(value);
  if (win) {
    const id = stageHostBinary(module, win.bytes);
    stagedIds.push(id);
    return win.view ? { $bin: id, $view: win.view } : { $bin: id };
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError('[QuickJSWASM] circular structure in payload');
    stack.add(value);
    let copy: ReviewedUnknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const enc = encodeBinaryValue(module, value[i], stagedIds, stack);
      if (enc !== value[i]) {
        if (!copy) copy = value.slice();
        copy[i] = enc;
      }
    }
    stack.delete(value);
    return copy ?? value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, ReviewedUnknown>;
    if (stack.has(obj)) throw new TypeError('[QuickJSWASM] circular structure in payload');
    stack.add(obj);
    const keys = Object.keys(obj);
    let copy: Record<string, ReviewedUnknown> | null = null;
    for (const k of keys) {
      const enc = encodeBinaryValue(module, obj[k], stagedIds, stack);
      if (enc !== obj[k]) {
        if (!copy) {
          copy = {};
          for (const kk of keys) copy[kk] = obj[kk];
        }
        copy[k] = enc;
      }
    }
    stack.delete(obj);
    return copy ?? value;
  }
  return value;
}

/**
 * Collect every staged-binary id referenced by a freshly parsed payload, so the receiver
 * can blanket-free them in a finally even when a branch never revives (unknown module,
 * handler missing, throw mid-dispatch).
 */
function collectBinIds(value: ReviewedUnknown, out: number[]): void {
  const sentinel = asBinSentinel(value);
  if (sentinel) {
    out.push(sentinel.$bin);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBinIds(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, ReviewedUnknown>;
    for (const k of Object.keys(obj)) collectBinIds(obj[k], out);
  }
}

/**
 * Revive every {"$bin":id} sentinel back to a real ArrayBuffer (or the recorded view
 * type), consuming the staged bytes. Mutates the freshly-parsed tree in place.
 */
function reviveBinaryValue(module: QuickJSWASMModule, value: ReviewedUnknown): ReviewedUnknown {
  const sentinel = asBinSentinel(value);
  if (sentinel) {
    const buffer = takeStagedBinary(module, sentinel.$bin);
    if (sentinel.$view === undefined) return buffer;
    const Ctor = VIEW_CONSTRUCTORS[sentinel.$view];
    return Ctor ? new Ctor(buffer) : new Uint8Array(buffer);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveBinaryValue(module, value[i]);
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, ReviewedUnknown>;
    for (const k of Object.keys(obj)) obj[k] = reviveBinaryValue(module, obj[k]);
    return obj;
  }
  return value;
}

// Guest-side twin of the codec above, installed once per context BEFORE any guest code
// runs, so every later shim (host fns, host modules, inject/extract) can rely on
// __rill.__binenc/__binrev. __rill_stageBinary/__rill_takeBinary are the native staging
// helpers registered by qjs_install_host_functions. Views are staged through a Uint8Array
// wrapper so the native helper always receives an exact byte window (byteOffset/byteLength
// respected — this includes DataView, which JS_GetTypedArrayBuffer does not cover); the
// view kind rides in $view so the peer rebuilds the same type. The encode walker preserves
// identity so non-binary payloads stringify byte-for-byte unchanged.
const GUEST_BINARY_CODEC = `
  (function () {
    var R = globalThis.__rill || (globalThis.__rill = {});
    if (R.__binenc) return;
    var VIEWS = {};
    ['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array',
     'Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','DataView'
    ].forEach(function (n) { if (typeof globalThis[n] === 'function') VIEWS[n] = globalThis[n]; });
    function tag(v) { return Object.prototype.toString.call(v).slice(8, -1); }
    // stack: cycle guard (throws like JSON.stringify would; this walk runs first).
    R.__binenc = function enc(v, stack) {
      if (v instanceof ArrayBuffer) { return { $bin: __rill_stageBinary(v) }; }
      if (ArrayBuffer.isView(v)) {
        return { $bin: __rill_stageBinary(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), $view: tag(v) };
      }
      if (Array.isArray(v)) {
        stack = stack || [];
        if (stack.indexOf(v) >= 0) { throw new TypeError('circular structure in payload'); }
        stack.push(v);
        var a = null;
        for (var i = 0; i < v.length; i++) { var e = enc(v[i], stack); if (e !== v[i]) { if (!a) a = v.slice(); a[i] = e; } }
        stack.pop();
        return a || v;
      }
      if (v && typeof v === 'object') {
        stack = stack || [];
        if (stack.indexOf(v) >= 0) { throw new TypeError('circular structure in payload'); }
        stack.push(v);
        var o = null, keys = Object.keys(v);
        for (var j = 0; j < keys.length; j++) {
          var k = keys[j], e2 = enc(v[k], stack);
          if (e2 !== v[k]) { if (!o) { o = {}; for (var m = 0; m < keys.length; m++) o[keys[m]] = v[keys[m]]; } o[k] = e2; }
        }
        stack.pop();
        return o || v;
      }
      return v;
    };
    R.__binrev = function rev(v) {
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = rev(v[i]); return v; }
      if (v && typeof v === 'object') {
        var keys = Object.keys(v);
        if (typeof v.$bin === 'number' &&
            ((keys.length === 1 && keys[0] === '$bin') ||
             (keys.length === 2 && typeof v.$view === 'string' &&
              keys.indexOf('$bin') >= 0 && keys.indexOf('$view') >= 0))) {
          var ab = __rill_takeBinary(v.$bin);
          if (typeof v.$view !== 'string') return ab;
          var C = VIEWS[v.$view];
          return C ? new C(ab) : new Uint8Array(ab);
        }
        for (var j = 0; j < keys.length; j++) v[keys[j]] = rev(v[keys[j]]);
        return v;
      }
      return v;
    };
  })();`;

// ---- Cross-boundary error fidelity ----
//
// A guest throw crosses the bridge as {"error":"<message>"} plus an OPTIONAL
// "errorDetail" sibling ({name, stack?, props?}) produced by the guest-side
// encoder below. The bare {"error":...} shape keeps its exact current meaning;
// in particular the deadline-interrupt marker (INTERRUPTED_ERROR_JSON) stays
// byte-identical and is the ONLY payload in the system without an errorDetail
// sibling. That invariant is ENFORCED in C (wasm_bindings.c), not just by
// construction: globalThis.__rill is a plain writable global a guest can
// replace wholesale, so encode_guest_error discards a marker-identical
// __errenc return (falling back to the message-only path, whose errorDetail
// is mandatory), and qjs_eval rewrites a completion value whose JSON is
// marker-identical to carry errorDetail too. Only a real g_interrupted
// deadline — a channel the guest cannot influence — produces the bare marker.
//
// Direction asymmetry (security): guest->host errors are revived with full
// fidelity (name, guest stack, own JSON-safe props) and the host stack is
// appended after a boundary marker; host->guest rejections carry name +
// message + own JSON-safe props but NEVER the host stack (information
// disclosure to an untrusted guest).

// Separates guest frames (above) from rill-runtime host frames (below) in a
// revived error's stack. Follows the quickjs-emscripten unwrapResult pattern.
export const HOST_STACK_BOUNDARY = '    --- host stack (rill runtime; frames above are guest) ---';

// Host-side DoS caps mirroring the guest encoder.
const MAX_ERROR_PROPS = 64;
const MAX_STACK_CHARS = 16384;

/** Optional rich sibling of the wire "error" message (see GUEST_ERROR_CODEC). */
interface GuestErrorDetail {
  name?: ReviewedUnknown;
  stack?: ReviewedUnknown;
  props?: ReviewedUnknown;
}

/** Guest-error payload (guest -> host) revived to a host Error with full fidelity. */
function reviveGuestError(parsed: {
  error?: ReviewedUnknown;
  errorDetail?: GuestErrorDetail;
}): Error {
  const message = String(parsed.error);
  const err = new Error(message); // message via ctor
  const hostStack = err.stack ?? ''; // capture BEFORE overwrite
  const d = parsed.errorDetail;
  if (d && typeof d === 'object') {
    if (typeof d.name === 'string') err.name = d.name; // explicit field
    if (d.props && typeof d.props === 'object') {
      const props = d.props as Record<string, ReviewedUnknown>;
      let n = 0;
      for (const k of Object.keys(props)) {
        if (n >= MAX_ERROR_PROPS) break;
        if (k === 'name' || k === 'message' || k === 'stack') continue;
        // Prototype-pollution defense: guest-controlled key names are applied
        // ONLY via defineProperty (never plain assignment).
        Object.defineProperty(err, k, {
          value: props[k],
          writable: true,
          enumerable: true,
          configurable: true,
        });
        n++;
      }
    }
    if (typeof d.stack === 'string') {
      const guest = d.stack.endsWith('\n') ? d.stack : `${d.stack}\n`;
      let combined = `${err.name}: ${err.message}\n${guest}${HOST_STACK_BOUNDARY}\n${hostStack}`;
      if (combined.length > MAX_STACK_CHARS) {
        combined = `${combined.slice(0, MAX_STACK_CHARS)}\n...[truncated]`;
      }
      err.stack = combined;
    }
  }
  return err;
}

/**
 * Host error (host -> guest rejection) serialized to a plain payload. NO stack —
 * the host stack never crosses to the untrusted guest. Accepts a string too
 * (e.g. the not-registered rejection message).
 *
 * MUST NOT throw: it runs synchronously inside rejectHostCall; if it threw, the
 * guest RPC promise would hang forever. A host Error with a throwing
 * own-enumerable accessor, or a throwing message getter, would otherwise trip
 * this — the whole body is wrapped so it always yields a well-formed payload.
 *
 * SECURITY NOTE: own enumerable JSON-safe props ARE forwarded to the untrusted
 * guest by design. Host-module authors must be aware that custom Error props
 * (e.g. Node fs errors' path/syscall, DB errors' query text) cross the trust
 * boundary. The host STACK is never sent; props are. To withhold props, throw
 * a plain Error whose message omits sensitive context.
 */
// Reason: a thrown/rejected host value can be any type before it is normalized.
function serializeHostError(err: unknown): {
  message: string;
  name: string;
  props?: Record<string, unknown>;
} {
  try {
    if (err instanceof Error) {
      const props: Record<string, unknown> = {};
      let n = 0;
      for (const k of Object.keys(err)) {
        // own enumerable only
        if (n >= MAX_ERROR_PROPS) break;
        if (k === 'name' || k === 'message' || k === 'stack') continue;
        // Reason: an own error property can hold any JSON-serializable value.
        let v: unknown;
        // Per-key isolation: a throwing accessor skips only that key.
        try {
          v = (err as unknown as Record<string, unknown>)[k];
        } catch {
          continue;
        }
        if (typeof v === 'undefined' || typeof v === 'function') continue;
        // Drop binary explicitly: JSON.stringify(view/ArrayBuffer) is lossy,
        // not throwing. No $bin staging on error paths.
        if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) continue;
        try {
          JSON.stringify(v);
        } catch {
          continue; // JSON-plain only
        }
        props[k] = v;
        n++;
      }
      const message = typeof err.message === 'string' ? err.message : String(err.message);
      const out: { message: string; name: string; props?: Record<string, unknown> } = {
        message,
        name: err.name || 'Error',
      };
      if (Object.keys(props).length) out.props = props;
      return out;
    }
    return { message: typeof err === 'string' ? err : String(err), name: 'Error' };
  } catch {
    // Last-resort: guarantee a well-formed payload so the guest promise settles.
    return { message: '[rill] host error', name: 'Error' };
  }
}

// Guest-side error encoder, installed by the provider prelude right after the
// binary codec (before ANY guest code runs). The C side (encode_guest_error in
// wasm_bindings.c) looks up globalThis.__rill.__errenc and calls it with the
// thrown value; on any failure it falls back to a C-escaped message-only
// payload. Both this encoder's catch fallback and the C fallback still emit
// the errorDetail sibling — mandatory. This alone is NOT the marker-forgery
// defense (a guest can replace globalThis.__rill and its __errenc wholesale);
// the C caller additionally rejects any __errenc return byte-identical to the
// bare interrupt marker.
const GUEST_ERROR_CODEC = `
  (function () {
    var R = globalThis.__rill || (globalThis.__rill = {});
    if (R.__errenc) return;
    var SKIP = { name: 1, message: 1, stack: 1 };
    var MAX_PROPS = 64;          // DoS cap: max own props copied
    var MAX_STR   = 8192;        // DoS cap: truncate message/stack/string prop length
    function clip(s) {
      return (typeof s === 'string' && s.length > MAX_STR)
        ? s.slice(0, MAX_STR) + '...[truncated]' : s;
    }
    // Turn a thrown value into the wire JSON {"error":msg,"errorDetail":{...}}.
    // JSON.stringify guarantees escaping, so the C caller never has to escape
    // a message itself. Never invoked on the interrupt path (C guards on the
    // g_interrupted flag before calling this).
    function encode(e) {
      var msg, name, stack, props;
      if (e instanceof Error) {
        msg  = typeof e.message === 'string' ? e.message : String(e.message);
        name = typeof e.name === 'string' ? e.name : 'Error';
        // .stack read may invoke a hostile getter; isolate it so a throw here
        // degrades to "no stack" instead of nuking name+message+props.
        try { if (typeof e.stack === 'string') stack = e.stack; } catch (_s) { stack = undefined; }
        props = {};
        var keys = Object.keys(e); // own enumerable only
        var count = 0;
        for (var i = 0; i < keys.length; i++) {
          if (count >= MAX_PROPS) break;
          var k = keys[i];
          if (SKIP[k]) continue;
          var v;
          // Per-key isolation: a throwing own-enumerable accessor must skip
          // only that key, never abort the whole props+stack set.
          try { v = e[k]; } catch (_g) { continue; }
          if (typeof v === 'undefined' || typeof v === 'function') continue;
          // Skip binary: JSON.stringify(ArrayBuffer/view) does NOT throw but
          // yields a lossy {} / index-map. Error props are JSON-plain only,
          // never $bin-staged.
          if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) continue;
          try { JSON.stringify(v); } catch (_j) { continue; } // JSON-safe only
          props[k] = (typeof v === 'string') ? clip(v) : v;
          count++;
        }
      } else if (e && typeof e === 'object') {
        name = 'Error';
        try { msg = JSON.stringify(e); } catch (_) { msg = String(e); }
      } else {
        name = 'Error';
        msg = String(e);
      }
      var detail = { name: name };
      if (typeof stack === 'string') detail.stack = clip(stack);
      if (props && Object.keys(props).length) detail.props = props;
      return JSON.stringify({ error: clip(msg), errorDetail: detail });
    }
    function errenc(e) {
      try {
        return encode(e);
      } catch (_) {
        var m;
        try { m = String(e && e.message ? e.message : e); } catch (__) { m = 'unknown'; }
        // errorDetail is MANDATORY even here (marker-forgery defense).
        return JSON.stringify({ error: clip(m), errorDetail: { name: 'Error' } });
      }
    }
    // Pin the encoder so the guest cannot delete/reassign it to force the
    // message-only C fallback path.
    Object.defineProperty(R, '__errenc', {
      value: errenc, writable: false, enumerable: false, configurable: false,
    });
  })();`;

/**
 * Build the guest-side shim for a by-name host function (issue #8 + #10).
 *
 * The shim posts the call to the host over __sendToHost and reads back the synchronous
 * return value (the host writes it to __rill_fn_ret). For #10, any FUNCTION argument is
 * replaced with a {__rill_cb:id} marker after registering it in __rill.callbacks; the host
 * reconstructs a proxy that invokes the guest callback by id (see onHostFnCall).
 *
 * Callback lifetime is managed guest-side so the registry doesn't leak:
 * - one-shot (setTimeout/setImmediate/queueMicrotask): a self-removing wrapper drops the
 *   id when it fires; the host timer id -> cb id map entry is cleared too.
 * - repeating (setInterval): the cb id lives until the matching clear releases it.
 * - clear (clearTimeout/clearInterval/clearImmediate): release the cb id paired to the
 *   host timer id, then forward the clear to the host.
 * - generic (everything else, e.g. __rill_sendBatch/__console_log): function args are
 *   markered so they survive the bridge, but without an auto-release lifetime (no host fn
 *   today keeps such a callback; timers are the only stateful case).
 */
function buildHostFnShim(name: string): string {
  const nameKey = JSON.stringify(name);
  const eventKey = JSON.stringify(`__rill_fn:${name}`);

  if (ONE_SHOT_CALLBACK_FNS.has(name)) {
    const keyPrefix = JSON.stringify(`${name}:`);
    return `globalThis[${nameKey}] = function() {
      var a = Array.prototype.slice.call(arguments);${ENSURE_CB_REGISTRY}
      var cb = a[0];
      var id, hostId, fired = false;
      var wrapper = function() {
        try { return (typeof cb === 'function') ? cb.apply(null, arguments) : undefined; }
        finally { fired = true; R.removeCallback(id); if (hostId != null) delete R.__timerCb[${keyPrefix} + hostId]; }
      };
      id = R.registerCallback(wrapper);
      a[0] = { __rill_cb: id, __rill_marker: 1 };
      globalThis.__rill_fn_ret = null;
      __sendToHost(${eventKey}, { args: a });
      hostId = globalThis.__rill_fn_ret;
      // Guard 'fired': if the host invoked the callback synchronously inside __sendToHost,
      // the wrapper already ran (with hostId undefined) — don't re-insert a stale mapping.
      if (hostId != null && !fired) R.__timerCb[${keyPrefix} + hostId] = id;
      return hostId;
    };`;
  }

  if (REPEATING_CALLBACK_FNS.has(name)) {
    const keyPrefix = JSON.stringify(`${name}:`);
    return `globalThis[${nameKey}] = function() {
      var a = Array.prototype.slice.call(arguments);${ENSURE_CB_REGISTRY}
      var cb = a[0];
      var id = R.registerCallback(function() { return (typeof cb === 'function') ? cb.apply(null, arguments) : undefined; });
      a[0] = { __rill_cb: id, __rill_marker: 1 };
      globalThis.__rill_fn_ret = null;
      __sendToHost(${eventKey}, { args: a });
      var hostId = globalThis.__rill_fn_ret;
      if (hostId != null) R.__timerCb[${keyPrefix} + hostId] = id;
      return hostId;
    };`;
  }

  if (CLEAR_TIMER_FNS.has(name)) {
    // Release the cb id paired to this host timer id under the family it cancels.
    const keyPrefix = JSON.stringify(`${CLEAR_TO_FAMILY[name]}:`);
    return `globalThis[${nameKey}] = function() {
      var a = Array.prototype.slice.call(arguments);${ENSURE_CB_REGISTRY}
      var hostId = a[0];
      var key = ${keyPrefix} + hostId;
      if (hostId != null && R.__timerCb[key] != null) { R.removeCallback(R.__timerCb[key]); delete R.__timerCb[key]; }
      globalThis.__rill_fn_ret = null;
      __sendToHost(${eventKey}, { args: a });
      return globalThis.__rill_fn_ret;
    };`;
  }

  // Generic: marker any function arguments so they survive the JSON bridge.
  // A single ArrayBuffer/view argument takes the dedicated fast binary channel
  // (__sendBinaryToHost, one (ptr,len) hop, no table round-trip); any OTHER
  // binary — multiple args or nested inside objects/arrays — is staged through
  // the {"$bin":id} codec so the JSON bridge never destroys bytes. typeof-gated
  // so an old wasm binary without the channel degrades to the JSON path, where
  // the Bridge's shape validation fails loudly instead of silently.
  return `globalThis[${nameKey}] = function() {
    var a = Array.prototype.slice.call(arguments);
    if (a.length === 1 && (a[0] instanceof ArrayBuffer || ArrayBuffer.isView(a[0])) &&
        typeof __sendBinaryToHost === 'function') {
      globalThis.__rill_fn_ret = null;
      __sendBinaryToHost(${eventKey}, a[0]);
      return globalThis.__rill_fn_ret;
    }
    var hasFn = false;
    for (var i = 0; i < a.length; i++) { if (typeof a[i] === 'function') { hasFn = true; break; } }
    if (hasFn) {${ENSURE_CB_REGISTRY}
      a = a.map(function(x){ return (typeof x === 'function') ? { __rill_cb: R.registerCallback(x), __rill_marker: 1 } : x; });
    }
    var RB = globalThis.__rill;
    if (RB && RB.__binenc) { a = RB.__binenc(a); }
    globalThis.__rill_fn_ret = null;
    __sendToHost(${eventKey}, { args: a });
    return globalThis.__rill_fn_ret;
  };`;
}

/**
 * QuickJS Native WASM Provider
 *
 * Provides true isolated JavaScript sandbox using QuickJS compiled to WASM.
 * Has its own event loop and timer system, making React hooks like useEffect work correctly.
 */
export class QuickJSNativeWASMProvider implements JSEngineProvider {
  private options: {
    loaderPath: string;
    wasmPath?: string;
    wasmBinary?: Uint8Array | ArrayBuffer;
    wasmFactory: QuickJSWASMFactory;
    timeout: number;
    debug: boolean;
  };
  private wasmModule: QuickJSWASMModule | null = null;
  private loadPromise: Promise<QuickJSWASMModule> | null = null;

  constructor(options: QuickJSNativeWASMProviderOptions = {}) {
    this.options = {
      loaderPath: options.loaderPath ?? '../wasm/quickjs-sandbox.js',
      wasmPath: options.wasmPath,
      wasmBinary: options.wasmBinary,
      wasmFactory: options.wasmFactory ?? this.defaultWASMFactory.bind(this),
      timeout: options.timeout ?? 5000,
      debug: options.debug ?? false,
    };
  }

  async createRuntime(): Promise<JSEngineRuntime> {
    const module = await this.loadWASM();

    return {
      createContext: (): SandboxScope => {
        // Initialize QuickJS
        const initResult = module._qjs_init();
        if (initResult !== 0) {
          throw new Error(`[QuickJSWASM] Failed to initialize: ${initResult}`);
        }

        let hostCallbackPtr = 0;
        let hostBinaryCallbackPtr = 0;

        // host:* module bridge handler. Assigned once the eval helpers below are
        // defined; the guest reaches it by posting `__rill_host_*` events through
        // __sendToHost (see installHostModules).
        let onHostModuleEvent: ((event: string, data: string) => void) | null = null;

        // By-name host->guest function bridge (issue #8). The isolated WASM realm
        // can't receive a host function reference, so each function injected by name
        // (render: __rill_sendBatch; events: __rill_emitEvent; config: __rill_getConfig;
        // etc.) is registered here and reached via __sendToHost -> onHostFnCall.
        let onHostFnCall: ((name: string, data: string) => void) | null = null;
        // Binary twin of onHostFnCall: receives the raw byte window a guest
        // handed to __sendBinaryToHost (already copied out of wasm memory).
        let onHostBinaryFnCall: ((name: string, bytes: Uint8Array) => void) | null = null;
        // Reason: injected host hooks accept/return arbitrary serializable values.
        const injectedHostFns = new Map<string, (...args: ReviewedUnknown[]) => ReviewedUnknown>();

        // Install host callback for communication
        const hostCallback = (eventPtr: number, dataPtr: number) => {
          const event = module.UTF8ToString(eventPtr);
          const data = module.UTF8ToString(dataPtr);

          if (this.options.debug) {
            console.log(`[QuickJSWASM] Host callback: ${event}`, data);
          }

          // host:* request/response bridge (issue #5)
          if (event.indexOf('__rill_host_') === 0) {
            onHostModuleEvent?.(event, data);
            return;
          }

          // by-name host function bridge (issue #8)
          if (event.indexOf('__rill_fn:') === 0) {
            onHostFnCall?.(event.slice(10), data);
            return;
          }

          // Handle console output
          if (event === 'console.log' || event === 'console.error') {
            if (this.options.debug) {
              console.log(`[Guest ${event}]`, data);
            }
          }
        };

        hostCallbackPtr = module.addFunction(hostCallback, 'vii');
        module._qjs_set_host_callback(hostCallbackPtr);

        // Binary channel (__sendBinaryToHost): the guest hands over a
        // (ptr,len) window into wasm linear memory; slice() copies the bytes
        // out BEFORE returning (the window is only valid during this call).
        const hostBinaryCallback = (eventPtr: number, dataPtr: number, len: number) => {
          const event = module.UTF8ToString(eventPtr);
          if (this.options.debug) {
            console.log(`[QuickJSWASM] Host binary callback: ${event} (${len} bytes)`);
          }
          if (event.indexOf('__rill_fn:') === 0) {
            onHostBinaryFnCall?.(event.slice(10), module.HEAPU8.slice(dataPtr, dataPtr + len));
          }
        };
        hostBinaryCallbackPtr = module.addFunction(hostBinaryCallback, 'viii');
        module._qjs_set_host_binary_callback(hostBinaryCallbackPtr);

        module._qjs_install_host_functions();
        module._qjs_install_console();

        // NOTE: the native C timer functions (qjs_install_timer_functions) are intentionally
        // NOT installed here (issue #10, approach A). The host Engine injects its own
        // TimerManager-backed setTimeout/setInterval/setImmediate polyfills, and those now
        // work on WASM because callback arguments cross the bridge by id (approach B, see
        // buildHostFnShim + onHostFnCall). Keeping the engine's TimerManager as the single
        // clock owner preserves pause()/resume() clock-freeze and the setImmediate drain that
        // React's concurrent scheduler relies on — installing native timers here would create
        // a second, unfreezable clock. (The C functions remain in the binary, unused.)

        // Use cwrap for string operations since HEAPU8 is not exported
        const rawEvalCode = module.cwrap('qjs_eval', 'number', ['string']) as (
          code: string
        ) => number;
        const rawEvalVoid = module.cwrap('qjs_eval_void', 'number', ['string']) as (
          code: string
        ) => number;
        const injectJson = module.cwrap('qjs_inject_json', 'number', ['string', 'string']) as (
          name: string,
          json: string
        ) => number;
        const rawExtractJson = module.cwrap('qjs_extract_json', 'number', ['string']) as (
          name: string
        ) => number;
        const freeString = module._qjs_free_string.bind(module);

        // ---- guest execution deadline (options.timeout) ----
        // Every entry into guest code arms the C-side deadline; the QuickJS
        // interrupt handler aborts the interpreter once it expires, so a guest
        // `while(true){}` cannot hang the host thread forever. Depth-tracked
        // because a guest __sendToHost call re-enters here synchronously
        // (host fn -> nested evalVoid): each (re-)entry re-arms a fresh
        // budget, and only the OUTERMOST exit disarms it. The budget is per
        // synchronous guest entry, not per app lifetime.
        const timeoutMs = this.options.timeout;
        let guestDepth = 0;
        const enterGuest = <T>(fn: () => T): T => {
          guestDepth++;
          module._qjs_set_deadline(timeoutMs);
          try {
            return fn();
          } finally {
            guestDepth--;
            if (guestDepth === 0) module._qjs_set_deadline(0);
          }
        };

        // qjs_eval_void / qjs_execute_pending_jobs return this when the
        // deadline interrupt fired (see wasm_bindings.c).
        const QJS_INTERRUPTED = -2;
        // Exact error payload qjs_eval returns for a deadline interrupt.
        const INTERRUPTED_ERROR_JSON = '{"error":"interrupted: execution deadline exceeded"}';

        const makeTimeoutError = (): Error =>
          new Error(
            `[QuickJSWASM] Guest execution interrupted: exceeded timeout of ${timeoutMs}ms`
          );
        // The guest was forcibly interrupted mid-execution — always surfaced,
        // not gated on debug: state may be partially applied.
        const reportTimeout = (where: string): void => {
          console.error(
            `[QuickJSWASM] ${where}: guest execution exceeded ${timeoutMs}ms and was interrupted`
          );
        };

        const evalCode = (code: string): number => enterGuest(() => rawEvalCode(code));
        const extractJson = (name: string): number => enterGuest(() => rawExtractJson(name));
        // Throws on timeout — but only when this is the OUTERMOST guest entry.
        // A nested entry (host callback running inside an outer eval) must not
        // throw across the live wasm frames of the outer eval; instead the
        // still-expired deadline interrupts the outer frame, which reports.
        const evalVoid = (code: string): number => {
          const nested = guestDepth > 0;
          const ret = enterGuest(() => rawEvalVoid(code));
          if (ret === QJS_INTERRUPTED) {
            reportTimeout('evalVoid');
            if (!nested) throw makeTimeoutError();
          }
          return ret;
        };

        // Install the guest-side binary codec before ANY guest code runs, so every
        // later shim (host fns, host modules, inject/extract) can rely on
        // __rill.__binenc/__binrev being present.
        evalVoid(GUEST_BINARY_CODEC);
        // Error encoder next (same first-writer-wins window): qjs_eval's
        // exception branch calls __rill.__errenc for rich error payloads.
        evalVoid(GUEST_ERROR_CODEC);

        // ---- host:* module bridge (issue #5) ----
        // The WASM realm can't hold host function references, so host:* capabilities
        // are bridged as a JSON request/response over __sendToHost: the guest stub posts
        // an invoke, the host runs the (boundary-enforced) dispatch table entry, and the
        // resolved result / rejection / subscription event is evaluated back into the
        // guest and the QuickJS microtask queue is drained.
        let hostModuleTable: HostModuleDispatchTable | null = null;
        const pendingHostCalls = new Set<Promise<void>>();
        const hostSubscriptions = new Map<string, () => void>();

        const drainJobs = (): void => {
          const nested = guestDepth > 0;
          const ret = enterGuest(() => module._qjs_execute_pending_jobs());
          if (ret === QJS_INTERRUPTED) {
            reportTimeout('pending jobs');
            if (!nested) throw makeTimeoutError();
          }
        };

        // Synchronously invoke a by-name injected host function (issue #8). The guest
        // shim is blocked inside __sendToHost while this runs, so writing the result
        // back to a guest global lets the shim return it synchronously. One-way hooks
        // (render/event) simply ignore the written value.
        // Invoke a guest callback by id (issue #10). A function can't cross the JSON
        // bridge, so the guest registered it in __rill.callbacks and passed an id; here the
        // host fires it later (e.g. when a TimerManager timer elapses) by evaluating
        // invokeCallback in the guest realm and draining the resulting microtasks.
        const invokeGuestCallback = (id: string, cbArgs: ReviewedUnknown[]): void => {
          // Binary callback args are staged into wasm memory and revived guest-side
          // (__binrev) before invokeCallback runs, so the guest callback sees real
          // ArrayBuffers/views instead of degraded JSON.
          const stagedIds: number[] = [];
          try {
            injectJson(
              '__rill_cb_args',
              JSON.stringify(encodeBinaryValue(module, cbArgs ?? [], stagedIds))
            );
            // Surface a throwing guest callback to the host logger (via __console_error)
            // rather than swallowing it silently at the evalVoid C boundary; always clear the
            // shared arg global afterward.
            evalVoid(
              `try { globalThis.__rill.invokeCallback(${JSON.stringify(id)},globalThis.__rill.__binrev(globalThis.__rill_cb_args)); } catch (e) { if (typeof __console_error === 'function') { __console_error('[rill] guest callback threw:', e && e.message ? e.message : String(e)); } } finally { delete globalThis.__rill_cb_args; }`
            );
          } finally {
            // Consume-exactly-once: anything the guest did not revive (inject or eval
            // failed) is released here; freeing a consumed id is a no-op.
            freeStagedIds(module, stagedIds);
          }
          drainJobs();
        };

        // Turn a {__rill_cb:id, __rill_marker:1} marker back into a host-side proxy function
        // the host fn can store and call; non-marker args pass through unchanged. The
        // __rill_marker brand (set only by buildHostFnShim) distinguishes a real callback
        // marker from a same-shaped data object a caller might legitimately pass.
        const reconstructCallbackArg = (a: ReviewedUnknown): ReviewedUnknown => {
          if (
            a &&
            typeof a === 'object' &&
            (a as { __rill_marker?: ReviewedUnknown }).__rill_marker === 1 &&
            typeof (a as { __rill_cb?: ReviewedUnknown }).__rill_cb === 'string'
          ) {
            const id = (a as { __rill_cb: string }).__rill_cb;
            return (...cbArgs: ReviewedUnknown[]) => invokeGuestCallback(id, cbArgs);
          }
          return a;
        };

        onHostBinaryFnCall = (name: string, bytes: Uint8Array): void => {
          const fn = injectedHostFns.get(name);
          if (!fn) return;
          try {
            // bytes is an exact-size copy, so .buffer IS the payload: the
            // injected host fn (e.g. engine sendToHost) sees a real host-realm
            // ArrayBuffer and its instanceof branch finally matches. One-way:
            // the guest shim pre-set __rill_fn_ret = null and returns that.
            fn(bytes.buffer);
          } catch (err) {
            if (this.options.debug) {
              console.error(`[QuickJSWASM] injected host fn "${name}" threw on binary arg:`, err);
            }
          }
        };

        onHostFnCall = (name: string, data: string): void => {
          const fn = injectedHostFns.get(name);
          let args: ReviewedUnknown[] = [];
          // Guest-staged binary in the args is copied out of wasm memory and freed here;
          // the finally releases anything a parse failure or revive throw left behind.
          const inboundIds: number[] = [];
          try {
            const parsed = JSON.parse(data) as { args?: ReviewedUnknown[] };
            if (parsed && Array.isArray(parsed.args)) {
              collectBinIds(parsed.args, inboundIds);
              args = (reviveBinaryValue(module, parsed.args) as ReviewedUnknown[]).map(
                reconstructCallbackArg
              );
            }
          } catch {
            /* malformed payload -> no args */
          } finally {
            freeStagedIds(module, inboundIds);
          }
          let result: ReviewedUnknown;
          try {
            result = fn ? fn(...args) : undefined;
          } catch (err) {
            if (this.options.debug) {
              console.error(`[QuickJSWASM] injected host fn "${name}" threw:`, err);
            }
            result = undefined;
          }
          const outboundIds: number[] = [];
          try {
            injectJson(
              '__rill_fn_ret',
              JSON.stringify(
                encodeBinaryValue(module, result === undefined ? null : result, outboundIds)
              )
            );
            if (outboundIds.length > 0) {
              // The guest shim returns __rill_fn_ret verbatim once __sendToHost returns —
              // revive here, still inside the synchronous call, so it holds real buffers.
              evalVoid(
                'globalThis.__rill_fn_ret = globalThis.__rill.__binrev(globalThis.__rill_fn_ret);'
              );
            }
          } catch {
            // Result not serializable -> restore the documented 'guest sees null' contract.
            // Must explicitly reset: __rill_fn_ret is a shared global and a nested host call
            // may have left a value there, which the outer shim would otherwise return.
            try {
              injectJson('__rill_fn_ret', 'null');
            } catch {
              /* ignore */
            }
          } finally {
            freeStagedIds(module, outboundIds);
          }
        };

        const resolveHostCall = (id: number, value: ReviewedUnknown): void => {
          if (value === undefined) {
            evalVoid(`globalThis.__rill.__resolveHostCall(${id},false)`);
          } else {
            // Stage any binary in the result as a {"$bin":id} sentinel before it crosses
            // the JSON bridge; the guest __resolveHostCall revives (and thereby consumes)
            // it. The finally releases what the guest did not consume — e.g. the call
            // record was already gone and __resolveHostCall returned early.
            const stagedIds: number[] = [];
            try {
              injectJson(
                '__rill_host_result',
                JSON.stringify(encodeBinaryValue(module, value, stagedIds))
              );
              evalVoid(
                `globalThis.__rill.__resolveHostCall(${id},true,globalThis.__rill_host_result);delete globalThis.__rill_host_result`
              );
            } finally {
              freeStagedIds(module, stagedIds);
            }
          }
          drainJobs();
        };

        // Host -> guest rejection: name + message + own JSON-safe props cross;
        // the host stack NEVER does. serializeHostError cannot throw, so the
        // guest promise always settles.
        // Reason: a rejected host-call reason can be any thrown value.
        const rejectHostCall = (id: number, err: unknown): void => {
          injectJson('__rill_host_error', JSON.stringify(serializeHostError(err)));
          evalVoid(
            `globalThis.__rill.__rejectHostCall(${id},globalThis.__rill_host_error);delete globalThis.__rill_host_error`
          );
          drainJobs();
        };

        const deliverSubscriptionEvent = (subId: string, event: ReviewedUnknown): void => {
          // Same staging + finally discipline as resolveHostCall: the guest
          // __deliverHostEvent revives only when the subscription handler still exists,
          // so the finally covers the already-unsubscribed case.
          const stagedIds: number[] = [];
          try {
            injectJson(
              '__rill_host_event',
              JSON.stringify(
                encodeBinaryValue(module, event === undefined ? null : event, stagedIds)
              )
            );
            evalVoid(
              `globalThis.__rill.__deliverHostEvent(${JSON.stringify(subId)},globalThis.__rill_host_event);delete globalThis.__rill_host_event`
            );
          } finally {
            freeStagedIds(module, stagedIds);
          }
          drainJobs();
        };

        const trackHostCall = (chain: Promise<void>): void => {
          pendingHostCalls.add(chain);
          void chain.then(() => pendingHostCalls.delete(chain));
        };

        onHostModuleEvent = (event: string, data: string): void => {
          let msg: ReviewedUnknown;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          const m = msg as {
            id?: number;
            subId?: string;
            moduleId?: string;
            exportName?: string;
            args?: ReviewedUnknown;
          };
          const table = hostModuleTable;
          const fn =
            table && m.moduleId && m.exportName ? table[m.moduleId]?.[m.exportName] : undefined;

          // Free-on-exit discipline: collect every staged-binary id anywhere in the
          // message up front. The invoke path consumes the args ids via revive; the
          // finally releases the rest (unknown module reject, subscribe payloads,
          // throw mid-dispatch), so no guest-staged block can outlive this crossing.
          const stagedIds: number[] = [];
          collectBinIds(msg, stagedIds);
          try {
            if (event === '__rill_host_invoke') {
              const id = m.id ?? 0;
              if (typeof fn !== 'function') {
                rejectHostCall(
                  id,
                  `[rill] Host module not registered: ${m.moduleId}.${m.exportName}`
                );
                return;
              }
              // Revive {"$bin":…} sentinels in the guest-sent args back to real
              // ArrayBuffers/views BEFORE the boundary fn (parseInput + impl) runs, so the
              // host handler sees the same binary values the wasm RBS1 path delivers.
              const revivedArgs = reviveBinaryValue(module, m.args);
              const chain = Promise.resolve()
                .then(() => fn(revivedArgs))
                .then((result) => resolveHostCall(id, result))
                .catch((err: ReviewedUnknown) => rejectHostCall(id, err));
              trackHostCall(chain);
              return;
            }

            if (event === '__rill_host_subscribe') {
              const subId = m.subId;
              if (!subId) return;
              if (typeof fn !== 'function') {
                if (this.options.debug) {
                  console.error(
                    `[QuickJSWASM] subscribe to unregistered host module: ${m.moduleId}.${m.exportName}`
                  );
                }
                return;
              }
              try {
                const unsubscribe = fn((evt: ReviewedUnknown) =>
                  deliverSubscriptionEvent(subId, evt)
                );
                if (typeof unsubscribe === 'function') {
                  hostSubscriptions.set(subId, unsubscribe as () => void);
                }
              } catch (err) {
                if (this.options.debug) {
                  console.error(`[QuickJSWASM] host subscribe error:`, err);
                }
              }
              return;
            }

            if (event === '__rill_host_unsubscribe') {
              const subId = m.subId;
              if (!subId) return;
              const unsubscribe = hostSubscriptions.get(subId);
              if (unsubscribe) {
                hostSubscriptions.delete(subId);
                try {
                  unsubscribe();
                } catch {
                  /* ignore */
                }
              }
            }
          } finally {
            freeStagedIds(module, stagedIds);
          }
        };

        return {
          eval: (code: string): unknown => {
            const resultPtr = evalCode(code);
            const result = module.UTF8ToString(resultPtr);
            freeString(resultPtr);

            if (result === INTERRUPTED_ERROR_JSON) {
              reportTimeout('eval');
              throw makeTimeoutError();
            }

            // Process any microtasks
            drainJobs();

            return this.parseResult(result);
          },

          evalAsync: async (code: string): Promise<ReviewedUnknown> => {
            const resultPtr = evalCode(code);
            const result = module.UTF8ToString(resultPtr);
            freeString(resultPtr);

            if (result === INTERRUPTED_ERROR_JSON) {
              reportTimeout('evalAsync');
              throw makeTimeoutError();
            }

            // Process microtasks
            drainJobs();

            return this.parseResult(result);
          },

          inject: (name: string, value: unknown): void => {
            // Bridge a by-name host function into the isolated guest realm (issue #8).
            // The guest shim posts its arguments to the host synchronously via
            // __sendToHost (routed to onHostFnCall in hostCallback), then reads back the
            // value the host wrote. This wires the render channel (__rill_sendBatch ->
            // host Receiver), host events (__rill_emitEvent), config (__rill_getConfig),
            // single ops (__rill_sendOperation), etc. — none of which worked before.
            if (typeof value === 'function') {
              injectedHostFns.set(name, value as (...args: ReviewedUnknown[]) => ReviewedUnknown);
              evalVoid(buildHostFnShim(name));
              return;
            }

            // Binary inside the value is staged into wasm memory and revived guest-side
            // right after the JSON lands, so the guest global holds real
            // ArrayBuffers/views. The identity-preserving encode makes the revive eval
            // (and its cost) conditional on binary actually being present.
            const stagedIds: number[] = [];
            try {
              const encoded = encodeBinaryValue(module, value as ReviewedUnknown, stagedIds);
              injectJson(name, JSON.stringify(encoded));
              if (stagedIds.length > 0) {
                const nameLit = JSON.stringify(name);
                evalVoid(
                  `globalThis[${nameLit}] = globalThis.__rill.__binrev(globalThis[${nameLit}]);`
                );
              }
            } finally {
              freeStagedIds(module, stagedIds);
            }
          },

          extract: (name: string): unknown => {
            // Pre-encode in the guest realm so binary survives the C-side
            // JS_JSONStringify (which would degrade a view to an index object and an
            // ArrayBuffer to "{}"); the staged bytes are copied out and consumed below.
            const nameLit = JSON.stringify(name);
            evalVoid(
              `globalThis.__rill_extract = globalThis.__rill.__binenc(globalThis[${nameLit}]);`
            );
            const resultPtr = extractJson('__rill_extract');
            const result = module.UTF8ToString(resultPtr);
            freeString(resultPtr);
            evalVoid('delete globalThis.__rill_extract;');

            // Parse raw first WITHOUT throwing, register any staged $bin ids, then
            // run the error classification INSIDE the try so freeStagedIds always
            // runs. This closes the leak where a guest value shaped
            // {error:..., buf:<binary>} would make the error-throw fire before the
            // staged id was freed (breaking the qjs_binary_count()===0 invariant).
            let raw: ReviewedUnknown;
            try {
              raw = JSON.parse(result);
            } catch {
              raw = undefined;
            }
            const stagedIds: number[] = [];
            collectBinIds(raw, stagedIds);
            try {
              // Same error classification parseResult uses, now that ids are
              // tracked: throw on errorDetail OR a non-empty string `error`.
              if (raw && typeof raw === 'object') {
                const r = raw as { error?: ReviewedUnknown; errorDetail?: GuestErrorDetail };
                if ('errorDetail' in r || (typeof r.error === 'string' && r.error.length > 0)) {
                  throw reviveGuestError(r);
                }
              }
              return reviveBinaryValue(module, raw);
            } finally {
              freeStagedIds(module, stagedIds); // always frees, even on the thrown-error path
            }
          },

          installHostModules: (
            table: HostModuleDispatchTable,
            contract: RillContractShape
          ): void => {
            hostModuleTable = table;

            // Partition declared capabilities by kind so the guest gets the right stub:
            // rpc → returns a Promise; subscription → registers a handler, returns unsubscribe.
            const rpcCaps: Record<string, string[]> = {};
            const subCaps: Record<string, string[]> = {};
            for (const [moduleId, spec] of Object.entries(contract.hostModules)) {
              const moduleTable = table[moduleId];
              if (!moduleTable) continue;
              for (const [exportName, descriptor] of Object.entries(spec)) {
                if (typeof moduleTable[exportName] !== 'function') continue;
                const bucket = descriptor.kind === 'subscription' ? subCaps : rpcCaps;
                const list = bucket[moduleId] ?? (bucket[moduleId] = []);
                list.push(exportName);
              }
            }

            evalVoid(`
              (function() {
                if (!globalThis.__rill) { globalThis.__rill = {}; }
                var R = globalThis.__rill;
                if (!R.__hostCalls) {
                  R.__hostCalls = {}; R.__hostCallSeq = 0;
                  R.__hostSubs = {}; R.__hostSubSeq = 0;
                  R.__resolveHostCall = function(id, hasValue, value) {
                    var c = R.__hostCalls[id]; if (!c) return; delete R.__hostCalls[id];
                    c.resolve(hasValue ? R.__binrev(value) : undefined);
                  };
                  R.__rejectHostCall = function(id, payload) {
                    var c = R.__hostCalls[id]; if (!c) return; delete R.__hostCalls[id];
                    // Rebuild a real Error from the host payload: name + message +
                    // own JSON-safe props. The host stack is intentionally absent;
                    // host-controlled prop names apply only via defineProperty.
                    var e = new Error(payload && payload.message ? payload.message : String(payload));
                    if (payload && typeof payload.name === 'string') e.name = payload.name;
                    if (payload && payload.props) {
                      var ks = Object.keys(payload.props);
                      for (var i = 0; i < ks.length; i++) {
                        var k = ks[i];
                        if (k === 'name' || k === 'message' || k === 'stack') continue;
                        Object.defineProperty(e, k, { value: payload.props[k], writable: true, enumerable: true, configurable: true });
                      }
                    }
                    c.reject(e); // keeps the guest's own stack; host stack intentionally absent
                  };
                  R.__deliverHostEvent = function(subId, event) {
                    var h = R.__hostSubs[subId]; if (typeof h === 'function') h(R.__binrev(event));
                  };
                  R.__invokeHostRpc = function(moduleId, exportName, arg) {
                    var id = ++R.__hostCallSeq;
                    var p = new Promise(function(resolve, reject) {
                      R.__hostCalls[id] = { resolve: resolve, reject: reject };
                    });
                    __sendToHost('__rill_host_invoke', { id: id, moduleId: moduleId, exportName: exportName, args: R.__binenc(arg === undefined ? null : arg) });
                    return p;
                  };
                  R.__invokeHostSubscription = function(moduleId, exportName, handler) {
                    if (typeof handler !== 'function') {
                      throw new Error('[rill] Subscription "' + moduleId + '.' + exportName + '" requires a handler function.');
                    }
                    var subId = 'sub_' + (++R.__hostSubSeq);
                    R.__hostSubs[subId] = handler;
                    __sendToHost('__rill_host_subscribe', { subId: subId, moduleId: moduleId, exportName: exportName });
                    return function() {
                      if (R.__hostSubs[subId]) {
                        delete R.__hostSubs[subId];
                        __sendToHost('__rill_host_unsubscribe', { subId: subId });
                      }
                    };
                  };
                }
                R.hostModules = R.hostModules || {};
                var rpc = ${JSON.stringify(rpcCaps)};
                var sub = ${JSON.stringify(subCaps)};
                Object.keys(rpc).forEach(function(mid) {
                  R.hostModules[mid] = R.hostModules[mid] || {};
                  rpc[mid].forEach(function(en) {
                    R.hostModules[mid][en] = function(a) { return R.__invokeHostRpc(mid, en, a); };
                  });
                });
                Object.keys(sub).forEach(function(mid) {
                  R.hostModules[mid] = R.hostModules[mid] || {};
                  sub[mid].forEach(function(en) {
                    R.hostModules[mid][en] = function(h) { return R.__invokeHostSubscription(mid, en, h); };
                  });
                });
              })();
            `);

            if (this.options.debug) {
              console.log(`[QuickJSWASM] Installed host modules: ${Object.keys(table).join(', ')}`);
            }
          },

          flushHostModuleCalls: async (): Promise<void> => {
            // Resolving a call drains guest jobs, which may enqueue further calls;
            // loop until the in-flight set is empty.
            let guard = 0;
            while (pendingHostCalls.size > 0 && guard < 10000) {
              guard++;
              await Promise.allSettled([...pendingHostCalls]);
            }
            drainJobs();
          },

          dispose: (): void => {
            // Release host:* subscriptions
            for (const unsubscribe of hostSubscriptions.values()) {
              try {
                unsubscribe();
              } catch {
                /* ignore */
              }
            }
            hostSubscriptions.clear();
            hostModuleTable = null;

            // Remove function pointers
            if (hostCallbackPtr) {
              module.removeFunction(hostCallbackPtr);
            }
            if (hostBinaryCallbackPtr) {
              module.removeFunction(hostBinaryCallbackPtr);
            }

            // Destroy QuickJS context
            module._qjs_destroy();
          },
        };
      },

      dispose: (): void => {
        // WASM module can be reused across runtimes
      },
    };
  }

  /**
   * Load WASM module (cached)
   */
  private async loadWASM(): Promise<QuickJSWASMModule> {
    if (this.wasmModule) {
      return this.wasmModule;
    }

    if (!this.loadPromise) {
      const { wasmPath, wasmBinary } = this.options;
      const moduleArg: QuickJSWASMFactoryModuleArg = {};
      if (wasmBinary) moduleArg.wasmBinary = wasmBinary;
      if (wasmPath) {
        moduleArg.locateFile = (path: string) => (path.endsWith('.wasm') ? wasmPath : path);
      }
      this.loadPromise = this.options.wasmFactory(
        Object.keys(moduleArg).length > 0 ? moduleArg : undefined
      );
    }

    this.wasmModule = await this.loadPromise;

    if (this.options.debug) {
      console.log('[QuickJSNativeWASM] WASM module loaded');
    }

    return this.wasmModule;
  }

  /**
   * Default WASM factory
   */
  private async defaultWASMFactory(
    moduleArg?: QuickJSWASMFactoryModuleArg
  ): Promise<QuickJSWASMModule> {
    // Dynamic import the Emscripten-generated loader
    const createQuickJSSandbox = (await import(
      /* webpackIgnore: true */
      this.options.loaderPath
    )) as { default: QuickJSWASMFactory };

    return await createQuickJSSandbox.default(moduleArg);
  }

  /**
   * Parse eval result from JSON string
   */
  private parseResult(json: string): ReviewedUnknown {
    if (json === 'undefined') {
      return undefined;
    }
    if (json === 'null') {
      return null;
    }

    // Check for error response
    if (json.startsWith('{') && json.includes('"error"')) {
      let parsed: ReviewedUnknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed === 'object') {
        const p = parsed as { error?: ReviewedUnknown; errorDetail?: GuestErrorDetail };
        // Throw iff this is definitively an error payload:
        //  - errorDetail present -> encoder-produced (rich OR empty-message error), OR
        //  - error is a NON-EMPTY string -> bare {"error":"<msg>"} (interrupt marker,
        //    C fallback, or any other caller's error).
        // A guest completion value shaped {error:""} with NO errorDetail is NOT an
        // error: it is returned as-is (completion-value semantics unchanged).
        if ('errorDetail' in p || (typeof p.error === 'string' && p.error.length > 0)) {
          throw reviveGuestError(p);
        }
        return parsed; // object that merely contains "error" (e.g. {error:""} value)
      }
      if (parsed !== undefined) return parsed;
    }

    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  }

  /**
   * Check if WASM is supported
   */
  static isAvailable(): boolean {
    return typeof WebAssembly !== 'undefined';
  }
}
