/**
 * JSCProvider stub for non-native environments
 * JSCProvider requires native JSI bindings (via @rill/sandbox-native)
 */

import type { JSEngineProvider } from '../types/provider';

export type JSCProviderOptions = {
  timeout?: number | undefined;
};

export class JSCProvider implements JSEngineProvider {
  constructor(_options?: JSCProviderOptions) {
    throw new Error(
      '[JSCProvider] Requires native JSI bindings (Apple platforms). Use VMProvider (Node/Bun) or QuickJSNativeWASMProvider (Web) for non-native environments.'
    );
  }

  createRuntime(): never {
    throw new Error('[JSCProvider] Requires native JSI bindings.');
  }
}

/**
 * Check if JSC native module is available (always false in non-native)
 */
export function isJSCAvailable(): boolean {
  return false;
}
