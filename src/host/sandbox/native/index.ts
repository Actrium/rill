/**
 * @rill/sandbox-native
 *
 * Native JS sandbox for React Native using JSI bindings.
 *
 * Provides three implementations:
 * - Hermes: When RILL_SANDBOX_ENGINE=hermes (isolated Hermes runtime)
 * - QuickJS: Cross-platform (iOS, Android, macOS, Windows)
 * - JSC: Apple platforms only (iOS, macOS, tvOS, visionOS) - zero binary overhead
 */

import type { ReviewedUnknown } from '../../types';

export {
  getHermesModule,
  type HermesContextNative,
  type HermesRuntimeNative,
  isHermesAvailable,
} from './hermes-module';
export {
  getJSCModule,
  isJSCAvailable,
  type JSCContextNative,
  type JSCRuntimeNative,
} from './jsc-module';
export {
  getQuickJSModule,
  isQuickJSAvailable,
  type QuickJSContextNative,
  type QuickJSRuntimeNative,
} from './quickjs-module';

/**
 * Common context interface
 */
export interface SandboxContext {
  eval(code: string): ReviewedUnknown;
  inject(name: string, value: ReviewedUnknown): void;
  extract(name: string): ReviewedUnknown;
  dispose(): void;
}

/**
 * Common runtime interface
 */
export interface SandboxRuntime {
  createContext(): SandboxContext;
  dispose(): void;
}

/**
 * Common module interface
 */
export interface SandboxModule {
  /**
   * Create an isolated runtime.
   *
   * `timeout` (ms) is a wall-clock execution budget per top-level eval.
   * Enforcement is engine-specific: QuickJS interrupts execution via a
   * native interrupt handler; Hermes and JSC have no equivalent interrupt
   * API and currently IGNORE this option — a tenant loop blocks the host
   * thread there. `timeout <= 0` means unlimited.
   *
   * `maxHeapBytes` caps the sandbox heap. Enforced by QuickJS
   * (JS_SetMemoryLimit; <= 0 uses the engine default); Hermes and JSC
   * currently ignore it.
   */
  createRuntime(options?: { timeout?: number; maxHeapBytes?: number }): SandboxRuntime;
  isAvailable(): boolean;
}

/**
 * Get the best available sandbox module for the current platform
 *
 * Priority:
 * 1. Hermes (when RILL_SANDBOX_ENGINE=hermes)
 * 2. JSC (Apple platforms - zero overhead)
 * 3. QuickJS (cross-platform)
 */
export function getSandboxModule(): SandboxModule | null {
  // Hermes sandbox (when built with RILL_SANDBOX_ENGINE=hermes)
  const hermesModule = getHermesModuleSafe();
  if (hermesModule) {
    return hermesModule;
  }

  // Prefer JSC on Apple platforms (uses system JSC, no binary overhead)
  const jscModule = getJSCModuleSafe();
  if (jscModule) {
    return jscModule;
  }

  // Fall back to QuickJS
  const quickjsModule = getQuickJSModuleSafe();
  if (quickjsModule) {
    return quickjsModule;
  }

  return null;
}

function getHermesModuleSafe(): SandboxModule | null {
  try {
    if (
      typeof global !== 'undefined' &&
      global.__HermesSandboxJSI !== undefined &&
      global.__HermesSandboxJSI.isAvailable()
    ) {
      return global.__HermesSandboxJSI as SandboxModule;
    }
  } catch {
    // Not available
  }
  return null;
}

function getJSCModuleSafe(): SandboxModule | null {
  try {
    if (
      typeof global !== 'undefined' &&
      global.__JSCSandboxJSI !== undefined &&
      global.__JSCSandboxJSI.isAvailable()
    ) {
      return global.__JSCSandboxJSI as SandboxModule;
    }
  } catch {
    // Not available
  }
  return null;
}

function getQuickJSModuleSafe(): SandboxModule | null {
  try {
    if (
      typeof global !== 'undefined' &&
      global.__QuickJSSandboxJSI !== undefined &&
      global.__QuickJSSandboxJSI.isAvailable()
    ) {
      return global.__QuickJSSandboxJSI as SandboxModule;
    }
  } catch {
    // Not available
  }
  return null;
}
