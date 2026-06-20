/**
 * @rill/bridge - Type Rules
 *
 * ：/
 * Host ↔ Guest
 */

import { createDecoder, createEncoder } from './serialization';
import type { ReviewedUnknown, SerializedFunction, SerializedPromise } from './types';

export { createDecoder, createEncoder };

/**
 * Helper type for checking serialized objects with __type property
 */
type SerializedObject = { __type: string; [key: string]: unknown };

/**
 *
 */
export type TransportStrategy =
  | 'passthrough' // （JSI ）
  | 'serialize' // （）
  | 'proxy'; // （）

/**
 *
 */
export interface TypeRule {
  /**
   * （）
   */
  name: string;

  /**
   *
   */
  // Reason: Type rule must accept any value to check its type
  match: (value: unknown) => boolean;

  /**
   * （）
   * @param value -
   * @param context - Bridge （ registry ）
   */
  // Reason: Type rule encode/decode must handle arbitrary values
  encode?: (value: unknown, context: CodecCallbacks) => unknown;

  /**
   * （）
   * @param value -
   * @param context - Bridge
   */
  // Reason: Type rule decode must handle arbitrary value types
  decode?: (value: unknown, context: CodecCallbacks) => unknown;

  /**
   *
   */
  strategy: TransportStrategy;
}

/**
 * （Bridge ）
 */
export interface CodecCallbacks {
  /**
   * （）
   */
  // Reason: Recursive encode/decode must handle arbitrary value types
  encode: (value: unknown) => unknown;

  /**
   * （）
   */
  // Reason: Recursive decode must handle arbitrary value types
  decode: (value: unknown) => unknown;

  /**
   * （ fnId）
   */
  // biome-ignore lint/complexity/noBannedTypes: Generic function registration requires Function type
  registerFunction: (fn: Function) => string;

  /**
   * （ fnId）
   */
  // Reason: Callback functions have arbitrary signatures with unknown args/return
  invokeFunction: (fnId: string, args: unknown[]) => unknown;

  /**
   * Optional logger for error reporting
   * If not provided, errors will be logged to console
   */
  logger?: {
    // Reason: Logger methods accept arbitrary console arguments
    error: (...args: unknown[]) => void;
  };

  /**
   *  Promise（ Promise ）
   * Bridge  Promise
   * @param promise -  Promise
   * @returns promiseId
   */
  // Reason: Promise values are runtime-defined across boundaries
  registerPromise?: (promise: Promise<ReviewedUnknown>) => string;

  /**
   *  Promise（）
   * @param promiseId - Promise ID
   * @returns  Promise， resolve/reject
   */
  // Reason: Promise values are runtime-defined across boundaries
  createPendingPromise?: (promiseId: string) => Promise<ReviewedUnknown>;
}

/**
 *
 */
export const DEFAULT_TYPE_RULES: TypeRule[] = [
  // 1. Null/Undefined -
  {
    name: 'null-undefined',
    match: (v) => v === null || v === undefined,
    strategy: 'passthrough',
  },

  // 2. Primitives -
  {
    name: 'primitives',
    match: (v) => typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string',
    strategy: 'passthrough',
  },

  // 2.5. Circular Reference -  undefined（）
  {
    name: 'circular',
    match: (v) =>
      typeof v === 'object' &&
      v !== null &&
      '__type' in v &&
      (v as { __type: string }).__type === 'circular',
    decode: () => undefined, // ， undefined
    strategy: 'serialize',
  },

  // 3. Serialized Function -  proxy
  {
    name: 'serialized-function',
    match: (v) =>
      typeof v === 'object' &&
      v !== null &&
      '__type' in v &&
      (v as SerializedFunction).__type === 'function' &&
      '__fnId' in v,
    decode: (v, ctx) => {
      const { __fnId, __name, __sourceFile, __sourceLine } = v as SerializedFunction;
      // Reason: Deserialized function proxy accepts arbitrary arguments
      const proxy = (...args: unknown[]) => {
        try {
          // IMPORTANT: Encode args before crossing JSI boundary to Guest sandbox
          // This handles complex objects like GestureResponderEvent which may contain:
          // - Functions (preventDefault, stopPropagation) → { __type: 'function', __fnId }
          // - Native object references → recursively encoded to plain objects
          // - Circular references → { __type: 'circular' }
          // Without encoding, JSI inject would crash when passing these types
          const encodedArgs = args.map((arg) => ctx.encode(arg));
          const result = ctx.invokeFunction(__fnId, encodedArgs);
          // Async errors propagate naturally as Promise rejections
          return result;
        } catch (err) {
          // String-only console to avoid JSI circular ref traversal in JSC sandbox.
          // Error objects may reference React fiber tree (circular).
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? (err.stack ?? '') : '';
          console.error(`[rill:TypeRules] Callback ${__fnId} threw sync error: ${errMsg}`);
          if (errStack) console.error(`[rill:TypeRules] stack: ${errStack}`);
          // Also use provided logger if available
          if (ctx.logger?.error) {
            ctx.logger.error(`[TypeRules] Callback ${__fnId} threw sync error: ${errMsg}`);
          }
          // In debug mode, re-throw to help identify the issue quickly
          // Check for global debug flag (set by Host or tests)
          if (
            typeof globalThis !== 'undefined' &&
            (globalThis as { __RILL_DEBUG__?: boolean }).__RILL_DEBUG__
          ) {
            throw err;
          }
          // In production, return undefined to prevent Host crashes
          // but the error is still visible in console
          return undefined;
        }
      };
      // Attach metadata for DevTools inspection and callback invocation
      const proxyWithMeta = proxy as {
        __type?: string;
        __fnId?: string;
        __name?: string;
        __sourceFile?: string;
        __sourceLine?: number;
      };
      proxyWithMeta.__type = 'function';
      proxyWithMeta.__fnId = __fnId;
      if (__name) {
        proxyWithMeta.__name = __name;
      }
      if (__sourceFile) {
        proxyWithMeta.__sourceFile = __sourceFile;
        // PERF: No console calls here — runs in render hot path.
        // In JSC sandbox, console calls trigger JSI circular reference traversal.
      }
      if (__sourceLine !== undefined) {
        proxyWithMeta.__sourceLine = __sourceLine;
      }
      return proxy;
    },
    strategy: 'proxy',
  },

  // 4. Functions -  fnId
  {
    name: 'function',
    match: (v) => typeof v === 'function',
    encode: (fn, ctx) => {
      // biome-ignore lint/complexity/noBannedTypes: fn is verified as function by match()
      const func = fn as Function;
      const fnId = ctx.registerFunction(func);

      // Check for pre-attached source location metadata (from Babel plugin or manual annotation)
      const fnWithMeta = func as {
        __sourceFile?: string;
        __sourceLine?: number;
        __name?: string;
      };

      // Capture function name for DevTools
      const fnName = fnWithMeta.__name || func.name || undefined;

      // Source location is injected by Babel plugin at compile time
      // via __sourceFile and __sourceLine properties on the function
      const sourceFile = fnWithMeta.__sourceFile;
      const sourceLine = fnWithMeta.__sourceLine;

      // PERF: No console calls here — runs in render hot path.
      // In JSC sandbox, console calls trigger JSI circular reference traversal.

      return {
        __type: 'function',
        __fnId: fnId,
        __name: fnName,
        __sourceFile: sourceFile,
        __sourceLine: sourceLine,
      } as SerializedFunction;
    },
    strategy: 'proxy',
  },

  // 4.5. Serialized Promise -  pending Promise
  {
    name: 'serialized-promise',
    match: (v) =>
      typeof v === 'object' &&
      v !== null &&
      '__type' in v &&
      (v as SerializedPromise).__type === 'promise' &&
      '__promiseId' in v,
    decode: (v, ctx) => {
      const { __promiseId } = v as SerializedPromise;
      //  Bridge  createPendingPromise，
      if (ctx.createPendingPromise) {
        return ctx.createPendingPromise(__promiseId);
      }
      //  resolve  Promise（）
      console.warn('[TypeRules] Promise decoding not supported, createPendingPromise not provided');
      return new Promise(() => {});
    },
    strategy: 'proxy',
  },

  // 4.6. Promise -  promiseId
  {
    name: 'promise',
    match: (v) => v instanceof Promise,
    encode: (promise, ctx) => {
      //  Bridge  registerPromise，
      if (ctx.registerPromise) {
        const promiseId = ctx.registerPromise(promise as Promise<ReviewedUnknown>);
        return { __type: 'promise', __promiseId: promiseId } as SerializedPromise;
      }
      //  unsupported（）
      console.warn('[TypeRules] Promise encoding not supported, registerPromise not provided');
      return { __type: 'unsupported', __originalType: 'Promise' } as unknown;
    },
    strategy: 'proxy',
  },

  // 5. Date -
  {
    name: 'date',
    match: (v) =>
      v instanceof Date ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'date'),
    encode: (date) => {
      // Already serialized by Guest?
      if (
        typeof date === 'object' &&
        date !== null &&
        '__type' in date &&
        (date as SerializedObject).__type === 'date'
      ) {
        return date;
      }
      return {
        __type: 'date',
        __value: (date as Date).toISOString(),
      };
    },
    decode: (obj) => {
      if (obj instanceof Date) return obj;
      const { __value } = obj as { __type: 'date'; __value: string };
      return new Date(__value);
    },
    strategy: 'serialize',
  },

  // 6. RegExp -
  {
    name: 'regexp',
    match: (v) =>
      v instanceof RegExp ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'regexp'),
    encode: (regex) => {
      // Already serialized by Guest?
      if (
        typeof regex === 'object' &&
        regex !== null &&
        '__type' in regex &&
        (regex as SerializedObject).__type === 'regexp'
      ) {
        return regex;
      }
      return {
        __type: 'regexp',
        __source: (regex as RegExp).source,
        __flags: (regex as RegExp).flags,
      };
    },
    decode: (obj) => {
      if (obj instanceof RegExp) return obj;
      const { __source, __flags } = obj as {
        __type: 'regexp';
        __source: string;
        __flags: string;
      };
      return new RegExp(__source, __flags);
    },
    strategy: 'serialize',
  },

  // 7. Error -
  {
    name: 'error',
    match: (v) =>
      v instanceof Error ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'error'),
    encode: (error) => {
      // Already serialized by Guest?
      if (
        typeof error === 'object' &&
        error !== null &&
        '__type' in error &&
        (error as SerializedObject).__type === 'error'
      ) {
        return error;
      }
      return {
        __type: 'error',
        __name: (error as Error).name,
        __message: (error as Error).message,
        __stack: (error as Error).stack,
      };
    },
    decode: (obj) => {
      if (obj instanceof Error) return obj;
      const { __name, __message, __stack } = obj as {
        __type: 'error';
        __name: string;
        __message: string;
        __stack?: string;
      };
      const error = new Error(__message);
      error.name = __name;
      if (__stack) {
        error.stack = __stack;
      }
      return error;
    },
    strategy: 'serialize',
  },

  // 8. Map - /
  {
    name: 'map',
    match: (v) =>
      v instanceof Map ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'map'),
    encode: (map, ctx) => {
      // Already serialized by Guest?
      if (!(map instanceof Map)) {
        return map;
      }
      const entries: [unknown, unknown][] = [];
      for (const [k, v] of map.entries()) {
        entries.push([ctx.encode(k), ctx.encode(v)]);
      }
      return { __type: 'map', __entries: entries };
    },
    decode: (obj, ctx) => {
      if (obj instanceof Map) return obj;
      const { __entries } = obj as { __type: 'map'; __entries: [unknown, unknown][] };
      const map = new Map();
      for (const [k, v] of __entries) {
        map.set(ctx.decode(k), ctx.decode(v));
      }
      return map;
    },
    strategy: 'serialize',
  },

  // 9. Set - /
  {
    name: 'set',
    match: (v) =>
      v instanceof Set ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'set'),
    encode: (set, ctx) => {
      // Already serialized by Guest?
      if (!(set instanceof Set)) {
        return set;
      }
      const values: ReviewedUnknown[] = [];
      for (const v of set.values()) {
        values.push(ctx.encode(v));
      }
      return { __type: 'set', __values: values };
    },
    decode: (obj, ctx) => {
      if (obj instanceof Set) return obj;
      const { __values } = obj as { __type: 'set'; __values: ReviewedUnknown[] };
      const set = new Set();
      for (const v of __values) {
        set.add(ctx.decode(v));
      }
      return set;
    },
    strategy: 'serialize',
  },

  // 10. TypedArray -  (must be before ArrayBuffer)
  {
    name: 'typedarray',
    match: (v) =>
      (ArrayBuffer.isView(v) && !(v instanceof DataView)) ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'typedarray'),
    encode: (view) => {
      if (!ArrayBuffer.isView(view) || view instanceof DataView) {
        // Already serialized
        return view;
      }
      const typedArray = view as
        | Int8Array
        | Uint8Array
        | Uint8ClampedArray
        | Int16Array
        | Uint16Array
        | Int32Array
        | Uint32Array
        | Float32Array
        | Float64Array
        | BigInt64Array
        | BigUint64Array;

      // Get constructor name for reconstruction
      const ctorName = typedArray.constructor.name;

      // Handle BigInt arrays: encode raw buffer bytes instead of string[]
      // This is more compact: 8 bytes per element vs decimal string per element
      if (typedArray instanceof BigInt64Array || typedArray instanceof BigUint64Array) {
        const bytes = new Uint8Array(
          typedArray.buffer,
          typedArray.byteOffset,
          typedArray.byteLength
        );
        return {
          __type: 'typedarray',
          __ctor: ctorName,
          __data: Array.from(bytes),
          __bigint: true,
        };
      }

      return {
        __type: 'typedarray',
        __ctor: ctorName,
        __data: Array.from(typedArray as Uint8Array), // Works for all non-BigInt typed arrays
      };
    },
    decode: (obj) => {
      if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        return obj;
      }
      const { __ctor, __data, __bigint } = obj as {
        __type: 'typedarray';
        __ctor: string;
        __data: number[];
        __bigint?: boolean;
      };

      // Map constructor name to actual constructor
      const constructors: Record<
        string,
        new (
          data: ArrayLike<number> | ArrayLike<bigint>
        ) => ArrayBufferView
      > = {
        Int8Array: Int8Array,
        Uint8Array: Uint8Array,
        Uint8ClampedArray: Uint8ClampedArray,
        Int16Array: Int16Array,
        Uint16Array: Uint16Array,
        Int32Array: Int32Array,
        Uint32Array: Uint32Array,
        Float32Array: Float32Array,
        Float64Array: Float64Array,
        BigInt64Array: BigInt64Array as unknown as new (
          data: ArrayLike<number> | ArrayLike<bigint>
        ) => ArrayBufferView,
        BigUint64Array: BigUint64Array as unknown as new (
          data: ArrayLike<number> | ArrayLike<bigint>
        ) => ArrayBufferView,
      };

      const Ctor = constructors[__ctor];
      if (!Ctor) {
        console.warn(`[TypeRules] Unknown TypedArray constructor: ${__ctor}`);
        return new Uint8Array(__data as number[]);
      }

      // Handle BigInt arrays: reconstruct from raw buffer bytes
      if (__bigint) {
        const bytes = new Uint8Array(__data as number[]);
        const buffer = bytes.buffer;
        return new (Ctor as unknown as new (buffer: ArrayBuffer) => BigInt64Array | BigUint64Array)(
          buffer
        );
      }

      return new (Ctor as new (data: number[]) => ArrayBufferView)(__data as number[]);
    },
    strategy: 'serialize',
  },

  // 11. ArrayBuffer -
  {
    name: 'arraybuffer',
    match: (v) =>
      v instanceof ArrayBuffer ||
      (typeof v === 'object' &&
        v !== null &&
        '__type' in v &&
        (v as SerializedObject).__type === 'arraybuffer'),
    encode: (buffer) => {
      if (!(buffer instanceof ArrayBuffer)) {
        // Already serialized
        return buffer;
      }
      const bytes = new Uint8Array(buffer);
      return {
        __type: 'arraybuffer',
        __data: Array.from(bytes),
      };
    },
    decode: (obj) => {
      if (obj instanceof ArrayBuffer) {
        return obj;
      }
      const { __data } = obj as { __type: 'arraybuffer'; __data: number[] };
      const bytes = new Uint8Array(__data);
      return bytes.buffer;
    },
    strategy: 'serialize',
  },

  // 12. Arrays -  (reference-preserving decode)
  {
    name: 'array',
    match: (v) => Array.isArray(v),
    encode: (arr, ctx) => (arr as unknown[]).map((item) => ctx.encode(item)),
    decode: (arr, ctx) => {
      const input = arr as unknown[];
      let changed = false;
      const result = input.map((item) => {
        const decoded = ctx.decode(item);
        if (decoded !== item) changed = true;
        return decoded;
      });
      return changed ? result : arr;
    },
    strategy: 'serialize',
  },

  // 13. toJSON -
  //  toJSON()
  // : class User { toJSON() { return { __class: 'User', name: this.name }; } }
  {
    name: 'toJSON',
    match: (v) =>
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as { toJSON?: ReviewedUnknown }).toJSON === 'function' &&
      // （Date, RegExp ）
      !(v instanceof Date) &&
      !(v instanceof RegExp) &&
      !(v instanceof Error) &&
      !(v instanceof Map) &&
      !(v instanceof Set),
    encode: (obj, ctx) => {
      //  toJSON ，
      const serialized = (obj as { toJSON: () => unknown }).toJSON();
      return ctx.encode(serialized);
    },
    // decode ，toJSON
    strategy: 'serialize',
  },

  // 14. Objects -  (reference-preserving decode)
  {
    name: 'object',
    match: (v) => typeof v === 'object' && v !== null,
    encode: (obj, ctx) => {
      // （，）
      if (typeof obj === 'object' && obj !== null && '__type' in obj) {
        const typed = obj as { __type: string };
        const specialTypes = [
          'date',
          'regexp',
          'error',
          'function',
          'circular',
          'arraybuffer',
          'typedarray',
        ];
        if (specialTypes.includes(typed.__type)) {
          return obj;
        }
      }

      //
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        result[key] = ctx.encode(value);
      }
      return result;
    },
    decode: (obj, ctx) => {
      // （，）
      if (typeof obj === 'object' && obj !== null && '__type' in obj) {
        // ，
        return obj;
      }

      // Reference-preserving: only create new object if any value changed.
      // Critical for React reconciliation — new refs for unchanged props
      // (e.g., style objects) breaks shallow comparison.
      const entries = Object.entries(obj as Record<string, unknown>);
      let changed = false;
      const result: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        const decoded = ctx.decode(value);
        result[key] = decoded;
        if (decoded !== value) changed = true;
      }
      return changed ? result : obj;
    },
    strategy: 'serialize',
  },
];
