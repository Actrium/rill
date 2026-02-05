/**
 * src/host/sandbox - JSEngineProvider Interface (internal)
 *
 * This file defines the core interfaces for abstracting different JavaScript sandbox
 * implementations (JSC, QuickJS, VM).
 *
 * - JSEngineProvider: The top-level factory for creating a runtime.
 * - JSEngineRuntime: A runtime instance that can create one or more isolated contexts.
 * - SandboxScope: A single, isolated JS execution environment.
 */

/**
 * Available sandbox types for DefaultProvider.
 *
 * Platform availability and communication:
 * - VM: Node.js / Bun only (native vm module)
 * - JSC: Apple platforms only via JSI (zero binary overhead)
 * - Hermes: Via JSI when RILL_SANDBOX_ENGINE=hermes (isolated Hermes runtime)
 * - QuickJS: Cross-platform native via JSI (iOS, Android, macOS, Windows)
 * - WasmQuickJS: Web via JS↔WASM, React Native via JSI↔WASM
 */
export enum SandboxType {
  /** Node.js vm module (Node/Bun only) */
  VM = 'vm',
  /** JavaScriptCore via JSI (Apple platforms only, zero binary overhead) */
  JSC = 'jsc',
  /** Hermes via JSI (when RILL_SANDBOX_ENGINE=hermes) */
  Hermes = 'hermes',
  /** QuickJS via JSI (cross-platform native) */
  QuickJS = 'quickjs',
  /** QuickJS via WASM (Web: JS↔WASM, React Native: JSI↔WASM) */
  WasmQuickJS = 'wasm-quickjs',
}

/**
 * SandboxScope - Represents an isolated JS execution context.
 * This is the actual sandbox environment where code is executed.
 */
export interface SandboxScope {
  /**
   * Synchronously evaluates a string of JavaScript code.
   * Note: This method blocks the current thread until execution is complete.
   * It may not be available in all environments (e.g., Web Workers).
   * @param code The JavaScript code string to execute.
   * @returns The result of the last executed expression in the code.
   */
  eval: (code: string) => unknown;

  /**
   * Asynchronously evaluates a string of JavaScript code.
   * This is the preferred method as it does not block the main thread.
   * @param code The JavaScript code string to execute.
   * @returns A Promise that resolves with the result of the last expression.
   */
  evalAsync?: (code: string) => Promise<unknown>;

  /**
   * Synchronously evaluates precompiled Hermes bytecode.
   * Only available when using Hermes sandbox engine.
   *
   * Benefits:
   * - Skips parsing and compilation phases
   * - Faster startup for static guest code
   * - Suitable for pre-known guest bundles
   *
   * Usage:
   * ```bash
   * # Compile JS to Hermes bytecode
   * hermesc -emit-binary -O -out guest.hbc guest.js
   * ```
   *
   * @param bytecode The precompiled Hermes bytecode (.hbc format).
   * @returns The result of the last executed expression.
   * @throws Error if bytecode format is invalid or sandbox is not Hermes.
   */
  evalBytecode?: (bytecode: ArrayBuffer) => unknown;

  /**
   * Sets a global variable in the sandbox's global scope synchronously.
   *
   * CRITICAL: This MUST be synchronous. Bridge architecture requires immediate execution.
   * Do NOT make this async - it will break Bridge's synchronous flow.
   *
   * @param name The name of the global variable.
   * @param value The value to set.
   */
  inject: (name: string, value: unknown) => void;

  /**
   * Gets a global variable from the sandbox's global scope.
   * Note: This may only retrieve serializable values in some providers due to threading limitations.
   * @param name The name of the global variable.
   * @returns The value of the variable.
   */
  extract: (name: string) => unknown;

  /**
   * Disposes of this context, releasing all associated resources.
   */
  dispose: () => void;

  /**
   * Binary transfer capabilities (optional).
   * When available, enables zero-copy transfer of binary data.
   * Use for large ArrayBuffer/TypedArray transfers to avoid JSON overhead.
   */
  binary?: BinaryTransferCapabilities;
}

/**
 * Binary transfer capabilities for zero-copy data transfer.
 * Optional extension for providers that support efficient binary transfer (e.g., WASM).
 *
 * Performance characteristics:
 * - JSON serialization: ~10-20ms overhead for 100KB
 * - Zero-copy transfer: ~0.5ms for 100KB
 *
 * Use for:
 * - Large ArrayBuffer transfers (images, audio, binary data)
 * - High-frequency binary data updates
 * - Performance-critical binary operations
 */
export interface BinaryTransferCapabilities {
  /**
   * Set a global ArrayBuffer variable using zero-copy transfer.
   * @param name The name of the global variable
   * @param buffer The ArrayBuffer to set
   */
  setArrayBuffer: (name: string, buffer: ArrayBuffer) => void;

  /**
   * Get a global ArrayBuffer variable using zero-copy transfer.
   * @param name The name of the global variable
   * @returns The ArrayBuffer, or null if not found or not an ArrayBuffer
   */
  getArrayBuffer: (name: string) => ArrayBuffer | null;

  /**
   * Get the size of a global ArrayBuffer without copying data.
   * @param name The name of the global variable
   * @returns Size in bytes, or 0 if not found or not an ArrayBuffer
   */
  getArrayBufferSize: (name: string) => number;
}

/**
 * JSEngineRuntime - An instance of a JS runtime.
 * It can create and manage one or more isolated SandboxScopes.
 */
export interface JSEngineRuntime {
  /**
   * Creates a new, isolated JS execution context.
   * @returns A SandboxScope instance.
   */
  createContext: () => SandboxScope;

  /**
   * Disposes of this runtime and all contexts it has created.
   */
  dispose: () => void;
}

/**
 * Options for creating a JSEngineRuntime.
 */
export interface JSEngineRuntimeOptions {
  /**
   * The execution timeout for scripts in milliseconds.
   * Note: Not all providers support hard interruption.
   */
  timeout?: number;

  /**
   * The memory limit in bytes.
   * Note: This is a hint and enforcement depends on the underlying engine.
   */
  memoryLimit?: number;

  /**
   * Other engine-specific options.
   */
  [key: string]: unknown;
}

/**
 * JSEngineProvider - The top-level abstraction for a JS engine.
 * Responsible for creating runtime instances based on configuration.
 */
export interface JSEngineProvider {
  /**
   * Creates a JS runtime instance.
   * This method can be asynchronous, e.g., if it needs to load a WASM file.
   * @param options Configuration options for the runtime.
   * @returns A JSEngineRuntime instance or a Promise resolving to one.
   */
  createRuntime: (options?: JSEngineRuntimeOptions) => Promise<JSEngineRuntime> | JSEngineRuntime;
}
