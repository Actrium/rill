/**
 * DefaultProvider - Auto-selects the best JS engine provider based on environment
 *
 * Implements JSEngineProvider directly, resolving the underlying provider at construction time.
 *
 * Strategy:
 * - Node/Bun: NodeVMProvider (zero overhead, full capabilities)
 * - Web: QuickJSNativeWASMProvider (strong isolation + full capabilities)
 *
 * All providers support high-performance direct object passing (no JSON serialization).
 */

import { NodeVMProvider } from '../providers/node-vm-provider';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';
import type { JSEngineProvider, JSEngineRuntime, JSEngineRuntimeOptions } from '../types/provider';
import { SandboxType } from '../types/provider';

function isNodeEnv(): boolean {
  return (
    typeof process !== 'undefined' && process.versions != null && process.versions.node != null
  );
}

// Lazily resolve vm module
import type * as vm from 'node:vm';

type NodeVM = typeof vm;

function getVm(): NodeVM | null {
  if (typeof require === 'undefined') {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:vm');
  } catch {
    return null;
  }
}

function isWASMCapable(): boolean {
  return typeof WebAssembly !== 'undefined';
}

let warnedNodeVmAutoDefault = false;

/**
 * Warn once when auto-detection silently falls back to node-vm.
 *
 * Only fires on the auto-detect path — an explicit `sandbox: 'node-vm'` is a
 * deliberate choice and stays quiet. node-vm is not a security boundary, so this
 * nudges callers who never picked an isolation level (e.g. untrusted guests).
 */
function warnNodeVmAutoDefault(): void {
  if (warnedNodeVmAutoDefault) return;
  warnedNodeVmAutoDefault = true;
  console.warn(
    "[rill] No sandbox specified; defaulting to 'node-vm' (Node's vm module), which is NOT a " +
      'security boundary. This is fine for tests, SSR, and trusted guests. For untrusted code, ' +
      "set sandbox to 'wasm-quickjs' | 'quickjs' | 'jsc' | 'tenant-manager'. Pass " +
      "sandbox: 'node-vm' explicitly to silence this warning."
  );
}

export type DefaultProviderOptions = {
  timeout?: number;
  /**
   * Force a specific sandbox type. If not specified, auto-detects the best provider.
   * - NodeVM: Node.js/Bun only (native vm module)
   * - JSC: Apple platforms only (requires native JSI bindings)
   * - QuickJS: Cross-platform native (requires native JSI bindings)
   * - WasmQuickJS: Web/cross-platform (WASM, no native bindings required)
   */
  sandbox?: SandboxType;
  /**
   * Path to QuickJS WASM files (for Web environments)
   * @default '/quickjs-sandbox.wasm'
   */
  wasmPath?: string;
  /**
   * Provide the QuickJS `.wasm` bytes directly (Web). When set, the loader
   * instantiates from memory and never fetches — required under a strict CSP
   * like `connect-src 'none'`.
   */
  wasmBinary?: Uint8Array | ArrayBuffer;
};

/**
 * DefaultProvider - Auto-selects the best JS engine provider based on environment
 *
 * Implements JSEngineProvider. Constructor resolves the underlying provider;
 * createRuntime() delegates to it.
 *
 * Selection priority (when sandbox option not specified):
 * 1. Node/Bun: NodeVMProvider (native, zero overhead)
 * 2. Web: QuickJSNativeWASMProvider (WASM, strong isolation)
 * 3. Error: No provider available
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
    const envInfo = {
      isNode: isNodeEnv(),
      hasVm: !!getVm(),
      isWASMCapable: isWASMCapable(),
    };

    // Build provider options
    const providerOptions =
      options?.timeout !== undefined ? { timeout: options.timeout } : undefined;

    // Explicit provider selection
    if (options?.sandbox === SandboxType.NodeVM) {
      if (isNodeEnv() && getVm()) {
        return new NodeVMProvider(providerOptions);
      }
      throw new Error(
        '[DefaultProvider] NodeVMProvider requested but not available in this environment.'
      );
    }

    if (options?.sandbox === SandboxType.JSC) {
      throw new Error(
        '[DefaultProvider] JSC sandbox requires native JSI bindings (Apple platforms only). ' +
          'Use in React Native with JavaScriptCore runtime.'
      );
    }

    if (options?.sandbox === SandboxType.QuickJS) {
      throw new Error(
        '[DefaultProvider] Native QuickJS sandbox requires native JSI bindings. ' +
          'Use in React Native with react-native-quickjs native module.'
      );
    }

    if (options?.sandbox === SandboxType.WasmQuickJS) {
      if (isWASMCapable()) {
        return new QuickJSNativeWASMProvider({
          timeout: options?.timeout,
          wasmPath: options?.wasmPath,
          wasmBinary: options?.wasmBinary,
        });
      }
      throw new Error('[DefaultProvider] WasmQuickJS requested but WebAssembly is not available.');
    }

    // Auto-detect best provider

    // 1. Node/Bun environment - use NodeVMProvider (native, fast, supports timeout)
    if (isNodeEnv() && getVm()) {
      warnNodeVmAutoDefault();
      return new NodeVMProvider(providerOptions);
    }

    // 2. Web environment with WASM support - use QuickJS Native WASM
    if (isWASMCapable()) {
      return new QuickJSNativeWASMProvider({
        timeout: options?.timeout,
        wasmPath: options?.wasmPath,
        wasmBinary: options?.wasmBinary,
      });
    }

    // No suitable provider available
    throw new Error(
      `[DefaultProvider] No suitable JS sandbox provider found. ` +
        `Environment: ${JSON.stringify(envInfo)}. ` +
        `Ensure WebAssembly is supported (for browsers) or run in Node.js/Bun.`
    );
  }
}
