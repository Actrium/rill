/**
 * QuickJSProvider - QuickJS sandbox via native JSI bindings
 *
 * Uses NativeJSIProvider base for common createRuntime/wrapContext logic.
 * Available on iOS, Android, macOS, Windows.
 */

import { getQuickJSModule, isQuickJSAvailable } from '../native/quickjs-module';
import { NativeJSIProvider, type NativeJSIProviderOptions } from './native-jsi-provider';

export type QuickJSProviderOptions = NativeJSIProviderOptions;

/**
 * QuickJSProvider - Wraps native QuickJS JSI module for rill Engine
 */
export class QuickJSProvider extends NativeJSIProvider {
  constructor(options?: QuickJSProviderOptions) {
    super({ getModule: getQuickJSModule, engineName: 'QuickJS' }, options);
  }
}

/**
 * Check if QuickJS native module is available
 */
export { isQuickJSAvailable };
