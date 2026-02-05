/**
 * Sandbox Injection Helper Functions
 *
 * Utilities for formatting console output and handling sandbox globals
 */

import type { ReviewedUnknown } from '../types';

/**
 * Format argument for console output (handles circular references)
 */
export function formatArg(arg: unknown, seen = new WeakSet()): unknown {
  if (arg === null || arg === undefined) return arg;
  if (typeof arg !== 'object') return arg;

  // Handle circular references
  if (seen.has(arg as object)) return '[Circular]';
  seen.add(arg as object);

  // Handle arrays
  if (Array.isArray(arg)) {
    return arg.map((item) => formatArg(item, seen));
  }

  // Handle plain objects
  try {
    const formatted: Record<string, unknown> = {};
    for (const key of Object.keys(arg as object)) {
      formatted[key] = formatArg((arg as Record<string, unknown>)[key], seen);
    }
    return formatted;
  } catch {
    return String(arg);
  }
}

/**
 * Format string template with placeholders (%s, %d, %i, %f, %o, %O)
 */
export function formatWithPlaceholders(template: string, params: ReviewedUnknown[]): string {
  let idx = 0;
  return template.replace(/%[sdifoO]/g, (token) => {
    const value = idx < params.length ? params[idx++] : '';
    switch (token) {
      case '%d':
      case '%i':
        return String(Number(value));
      case '%f':
        return String(Number(value));
      case '%o':
      case '%O': {
        try {
          return JSON.stringify(formatArg(value), null, 2);
        } catch {
          return String(value);
        }
      }
      default:
        return String(value);
    }
  });
}

/**
 * Format console arguments (handles template strings and object formatting)
 */
export function formatConsoleArgs(args: ReviewedUnknown[]): ReviewedUnknown[] {
  if (args.length > 1 && typeof args[0] === 'string' && /%[sdifoO]/.test(args[0])) {
    const [template, ...rest] = args;
    const formattedFirst = formatWithPlaceholders(template as string, rest);
    const remaining = rest
      .slice((template as string).match(/%[sdifoO]/g)?.length ?? 0)
      .map((arg) =>
        typeof arg === 'object' && arg !== null
          ? (() => {
              try {
                return JSON.stringify(formatArg(arg), null, 2);
              } catch {
                return formatArg(arg);
              }
            })()
          : arg
      );
    return [formattedFirst, ...remaining];
  }

  return args.map((arg) => {
    if (typeof arg === 'object' && arg !== null) {
      try {
        // Format objects nicely with JSON.stringify for readability
        return JSON.stringify(formatArg(arg), null, 2);
      } catch {
        return formatArg(arg);
      }
    }
    return arg;
  });
}

/**
 * Create minimal CommonJS globals
 */
export function createCommonJSGlobals() {
  const moduleObj = { exports: {} as Record<string, unknown> };
  return {
    module: moduleObj,
    exports: moduleObj.exports,
  };
}

/**
 * Create React Native shim module
 */
export function createReactNativeShim() {
  const Image = {
    type: 'Image',
    resolveAssetSource: (source: ReviewedUnknown): ReviewedUnknown => source,
    prefetch: async (_uri?: string) => true,
    queryCache: async (_uris?: string[]) => ({}) as Record<string, 'disk' | 'memory'>,
    getSize: (_uri: string, success?: (w: number, h: number) => void) => {
      if (typeof success === 'function') success(0, 0);
    },
  };

  return {
    Platform: {
      OS: 'web',
      select: (o: Record<string, unknown>) => o.default ?? o.web,
    },
    StyleSheet: { create: (s: ReviewedUnknown): ReviewedUnknown => s },
    View: 'View',
    Text: 'Text',
    Image,
    ScrollView: 'ScrollView',
    TouchableOpacity: 'TouchableOpacity',
    Button: 'Button',
    ActivityIndicator: 'ActivityIndicator',
    FlatList: 'FlatList',
    TextInput: 'TextInput',
    Switch: 'Switch',
  };
}

/**
 * Create console setup code for sandbox
 */
export const CONSOLE_SETUP_CODE = `
(function(){
  // JSI-safe argument sanitizer: stringify non-primitives before crossing JSI boundary
  // to avoid circular reference traversal (React fiber trees attached to Error objects).
  function __safeArg(a) {
    if (a === null || a === undefined) return a;
    var t = typeof a;
    if (t === 'string' || t === 'number' || t === 'boolean') return a;
    if (a instanceof Error) {
      var n = a.name || 'Error', m = a.message || '', s = a.stack || '';
      return s ? n + ': ' + m + '\\n' + s : n + ': ' + m;
    }
    if (t === 'function') return '[Function: ' + (a.name || 'anonymous') + ']';
    try { return JSON.stringify(a); } catch(e) { try { return String(a); } catch(e2) { return '[object]'; } }
  }
  function __safeArgs(args) { var r = []; for (var i = 0; i < args.length; i++) r.push(__safeArg(args[i])); return r; }
  if (typeof globalThis.console === 'undefined') {
    globalThis.console = {
      log: function() { __console_log.apply(null, __safeArgs(arguments)); },
      warn: function() { __console_warn.apply(null, __safeArgs(arguments)); },
      error: function() { __console_error.apply(null, __safeArgs(arguments)); },
      debug: function() { __console_debug.apply(null, __safeArgs(arguments)); },
      info: function() { __console_info.apply(null, __safeArgs(arguments)); }
    };
  }
})();`;

/**
 * Create runtime helpers code for sandbox
 */
export const RUNTIME_HELPERS_CODE = `
(function(){
  // Initialize __rill namespace
  if (!globalThis.__rill) { globalThis.__rill = {}; }
  var __rill = globalThis.__rill;

  if (typeof __rill.eventListeners === 'undefined') {
    var __eventListeners = new Map();
    __rill.eventListeners = __eventListeners;
    globalThis.__rill_onHostEvent = function(eventName, callback){
      if (!__eventListeners.has(eventName)) __eventListeners.set(eventName, new Set());
      var set = __eventListeners.get(eventName);
      set.add(callback);
      return function(){ try { set.delete(callback); } catch(_){} };
    };
    __rill.dispatchEvent = function(eventName, payload){
      var set = __eventListeners.get(eventName);
      if (set) {
        set.forEach(function(cb){ try { cb(payload); } catch(e) { console.error('[rill] Host event listener error: ' + (e && e.message ? e.message : String(e))); } });
      }
    };
  }

  // Callback registry helpers
  if (!__rill.callbacks) {
    __rill.callbacks = new Map();
  }
  if (typeof __rill.callbackId !== 'number') {
    __rill.callbackId = 0;
  }
  if (typeof __rill.registerCallback !== 'function') {
    __rill.registerCallback = function(fn){
      var id = 'fn_' + (++__rill.callbackId);
      __rill.callbacks.set(id, fn);
      return id;
    };
  }
  if (typeof __rill.invokeCallback !== 'function') {
    __rill.invokeCallback = function(id, args){
      var fn = __rill.callbacks.get(id);
      if (fn) {
        try {
          return fn.apply(null, args || []);
        } catch(e) {
          var msg = e && e.message ? e.message : String(e);
          var stack = e && e.stack ? e.stack : '';
          console.error('[rill] Callback ' + id + ' threw: ' + msg);
          if (stack) console.error('[rill] stack: ' + stack);
          throw e;
        }
      } else {
        console.warn('[rill] Callback not found:', id);
      }
    };
  }
  if (typeof __rill.removeCallback !== 'function') {
    __rill.removeCallback = function(id){
      __rill.callbacks.delete(id);
    };
  }
})();`;
