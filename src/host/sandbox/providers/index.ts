/**
 * Rill Sandbox Providers
 *
 * All providers support high-performance direct object passing:
 * - Can pass functions, circular references, complex objects
 * - No JSON serialization overhead
 * - True isolation with strong capabilities
 */

export type { HermesProviderOptions } from './hermes-provider';
// Hermes Native (React Native - when RILL_SANDBOX_ENGINE=hermes)
export { HermesProvider, isHermesAvailable } from './hermes-provider';
export type { JSCProviderOptions } from './jsc-provider';
// JSC Native (React Native - Apple platforms only)
export { isJSCAvailable, JSCProvider } from './jsc-provider';
// Base class for native JSI providers
export {
  NativeJSIProvider,
  type NativeJSIProviderConfig,
  type NativeJSIProviderOptions,
} from './native-jsi-provider';
export type { QuickJSNativeWASMProviderOptions } from './quickjs-native-wasm-provider';
// QuickJS Native WASM (Web - compiled from native/quickjs)
export { QuickJSNativeWASMProvider } from './quickjs-native-wasm-provider';
export type { QuickJSProviderOptions } from './quickjs-provider';
// QuickJS Native (React Native - cross-platform)
export { isQuickJSAvailable, QuickJSProvider } from './quickjs-provider';
// Node.js VM (Node/Bun only)
export { VMProvider } from './vm-provider';
