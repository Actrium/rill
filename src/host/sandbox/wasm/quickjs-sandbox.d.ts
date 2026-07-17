/**
 * Type declarations for QuickJS WASM module
 */

import type { ReviewedUnknown } from '../../types';

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
  // Binary staging table backing the {"$bin":id} JSON sentinel (first-class
  // ArrayBuffer marshalling). Every staged id is consumed exactly once;
  // qjs_binary_count() exists for zero-leak assertions.
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

type QuickJSWASMFactoryModuleArg = {
  locateFile?: (path: string, scriptDirectory?: string) => string;
  /** Instantiate from these bytes directly (no fetch; required under strict CSP). */
  wasmBinary?: Uint8Array | ArrayBuffer;
};

type QuickJSWASMFactory = (moduleArg?: QuickJSWASMFactoryModuleArg) => Promise<QuickJSWASMModule>;

declare const createQuickJSSandbox: QuickJSWASMFactory;
export default createQuickJSSandbox;
