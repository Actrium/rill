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

        // Track pending timers for cleanup
        const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
        let hostCallbackPtr = 0;
        let timerCallbackPtr = 0;

        // Install host callback for communication
        const hostCallback = (eventPtr: number, dataPtr: number) => {
          const event = module.UTF8ToString(eventPtr);
          const data = module.UTF8ToString(dataPtr);

          if (this.options.debug) {
            console.log(`[QuickJSWASM] Host callback: ${event}`, data);
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

        // Install timer support
        const timerCallback = (encodedValue: number) => {
          const timerId = encodedValue >> 16;
          const delay = encodedValue & 0xffff;

          if (this.options.debug) {
            console.log(`[QuickJSWASM] Timer scheduled: id=${timerId}, delay=${delay}`);
          }

          const handle = setTimeout(() => {
            pendingTimers.delete(timerId);
            module._qjs_fire_timer(timerId);
            // Process any promises that might have resolved
            module._qjs_execute_pending_jobs();
          }, delay);

          pendingTimers.set(timerId, handle);
        };

        timerCallbackPtr = module.addFunction(timerCallback, 'vi');
        module._qjs_set_timer_callback(timerCallbackPtr);
        module._qjs_install_timer_functions();

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
            // Handle functions specially
            if (typeof value === 'function') {
              // Create a wrapper in the sandbox
              const fnId = `__host_fn_${name}_${Date.now()}`;
              const wrapperCode = `
                globalThis["${name}"] = function(...args) {
                  globalThis.__rill_sendBatch("CALL_HOST_FN", { fnId: "${fnId}", args: args });
                };
              `;
              evalVoid(wrapperCode);
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

          dispose: (): void => {
            // Clear pending timers
            for (const handle of pendingTimers.values()) {
              clearTimeout(handle);
            }
            pendingTimers.clear();

            // Remove function pointers
            if (hostCallbackPtr) {
              module.removeFunction(hostCallbackPtr);
            }
            if (timerCallbackPtr) {
              module.removeFunction(timerCallbackPtr);
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
