/**
 * src/host/sandbox - JavaScript Sandbox Providers (internal)
 *
 * Provides multiple sandbox implementations for different environments:
 * - NodeVMProvider: Node.js vm module (Node/Bun)
 * - QuickJSNativeWASMProvider: QuickJS compiled to WebAssembly (Browser)
 * - QuickJSProvider: QuickJS via native JSI bindings (React Native)
 * - JSCProvider: JavaScriptCore via native JSI bindings (Apple platforms)
 * - DefaultProvider: Auto-selects the best provider for the current environment
 */

export type { DefaultProviderOptions } from './default/default-provider';
// Default provider
export { DefaultProvider } from './default/default-provider';
export type { JSCProviderOptions } from './providers/jsc-provider';
export { isJSCAvailable, JSCProvider } from './providers/jsc-provider';
// Provider exports
export { NodeVMProvider } from './providers/node-vm-provider';
export type { QuickJSNativeWASMProviderOptions } from './providers/quickjs-native-wasm-provider';
export { QuickJSNativeWASMProvider } from './providers/quickjs-native-wasm-provider';
export type { QuickJSProviderOptions } from './providers/quickjs-provider';
export { isQuickJSAvailable, QuickJSProvider } from './providers/quickjs-provider';
export type {
  JSEngineProvider,
  JSEngineRuntime,
  JSEngineRuntimeOptions,
  SandboxScope,
} from './types/provider';
// Type and enum exports
export { SandboxType } from './types/provider';
