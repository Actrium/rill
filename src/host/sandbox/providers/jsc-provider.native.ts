/**
 * JSCProvider - JavaScriptCore sandbox via native JSI bindings
 *
 * Uses NativeJSIProvider base for common createRuntime/wrapContext logic.
 * Only available on Apple platforms (iOS, macOS, tvOS, visionOS).
 */

import { getJSCModule, isJSCAvailable } from '../native/jsc-module';
import { NativeJSIProvider, type NativeJSIProviderOptions } from './native-jsi-provider';

export type JSCProviderOptions = NativeJSIProviderOptions;

/**
 * JSCProvider - Wraps native JSC JSI module for rill Engine
 */
export class JSCProvider extends NativeJSIProvider {
  constructor(options?: JSCProviderOptions) {
    super({ getModule: getJSCModule, engineName: 'JSC' }, options);
  }
}

/**
 * Check if JSC native module is available
 */
export { isJSCAvailable };
