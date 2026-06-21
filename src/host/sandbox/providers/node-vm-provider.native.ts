/**
 * NodeVMProvider stub for non-Node.js environments
 * NodeVMProvider requires Node.js vm module
 */

import type { JSEngineProvider } from '../types/provider';

export class NodeVMProvider implements JSEngineProvider {
  constructor(_options?: { timeout?: number }) {
    throw new Error(
      '[NodeVMProvider] Requires Node.js vm module. Use JSCProvider/QuickJSProvider/HermesProvider in React Native.'
    );
  }

  createRuntime(): never {
    throw new Error('[NodeVMProvider] Requires Node.js vm module.');
  }
}
