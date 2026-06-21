/**
 * @workaround - bust cache
 * Rill Engine
 *
 * Sandbox engine core, responsible for managing QuickJS execution environment and lifecycle.
 * Uses react-native-quickjs for sandboxed JavaScript execution.
 */

// Augment globalThis for DevTools integration and Guest runtime
declare global {
  // eslint-disable-next-line no-var
  // Reason: DevTools event payload can be any serializable type
  var __rill_emitEvent: ((eventName: string, payload?: unknown) => void) | undefined;
  // eslint-disable-next-line no-var
  var __rill: Record<string, unknown> | undefined;
  // eslint-disable-next-line no-var
  var __rill_handleMessage: ((message: import('../types').HostMessage) => void) | undefined;
}

import {
  createHostModuleDispatch,
  type HostModuleDispatchTable,
  type RillContractShape,
} from '../../contract';
import type { RuntimeCollector } from '../../devtools/index';
import { createRuntimeCollector } from '../../devtools/index';
import { GUEST_BUNDLE_CODE } from '../../guest/build/bundle';
import type {
  HostMessage as BridgeHostMessage,
  OperationBatch as BridgeOperationBatch,
  BridgeValue,
  BridgeValueObject,
  SendToHost,
} from '../../shared';
import { CallbackRegistryImpl as CallbackRegistry, HostMsg } from '../../shared';
import { Bridge } from '../../shared/bridge/bridge';
import { Receiver } from '../receiver';
import type { ComponentMap } from '../registry';
import { ComponentRegistry } from '../registry';
import type { JSEngineProvider, JSEngineRuntime, SandboxScope } from '../sandbox';
import type { RillReconcilerGlobal } from '../sandbox/globals';
import { TenantManagerProvider } from '../tenant-manager/tenant-manager-provider';
import type { HostMessage, OperationBatch, ReviewedUnknown } from '../types';
import { DiagnosticsCollector } from './diagnostics-collector';
import { createCommonJSGlobals, createReactNativeShim, formatConsoleArgs } from './sandbox-helpers';
import { DEVTOOLS_SHIM } from './shims';
import { TimerManager } from './timer-manager';
// Import from engine/types.ts (single source of truth)
import type {
  EngineDiagnostics,
  EngineEvents,
  EngineOptions,
  EventListener,
  IEngine,
  LoadBundleOptions,
} from './types';
import { ExecutionError, RequireError, TimeoutError } from './types';

// Re-export types for external API
// Re-export IEngine types for convenience
export type {
  EngineActivityStats,
  EngineActivityTimeline,
  EngineActivityTimelinePoint,
  EngineDiagnostics,
  EngineEvents,
  EngineHealth,
  EngineOptions,
  GuestMessage,
  IEngine,
  LoadBundleOptions,
} from './types';
export { ExecutionError, RequireError, TimeoutError } from './types';

/**
 * Rill Engine - JS sandbox engine with dedicated runtime
 *
 * Each Engine instance owns an isolated JS runtime.
 * Create a new Engine for each isolated context (e.g., each tab/view).
 *
 * @example
 * ```typescript
 * const engine = new Engine({ debug: true });
 * engine.register({ StepList: NativeStepList });
 * await engine.loadBundle(bundleCode);
 * // When done:
 * engine.destroy();
 * ```
 */
// Global engine counter for debugging
let engineIdCounter = 0;

export class Engine implements IEngine {
  private runtime: JSEngineRuntime | null = null;
  private context: SandboxScope | null = null;
  private registry: ComponentRegistry;
  /**
   * Callback Registry - owned by this Engine instance
   *
   * Single ownership principle: Each Engine owns its CallbackRegistry.
   * This ensures complete isolation between multiple Engine instances.
   */
  private callbackRegistry: CallbackRegistry;
  private receiver: Receiver | null = null;
  private bridge: Bridge | null = null;
  private config: Record<string, unknown> = {};
  private options: {
    timeout: number;
    debug: boolean;
    logger: NonNullable<EngineOptions['logger']>;
    requireWhitelist: ReadonlySet<string>;
    onMetric?: (name: string, value: number, extra?: Record<string, unknown>) => void;
    receiverMaxBatchSize: number;
  };
  private provider: JSEngineProvider | null = null;
  private destroyed = false;
  private loaded = false;
  private _timeoutTimer?: ReturnType<typeof setTimeout>;

  /**
   * Dispatch-wrapped `host:*` modules exposed to the Guest, or null when no host
   * modules were configured. Built once from the contract + implementations and
   * injected into the sandbox during injectRuntimeAPI().
   */
  private _hostModuleDispatch: HostModuleDispatchTable | null = null;

  /**
   * Capability contract backing {@link Engine._hostModuleDispatch}. Retained so
   * isolated-realm providers (WASM) can read each capability's kind when bridging.
   */
  private _hostModuleContract: RillContractShape | null = null;

  // Pause state
  private _isPaused = false;
  private _eventQueue: Array<{ eventName: string; payload?: ReviewedUnknown }> = [];

  // Unique engine ID (UUID-like format)
  public readonly id: string;

  // Event listeners
  // Reason: Event listeners accept arbitrary event payload types
  private listeners: Map<keyof EngineEvents, Set<EventListener<unknown>>> = new Map();

  // Memory leak detection for Engine events
  private maxListeners = 10;
  private warnedEvents = new Set<keyof EngineEvents>();

  // Synchronous drain function for setImmediate queue.
  // Populated by injectPolyfills(); called after eval() to flush React scheduler work.
  private _drainPendingImmediates: (() => void) | null = null;

  // DevTools collector (optional)
  private _devtools: RuntimeCollector | null = null;

  // Refactored modules
  private timerManager!: TimerManager;
  private diagnostics!: DiagnosticsCollector;

  /**
   * Diagnostic accumulator: write timestamped messages to globalThis.__rill_drain_diag
   * so HOST-side code (AskcTabView) can read them after loadBundle returns.
   * nativeLoggingHook is NOT available in XPC ViewBridge context.
   */
  private diagAccum(msg: string): void {
    try {
      let diag = (globalThis as Record<string, unknown>).__rill_drain_diag as string[] | undefined;
      if (!diag) {
        diag = [];
        (globalThis as Record<string, unknown>).__rill_drain_diag = diag;
      }
      diag.push(`${Date.now()}:${msg}`);
    } catch {
      /* ignore */
    }
  }

  constructor(options: EngineOptions = {}) {
    const defaultWhitelist = new Set([
      'react',
      'react-native',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'rill/guest',
      'rill/reconciler',
    ]);
    // Provide a safe fallback logger if console is not available
    const defaultLogger =
      typeof console !== 'undefined'
        ? console
        : {
            log: () => {},
            warn: () => {},
            error: () => {},
            info: () => {},
            debug: () => {},
          };
    this.options = {
      timeout: options.timeout ?? 5000,
      debug: options.debug ?? false,
      logger: options.logger ?? defaultLogger,
      requireWhitelist: new Set(options.requireWhitelist ?? Array.from(defaultWhitelist)),
      onMetric: options.onMetric,
      receiverMaxBatchSize: options.receiverMaxBatchSize ?? 5000,
    };

    // Generate unique engine ID early (needed by TenantManagerProvider default appId)
    const counter = ++engineIdCounter;
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    this.id = `engine-${counter}-${timestamp}-${random}`;

    this.registry = new ComponentRegistry();

    // Create CallbackRegistry - owned by this Engine instance
    // CallbackRegistry is Bridge layer infrastructure, not reconciler specific
    this.callbackRegistry = new CallbackRegistry();

    // Initialize JS engine provider
    // Priority: TenantManager (explicit or auto-detect) > DefaultProvider
    // Note: custom provider injection is intentionally not part of the public API.
    const useTenantManager =
      options.sandbox === 'tenant-manager' ||
      (!options.sandbox && TenantManagerProvider.isAvailable());

    if (useTenantManager && TenantManagerProvider.isAvailable()) {
      const tenantConfig = options.tenant ?? { appId: this.id };
      this.provider = new TenantManagerProvider({
        tenantConfig: {
          ...tenantConfig,
          debug: tenantConfig.debug ?? this.options.debug,
        },
        timeout: this.options.timeout,
      });
      if (this.options.debug) {
        this.options.logger.log(
          `[rill:${this.id}] Using TenantManagerProvider (appId: ${tenantConfig.appId})`
        );
      }
    } else {
      // Fallback to DefaultProvider (VM, JSC, Hermes, QuickJS, WASM)
      if (this.options.debug) {
        const hermesGlobalType =
          typeof (globalThis as Record<string, unknown>).__HermesSandboxJSI !== 'undefined'
            ? typeof (globalThis as Record<string, unknown>).__HermesSandboxJSI
            : 'undefined';
        const jscGlobalType =
          typeof (globalThis as Record<string, unknown>).__JSCSandboxJSI !== 'undefined'
            ? typeof (globalThis as Record<string, unknown>).__JSCSandboxJSI
            : 'undefined';
        const quickjsGlobalType =
          typeof (globalThis as Record<string, unknown>).__QuickJSSandboxJSI !== 'undefined'
            ? typeof (globalThis as Record<string, unknown>).__QuickJSSandboxJSI
            : 'undefined';
        this.options.logger.log('[rill] Sandbox globals', {
          __HermesSandboxJSI: hermesGlobalType,
          __JSCSandboxJSI: jscGlobalType,
          __QuickJSSandboxJSI: quickjsGlobalType,
        });
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DefaultProvider } = require('../sandbox/index');
        this.provider = new DefaultProvider({
          timeout: this.options.timeout,
          sandbox: options.sandbox,
        });
        if (this.options.debug) {
          const providerName = this.provider?.constructor?.name || 'unknown';
          this.options.logger.log(`[rill] Provider type: ${providerName}`);
          this.options.logger.log('[rill] Initialized DefaultProvider');
        }
      } catch (e) {
        this.options.logger.error('[rill] Failed to initialize DefaultProvider:', e);
        throw e;
      }
    }

    // Initialize refactored modules (after this.id is set)
    this.timerManager = new TimerManager({
      debug: this.options.debug,
      logger: this.options.logger,
      engineId: this.id,
      onError: (error: Error) => {
        // diagnostics is initialized right after TimerManager in constructor
        this.diagnostics?.recordError?.();
        this.emit('error', error);
      },
    });

    this.diagnostics = new DiagnosticsCollector({
      engineId: this.id,
      activityWindowMs: options.diagnostics?.activityWindowMs ?? 5000,
      activityHistoryMs: options.diagnostics?.activityHistoryMs ?? 60_000,
      activityBucketMs: options.diagnostics?.activityBucketMs ?? 2000,
    });

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Engine created`);
    }

    // Initialize DevTools if enabled
    if (options.devtools) {
      const devtoolsConfig = typeof options.devtools === 'object' ? options.devtools : {};
      this._devtools = createRuntimeCollector(devtoolsConfig);
      this._devtools.enable();
      if (this.options.debug) {
        this.options.logger.log(`[rill:${this.id}] DevTools enabled`);
      }
    }

    // Build the host-module dispatch table (fail-closed): pairs contract descriptors
    // with their implementations and wraps each capability with the boundary schemas.
    if (options.hostModules) {
      if (!options.contract) {
        throw new Error(
          '[rill] EngineOptions.hostModules requires EngineOptions.contract so boundary schemas can be enforced.'
        );
      }
      this._hostModuleContract = options.contract;
      this._hostModuleDispatch = createHostModuleDispatch(options.contract, options.hostModules, {
        onError: (error, ctx) => {
          this.options.logger.error(
            `[rill:${this.id}] Host module boundary rejected ${ctx.moduleId}.${ctx.exportName} (${ctx.phase}):`,
            error
          );
          this.diagnostics?.recordError?.();
        },
      });
      if (this.options.debug) {
        this.options.logger.log(
          `[rill:${this.id}] Host modules registered: ${Object.keys(this._hostModuleDispatch).join(', ')}`
        );
      }
    }

    // Emit metric for engine creation
    this.options.onMetric?.('engine.created', 1, { engineId: this.id });
  }

  /**
   * Register custom components
   */
  register(components: ComponentMap): void {
    this.registry.registerAll(components);
    if (this.options.debug) {
      this.options.logger.log('[rill] Registered components:', Object.keys(components).join(', '));
    }
  }

  /**
   * Load and execute Guest code.
   *
   * Always returns a Promise that resolves when the bundle has been loaded
   * and executed. For sync providers the work completes before the Promise
   * settles, so callers can simply `await engine.loadBundle(...)`.
   *
   * CRITICAL: For sync providers, the entire pipeline runs without ANY microtask
   * boundaries (no async, no await, no Promise). This avoids the HOST microtask
   * stall in XPC ViewBridge context where RN bridge's RCTTiming is frozen (~24s)
   * and microtask continuations never drain.
   */
  loadBundle(
    source: string,
    initialProps?: Record<string, unknown>,
    bundleOptions?: LoadBundleOptions
  ): Promise<void> {
    if (this.destroyed) {
      throw new Error('[rill] Engine has been destroyed');
    }

    if (this.loaded) {
      throw new Error('[rill] Engine already loaded a Guest');
    }

    this.config = initialProps ?? {};

    const bytecodeAssetPath = bundleOptions?.bytecodeAssetPath;

    const isRemoteSource = source.startsWith('http://') || source.startsWith('https://');

    if (isRemoteSource || this.isAsyncProvider()) {
      return this._loadBundleAsync(source, bytecodeAssetPath);
    }

    // ──── SYNC FAST PATH (JSC + inline code) ────
    // Zero await, zero Promise, zero microtask boundaries.
    // initializeRuntime(), executeBundleSync() all run synchronously.
    // JSC drains sandbox microtasks (React scheduler) after eval().
    try {
      const t0 = Date.now();
      const code = source;
      this.options.logger.log(`[rill:${this.id}] [DIAG] resolveSource: 0ms (sync inline)`);

      if (this.options.debug) {
        this.options.logger.log(`[rill:${this.id}] Bundle loaded, length:`, code.length);
        this.options.logger.log(`[rill:${this.id}] Bundle preview:`, code.substring(0, 200));
        this.options.logger.log(
          `[rill:${this.id}] Bundle footer (last 500 chars):`,
          code.substring(code.length - 500)
        );
        this.options.logger.log(`[rill:${this.id}] Has Auto-render:`, code.includes('Auto-render'));
      }

      // Initialize runtime synchronously (JSC provider returns void, not Promise)
      const initResult = this.initializeRuntime();
      if (initResult instanceof Promise) {
        // Should not happen for sync providers — defensive check
        return initResult.then(() => this._loadBundleSyncContinuation(code, t0, bytecodeAssetPath));
      }
      const t1 = Date.now();
      this.options.logger.log(`[rill:${this.id}] [DIAG] initializeRuntime: ${t1 - t0}ms`);

      this._devtools?.updateSandboxStatus({ state: 'running' });

      // Execute bundle synchronously
      const t2 = Date.now();
      this.executeBundleSync(code, bytecodeAssetPath);
      const t3 = Date.now();
      this.options.logger.log(`[rill:${this.id}] [DIAG] executeBundle: ${t3 - t2}ms`);

      this._finishBundleLoad();
      this.options.logger.log(`[rill:${this.id}] [DIAG] loadBundle: SYNC path complete`);
    } catch (error) {
      this._handleBundleError(error);
    }

    return Promise.resolve();
  }

  /**
   * Async path for loadBundle — used for remote URLs and async providers (Worker).
   */
  private async _loadBundleAsync(source: string, bytecodeAssetPath?: string): Promise<void> {
    try {
      const t0 = Date.now();
      const code = await this.resolveSource(source);
      const t1 = Date.now();
      this.options.logger.log(`[rill:${this.id}] [DIAG] resolveSource: ${t1 - t0}ms`);

      if (this.options.debug) {
        this.options.logger.log(`[rill:${this.id}] Bundle loaded, length:`, code.length);
        this.options.logger.log(`[rill:${this.id}] Bundle preview:`, code.substring(0, 200));
        this.options.logger.log(
          `[rill:${this.id}] Bundle footer (last 500 chars):`,
          code.substring(code.length - 500)
        );
        this.options.logger.log(`[rill:${this.id}] Has Auto-render:`, code.includes('Auto-render'));
      }

      await this.initializeRuntime();
      const t2 = Date.now();
      this.options.logger.log(`[rill:${this.id}] [DIAG] initializeRuntime: ${t2 - t1}ms`);

      this._devtools?.updateSandboxStatus({ state: 'running' });

      const timeout = this.options.timeout;
      const t3 = Date.now();

      if (this.isAsyncProvider()) {
        // Async providers (Worker): use await + timeout protection
        const hasTimeout = timeout > 0 && typeof globalThis.setTimeout === 'function';
        if (hasTimeout) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = globalThis.setTimeout(() => {
              this.options.logger.error(
                `[rill] Fatal: Bundle execution exceeded timeout ${timeout}ms, destroying engine`
              );
              const error = new TimeoutError(
                `[rill] Execution exceeded timeout ${timeout}ms (hard limit)`
              );
              this.emit('fatalError', error);
              this.forceDestroy();
              reject(error);
            }, timeout);
            this._timeoutTimer = timer;
          });

          try {
            await Promise.race([this.executeBundle(code, bytecodeAssetPath), timeoutPromise]);
          } finally {
            if (this._timeoutTimer) {
              globalThis.clearTimeout(this._timeoutTimer);
              this._timeoutTimer = undefined;
            }
          }
        } else {
          await this.executeBundle(code, bytecodeAssetPath);
        }
      } else {
        this.executeBundleSync(code, bytecodeAssetPath);
      }
      const t4 = Date.now();
      this.options.logger.log(`[rill:${this.id}] [DIAG] executeBundle: ${t4 - t3}ms`);

      this._finishBundleLoad();
      this.options.logger.log(`[rill:${this.id}] [DIAG] loadBundle: ASYNC path complete`);
    } catch (error) {
      this._handleBundleError(error);
    }
  }

  /**
   * Continuation for the rare case where a supposedly-sync provider returns a Promise
   * from initializeRuntime (defensive fallback).
   */
  private _loadBundleSyncContinuation(code: string, t0: number, bytecodeAssetPath?: string): void {
    try {
      const t1 = Date.now();
      this.options.logger.log(
        `[rill:${this.id}] [DIAG] initializeRuntime: ${t1 - t0}ms (fallback async)`
      );
      this._devtools?.updateSandboxStatus({ state: 'running' });

      const t2 = Date.now();
      this.executeBundleSync(code, bytecodeAssetPath);
      const t3 = Date.now();
      this.options.logger.log(`[rill:${this.id}] [DIAG] executeBundle: ${t3 - t2}ms`);

      this._finishBundleLoad();
    } catch (error) {
      this._handleBundleError(error);
    }
  }

  /** Common post-load bookkeeping */
  private _finishBundleLoad(): void {
    this.loaded = true;
    this.diagnostics.setLoaded(true);
    this.options.logger.log(`[rill:${this.id}] [DIAG] loadBundle: loaded=true set`);
    this._devtools?.updateSandboxStatus({ state: 'running' });
    this.emit('load');
    this.options.logger.log(`[rill:${this.id}] [DIAG] loadBundle: emit('load') done`);

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Bundle executed successfully`);
    }
  }

  /** Common error handling for loadBundle paths */
  private _handleBundleError(error: ReviewedUnknown): never {
    const err = error instanceof Error ? error : new Error(String(error));
    this.diagnostics.recordError();
    this._devtools?.recordSandboxError();
    this._devtools?.updateSandboxStatus({ state: 'error' });
    this.emit('error', err);
    throw err;
  }

  /**
   * Resolve bundle source (URL or code string)
   */
  private async resolveSource(source: string): Promise<string> {
    const start = Date.now();
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const s1 = Date.now();
      const response = await fetch(source);
      if (!response.ok) {
        this.options.onMetric?.('engine.fetchBundle', Date.now() - s1, { status: response.status });
        throw new Error(`Failed to fetch bundle: ${response.status}`);
      }
      const text = await response.text();
      this.options.onMetric?.('engine.fetchBundle', Date.now() - s1, {
        status: 200,
        size: text.length,
      });
      this.options.onMetric?.('engine.resolveSource', Date.now() - start);
      return text;
    }
    this.options.onMetric?.('engine.resolveSource', Date.now() - start);
    return source;
  }

  /**
   * Initialize runtime, context, bridge, polyfills, and runtime API.
   *
   * Returns void for sync providers (JSC) or Promise<void> for async providers (Worker).
   * For sync providers, the entire initialization runs without any microtask boundaries,
   * avoiding the HOST microtask stall in XPC ViewBridge context.
   */
  private initializeRuntime(): void | Promise<void> {
    const start = Date.now();
    const debug = this.options.debug;
    const logger = this.options.logger;

    if (!this.provider) {
      throw new Error('[rill] QuickJS provider not initialized');
    }

    // After runtime + context are created, set up Bridge, polyfills, and runtime API
    const finishInit = (): void | Promise<void> => {
      this._createBridge();

      if (debug) {
        logger.log(`[rill:${this.id}] initializeRuntime: Bridge created, injecting polyfills...`);
      }

      const polyfillResult = this.injectPolyfills();

      const afterPolyfills = (): void | Promise<void> => {
        if (debug) {
          logger.log(
            `[rill:${this.id}] initializeRuntime: polyfills done, injecting runtimeAPI...`
          );
        }

        const apiResult = this.injectRuntimeAPI();

        const afterAPI = () => {
          if (debug) logger.log(`[rill:${this.id}] initializeRuntime: done`);
          const dur = Date.now() - start;
          this.options.onMetric?.('engine.initializeRuntime', dur);
        };

        if (apiResult instanceof Promise) return apiResult.then(afterAPI);
        afterAPI();
      };

      if (polyfillResult instanceof Promise) return polyfillResult.then(afterPolyfills);
      return afterPolyfills();
    };

    if (debug) logger.log(`[rill:${this.id}] initializeRuntime: creating runtime...`);
    const runtimeResult = this.provider.createRuntime();

    if (runtimeResult instanceof Promise) {
      // ASYNC PATH (Worker providers): createRuntime returns a Promise
      return runtimeResult.then((runtime) => {
        this.runtime = runtime;
        if (debug) logger.log(`[rill:${this.id}] initializeRuntime: runtime created (async)`);
        this.context = this.runtime.createContext();
        return finishInit();
      });
    }

    // SYNC PATH (JSC): createRuntime returns value directly — no microtask boundaries
    this.runtime = runtimeResult;
    if (debug) logger.log(`[rill:${this.id}] initializeRuntime: runtime created (sync)`);
    this.context = this.runtime.createContext();
    return finishInit();
  }

  /**
   * Create Bridge for Host ↔ Sandbox communication.
   * Extracted from initializeRuntime for readability.
   */
  private _createBridge(): void {
    const debug = this.options.debug;
    const logger = this.options.logger;

    if (debug) {
      logger.log(`[rill:${this.id}] _createBridge: creating BridgeV2...`);
    }

    // Bridge encapsulates all serialization - uses this Engine's callback registry
    this.bridge = new Bridge({
      debug: this.options.debug,
      logger: this.options.logger,
      callbackRegistry: this.callbackRegistry,
      // Guest callback invoker - routes Guest callbacks to sandbox
      guestInvoker: (fnId, args) => {
        if (/^fn_\d+$/.test(fnId)) {
          const rillNs = this.context?.extract('__rill') as Record<string, unknown> | undefined;
          const invokeCallback = rillNs?.invokeCallback as
            | ((fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown)
            | undefined;
          if (invokeCallback) {
            return invokeCallback(fnId, args);
          }
        }
        const reconciler = this.context?.extract('RillReconciler') as
          | { invokeCallback?: (fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown }
          | undefined;
        if (reconciler?.invokeCallback) {
          return reconciler.invokeCallback(fnId, args);
        }
        logger.warn(`[rill:${this.id}] No invoker found for ${fnId}`);
        return undefined;
      },
      // Guest callback releaser
      guestReleaseCallback: (fnId) => {
        const reconciler = this.context?.extract('RillReconciler') as
          | { releaseCallback?: (fnId: string) => void }
          | undefined;
        if (reconciler?.releaseCallback) {
          reconciler.releaseCallback(fnId);
        }
      },
      onGuestOperations: (batch: BridgeOperationBatch) => {
        const t0 = Date.now();
        const batchOps = batch.operations?.length ?? '?';
        this.diagAccum(
          `[rill:${this.id}] onGuestOperations ops=${batchOps} hasReceiver=${!!this.receiver}`
        );
        logger.log(`[rill:${this.id}] [DIAG] onGuestOperations START ops=${batchOps}`);
        if (this.receiver) {
          const stats = this.receiver.applyBatch(batch as OperationBatch);
          this.diagnostics.recordBatch(stats);
          this.emit('operation', batch as OperationBatch);
        } else {
          logger.warn(`[rill:${this.id}] No receiver to apply batch!`);
        }
        logger.log(`[rill:${this.id}] [DIAG] onGuestOperations END took=${Date.now() - t0}ms`);
      },
      onHostMessage: async (message: BridgeHostMessage) => {
        if (this.context) {
          if (message.type === HostMsg.REF_METHOD_RESULT) {
            this.context.inject('__refResultMessage', message);
            await this.evalCode(
              "globalThis.__rill.dispatchEvent('__REF_RESULT__', __refResultMessage)"
            );
            this.context.inject('__refResultMessage', undefined);
            return;
          }

          this.context.inject('__hostMessage', message);
          await this.evalCode('globalThis.__rill_handleMessage(__hostMessage)');
          this.context.inject('__hostMessage', undefined);
        }
      },
    });
  }

  /**
   * Inject polyfills into sandbox
   */
  private injectPolyfills(): void | Promise<void> {
    if (!this.context) return;

    const logger = this.options.logger;
    const debug = this.options.debug;

    // Helper to log inject calls for debugging (synchronous)
    // Reason: inject can accept any serializable value
    const injectWithLog = (name: string, value: unknown): void => {
      if (debug) logger.log(`[rill:${this.id}] inject: ${name} starting...`);
      const start = Date.now();
      try {
        this.context!.inject(name, value);
        if (debug) logger.log(`[rill:${this.id}] inject: ${name} done (${Date.now() - start}ms)`);
      } catch (e) {
        logger.error(`[rill:${this.id}] inject: ${name} failed:`, e);
        throw e;
      }
    };

    // Save native queueMicrotask to avoid recursion issues (with fallback for test environments)
    const nativeQueueMicrotask =
      typeof globalThis.queueMicrotask === 'function'
        ? globalThis.queueMicrotask.bind(globalThis)
        : (fn: () => void) => Promise.resolve().then(fn);

    // Guest Bundle injection function
    // The bundle includes: init, console setup, runtime helpers, React shims, and Reconciler
    // Returns void for sync providers, Promise<void> for async providers.
    const postGuestBundleSetup = () => {
      // NOTE: Previously this did a extract→inject round-trip for RillGuest and
      // RillReconciler to ensure they're available as top-level identifiers in sandbox
      // contexts that don't map globalThis properties to lexical bindings.
      //
      // This round-trip is HARMFUL for native JSI providers (QuickJS, Hermes, JSC)
      // because it wraps every function in JSI proxies, causing each internal
      // reconciler call to bounce through the JSI boundary twice:
      //   QJS → JSI (cb_N) → QJS (__sandbox_fn_N__)
      // On Android this caused ANR from cumulative overhead (~100+ boundary crossings
      // during a single React commit phase).
      //
      // Native JS engines already have globalThis properties as global bindings,
      // so the round-trip is unnecessary. Removed entirely.

      if (debug) logger.log(`[rill:${this.id}] Guest bundle injected (shims + reconciler)`);
    };

    const injectGuestBundle = (): void | Promise<void> => {
      try {
        // Check if already injected (e.g., from previous load)
        // Use presence of core globals instead of __REACT_SHIM__ because that flag
        // may be false when using real React (not a shim).
        const alreadyInjected = this.context?.extract('RillGuest');
        if (alreadyInjected) {
          if (debug) logger.log(`[rill:${this.id}] Guest bundle already injected, skipping`);
          return;
        }

        // Single eval for entire Guest bundle
        // evalCode returns void for sync providers (JSC), Promise<void> for async
        const evalResult = this.evalCode(GUEST_BUNDLE_CODE);

        if (evalResult instanceof Promise) {
          return evalResult.then(postGuestBundleSetup);
        }
        postGuestBundleSetup();
      } catch (e) {
        logger.error(`[rill:${this.id}] Failed to inject Guest bundle:`, e);
        throw e;
      }
    };

    // Provide minimal CommonJS globals for bundles built as CJS
    const cjsGlobals = createCommonJSGlobals();
    injectWithLog('module', cjsGlobals.module);
    injectWithLog('exports', cjsGlobals.exports);

    const engineId = this.id;

    // console - Register each method separately for JSC sandbox compatibility
    // JSC sandbox can't handle objects with function properties via RN bridge
    injectWithLog('__console_log', (...args: unknown[]) => {
      // Always forward [DIAG] messages even when debug=false
      const msg = args.length > 0 ? String(args[0]) : '';
      if (debug || msg.includes('[DIAG]')) {
        logger.log(`[rill:${engineId}][Guest]`, ...formatConsoleArgs(args));
      }
    });
    injectWithLog('__console_warn', (...args: unknown[]) => {
      logger.warn(`[rill:${engineId}][Guest]`, ...formatConsoleArgs(args));
    });
    injectWithLog('__console_error', (...args: unknown[]) => {
      logger.error(`[rill:${engineId}][Guest]`, ...formatConsoleArgs(args));
    });
    injectWithLog('__console_debug', (...args: unknown[]) => {
      if (debug) logger.log(`[rill:${engineId}][Guest:debug]`, ...formatConsoleArgs(args));
    });
    injectWithLog('__console_info', (...args: unknown[]) => {
      if (debug) logger.log(`[rill:${engineId}][Guest:info]`, ...formatConsoleArgs(args));
    });

    // Inject timer polyfills using TimerManager
    // IMPORTANT: Must be injected BEFORE Guest Bundle so that reconciler can use globalThis.setTimeout
    //
    // These are injected unconditionally for ALL providers — the engine's TimerManager is
    // the single timer/clock owner, which is what makes pause()/resume() clock-freeze and
    // the setImmediate synchronous drain work uniformly. On the WASM provider these callbacks
    // are functions, which can't cross the JSON bridge by reference; the provider's inject()
    // shim now registers them by id so they survive (issue #10). We deliberately do NOT skip
    // injection in favor of a provider's native timers — that would create a second,
    // unfreezable clock and break pause/resume on that provider.
    injectWithLog('setTimeout', this.timerManager.createSetTimeoutPolyfill());
    injectWithLog('clearTimeout', this.timerManager.createClearTimeoutPolyfill());
    injectWithLog('setInterval', this.timerManager.createSetIntervalPolyfill());
    injectWithLog('clearInterval', this.timerManager.createClearIntervalPolyfill());

    // setImmediate / clearImmediate polyfills
    // CRITICAL: React concurrent scheduler checks for setImmediate first.
    // Without it, scheduler falls back to setTimeout(fn, 0) which goes through
    // native RCTTiming module — stalled ~24s in XPC ViewBridge service context.
    //
    // Implementation: synchronous callback queue with explicit drain.
    // When setImmediate(fn) is called, fn is pushed to a queue. The queue is
    // explicitly drained by Engine after eval() (via _drainPendingImmediates).
    // A microtask fallback also schedules a drain for non-eval contexts.
    //
    // Why not queueMicrotask directly? nativeQueueMicrotask is the HOST's
    // queueMicrotask, which drains after the HOST call stack unwinds — too late
    // for synchronous rendering during eval().
    {
      let immediateIdCounter = 0;
      let immediateCallCount = 0;
      const pendingQueue: Array<{ id: number; fn: () => void; queuedAt: number }> = [];
      const cancelledIds = new Set<number>();
      let isDraining = false;

      const drainQueue = () => {
        if (isDraining) return;
        isDraining = true;
        this.diagAccum(`[rill:${engineId}] DRAIN START pending=${pendingQueue.length}`);
        try {
          let safety = 0;
          while (pendingQueue.length > 0 && safety < 10000) {
            safety++;
            const entry = pendingQueue.shift()!;
            if (cancelledIds.has(entry.id)) {
              cancelledIds.delete(entry.id);
              continue;
            }
            immediateCallCount++;
            if (immediateCallCount <= 10 || immediateCallCount % 100 === 0) {
              logger.log(
                `[rill:${engineId}] [DIAG] setImmediate FIRED id=${entry.id} delay=${Date.now() - entry.queuedAt}ms total=${immediateCallCount}`
              );
              this.diagAccum(`[rill:${engineId}] FIRED id=${entry.id} total=${immediateCallCount}`);
            }
            try {
              const fnStart = Date.now();
              entry.fn();
              const fnDur = Date.now() - fnStart;
              if (immediateCallCount <= 10) {
                logger.log(
                  `[rill:${engineId}] [DIAG] setImmediate fn() DONE id=${entry.id} took=${fnDur}ms`
                );
              }
              this.diagAccum(
                `[rill:${engineId}] fn() DONE id=${entry.id} took=${fnDur}ms queueAfter=${pendingQueue.length}`
              );
            } catch (e) {
              const error = e instanceof Error ? e : new Error(String(e));
              logger.error(`[rill:${engineId}] setImmediate callback error:`, error);
              this.diagAccum(`[rill:${engineId}] fn() ERROR id=${entry.id}: ${error.message}`);
              this.diagnostics?.recordError?.();
              this.emit('error', error);
            }
          }
          this.diagAccum(
            `[rill:${engineId}] DRAIN END processed=${safety} remaining=${pendingQueue.length}`
          );
          if (safety >= 10000) {
            logger.warn(
              `[rill:${engineId}] setImmediate drain hit safety limit (10000 iterations)`
            );
          }
        } finally {
          isDraining = false;
        }
      };

      // Expose drain function for Engine to call after eval()
      this._drainPendingImmediates = drainQueue;

      injectWithLog('setImmediate', (fn: () => void) => {
        const id = ++immediateIdCounter;
        const queuedAt = Date.now();
        if (immediateCallCount < 5) {
          logger.log(`[rill:${engineId}] [DIAG] setImmediate called id=${id} fnType=${typeof fn}`);
        }
        pendingQueue.push({ id, fn, queuedAt });

        // Microtask fallback: drain queue if not already being drained.
        // This handles setImmediate calls outside of eval() context (e.g., from events).
        nativeQueueMicrotask(() => {
          if (pendingQueue.length > 0 && !isDraining) {
            drainQueue();
          }
        });

        return id;
      });

      injectWithLog('clearImmediate', (id: number) => {
        cancelledIds.add(id);
      });
    }

    // queueMicrotask
    injectWithLog('queueMicrotask', (fn: () => void) => {
      nativeQueueMicrotask(() => {
        try {
          fn();
        } catch (error) {
          logger.error('[Guest] queueMicrotask error:', error);
        }
      });
    });

    // Post-eval polyfill setup: require(), unhandled rejection, etc.
    // Extracted as a function so it can run after sync or async eval.
    const finishPolyfillSetup = () => {
      // require: module loader for Guest code
      // Note: Globals like __useHostEvent, __rill_getConfig, __rill_emitEvent are defined AFTER require.
      // They are accessed lazily when require('rill/guest') is called (after injectPolyfills completes).
      // require(): Implemented inside the sandbox to avoid JSI boundary crossings.
      //
      // Previously, require was a host function that called extract() to fetch
      // sandbox objects, round-tripping them through JSI. This wrapped EVERY function
      // in the returned object (React, Reconciler, etc.) with JSI proxies, causing
      // each internal call to bounce QJS→JSI→QJS — ~100+ boundary crossings during
      // a single React commit phase, leading to ANR on Android.
      //
      // The sandbox-internal require returns globalThis references directly, avoiding
      // any JSI conversion. Special modules (react-native shim) are pre-injected.
      const requireWhitelistStr = JSON.stringify(Array.from(this.options.requireWhitelist));
      this.evalCode(`
        (function() {
          var whitelist = ${requireWhitelistStr};
          var modules = {};
          function isWhitelisted(name) {
            for (var i = 0; i < whitelist.length; i++) {
              var p = whitelist[i];
              if (p === name) return true;
              if (typeof p === 'string' && p.length > 0 && p.charAt(p.length - 1) === '*') {
                var prefix = p.slice(0, -1);
                if (name.indexOf(prefix) === 0) return true;
              }
            }
            return false;
          }
          globalThis.require = function(name) {
            if (!isWhitelisted(name)) {
              var e = new Error('[rill] Unsupported require("' + name + '")');
              e.name = 'RequireError';
              throw e;
            }
            if (modules[name]) return modules[name];
            switch (name) {
              case 'react':
                if (!globalThis.React) throw new Error('[rill] React not found');
                return globalThis.React;
              case 'react/jsx-runtime':
                if (!globalThis.ReactJSXRuntime) throw new Error('[rill] ReactJSXRuntime not found');
                return globalThis.ReactJSXRuntime;
              case 'react/jsx-dev-runtime':
                return globalThis.ReactJSXDevRuntime || globalThis.ReactJSXRuntime;
              case 'rill/reconciler':
                if (!globalThis.RillReconciler) throw new Error('[rill] RillReconciler not found');
                return globalThis.RillReconciler;
              case 'rill/guest':
                if (!globalThis.RillGuest) throw new Error('[rill] RillGuest not found');
                return globalThis.RillGuest;
              case 'react-native':
                return modules['react-native'] || { Platform: { OS: 'unknown' } };
              default:
                throw new Error('[rill] Unsupported require("' + name + '")');
            }
          };
          // Allow host to register module objects (e.g., react-native shim)
          globalThis.__rill_registerModule = function(name, mod) {
            modules[name] = mod;
          };
        })();
      `);
      // Inject react-native shim as a module
      this.context?.inject('__rill_rn_shim', createReactNativeShim());
      this.evalCode(`
        globalThis.__rill_registerModule('react-native', globalThis.__rill_rn_shim);
        delete globalThis.__rill_rn_shim;
      `);

      // React/JSX shims are already injected before require was set up
      // No need for lazy getters - Guest has its own React implementation

      // Unhandled Promise Rejection monitoring
      // This catches Promise rejections that are not handled with .catch()
      // Note: Support varies by sandbox environment (vm/worker/web)
      try {
        // Reason: Promise rejection reason and promise value can be any type
        const unhandledRejectionHandler = (event: {
          reason?: unknown;
          promise?: Promise<unknown>;
          preventDefault?: () => void;
        }) => {
          const error =
            event.reason instanceof Error ? event.reason : new Error(String(event.reason));
          logger.error(`[rill:${this.id}][Guest] Unhandled Promise Rejection:`, error);

          // Track error for monitoring
          this.diagnostics.recordError();

          // Emit error event so Host can handle it
          this.emit('error', error);

          // Prevent error from bubbling to Host console
          if (event.preventDefault) {
            event.preventDefault();
          }
        };

        // Try to set unhandledrejection handler
        // Different sandbox environments have different support
        // Modern browsers and Node.js support
        if ('addEventListener' in globalThis) {
          globalThis.addEventListener('unhandledrejection', unhandledRejectionHandler);
        } else if ('onunhandledrejection' in globalThis) {
          globalThis.onunhandledrejection = unhandledRejectionHandler;
        }

        // Inject into sandbox context
        injectWithLog('onunhandledrejection', unhandledRejectionHandler);
      } catch (_err) {
        // Silently fail if unhandledrejection is not supported
        if (debug) {
          logger.warn(`[rill:${this.id}] Unhandledrejection handler not supported in this sandbox`);
        }
      }

      // Note: console object is now constructed in Guest bundle (globals-setup.ts)
      if (debug) {
        logger.log(`[rill:${this.id}] injectPolyfills: console setup done via Guest bundle`);
      }
    }; // end finishPolyfillSetup

    // Inject Guest Bundle (includes shims, console, runtime helpers, reconciler)
    // Single eval for entire Guest runtime.
    // For sync providers (JSC): returns void, finishPolyfillSetup runs inline
    // For async providers (Worker): returns Promise, finishPolyfillSetup runs in .then()
    const guestResult = injectGuestBundle();

    if (guestResult instanceof Promise) {
      return guestResult.then(finishPolyfillSetup);
    }
    finishPolyfillSetup();
  }

  /**
   * Inject runtime API into sandbox
   */
  private injectRuntimeAPI(): void | Promise<void> {
    if (!this.context) return;

    const debug = this.options.debug;
    const logger = this.options.logger;

    // Note: Runtime helpers (__useHostEvent, __rill.dispatchEvent) are now in Guest bundle

    // __rill_registerComponentType: register Guest function components on Host so they survive JSI
    const engineId = this.id;
    const registerComponentType = (fn: unknown) => {
      try {
        // Use sandbox's RillReconciler for component type registration
        const reconciler = this.context?.extract('RillReconciler') as
          | RillReconcilerGlobal
          | undefined;
        return reconciler?.registerComponentType?.(fn, engineId) ?? null;
      } catch {
        // ignore
      }
      return null;
    };
    this.context.inject('__rill_registerComponentType', registerComponentType);

    // __rill_sendBatch: Receives batch from Guest, dispatches to the correct Bridge method
    // based on the batch format (raw object, binary ArrayBuffer, or JSON string).
    const sendToHost: SendToHost = (batch) => {
      if (!this.bridge) return;
      if (batch instanceof ArrayBuffer) {
        this.bridge.sendBinaryBatch(batch);
      } else if (typeof batch === 'string') {
        this.bridge.sendJsonBatch(batch);
      } else {
        this.bridge.sendRawBatch(batch as OperationBatch);
      }
    };

    // Inject __rill_sendBatch for Guest code
    // Bridge.sendToHost handles all serialization via TypeRules
    this.context.inject('__rill_sendBatch', sendToHost);

    // __rill_sendOperation: Send a single operation directly to Host (bypasses batching)
    // Used by Remote Ref for immediate REF_CALL delivery
    this.context.inject('__rill_sendOperation', (op: ReviewedUnknown) => {
      if (!this.bridge || !op || typeof op !== 'object') return;

      // Wrap single operation in a minimal batch for Bridge compatibility
      // Note: op contains raw BridgeValue (not yet serialized), Bridge.sendRawBatch will encode it
      const batch: BridgeOperationBatch = {
        version: 1,
        batchId: Date.now(), // Use timestamp as unique batch ID
        operations: [op as BridgeOperationBatch['operations'][0]],
      };

      if (debug) {
        logger.log(`[rill:${this.id}] __rill_sendOperation:`, (op as { op?: string }).op);
      }

      this.bridge.sendRawBatch(batch);
    });

    // Guest-side render tracking + scheduleRender
    // Must be Guest code (not a Host closure) to avoid TenantManager re-entrancy deadlocks.
    this.evalCode(`
      (function() {
        try {
          if (!globalThis.__rill) globalThis.__rill = {};
          var __rill = globalThis.__rill;
          if (!__rill.__internal) __rill.__internal = {};
          var __internal = __rill.__internal;

          if (!__internal.renderHookInstalled) {
            __internal.renderHookInstalled = true;
            __internal.lastRenderElement = null;
            __internal.lastRenderSendToHost = null;

            var R = globalThis.RillReconciler;
            if (R && typeof R.render === 'function') {
              var __origRender = R.render;
              R.render = function(element, sendToHost) {
                __internal.lastRenderElement = element;
                __internal.lastRenderSendToHost = sendToHost;
                return __origRender(element, sendToHost);
              };
            }
          }

          if (typeof globalThis.__rill_scheduleRender !== 'function') {
            globalThis.__rill_scheduleRender = function() {
              try {
                var R = globalThis.RillReconciler;
                if (!R || typeof R.render !== 'function') return;
                var el = __internal.lastRenderElement;
                var send = __internal.lastRenderSendToHost;
                if (!el || typeof send !== 'function') return;
                var React = globalThis.React;
                // Force a new element identity to ensure update propagation
                var nextEl = (React && typeof React.cloneElement === 'function')
                  ? React.cloneElement(el)
                  : el;
                R.render(nextEl, send);
              } catch (e) {
                if (typeof __console_error === 'function') {
                  __console_error('[rill] __rill_scheduleRender error:', e);
                }
              }
            };
          }
        } catch (e) {}
      })();
    `);

    // __rill_getConfig: Get initial configuration
    this.context.inject('__rill_getConfig', () => this.config);

    // __rill_emitEvent: Send event to host
    // Reason: Event payload can be any serializable type
    this.context.inject('__rill_emitEvent', (eventName: string, payload?: unknown) => {
      if (debug) {
        logger.log('[rill] Guest event:', eventName, payload);
      }

      // Handle DevTools messages from Guest
      if (eventName.startsWith('__DEVTOOLS_') && this._devtools) {
        const p = payload as Record<string, unknown> | undefined;
        switch (eventName) {
          case '__DEVTOOLS_CONSOLE__':
            // Console logs are forwarded via emit for external processing
            if (p?.entry) {
              this.emit(
                'devtoolsConsole',
                p.entry as Parameters<EngineEvents['devtoolsConsole']>[0]
              );
            }
            break;
          case '__DEVTOOLS_ERROR__':
            // Errors are recorded in devtools and emitted
            this._devtools.recordSandboxError();
            if (p?.error) {
              this.emit('devtoolsError', p.error as Parameters<EngineEvents['devtoolsError']>[0]);
            }
            break;
          case '__DEVTOOLS_READY__':
            // Guest devtools is ready
            this.emit('devtoolsReady', {});
            break;
        }
        return; // Don't process as regular message
      }

      // Record guest event via DiagnosticsCollector
      const payloadBytes =
        payload === undefined
          ? 0
          : (() => {
              try {
                return JSON.stringify(payload).length;
              } catch {
                return undefined;
              }
            })();
      this.diagnostics.recordGuestEvent(eventName, payloadBytes);

      // Special convention: Guest reports its sleep state (used with HOST_VISIBILITY)
      if (eventName === 'GUEST_SLEEP_STATE' && payload && typeof payload === 'object') {
        // Reason: Payload field type unknown until runtime validation
        const sleeping = (payload as { sleeping?: unknown }).sleeping;
        if (typeof sleeping === 'boolean') {
          this.diagnostics.setGuestSleeping(sleeping);
        }
      }
      this.emit('message', { event: eventName, payload });
    });

    // __rill_handleMessage: Handle messages from host
    // IMPORTANT: Defined as GUEST code (not a host closure) to avoid re-entrant
    // TenantManager mutex calls. When evalInTenant holds the mutex and the evaluated
    // code calls a host closure that uses extract/inject, a deadlock occurs
    // with non-recursive mutexes. Guest code can access __rill directly from its
    // own global scope without going through the TenantManager's extract.
    this.evalCode(`
      globalThis.__rill_handleMessage = function(message) {
        try {
          if (!message || !message.type) return;
          if (message.type === 'CALL_FUNCTION') {
            if (typeof globalThis.__rill !== 'undefined' &&
                typeof globalThis.__rill.invokeCallback === 'function') {
              globalThis.__rill.invokeCallback(message.fnId, message.args);
            }
          } else if (message.type === 'HOST_EVENT') {
            if (typeof globalThis.__rill !== 'undefined' &&
                typeof globalThis.__rill.dispatchEvent === 'function') {
              globalThis.__rill.dispatchEvent(message.eventName, message.payload);
            }
          } else if (message.type === 'CONFIG_UPDATE') {
            // Forward config updates to the Host event system so Guest hooks can subscribe.
            if (typeof globalThis.__rill !== 'undefined' &&
                typeof globalThis.__rill.dispatchEvent === 'function') {
              globalThis.__rill.dispatchEvent('CONFIG_UPDATE', message.config);
            }
            // Also trigger a re-render (idempotent, no-op before first render).
            if (typeof globalThis.__rill_scheduleRender === 'function') {
              globalThis.__rill_scheduleRender();
            }
          } else if (message.type === 'DESTROY') {
            if (typeof globalThis.RillReconciler !== 'undefined' &&
                typeof globalThis.RillReconciler.unmountAll === 'function') {
              globalThis.RillReconciler.unmountAll();
            }
            if (typeof globalThis.__rill !== 'undefined' &&
                globalThis.__rill.eventListeners &&
                typeof globalThis.__rill.eventListeners.clear === 'function') {
              globalThis.__rill.eventListeners.clear();
            }
          }
        } catch (e) {
          if (typeof __console_error === 'function') {
            __console_error('[rill] __rill_handleMessage error:', e);
          }
        }
      };
    `);

    // Skip RillGuest/ReactNative hooks update for JSC sandbox
    // The hooks (__useHostEvent, __rill_getConfig, __rill_emitEvent) are already available as global functions
    // Bundles use require('rill/guest') which returns these via the callback proxy mechanism
    // Trying to pass an object with extract results (Promises in JSC) causes serialization issues
    if (debug) {
      logger.log(
        `[rill:${this.id}] injectRuntimeAPI: skipping RillGuest hooks update (available via require())`
      );
    }

    // Inject registered component names as global variables
    // Guest scripts use these directly: h(View, ...), h(Text, ...), etc.
    const componentNames = this.registry.getRegisteredNames();
    for (const name of componentNames) {
      this.context.inject(name, name);
    }
    if (debug && componentNames.length > 0) {
      logger.log(
        `[rill:${this.id}] injectRuntimeAPI: injected component globals: ${componentNames.join(', ')}`
      );
    }

    // Expose host:* modules to the Guest resolver (globalThis.__rill.hostModules).
    this.injectHostModules();

    // All inject operations are now synchronous - no need to wait
    if (debug) {
      logger.log(`[rill:${this.id}] injectRuntimeAPI: all inject operations done`);
    }

    // Inject DevTools Guest shim if enabled
    if (this._devtools) {
      try {
        const evalResult = this.evalCode(DEVTOOLS_SHIM);
        if (evalResult instanceof Promise) {
          return evalResult.then(() => {
            if (debug) {
              logger.log(`[rill:${this.id}] injectRuntimeAPI: DevTools shim injected`);
            }
          });
        }
        if (debug) {
          logger.log(`[rill:${this.id}] injectRuntimeAPI: DevTools shim injected`);
        }
      } catch (e) {
        logger.warn(`[rill:${this.id}] Failed to inject DevTools shim:`, e);
      }
    }
  }

  /**
   * Inject the dispatch-wrapped `host:*` modules into the sandbox.
   *
   * Each capability is injected as an individual host function (mirroring how
   * `__rill_emitEvent`, `__rill_getConfig`, etc. are injected) so the marshalling
   * layer only ever crosses single functions — the JSI-friendly shape. A single
   * eval then assembles `globalThis.__rill.hostModules`, which is exactly where the
   * Guest bundle's rewritten `host:*` imports resolve (build.ts: `__rill_importHostModule`).
   *
   * Capabilities not registered here are absent from the table, so the Guest
   * resolver throws "Host module not registered" (fail-closed).
   */
  private injectHostModules(): void {
    if (!this.context || !this._hostModuleDispatch) return;

    // Provider-specific transport: isolated-realm providers (WASM) can't receive
    // host function references and bridge calls via a request/response protocol.
    // They opt in via installHostModules; realm-sharing / JSI providers fall through
    // to direct injection below.
    if (typeof this.context.installHostModules === 'function' && this._hostModuleContract) {
      this.context.installHostModules(this._hostModuleDispatch, this._hostModuleContract);
      if (this.options.debug) {
        this.options.logger.log(
          `[rill:${this.id}] injectHostModules: installed via provider bridge (${Object.keys(this._hostModuleDispatch).join(', ')})`
        );
      }
      return;
    }

    const assignments: string[] = [];
    let counter = 0;

    for (const [moduleId, moduleDispatch] of Object.entries(this._hostModuleDispatch)) {
      const moduleKey = JSON.stringify(moduleId);
      for (const [exportName, handler] of Object.entries(moduleDispatch)) {
        const tempName = `__rill_hm_${counter++}`;
        this.context.inject(tempName, handler);
        const tempKey = JSON.stringify(tempName);
        const exportKey = JSON.stringify(exportName);
        assignments.push(
          `  m[${moduleKey}] = m[${moduleKey}] || {};\n` +
            `  m[${moduleKey}][${exportKey}] = globalThis[${tempKey}];\n` +
            `  try { delete globalThis[${tempKey}]; } catch (e) {}`
        );
      }
    }

    this.evalCode(`
      (function() {
        if (!globalThis.__rill) { globalThis.__rill = {}; }
        var m = globalThis.__rill.hostModules || {};
${assignments.join('\n')}
        globalThis.__rill.hostModules = m;
      })();
    `);

    if (this.options.debug) {
      this.options.logger.log(
        `[rill:${this.id}] injectHostModules: injected ${counter} host capability function(s)`
      );
    }
  }

  /**
   * Helper to evaluate code - uses evalAsync if available (for Worker providers),
   * otherwise falls back to sync eval.
   *
   * Returns void for sync providers (JSC) or Promise<void> for async providers (Worker).
   * Callers should check `result instanceof Promise` before awaiting to avoid
   * unnecessary HOST microtask boundaries in XPC ViewBridge context.
   */
  private evalCode(code: string): void | Promise<void> {
    if (!this.context) return;
    // Check for non-standard evalAsync (Worker providers)
    // Reason: evalAsync returns arbitrary type from dynamic code execution
    const ctx = this.context as SandboxScope & {
      evalAsync?: (code: string) => Promise<unknown>;
    };
    if (ctx.evalAsync) {
      this.options.logger.log(`[rill:${this.id}] [DIAG] evalCode: using evalAsync`);
      return ctx.evalAsync(code).then(() => {});
    }
    const es = Date.now();
    this.context.eval(code);
    this.options.logger.log(
      `[rill:${this.id}] [DIAG] evalCode: sync eval done in ${Date.now() - es}ms, codeLen=${code.length}`
    );
  }

  /**
   * Execute bundle code in sandbox (async path for Worker providers)
   */
  private async executeBundle(code: string, bytecodeAssetPath?: string): Promise<void> {
    const start = Date.now();
    if (!this.context) {
      throw new Error('[rill] Context not initialized');
    }

    try {
      const canEvalBytecodeFromAsset =
        typeof bytecodeAssetPath === 'string' &&
        bytecodeAssetPath.length > 0 &&
        typeof this.context.evalBytecodeAsset === 'function';
      let usedBytecodeAsset = false;

      if (canEvalBytecodeFromAsset) {
        try {
          this.context.evalBytecodeAsset!(bytecodeAssetPath!);
          usedBytecodeAsset = true;
          const stats = this.receiver?.getStats();
          if (stats && stats.rootChildrenCount === 0) {
            this.options.logger.warn(
              `[rill:${this.id}] evalBytecodeAsset produced no root nodes, fallback to source eval`
            );
            await this.evalCode(code);
            usedBytecodeAsset = false;
          }
        } catch (error) {
          this.options.logger.warn(
            `[rill:${this.id}] evalBytecodeAsset failed, fallback to source eval:`,
            error
          );
          await this.evalCode(code);
        }
      } else {
        await this.evalCode(code);
      }
      const dur = Date.now() - start;
      this.options.onMetric?.('engine.executeBundle', dur, {
        size: code.length,
        mode: usedBytecodeAsset ? 'bytecode-asset' : 'source',
      });
    } catch (error) {
      this.options.logger.error('[rill] Bundle execution error:', error);
      const errLike = error as {
        name?: ReviewedUnknown;
        message?: ReviewedUnknown;
        stack?: ReviewedUnknown;
      } | null;
      const errName = typeof errLike?.name === 'string' ? errLike.name : undefined;
      const errMessage = typeof errLike?.message === 'string' ? errLike.message : String(error);
      const errStack = typeof errLike?.stack === 'string' ? errLike.stack : undefined;

      if (errName === 'RequireError') {
        const re = new RequireError(errMessage);
        if (errStack) re.stack = errStack;
        throw re;
      }
      const ex = new ExecutionError(errMessage);
      if (errStack) ex.stack = errStack;
      throw ex;
    }
  }

  /**
   * Execute bundle code synchronously in sandbox (JSC/sync providers).
   *
   * After eval(), explicitly drains the setImmediate queue so that React's
   * scheduled reconciliation work completes synchronously. Without this drain,
   * setImmediate callbacks stay queued in the HOST's microtask queue and don't
   * fire until the HOST RunLoop processes them (which can be delayed by seconds
   * in XPC ViewBridge context where RCTTiming is frozen).
   */
  private executeBundleSync(code: string, bytecodeAssetPath?: string): void {
    const start = Date.now();
    if (!this.context) {
      throw new Error('[rill] Context not initialized');
    }

    // DIAG: Check sandbox state before eval
    const hasSendToHost = this.context.extract('__rill_sendBatch');
    const rillNsDiag = this.context.extract('__rill') as Record<string, unknown> | undefined;
    const hasRillGuest = rillNsDiag?.guest;
    const hasReact = this.context.extract('React');
    const hasReconciler = this.context.extract('RillReconciler');
    this.options.logger.log(
      `[rill:${this.id}] [DIAG] pre-eval sandbox state: ` +
        `__rill_sendBatch=${typeof hasSendToHost}, ` +
        `__rill.guest=${typeof hasRillGuest}, ` +
        `React=${typeof hasReact}, ` +
        `RillReconciler=${typeof hasReconciler}`
    );

    try {
      const es = Date.now();
      const canEvalBytecodeFromAsset =
        typeof bytecodeAssetPath === 'string' &&
        bytecodeAssetPath.length > 0 &&
        typeof this.context.evalBytecodeAsset === 'function';
      let usedBytecodeAsset = false;

      if (canEvalBytecodeFromAsset) {
        try {
          this.context.evalBytecodeAsset!(bytecodeAssetPath!);
          usedBytecodeAsset = true;
          const stats = this.receiver?.getStats();
          if (stats && stats.rootChildrenCount === 0) {
            this.options.logger.warn(
              `[rill:${this.id}] evalBytecodeAsset produced no root nodes, fallback to source eval`
            );
            this.context.eval(code);
            usedBytecodeAsset = false;
          }
          this.options.logger.log(
            `[rill:${this.id}] [DIAG] evalBytecodeAsset: sync eval done in ${Date.now() - es}ms, path=${bytecodeAssetPath}`
          );
        } catch (error) {
          this.options.logger.warn(
            `[rill:${this.id}] evalBytecodeAsset failed, fallback to source eval:`,
            error
          );
          this.context.eval(code);
          this.options.logger.log(
            `[rill:${this.id}] [DIAG] evalCode(fallback): sync eval done in ${Date.now() - es}ms, codeLen=${code.length}`
          );
        }
      } else {
        this.context.eval(code);
        this.options.logger.log(
          `[rill:${this.id}] [DIAG] evalCode: sync eval done in ${Date.now() - es}ms, codeLen=${code.length}`
        );
      }

      // Drain pending setImmediate callbacks synchronously.
      // React's scheduler schedules reconciliation work via setImmediate during eval().
      // The setImmediate polyfill queues callbacks instead of using queueMicrotask
      // (which would drain too late). We must explicitly flush the queue here so that
      // React's render → commit → sendToHost pipeline completes before this method returns.
      if (this._drainPendingImmediates) {
        this.diagAccum(`[rill:${this.id}] executeBundleSync: about to drain`);
        const drainStart = Date.now();
        this._drainPendingImmediates();
        const drainDur = Date.now() - drainStart;
        this.diagAccum(`[rill:${this.id}] executeBundleSync: drain done took=${drainDur}ms`);
        this.options.logger.log(
          `[rill:${this.id}] [DIAG] drainPendingImmediates: took=${drainDur}ms`
        );
      }

      // DIAG: Check sandbox state after eval (verify user script set __rill.guest)
      const postRillNs = this.context.extract('__rill') as Record<string, unknown> | undefined;
      const postRillGuest = postRillNs?.guest;
      const postKeys =
        postRillGuest && typeof postRillGuest === 'object' ? Object.keys(postRillGuest) : [];
      this.options.logger.log(
        `[rill:${this.id}] [DIAG] post-eval: __rill.guest=${typeof postRillGuest}, keys=[${postKeys.join(',')}]`
      );

      const dur = Date.now() - start;
      this.diagAccum(`[rill:${this.id}] executeBundleSync COMPLETE dur=${dur}ms`);
      this.options.onMetric?.('engine.executeBundle', dur, {
        size: code.length,
        mode: usedBytecodeAsset ? 'bytecode-asset' : 'source',
      });
    } catch (error) {
      this.diagAccum(`[rill:${this.id}] executeBundleSync ERROR: ${error}`);
      this.options.logger.error('[rill] Bundle execution error:', error);
      const errLike = error as {
        name?: ReviewedUnknown;
        message?: ReviewedUnknown;
        stack?: ReviewedUnknown;
      } | null;
      const errName = typeof errLike?.name === 'string' ? errLike.name : undefined;
      const errMessage = typeof errLike?.message === 'string' ? errLike.message : String(error);
      const errStack = typeof errLike?.stack === 'string' ? errLike.stack : undefined;

      if (errName === 'RequireError') {
        const re = new RequireError(errMessage);
        if (errStack) re.stack = errStack;
        throw re;
      }
      const ex = new ExecutionError(errMessage);
      if (errStack) ex.stack = errStack;
      throw ex;
    }
  }

  /**
   * Check if the current provider uses async eval (Worker providers).
   * Sync providers (JSC) use direct eval() which completes synchronously.
   */
  private isAsyncProvider(): boolean {
    if (!this.context) return false;
    const ctx = this.context as SandboxScope & {
      evalAsync?: (code: string) => Promise<ReviewedUnknown>;
    };
    return typeof ctx.evalAsync === 'function';
  }

  /**
   * Send message to sandbox
   *
   * Delegates to Bridge for unified communication handling
   */
  async sendToSandbox(message: HostMessage): Promise<void> {
    if (this.destroyed || !this.bridge) return;

    const start = Date.now();
    await this.bridge.sendToGuest(message);
    const duration = Date.now() - start;

    this.options.onMetric?.('bridge.sendToSandbox', duration, { type: message.type });

    // Handle DESTROY message - cleanup Engine state
    if (message.type === HostMsg.DESTROY) {
      this.destroy();
    }
  }

  /**
   * Emit event
   */
  emit<K extends keyof EngineEvents>(
    event: K,
    ...args: EngineEvents[K] extends () => void ? [] : [Parameters<EngineEvents[K]>[0]]
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(args[0]);
        } catch (error) {
          this.options.logger.error(`[rill] Event listener error:`, error);
        }
      });
    }
  }

  /**
   * Listen to engine events
   */
  on<K extends keyof EngineEvents>(
    event: K,
    listener: EngineEvents[K] extends () => void
      ? () => void
      : (data: Parameters<EngineEvents[K]>[0]) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<unknown>);

    // Memory leak detection - warn if listener count exceeds threshold
    if (this.options.debug) {
      const count = this.listeners.get(event)!.size;
      if (count > this.maxListeners && !this.warnedEvents.has(event)) {
        this.options.logger.warn(
          `[rill] Possible EventEmitter memory leak detected. ` +
            `${count} listeners added for event "${String(event)}". ` +
            `Use setMaxListeners() to increase limit.`
        );
        this.warnedEvents.add(event);
      }
    }

    return () => {
      this.listeners.get(event)?.delete(listener as EventListener<unknown>);
      // Clear warning if count drops below threshold
      if (this.warnedEvents.has(event)) {
        const count = this.listeners.get(event)?.size ?? 0;
        if (count <= this.maxListeners) {
          this.warnedEvents.delete(event);
        }
      }
    };
  }

  /**
   * Send event to sandbox guest
   * If engine is paused, events are queued and sent when resumed
   */
  // Reason: Event payload can be any serializable type
  sendEvent(eventName: string, payload?: unknown): void {
    // If paused, queue the event for later
    if (this._isPaused) {
      this._eventQueue.push({ eventName, payload });
      if (this.options.debug) {
        this.options.logger.log(
          `[rill:${this.id}] Event queued (paused): ${eventName}, queue size: ${this._eventQueue.length}`
        );
      }
      return;
    }

    this._sendEventInternal(eventName, payload);
  }

  /**
   * Internal method to actually send an event
   */
  private _sendEventInternal(eventName: string, payload?: ReviewedUnknown): void {
    // Record host event via DiagnosticsCollector
    const payloadBytes =
      payload === undefined
        ? 0
        : (() => {
            try {
              return JSON.stringify(payload).length;
            } catch {
              return undefined;
            }
          })();
    this.diagnostics.recordHostEvent(eventName, payloadBytes);

    // Record to DevTools
    this._devtools?.recordHostEvent(eventName, payload);

    void this.sendToSandbox({
      type: HostMsg.HOST_EVENT,
      eventName,
      payload: (payload ?? null) as BridgeValue,
    });
  }

  /**
   * Update configuration
   */
  updateConfig(config: BridgeValueObject): void {
    this.config = { ...this.config, ...config };
    void this.sendToSandbox({
      type: HostMsg.CONFIG_UPDATE,
      config,
    });
  }

  /**
   * Create Receiver
   */
  createReceiver(): Receiver {
    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Creating Receiver`);
    }
    this.receiver = new Receiver(
      this.registry,
      (message) => this.sendToSandbox(message),
      () => this.emit('update'),
      {
        onMetric: this.options.onMetric,
        maxBatchSize: this.options.receiverMaxBatchSize,
        // Use Bridge's releaseCallback for proper Host/Guest routing
        releaseCallback: (fnId) => this.bridge?.releaseCallback(fnId),
      }
    );

    // BridgeV2 is now connected via the onGuestOperations in the constructor, so setBridge is obsolete.

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Receiver created`);
    }
    return this.receiver;
  }

  /**
   * Get Receiver
   */
  getReceiver(): Receiver | null {
    return this.receiver;
  }

  /**
   * Get component registry
   */
  getRegistry(): ComponentRegistry {
    return this.registry;
  }

  /**
   * Check if loaded
   */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Check if destroyed
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Check if engine is paused
   */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Pause the engine - freeze timers and queue incoming events
   * Timer clocks are frozen (not just callbacks blocked)
   */
  pause(): void {
    if (this._isPaused || this.destroyed) return;

    this._isPaused = true;

    // Pause all timers (true clock freeze)
    this.timerManager.pause();

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Engine paused`);
    }

    // Emit pause event
    this.emit('pause');
  }

  /**
   * Resume the engine - unfreeze timers and flush queued events
   * Timers continue from where they left off
   */
  resume(): void {
    if (!this._isPaused || this.destroyed) return;

    this._isPaused = false;

    // Resume all timers (continue from remaining time)
    this.timerManager.resume();

    // Flush queued events
    const queuedEvents = this._eventQueue.splice(0);
    if (queuedEvents.length > 0 && this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Flushing ${queuedEvents.length} queued events`);
    }
    for (const event of queuedEvents) {
      this._sendEventInternal(event.eventName, event.payload);
    }

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Engine resumed`);
    }

    // Emit resume event
    this.emit('resume');
  }

  /**
   * Get DevTools collector (if enabled)
   */
  get devtools(): RuntimeCollector | null {
    return this._devtools;
  }

  /**
   * Set maximum number of listeners per event before warning
   */
  setMaxListeners(n: number): void {
    this.maxListeners = n;
  }

  /**
   * Get current maximum listener threshold
   */
  getMaxListeners(): number {
    return this.maxListeners;
  }

  /**
   * Get timer statistics (for testing/debugging)
   */
  getTimerStats(): { timeouts: number; intervals: number } {
    return this.timerManager.getStats();
  }

  /**
   * Get Guest callback registry size (for testing/debugging)
   *
   * Returns callbacks registered in Guest's globalCallbackRegistry (reconciler usage)
   * plus callbacks registered in Host's callbackRegistry (manual operations).
   *
   * Two sources of callbacks:
   * 1. Guest reconciler: serializes functions → Guest's globalCallbackRegistry
   * 2. Manual operations: raw functions → Host's callbackRegistry via Bridge
   */
  get guestCallbackCount(): number {
    // Host's callbackRegistry (for manual operations via __rill_sendBatch)
    const hostCount = this.callbackRegistry.size;

    // Guest's globalCallbackRegistry (for reconciler usage)
    let guestCount = 0;
    if (this.context) {
      const reconciler = this.context.extract('RillReconciler') as RillReconcilerGlobal | undefined;
      guestCount = reconciler?.getCallbackCount?.() ?? 0;
    }

    return hostCount + guestCount;
  }

  /**
   * Destroy engine and release all resources
   */
  destroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.loaded = false;
    this.diagnostics.setLoaded(false);
    this.diagnostics.setDestroyed(true);

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Destroying engine`);
    }

    this.emit('destroy');

    // Clean up component type registry for this engine (JSI-safe function component transport)
    // Must be done before context disposal
    try {
      const reconciler = this.context?.extract('RillReconciler') as
        | RillReconcilerGlobal
        | undefined;
      reconciler?.unregisterComponentTypes?.(this.id);
    } catch {
      // ignore
    }

    // Clear all pending timers
    this.clearAllTimers();

    // Release setImmediate drain reference
    this._drainPendingImmediates = null;

    this.receiver?.clear();
    this.receiver = null;

    // Clear callback registry - this Engine's callbacks are no longer valid
    this.callbackRegistry.clear();

    // Clean up Bridge (clears pending promises to prevent timeout errors)
    this.bridge?.destroy();
    this.bridge = null;

    this.context?.dispose();
    this.context = null;
    this.runtime?.dispose();
    this.runtime = null;

    this.listeners.clear();

    // Clear DevTools
    if (this._devtools) {
      this._devtools.updateSandboxStatus({ state: 'destroyed' });
      this._devtools.disable();
      this._devtools.clear();
      this._devtools = null;
    }

    // Emit metric for engine destruction
    this.options.onMetric?.('engine.destroyed', 1, { engineId: this.id });
  }

  /**
   * Clear all pending timers (timeouts and intervals)
   */
  private clearAllTimers(): void {
    // Delegate to TimerManager
    this.timerManager.clearAllTimers();
  }

  /**
   * Force destroy engine without emitting events.
   * Used for fatal error recovery (e.g., timeout) to prevent snowball effects.
   * This is more aggressive than destroy() - it doesn't emit 'destroy' event
   * to avoid potential callback execution during error recovery.
   */
  private forceDestroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.loaded = false;
    this.diagnostics.setLoaded(false);
    this.diagnostics.setDestroyed(true);

    // Don't emit 'destroy' event during force destroy to avoid callbacks

    // Best-effort cleanup for component type registry (before context disposal)
    try {
      const reconciler = this.context?.extract('RillReconciler') as
        | RillReconcilerGlobal
        | undefined;
      reconciler?.unregisterComponentTypes?.(this.id);
    } catch {
      // ignore
    }

    // Clear all pending timers first
    this.clearAllTimers();

    this.receiver?.clear();
    this.receiver = null;

    // Clear callback registry
    this.callbackRegistry.clear();

    // Clean up Bridge (clears pending promises to prevent timeout errors)
    try {
      this.bridge?.destroy();
    } catch {
      // Ignore errors during force destroy
    }
    this.bridge = null;

    try {
      this.context?.dispose();
    } catch {
      // Ignore errors during force dispose
    }
    this.context = null;

    try {
      this.runtime?.dispose();
    } catch {
      // Ignore errors during force dispose
    }
    this.runtime = null;

    // Keep listeners for fatalError handling, clear after
    // Give handlers a chance to process, then clear
    queueMicrotask(() => {
      this.listeners.clear();
    });

    // Clear DevTools
    if (this._devtools) {
      this._devtools.updateSandboxStatus({ state: 'destroyed' });
      this._devtools.disable();
      this._devtools.clear();
      this._devtools = null;
    }

    // Emit metric for engine destruction
    this.options.onMetric?.('engine.destroyed', 1, { engineId: this.id, forced: true });
  }

  private getResourceStats(): { timers: number; nodes: number; callbacks: number } {
    const timerStats = this.timerManager.getStats();
    return {
      timers: timerStats.timeouts + timerStats.intervals,
      nodes: this.receiver?.nodeCount ?? 0,
      // Use Engine's own callbackRegistry
      callbacks: this.callbackRegistry.size,
    };
  }

  getDiagnostics(): EngineDiagnostics {
    // Delegate to DiagnosticsCollector
    return this.diagnostics.getDiagnostics(this.receiver, () => this.getResourceStats());
  }
}
