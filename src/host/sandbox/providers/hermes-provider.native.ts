/**
 * HermesProvider - Hermes sandbox via native JSI bindings
 *
 * Extends NativeJSIProvider to add evalBytecode() support.
 * Available when RILL_SANDBOX_ENGINE=hermes is set during native build.
 */

import type { SandboxContext } from '../native';
import {
  getHermesModule,
  type HermesContextNative,
  isHermesAvailable,
} from '../native/hermes-module';
import type { SandboxScope } from '../types/provider';
import { NativeJSIProvider, type NativeJSIProviderOptions } from './native-jsi-provider';

export type HermesProviderOptions = NativeJSIProviderOptions;

/**
 * HermesProvider - Wraps native Hermes JSI module for rill Engine
 *
 * Adds evalBytecode() to SandboxScope for precompiled Hermes bytecode support.
 */
export class HermesProvider extends NativeJSIProvider {
  constructor(options?: HermesProviderOptions) {
    super({ getModule: getHermesModule, engineName: 'Hermes' }, options);
  }

  protected override wrapContext(ctx: SandboxContext): SandboxScope {
    const scope = super.wrapContext(ctx);
    // Hermes contexts support evalBytecode for precompiled .hbc files
    const hermesCtx = ctx as HermesContextNative;
    scope.evalBytecode = (bytecode: ArrayBuffer) => hermesCtx.evalBytecode(bytecode);
    return scope;
  }
}

/**
 * Check if Hermes native module is available
 */
export { isHermesAvailable };
