/**
 * VMProvider stub for non-Node.js environments
 * VMProvider requires Node.js vm module
 */

import type { JSEngineProvider } from '../types/provider';

export class VMProvider implements JSEngineProvider {
  constructor(_options?: { timeout?: number }) {
    throw new Error(
      '[VMProvider] Requires Node.js vm module. Use JSCProvider/QuickJSProvider/HermesProvider in React Native.'
    );
  }

  createRuntime(): never {
    throw new Error('[VMProvider] Requires Node.js vm module.');
  }
}
