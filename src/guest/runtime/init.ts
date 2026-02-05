/**
 * Guest Environment Initialization
 *
 * This file MUST be imported FIRST before any other imports.
 * It sets up the Guest environment markers that CallbackRegistry checks.
 */

import type { SandboxGlobals } from '../../host/sandbox/globals';

const globals = globalThis as typeof globalThis & SandboxGlobals;

// Initialize __rill namespace object
if (!globals.__rill) {
  globals.__rill = {};
}
const __rill = globals.__rill;

// Initialize callbacks BEFORE CallbackRegistry constructor runs
if (!__rill.callbacks) {
  __rill.callbacks = new Map();
}

// Initialize callback counter
if (typeof __rill.callbackId === 'undefined') {
  __rill.callbackId = 0;
}

// Mark Guest environment - CallbackRegistry checks this in constructor
globals.__RILL_GUEST_ENV__ = true;

// Provide registerCallback for CallbackRegistry to use
if (typeof __rill.registerCallback !== 'function') {
  __rill.registerCallback = (fn: (...args: unknown[]) => unknown): string => {
    const id = `fn_${++__rill.callbackId!}`;
    __rill.callbacks!.set(id, fn);
    return id;
  };
}

// Provide invokeCallback for Host to call Guest functions
if (typeof __rill.invokeCallback !== 'function') {
  __rill.invokeCallback = (fnId: string, args: unknown[]): unknown => {
    const fn = __rill.callbacks?.get(fnId);
    if (fn) {
      return fn(...(args || []));
    }
    console.warn('[rill] Callback not found:', fnId);
    return undefined;
  };
}

export const GUEST_INIT_COMPLETE = true;
