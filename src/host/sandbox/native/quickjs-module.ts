/**
 * QuickJS Native Module - JSI binding
 *
 * Provides access to the native QuickJS sandbox via global.__QuickJSSandboxJSI
 */

import type { ReviewedUnknown } from '../../types';

declare global {
  var __QuickJSSandboxJSI:
    | {
        /** `maxHeapBytes` caps the QuickJS heap (JS_SetMemoryLimit); <= 0 uses the 256MB default. */
        createRuntime(options?: { timeout?: number; maxHeapBytes?: number }): QuickJSRuntimeNative;
        isAvailable(): boolean;
      }
    | undefined;
}

interface QuickJSContextNative {
  eval(code: string): ReviewedUnknown;
  inject(name: string, value: ReviewedUnknown): void;
  extract(name: string): ReviewedUnknown;
  dispose(): void;
}

interface QuickJSRuntimeNative {
  createContext(): QuickJSContextNative;
  dispose(): void;
}

/**
 * Check if QuickJS native module is available
 *
 * Note: We use try-catch instead of typeof checks because JSI HostObjects
 * may not return 'function' for typeof when accessing their properties.
 */
export function isQuickJSAvailable(): boolean {
  try {
    if (typeof global === 'undefined' || global.__QuickJSSandboxJSI === undefined) {
      return false;
    }
    return global.__QuickJSSandboxJSI.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Get the native QuickJS module
 */
export function getQuickJSModule() {
  if (!isQuickJSAvailable()) {
    return null;
  }
  return global.__QuickJSSandboxJSI!;
}

// Re-export types
export type { QuickJSContextNative, QuickJSRuntimeNative };
