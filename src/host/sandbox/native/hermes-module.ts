/**
 * Hermes Native Module - JSI binding
 *
 * Provides access to the native Hermes sandbox via global.__HermesSandboxJSI
 * Available when RILL_SANDBOX_ENGINE=hermes is set during native build
 */

import type { ReviewedUnknown } from '../../types';

declare global {
  var __HermesSandboxJSI:
    | {
        createRuntime(options?: { timeout?: number }): HermesRuntimeNative;
        isAvailable(): boolean;
      }
    | undefined;
}

interface HermesContextNative {
  eval(code: string): ReviewedUnknown;
  /**
   * Evaluate precompiled Hermes bytecode.
   * Skips parsing and compilation for faster execution.
   * @param bytecode Precompiled Hermes bytecode (.hbc format)
   */
  evalBytecode(bytecode: ArrayBuffer): ReviewedUnknown;
  inject(name: string, value: ReviewedUnknown): void;
  extract(name: string): ReviewedUnknown;
  dispose(): void;
}

interface HermesRuntimeNative {
  createContext(): HermesContextNative;
  dispose(): void;
}

/**
 * Check if Hermes native module is available
 *
 * Note: We use try-catch instead of typeof checks because JSI HostObjects
 * may not return 'function' for typeof when accessing their properties.
 */
export function isHermesAvailable(): boolean {
  try {
    if (typeof global === 'undefined' || global.__HermesSandboxJSI === undefined) {
      return false;
    }
    // Directly call isAvailable() - HostObject will invoke the function via get()
    return global.__HermesSandboxJSI.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Get the native Hermes module
 */
export function getHermesModule() {
  if (!isHermesAvailable()) {
    return null;
  }
  return global.__HermesSandboxJSI!;
}

// Re-export types
export type { HermesContextNative, HermesRuntimeNative };
