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

// ---- $b64 binary sidecar for the JSON string bridge (store-net-bytes.DESIGN §B.5) ----
//
// The QuickJS shell is a SYNCHRONOUS JSON STRING BRIDGE, not postMessage: guest args are
// JSON.stringify'd by __sendToHost (wasm_bindings.c js_send_to_host) and host results are
// JSON.stringify'd here (resolveHostCall). A Uint8Array crossing that bridge would degrade
// into a `{"0":.., "1":..}` index object (~4-6x bloat) and arrive at the peer as a plain
// object, NOT a Uint8Array — losing parity with the wasm RBS1 path.
//
// Fix, additive: at the shell boundary each Uint8Array is replaced by the reserved sentinel
// {"$b64":"<base64>"} (~1.33x) before JSON.stringify and revived to a real Uint8Array on the
// other side, so the host handler and the guest both see identical Uint8Array semantics as
// the wasm path. Non-binary values are returned by identity (same reference), so their
// JSON.stringify output is byte-for-byte unchanged.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET.charAt(i)] = i;
  return m;
})();

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] as number;
    const has1 = i + 1 < len;
    const has2 = i + 2 < len;
    const b1 = has1 ? (bytes[i + 1] as number) : 0;
    const b2 = has2 ? (bytes[i + 2] as number) : 0;
    out += B64_ALPHABET.charAt(b0 >> 2);
    out += B64_ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += has1 ? B64_ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=';
    out += has2 ? B64_ALPHABET.charAt(b2 & 63) : '=';
  }
  return out;
}

function base64ToBytes(str: string): Uint8Array {
  const len = str.length;
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (str.charAt(len - 1) === '=') pad++;
  if (str.charAt(len - 2) === '=') pad++;
  const outLen = (len >> 2) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[str.charAt(i)] ?? 0;
    const c1 = B64_LOOKUP[str.charAt(i + 1)] ?? 0;
    const c2 = B64_LOOKUP[str.charAt(i + 2)] ?? 0;
    const c3 = B64_LOOKUP[str.charAt(i + 3)] ?? 0;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

/**
 * Replace every Uint8Array in `value` with a {"$b64":"…"} sentinel, in place-preserving
 * fashion: containers are only re-allocated when a descendant actually changes, so a value
 * with no binary is returned by identity and its JSON.stringify output is unchanged.
 */
function encodeBinaryValue(value: ReviewedUnknown): ReviewedUnknown {
  if (value instanceof Uint8Array) {
    return { $b64: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    let copy: ReviewedUnknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const enc = encodeBinaryValue(value[i]);
      if (enc !== value[i]) {
        if (!copy) copy = value.slice();
        copy[i] = enc;
      }
    }
    return copy ?? value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, ReviewedUnknown>;
    const keys = Object.keys(obj);
    let copy: Record<string, ReviewedUnknown> | null = null;
    for (const k of keys) {
      const enc = encodeBinaryValue(obj[k]);
      if (enc !== obj[k]) {
        if (!copy) {
          copy = {};
          for (const kk of keys) copy[kk] = obj[kk];
        }
        copy[k] = enc;
      }
    }
    return copy ?? value;
  }
  return value;
}

/**
 * Revive every {"$b64":"…"} sentinel (an object whose SOLE key is the reserved `$b64`,
 * mapped to a string) back to a real Uint8Array. Mutates the freshly-parsed tree in place.
 */
function reviveBinaryValue(value: ReviewedUnknown): ReviewedUnknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveBinaryValue(value[i]);
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, ReviewedUnknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '$b64' && typeof obj.$b64 === 'string') {
      return base64ToBytes(obj.$b64);
    }
    for (const k of keys) obj[k] = reviveBinaryValue(obj[k]);
    return obj;
  }
  return value;
}

// Guest-side twin of the codec above, injected once into the QuickJS realm. Uint8Array
// exists in the guest, but btoa/atob/Buffer do not, so base64 is done by hand. Exposed on
// __rill as __b64enc (guest→host arg marshaling) and __b64rev (host→guest result/event
// revival); the walkers preserve identity so non-binary payloads stringify unchanged.
const GUEST_B64_CODEC = `
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64L = {}; for (var _i = 0; _i < B64.length; _i++) { B64L[B64[_i]] = _i; }
  function b64enc(u8) {
    var s = '', L = u8.length;
    for (var i = 0; i < L; i += 3) {
      var b0 = u8[i], h1 = i + 1 < L, h2 = i + 2 < L;
      var b1 = h1 ? u8[i + 1] : 0, b2 = h2 ? u8[i + 2] : 0;
      s += B64[b0 >> 2];
      s += B64[((b0 & 3) << 4) | (b1 >> 4)];
      s += h1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      s += h2 ? B64[b2 & 63] : '=';
    }
    return s;
  }
  function b64dec(str) {
    var L = str.length; if (L === 0) return new Uint8Array(0);
    var pad = 0; if (str[L - 1] === '=') pad++; if (str[L - 2] === '=') pad++;
    var outLen = (L >> 2) * 3 - pad, out = new Uint8Array(outLen), o = 0;
    for (var i = 0; i < L; i += 4) {
      var c0 = B64L[str[i]] || 0, c1 = B64L[str[i + 1]] || 0, c2 = B64L[str[i + 2]] || 0, c3 = B64L[str[i + 3]] || 0;
      var n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
      if (o < outLen) out[o++] = (n >> 16) & 255;
      if (o < outLen) out[o++] = (n >> 8) & 255;
      if (o < outLen) out[o++] = n & 255;
    }
    return out;
  }
  R.__b64enc = function enc(v) {
    if (v instanceof Uint8Array) { return { $b64: b64enc(v) }; }
    if (Array.isArray(v)) {
      var a = null;
      for (var i = 0; i < v.length; i++) { var e = enc(v[i]); if (e !== v[i]) { if (!a) a = v.slice(); a[i] = e; } }
      return a || v;
    }
    if (v && typeof v === 'object') {
      var o = null, keys = Object.keys(v);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j], e2 = enc(v[k]);
        if (e2 !== v[k]) { if (!o) { o = {}; for (var m = 0; m < keys.length; m++) o[keys[m]] = v[keys[m]]; } o[k] = e2; }
      }
      return o || v;
    }
    return v;
  };
  R.__b64rev = function rev(v) {
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = rev(v[i]); return v; }
    if (v && typeof v === 'object') {
      var keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$b64' && typeof v.$b64 === 'string') { return b64dec(v.$b64); }
      for (var j = 0; j < keys.length; j++) v[keys[j]] = rev(v[keys[j]]);
      return v;
    }
    return v;
  };`;

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
  // A single ArrayBuffer/view argument takes the dedicated binary channel —
  // the JSON bridge stringifies an ArrayBuffer to '{}', destroying the bytes
  // (the binary op-batch failure mode). typeof-gated so an old wasm binary
  // without __sendBinaryToHost degrades to the JSON path, where the Bridge's
  // shape validation now fails loudly instead of silently.
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
          injectJson('__rill_cb_args', JSON.stringify(cbArgs ?? []));
          // Surface a throwing guest callback to the host logger (via __console_error)
          // rather than swallowing it silently at the evalVoid C boundary; always clear the
          // shared arg global afterward.
          evalVoid(
            `try { globalThis.__rill.invokeCallback(${JSON.stringify(id)},globalThis.__rill_cb_args); } catch (e) { if (typeof __console_error === 'function') { __console_error('[rill] guest callback threw:', e && e.message ? e.message : String(e)); } } finally { delete globalThis.__rill_cb_args; }`
          );
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
          try {
            const parsed = JSON.parse(data) as { args?: ReviewedUnknown[] };
            if (parsed && Array.isArray(parsed.args))
              args = parsed.args.map(reconstructCallbackArg);
          } catch {
            /* malformed payload -> no args */
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
          try {
            injectJson('__rill_fn_ret', JSON.stringify(result === undefined ? null : result));
          } catch {
            // Result not serializable -> restore the documented 'guest sees null' contract.
            // Must explicitly reset: __rill_fn_ret is a shared global and a nested host call
            // may have left a value there, which the outer shim would otherwise return.
            try {
              injectJson('__rill_fn_ret', 'null');
            } catch {
              /* ignore */
            }
          }
        };

        const resolveHostCall = (id: number, value: ReviewedUnknown): void => {
          if (value === undefined) {
            evalVoid(`globalThis.__rill.__resolveHostCall(${id},false)`);
          } else {
            // Encode any Uint8Array in the result as a {"$b64":…} sentinel before it
            // crosses the JSON bridge; the guest __resolveHostCall revives it (DESIGN §B.5).
            injectJson('__rill_host_result', JSON.stringify(encodeBinaryValue(value)));
            evalVoid(
              `globalThis.__rill.__resolveHostCall(${id},true,globalThis.__rill_host_result);delete globalThis.__rill_host_result`
            );
          }
          drainJobs();
        };

        const rejectHostCall = (id: number, message: string): void => {
          injectJson('__rill_host_error', JSON.stringify(message));
          evalVoid(
            `globalThis.__rill.__rejectHostCall(${id},globalThis.__rill_host_error);delete globalThis.__rill_host_error`
          );
          drainJobs();
        };

        const deliverSubscriptionEvent = (subId: string, event: ReviewedUnknown): void => {
          injectJson(
            '__rill_host_event',
            JSON.stringify(encodeBinaryValue(event === undefined ? null : event))
          );
          evalVoid(
            `globalThis.__rill.__deliverHostEvent(${JSON.stringify(subId)},globalThis.__rill_host_event);delete globalThis.__rill_host_event`
          );
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

          if (event === '__rill_host_invoke') {
            const id = m.id ?? 0;
            if (typeof fn !== 'function') {
              rejectHostCall(
                id,
                `[rill] Host module not registered: ${m.moduleId}.${m.exportName}`
              );
              return;
            }
            // Revive {"$b64":…} sentinels in the guest-sent args back to real
            // Uint8Array BEFORE the boundary fn (parseInput + impl) runs, so the host
            // handler sees the same Uint8Array the wasm path delivers (DESIGN §B.5).
            const revivedArgs = reviveBinaryValue(m.args);
            const chain = Promise.resolve()
              .then(() => fn(revivedArgs))
              .then((result) => resolveHostCall(id, result))
              .catch((err: ReviewedUnknown) =>
                rejectHostCall(id, err instanceof Error ? err.message : String(err))
              );
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

            const valueJson = JSON.stringify(value);
            injectJson(name, valueJson);
          },

          extract: (name: string): unknown => {
            const resultPtr = extractJson(name);
            const result = module.UTF8ToString(resultPtr);
            freeString(resultPtr);
            return this.parseResult(result);
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
                  R.__hostSubs = {}; R.__hostSubSeq = 0;${GUEST_B64_CODEC}
                  R.__resolveHostCall = function(id, hasValue, value) {
                    var c = R.__hostCalls[id]; if (!c) return; delete R.__hostCalls[id];
                    c.resolve(hasValue ? R.__b64rev(value) : undefined);
                  };
                  R.__rejectHostCall = function(id, message) {
                    var c = R.__hostCalls[id]; if (!c) return; delete R.__hostCalls[id];
                    c.reject(new Error(message));
                  };
                  R.__deliverHostEvent = function(subId, event) {
                    var h = R.__hostSubs[subId]; if (typeof h === 'function') h(R.__b64rev(event));
                  };
                  R.__invokeHostRpc = function(moduleId, exportName, arg) {
                    var id = ++R.__hostCallSeq;
                    var p = new Promise(function(resolve, reject) {
                      R.__hostCalls[id] = { resolve: resolve, reject: reject };
                    });
                    __sendToHost('__rill_host_invoke', { id: id, moduleId: moduleId, exportName: exportName, args: R.__b64enc(arg === undefined ? null : arg) });
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
      try {
        const parsed = JSON.parse(json);
        if (parsed.error) {
          throw new Error(parsed.error);
        }
      } catch (e) {
        if (e instanceof Error && e.message !== 'Unexpected token') {
          throw e;
        }
        // Not an error object, continue parsing
      }
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
