/**
 * src/host/sandbox - JavaScript Sandbox Providers (Native, internal)
 *
 * Provides sandbox implementations for native environments:
 * - QuickJSProvider: QuickJS via native JSI bindings (cross-platform)
 * - JSCProvider: JavaScriptCore via native JSI bindings (Apple platforms)
 * - DefaultProvider: Auto-selects the best provider for the current platform
 */

export type { DefaultProviderOptions } from './default/default-provider';
// Default provider (uses .native.ts variant automatically)
export { DefaultProvider } from './default/default-provider';
export type { JSCProviderOptions } from './providers/jsc-provider';
export { isJSCAvailable, JSCProvider } from './providers/jsc-provider';
export type { QuickJSProviderOptions } from './providers/quickjs-provider';
// Provider exports (native only)
export { isQuickJSAvailable, QuickJSProvider } from './providers/quickjs-provider';
export type {
  JSEngineProvider,
  JSEngineRuntime,
  JSEngineRuntimeOptions,
  SandboxScope,
} from './types/provider';
// Type and enum exports
export { SandboxType } from './types/provider';
