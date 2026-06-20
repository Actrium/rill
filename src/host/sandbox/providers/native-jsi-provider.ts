/**
 * NativeJSIProvider - Base class for native JSI sandbox providers
 *
 * Extracts the common createRuntime() → wrapContext() pattern shared by
 * HermesProvider, JSCProvider, and QuickJSProvider on native platforms.
 *
 * Subclasses only need to supply:
 *   - getModule(): the native JSI module getter
 *   - engineName: used in error messages
 *
 * Override wrapContext() for engine-specific extensions (e.g. Hermes evalBytecode).
 */

import type { SandboxContext, SandboxModule } from '../native';
import type { JSEngineProvider, JSEngineRuntime, SandboxScope } from '../types/provider';

export interface NativeJSIProviderConfig {
  /** Function that returns the native JSI module, or null if unavailable */
  getModule: () => SandboxModule | null;
  /** Engine name for error messages (e.g. "Hermes", "JSC", "QuickJS") */
  engineName: string;
}

export interface NativeJSIProviderOptions {
  timeout?: number | undefined;
}

/**
 * Base class for all native JSI sandbox providers.
 *
 * The createRuntime() method:
 * 1. Gets the native module (throws if unavailable)
 * 2. Creates a native runtime with timeout option
 * 3. Returns a JSEngineRuntime whose createContext() calls wrapContext()
 *
 * Subclasses can override wrapContext() to add engine-specific capabilities.
 */
export class NativeJSIProvider implements JSEngineProvider {
  protected readonly config: NativeJSIProviderConfig;
  protected readonly options: NativeJSIProviderOptions;

  constructor(config: NativeJSIProviderConfig, options?: NativeJSIProviderOptions) {
    this.config = config;
    this.options = options || {};
  }

  createRuntime(): JSEngineRuntime {
    const mod = this.config.getModule();
    if (!mod) {
      throw new Error(
        `[${this.config.engineName}Provider] ${this.config.engineName} native module not available`
      );
    }

    const runtimeOptions =
      this.options.timeout !== undefined ? { timeout: this.options.timeout } : undefined;
    const rt = mod.createRuntime(runtimeOptions);

    return {
      createContext: (): SandboxScope => this.wrapContext(rt.createContext()),
      dispose: (): void => rt.dispose(),
    };
  }

  /**
   * Wraps a native SandboxContext into a SandboxScope.
   * Override in subclasses to add engine-specific methods (e.g. evalBytecode).
   */
  protected wrapContext(ctx: SandboxContext): SandboxScope {
    return {
      eval: (code: string): unknown => ctx.eval(code),
      inject: (name: string, value: unknown): void => ctx.inject(name, value),
      extract: (name: string): unknown => ctx.extract(name),
      dispose: (): void => ctx.dispose(),
    };
  }
}
