/**
 * QuickJSProvider stub for non-native environments
 * QuickJSProvider requires native JSI bindings (via @rill/sandbox-native)
 */

import type { JSEngineProvider } from '../types/provider';

export type QuickJSProviderOptions = {
  timeout?: number | undefined;
};

export class QuickJSProvider implements JSEngineProvider {
  constructor(_options?: QuickJSProviderOptions) {
    throw new Error(
      '[QuickJSProvider] Requires native JSI bindings. Use NodeVMProvider (Node/Bun) or QuickJSNativeWASMProvider (Web) for non-native environments.'
    );
  }

  createRuntime(): never {
    throw new Error('[QuickJSProvider] Requires native JSI bindings.');
  }
}

/**
 * Check if QuickJS native module is available (always false in non-native)
 */
export function isQuickJSAvailable(): boolean {
  return false;
}
