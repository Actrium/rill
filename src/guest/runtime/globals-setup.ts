/**
 * Guest Globals Setup
 *
 * Sets up console and runtime helpers in the Guest sandbox.
 * This must run after Host has set up __console_* globals via inject.
 */

import type { SandboxGlobals } from '../../host/sandbox/globals';

// ============================================
// Console Setup
// ============================================

declare const __console_log: (...args: unknown[]) => void;
declare const __console_warn: (...args: unknown[]) => void;
declare const __console_error: (...args: unknown[]) => void;
declare const __console_debug: (...args: unknown[]) => void;
declare const __console_info: (...args: unknown[]) => void;

// Reason: Console arguments can be any runtime values (including non-serializable objects)
function __safeArg(arg: unknown): unknown {
  if (arg === null || arg === undefined) return arg;
  const t = typeof arg;
  if (t === 'string' || t === 'number' || t === 'boolean') return arg;
  if (arg instanceof Error) {
    const name = arg.name || 'Error';
    const msg = arg.message || '';
    const stack = arg.stack || '';
    return stack ? `${name}: ${msg}\n${stack}` : `${name}: ${msg}`;
  }
  if (t === 'function') return `[Function: ${(arg as { name?: string }).name || 'anonymous'}]`;
  if (t === 'symbol') return (arg as symbol).toString();
  try {
    return JSON.stringify(arg);
  } catch {
    try {
      return String(arg);
    } catch {
      return '[object]';
    }
  }
}

(globalThis as Record<string, unknown>).console = {
  log: (...args: unknown[]) => __console_log(...args.map(__safeArg)),
  warn: (...args: unknown[]) => __console_warn(...args.map(__safeArg)),
  error: (...args: unknown[]) => __console_error(...args.map(__safeArg)),
  debug: (...args: unknown[]) => __console_debug(...args.map(__safeArg)),
  info: (...args: unknown[]) => __console_info(...args.map(__safeArg)),
};

// ============================================
// Host Event System
// ============================================

type HostEventCallback = (payload: unknown) => void;

// Ensure __rill namespace exists (init.ts should have created it)
const __rill =
  (globalThis as unknown as SandboxGlobals).__rill ||
  ((globalThis as unknown as SandboxGlobals).__rill = {});

const __eventListeners = new Map<string, Set<HostEventCallback>>();
__rill.eventListeners = __eventListeners;

// Subscribe to host events (used by __rill_onHostEvent hook)
(globalThis as Record<string, unknown>).__rill_onHostEvent = (
  eventName: string,
  callback: HostEventCallback
): (() => void) => {
  if (!__eventListeners.has(eventName)) {
    __eventListeners.set(eventName, new Set());
  }
  const set = __eventListeners.get(eventName)!;
  set.add(callback);
  return () => {
    try {
      set.delete(callback);
    } catch {
      // ignore cleanup errors
    }
  };
};

// Called by Host to dispatch events to Guest listeners
// Reason: Host event payload type is runtime-defined
__rill.dispatchEvent = (eventName: string, payload: unknown): void => {
  const set = __eventListeners.get(eventName);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[rill] Host event listener error: ${msg}`);
      }
    });
  }
};

// ============================================
// Callback Registry Helpers
// ============================================

if (typeof __rill.removeCallback !== 'function') {
  __rill.removeCallback = (id: string): void => {
    __rill.callbacks?.delete(id);
  };
}

export const GLOBALS_SETUP_COMPLETE = true;
