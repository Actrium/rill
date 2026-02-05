/**
 * JSC Native Module - JSI binding
 *
 * Provides access to the native JSC sandbox via global.__JSCSandboxJSI
 * Only available on Apple platforms (iOS, macOS, tvOS, visionOS)
 */

import type { ReviewedUnknown } from '../../types';

declare global {
  var __JSCSandboxJSI:
    | {
        createRuntime(options?: { timeout?: number }): JSCRuntimeNative;
        isAvailable(): boolean;
      }
    | undefined;
}

interface JSCContextNative {
  eval(code: string): ReviewedUnknown;
  inject(name: string, value: ReviewedUnknown): void;
  extract(name: string): ReviewedUnknown;
  dispose(): void;
}

interface JSCRuntimeNative {
  createContext(): JSCContextNative;
  dispose(): void;
}

/**
 * Check if JSC native module is available
 *
 * Note: We use try-catch instead of typeof checks because JSI HostObjects
 * may not return 'function' for typeof when accessing their properties.
 */
export function isJSCAvailable(): boolean {
  try {
    if (typeof global === 'undefined' || global.__JSCSandboxJSI === undefined) {
      return false;
    }
    return global.__JSCSandboxJSI.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Get the native JSC module
 */
export function getJSCModule() {
  if (!isJSCAvailable()) {
    return null;
  }
  return global.__JSCSandboxJSI!;
}

// Re-export types
export type { JSCContextNative, JSCRuntimeNative };
