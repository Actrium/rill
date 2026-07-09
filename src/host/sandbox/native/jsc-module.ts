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
        /**
         * `timeout` (ms) is only enforced when `enableExecutionTimeLimit` is
         * explicitly true: JSC then arms the private
         * JSContextGroupSetExecutionTimeLimit API, resolved at runtime via
         * dlsym so no private symbol is statically referenced. Default is
         * false — zero App Store review risk, but timeouts are NOT enforced
         * and a tenant loop blocks the host thread. Opting in is meant for
         * enterprise/internal distribution; if the private symbols are
         * unavailable at runtime, JSC logs and falls back to not enforcing.
         */
        createRuntime(options?: {
          timeout?: number;
          enableExecutionTimeLimit?: boolean;
        }): JSCRuntimeNative;
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
