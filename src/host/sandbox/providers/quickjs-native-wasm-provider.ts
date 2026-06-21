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
  _qjs_eval: (codePtr: number) => number;
  _qjs_eval_void: (codePtr: number) => number;
  _qjs_inject_json: (namePtr: number, valuePtr: number) => number;
  _qjs_extract_json: (namePtr: number) => number;
  _qjs_set_host_callback: (fnPtr: number) => void;
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
   * Custom WASM module factory
   */
  wasmFactory?: QuickJSWASMFactory;

  /**
   * Execution timeout (milliseconds)
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
  return `globalThis[${nameKey}] = function() {
    var a = Array.prototype.slice.call(arguments);
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

        // host:* module bridge handler. Assigned once the eval helpers below are
        // defined; the guest reaches it by posting `__rill_host_*` events through
        // __sendToHost (see installHostModules).
        let onHostModuleEvent: ((event: string, data: string) => void) | null = null;

        // By-name host->guest function bridge (issue #8). The isolated WASM realm
        // can't receive a host function reference, so each function injected by name
        // (render: __rill_sendBatch; events: __rill_emitEvent; config: __rill_getConfig;
        // etc.) is registered here and reached via __sendToHost -> onHostFnCall.
        let onHostFnCall: ((name: string, data: string) => void) | null = null;
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
        const evalCode = module.cwrap('qjs_eval', 'number', ['string']) as (code: string) => number;
        const evalVoid = module.cwrap('qjs_eval_void', 'number', ['string']) as (
          code: string
        ) => number;
        const injectJson = module.cwrap('qjs_inject_json', 'number', ['string', 'string']) as (
          name: string,
          json: string
        ) => number;
        const extractJson = module.cwrap('qjs_extract_json', 'number', ['string']) as (
          name: string
        ) => number;
        const freeString = module._qjs_free_string.bind(module);

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
          module._qjs_execute_pending_jobs();
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
            injectJson('__rill_host_result', JSON.stringify(value));
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
          injectJson('__rill_host_event', JSON.stringify(event === undefined ? null : event));
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
            const chain = Promise.resolve()
              .then(() => fn(m.args))
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

            // Process any microtasks
            module._qjs_execute_pending_jobs();

            return this.parseResult(result);
          },

          evalAsync: async (code: string): Promise<ReviewedUnknown> => {
            const resultPtr = evalCode(code);
            const result = module.UTF8ToString(resultPtr);
            freeString(resultPtr);

            // Process microtasks
            module._qjs_execute_pending_jobs();

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
                  R.__hostSubs = {}; R.__hostSubSeq = 0;
                  R.__resolveHostCall = function(id, hasValue, value) {
                    var c = R.__hostCalls[id]; if (!c) return; delete R.__hostCalls[id];
                    c.resolve(hasValue ? value : undefined);
                  };
                  R.__rejectHostCall = function(id, message) {
                    var c = R.__hostCalls[id]; if (!c) return; delete R.__hostCalls[id];
                    c.reject(new Error(message));
                  };
                  R.__deliverHostEvent = function(subId, event) {
                    var h = R.__hostSubs[subId]; if (typeof h === 'function') h(event);
                  };
                  R.__invokeHostRpc = function(moduleId, exportName, arg) {
                    var id = ++R.__hostCallSeq;
                    var p = new Promise(function(resolve, reject) {
                      R.__hostCalls[id] = { resolve: resolve, reject: reject };
                    });
                    __sendToHost('__rill_host_invoke', { id: id, moduleId: moduleId, exportName: exportName, args: arg === undefined ? null : arg });
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
      const wasmPath = this.options.wasmPath;
      this.loadPromise = this.options.wasmFactory(
        wasmPath
          ? {
              locateFile: (path: string) => (path.endsWith('.wasm') ? wasmPath : path),
            }
          : undefined
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
