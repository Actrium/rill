/**
 * HermesProvider stub for non-native environments
 * HermesProvider requires native JSI bindings (via @rill/sandbox-native)
 */

import type { JSEngineProvider } from '../types/provider';

export interface HermesProviderOptions {
  timeout?: number | undefined;
}

export class HermesProvider implements JSEngineProvider {
  constructor(_options?: HermesProviderOptions) {
    throw new Error(
      '[HermesProvider] Requires native JSI bindings (React Native with Hermes). Use VMProvider (Node/Bun) or QuickJSNativeWASMProvider (Web) for non-native environments.'
    );
  }

  createRuntime(): never {
    throw new Error('[HermesProvider] Requires native JSI bindings.');
  }
}

/**
 * Check if Hermes native module is available (always false in non-native)
 */
export function isHermesAvailable(): boolean {
  return false;
}
