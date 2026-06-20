/**
 * DefaultProvider for native environments (with JSI bindings)
 *
 * Implements JSEngineProvider directly, resolving the underlying provider at construction time.
 *
 * Auto-selects the best sandbox provider based on platform:
 * - Hermes sandbox: HermesProvider (when RILL_SANDBOX_ENGINE=hermes)
 * - Apple platforms: JSCProvider (uses system JSC, zero binary overhead)
 * - Other platforms: QuickJSProvider (cross-platform)
 * - No fallback - throws error if no provider available
 */

import { TurboModuleRegistry } from 'react-native';

import { isHermesAvailable } from '../native/hermes-module';
import { isJSCAvailable } from '../native/jsc-module';
import { isQuickJSAvailable } from '../native/quickjs-module';
import { HermesProvider } from '../providers/hermes-provider';
import { JSCProvider } from '../providers/jsc-provider';
import { QuickJSProvider } from '../providers/quickjs-provider';
import type { JSEngineProvider, JSEngineRuntime, JSEngineRuntimeOptions } from '../types/provider';
import { SandboxType } from '../types/provider';

export type DefaultProviderOptions = {
  timeout?: number;
  /**
   * Force a specific sandbox type. If not specified, auto-detects the best provider.
   * Available types for React Native: SandboxType.Hermes, SandboxType.JSC, SandboxType.QuickJS
   */
  sandbox?: SandboxType.Hermes | SandboxType.JSC | SandboxType.QuickJS;
};

/**
 * DefaultProvider - Auto-selects the best JS engine provider for native platforms
 *
 * Implements JSEngineProvider. Constructor resolves the underlying provider;
 * createRuntime() delegates to it.
 *
 * Selection priority (when sandbox option not specified):
 * 1. HermesProvider (when RILL_SANDBOX_ENGINE=hermes at build time)
 * 2. Apple platforms: JSCProvider (uses system JSC, zero overhead)
 * 3. All platforms: QuickJSProvider (if available)
 * 4. Error: No fallback (throws if no provider available)
 */
export class DefaultProvider implements JSEngineProvider {
  private readonly inner: JSEngineProvider;

  constructor(options?: DefaultProviderOptions) {
    this.inner = DefaultProvider.resolve(options);
  }

  createRuntime(options?: JSEngineRuntimeOptions): Promise<JSEngineRuntime> | JSEngineRuntime {
    return this.inner.createRuntime(options);
  }

  /** The resolved underlying provider instance */
  get resolvedProvider(): JSEngineProvider {
    return this.inner;
  }

  private static resolve(options?: DefaultProviderOptions): JSEngineProvider {
    // Force-load the RillSandboxNative TurboModule to trigger installJSIBindingsWithRuntime.
    // This installs __JSCSandboxJSI / __HermesSandboxJSI / __QuickJSSandboxJSI globals.
    // NOTE: The TurboModuleRegistry import and this call MUST be used inside a function body.
    // A bare top-level `TurboModuleRegistry.get(...)` is eliminated by Metro/Hermes as dead
    // code when the return value is unused, causing the native module to never load.
    TurboModuleRegistry.get('RillSandboxNative');

    // Cache availability checks to avoid repeated native calls and add diagnostics
    const hermesAvailable = isHermesAvailable();
    const jscAvailable = isJSCAvailable();
    const quickjsAvailable = isQuickJSAvailable();
    // One-time availability log to help debug sandbox loading issues
    if (typeof console?.log === 'function') {
      console.log('[rill][DefaultProvider] availability', {
        hermesAvailable,
        jscAvailable,
        quickjsAvailable,
        hermesGlobal: typeof globalThis.__HermesSandboxJSI,
        jscGlobal: typeof globalThis.__JSCSandboxJSI,
        quickjsGlobal: typeof globalThis.__QuickJSSandboxJSI,
      });
    }

    // Build provider options only with defined values
    const providerOptions =
      options?.timeout !== undefined ? { timeout: options.timeout } : undefined;

    // Explicit Hermes provider selection
    if (options?.sandbox === SandboxType.Hermes) {
      if (hermesAvailable) {
        return new HermesProvider(providerOptions);
      }
      throw new Error(
        '[DefaultProvider] HermesProvider requested but Hermes sandbox not available (RILL_SANDBOX_ENGINE!=hermes or native module not linked).'
      );
    }

    // Explicit JSC provider selection (Apple platforms only)
    if (options?.sandbox === SandboxType.JSC) {
      if (jscAvailable) {
        return new JSCProvider(providerOptions);
      }
      throw new Error(
        '[DefaultProvider] JSCProvider requested but JSC sandbox not available (not on Apple platform or native module not linked).'
      );
    }

    // Explicit QuickJS provider selection
    if (options?.sandbox === SandboxType.QuickJS) {
      if (quickjsAvailable) {
        return new QuickJSProvider(providerOptions);
      }
      throw new Error(
        '[DefaultProvider] QuickJSProvider requested but QuickJS native module not available.'
      );
    }

    // Auto-detect best provider

    // Hermes sandbox (when built with RILL_SANDBOX_ENGINE=hermes)
    if (hermesAvailable) {
      return new HermesProvider(providerOptions);
    }

    // On Apple platforms, prefer JSCProvider (zero binary overhead)
    if (jscAvailable) {
      return new JSCProvider(providerOptions);
    }

    // Try QuickJSProvider (works on all platforms including Android)
    if (quickjsAvailable) {
      return new QuickJSProvider(providerOptions);
    }

    // No suitable provider available
    const diag = {
      hermesAvailable,
      jscAvailable,
      quickjsAvailable,
      hermesGlobal: typeof globalThis.__HermesSandboxJSI,
      jscGlobal: typeof globalThis.__JSCSandboxJSI,
      quickjsGlobal: typeof globalThis.__QuickJSSandboxJSI,
    };
    throw new Error(
      `[DefaultProvider] No sandbox engine available. ` +
        `Ensure 'RillSandboxNative' pod is linked (run \`pod install\`). ` +
        `diag=${JSON.stringify(diag)}`
    );
  }
}
