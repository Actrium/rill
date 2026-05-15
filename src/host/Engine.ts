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
  var __sendEventToHost: ((eventName: string, payload?: unknown) => void) | undefined;
  // eslint-disable-next-line no-var
  var __invokeCallback: ((fnId: string, args: unknown[]) => unknown) | undefined;
  // eslint-disable-next-line no-var
  var __handleHostEvent: ((eventName: string, payload: unknown) => void) | undefined;
}

import type { RuntimeCollector } from '../devtools/index';
import { createRuntimeCollector } from '../devtools/index';
import { GUEST_BUNDLE_CODE } from '../guest/build/bundle';
import type { JSEngineContext, JSEngineProvider, JSEngineRuntime } from '../sandbox';
import type { RillHooksState, RillReconcilerGlobal } from '../sandbox/globals';
import type {
  HostMessage as BridgeHostMessage,
  OperationBatch as BridgeOperationBatch,
  BridgeValue,
  BridgeValueObject,
  SendToHost,
  SerializedOperationBatch,
} from '../shared';
import { CallbackRegistryImpl as CallbackRegistry } from '../shared';
import { Bridge } from '../shared/bridge/Bridge';
import { DiagnosticsCollector } from './engine/DiagnosticsCollector';
import {
  createCommonJSGlobals,
  createReactNativeShim,
  createRillSDKModule,
  formatConsoleArgs,
} from './engine/SandboxHelpers';
import { DEVTOOLS_SHIM } from './engine/shims';
import { TimerManager } from './engine/TimerManager';
// Import from engine/types.ts (single source of truth)
import type { EngineOptions, EventListener } from './engine/types';
import { ExecutionError, RequireError, TimeoutError } from './engine/types';
import type { EngineDiagnostics, EngineEvents, EngineHealth, IEngine } from './IEngine';
import { Receiver } from './receiver';
import type { ComponentMap } from './registry';
import { ComponentRegistry } from './registry';
import type { HostMessage, OperationBatch } from './types';

// Re-export sandbox provider types
export type {
  JSEngineContext,
  JSEngineProvider,
  JSEngineRuntime,
  JSEngineRuntimeOptions,
} from '../sandbox';
// Re-export types for external API
export type { EngineOptions } from './engine/types';
export { ExecutionError, RequireError, TimeoutError } from './engine/types';
// Re-export IEngine types for convenience
export type {
  EngineActivityStats,
  EngineActivityTimeline,
  EngineActivityTimelinePoint,
  EngineDiagnostics,
  EngineEvents,
  EngineHealth,
  GuestMessage,
  IEngine,
} from './IEngine';

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
  private context: JSEngineContext | null = null;
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
    provider?: JSEngineProvider;
    timeout: number;
    debug: boolean;
    logger: NonNullable<EngineOptions['logger']>;
    requireWhitelist: ReadonlySet<string>;
    onMetric?: (name: string, value: number, extra?: Record<string, unknown>) => void;
    receiverMaxBatchSize: number;
  };
  private destroyed = false;
  private loaded = false;
  private errorCount = 0;
  private lastErrorAt: number | null = null;
  private _timeoutTimer?: ReturnType<typeof setTimeout>;

  // Pause state
  private _isPaused = false;
  private _eventQueue: Array<{ eventName: string; payload?: unknown }> = [];

  // Unique engine ID (UUID-like format)
  public readonly id: string;

  // Event listeners
  // Reason: Event listeners accept arbitrary event payload types
  private listeners: Map<keyof EngineEvents, Set<EventListener<unknown>>> = new Map();

  // Memory leak detection for Engine events
  private maxListeners = 10;
  private warnedEvents = new Set<keyof EngineEvents>();

  // sendToHost reference for callback registry access
  private sendToHostFn: SendToHost | null = null;

  // Guest-triggered rerender support (useState/useEffect in sandbox)
  // We record the last root element rendered via require('rill/reconciler').render
  // so Guest hooks can request an update without needing to rehydrate root props.
  // Reason: Last rendered element can be any React element type from guest
  private lastRenderedElement: unknown | null = null;
  private lastRenderedSendToHost: SendToHost | null = null;

  // DevTools collector (optional)
  private _devtools: RuntimeCollector | null = null;

  // Refactored modules
  private timerManager!: TimerManager;
  private diagnostics!: DiagnosticsCollector;

  constructor(options: EngineOptions = {}) {
    const defaultWhitelist = new Set([
      'react',
      'react-native',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      '@rill/let',
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
      provider: options.provider ?? options.quickjs,
      timeout: options.timeout ?? 5000,
      debug: options.debug ?? false,
      logger: options.logger ?? defaultLogger,
      requireWhitelist: new Set(options.requireWhitelist ?? Array.from(defaultWhitelist)),
      onMetric: options.onMetric,
      receiverMaxBatchSize: options.receiverMaxBatchSize ?? 5000,
    };

    this.registry = new ComponentRegistry();

    // Create CallbackRegistry - owned by this Engine instance
    // CallbackRegistry is Bridge layer infrastructure, not reconciler specific
    this.callbackRegistry = new CallbackRegistry();

    // Initialize JS engine provider
    // Priority: explicit provider > DefaultProvider auto-detect
    if (!this.options.provider) {
      // JS-side可视化全局可用性，便于在 Metro/Console 看到（仅 debug 输出，避免误判为错误）
      if (this.options.debug) {
        const jscGlobalType =
          typeof (globalThis as Record<string, unknown>).__JSCSandboxJSI !== 'undefined'
            ? typeof (globalThis as Record<string, unknown>).__JSCSandboxJSI
            : 'undefined';
        const quickjsGlobalType =
          typeof (globalThis as Record<string, unknown>).__QuickJSSandboxJSI !== 'undefined'
            ? typeof (globalThis as Record<string, unknown>).__QuickJSSandboxJSI
            : 'undefined';
        this.options.logger.log('[rill] Sandbox globals', {
          __JSCSandboxJSI: jscGlobalType,
          __QuickJSSandboxJSI: quickjsGlobalType,
        });
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DefaultProvider } = require('../sandbox/index');
        this.options.provider = DefaultProvider.create({
          timeout: this.options.timeout,
          sandbox: options.sandbox,
        });
        // Log provider type using logger (shows in Xcode console)
        if (this.options.debug) {
          const providerName = this.options.provider?.constructor?.name || 'unknown';
          this.options.logger.log(`[rill] Provider type: ${providerName}`);
          this.options.logger.log('[rill] Initialized DefaultProvider');
        }
      } catch (e) {
        this.options.logger.error('[rill] Failed to initialize DefaultJSEngineProvider:', e);
        // No fallback: surface error to caller
        throw e;
      }
    }

    // Generate unique engine ID
    const counter = ++engineIdCounter;
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    this.id = `engine-${counter}-${timestamp}-${random}`;

    // Initialize refactored modules (after this.id is set)
    this.timerManager = new TimerManager({
      debug: this.options.debug,
      logger: this.options.logger,
      engineId: this.id,
      onError: (error: Error) => {
        this.errorCount++;
        this.lastErrorAt = Date.now();
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
   * Load and execute Guest code
   */
  async loadBundle(source: string, initialProps?: Record<string, unknown>): Promise<void> {
    if (this.destroyed) {
      throw new Error('[rill] Engine has been destroyed');
    }

    if (this.loaded) {
      throw new Error('[rill] Engine already loaded a Guest');
    }

    this.config = initialProps ?? {};

    try {
      // Get bundle code
      const code = await this.resolveSource(source);

      if (this.options.debug) {
        this.options.logger.log(`[rill:${this.id}] Bundle loaded, length:`, code.length);
        this.options.logger.log(`[rill:${this.id}] Bundle preview:`, code.substring(0, 200));
        this.options.logger.log(
          `[rill:${this.id}] Bundle footer (last 500 chars):`,
          code.substring(code.length - 500)
        );
        this.options.logger.log(`[rill:${this.id}] Has Auto-render:`, code.includes('Auto-render'));
      }

      // Initialize sandbox and execute
      await this.initializeRuntime();

      // Update DevTools sandbox status
      this._devtools?.updateSandboxStatus({ state: 'running' });

      // Execute with timeout protection
      // Note: Hard timeout enforcement depends on the provider:
      // - VMProvider: Uses vm.Script timeout (hard interrupt)
      // - WorkerProvider: Web Worker sandbox (async-only)
      // - QuickJSProvider/JSCProvider: Native JSI implementation dependent
      //
      // The timer below serves as a fallback safety net for async providers
      // and will forcibly destroy the engine if execution hangs.

      const timeout = this.options.timeout;
      const hasTimeout = timeout > 0 && typeof globalThis.setTimeout === 'function';

      if (hasTimeout) {
        // Use Promise.race for hard timeout enforcement on async providers
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = globalThis.setTimeout(() => {
            // Fatal: execution exceeded timeout, force destroy to prevent snowball
            this.options.logger.error(
              `[rill] Fatal: Bundle execution exceeded timeout ${timeout}ms, destroying engine`
            );
            const error = new TimeoutError(
              `[rill] Execution exceeded timeout ${timeout}ms (hard limit)`
            );

            // Emit fatal error before destroying
            this.emit('fatalError', error);

            // Force destroy the engine to prevent resource leak
            this.forceDestroy();

            reject(error);
          }, timeout);

          // Store timer reference for cleanup
          this._timeoutTimer = timer;
        });

        try {
          await Promise.race([this.executeBundle(code), timeoutPromise]);
        } finally {
          // Clean up timer if execution completed normally
          if (this._timeoutTimer) {
            globalThis.clearTimeout(this._timeoutTimer);
            this._timeoutTimer = undefined;
          }
        }
      } else {
        // No timeout protection available
        await this.executeBundle(code);
      }

      this.loaded = true;
      this.diagnostics.setLoaded(true);
      this._devtools?.updateSandboxStatus({ state: 'ready' });
      this.emit('load');

      if (this.options.debug) {
        this.options.logger.log(`[rill:${this.id}] Bundle executed successfully`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.errorCount += 1;
      this.lastErrorAt = Date.now();
      this.diagnostics.recordError();
      this._devtools?.recordSandboxError();
      this._devtools?.updateSandboxStatus({ state: 'error' });
      this.emit('error', err);
      throw err;
    }
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
   * Initialize QuickJS runtime using the provided QuickJS provider
   */
  private async initializeRuntime(): Promise<void> {
    const start = Date.now();
    const debug = this.options.debug;
    const logger = this.options.logger;

    if (!this.options.provider) {
      throw new Error('[rill] QuickJS provider not initialized');
    }
    if (debug) logger.log(`[rill:${this.id}] initializeRuntime: creating runtime...`);
    this.runtime = await this.options.provider.createRuntime();
    if (debug) logger.log(`[rill:${this.id}] initializeRuntime: runtime created`);
    this.context = this.runtime.createContext();
    if (debug) {
      logger.log(`[rill:${this.id}] initializeRuntime: context created, creating BridgeV2...`);
    }

    // Create Bridge for Host ↔ Sandbox communication
    // Bridge encapsulates all serialization - uses this Engine's callback registry
    this.bridge = new Bridge({
      debug: this.options.debug,
      logger: this.options.logger, // Pass logger to Bridge for error reporting
      callbackRegistry: this.callbackRegistry,
      // Guest callback invoker - routes Guest callbacks to sandbox
      // Handles both fn_N (__registerCallback) and fn_xxx_N (Guest globalCallbackRegistry)
      guestInvoker: (fnId, args) => {
        // fn_N pattern: sandbox __registerCallback (simple counter)
        if (/^fn_\d+$/.test(fnId)) {
          const invokeCallback = this.context?.getGlobal('__invokeCallback') as
            | ((fnId: string, args: unknown[]) => unknown)
            | undefined;
          if (invokeCallback) {
            return invokeCallback(fnId, args);
          }
        }
        // fn_xxx_N pattern: Guest's globalCallbackRegistry (via RillReconciler)
        const reconciler = this.context?.getGlobal('RillReconciler') as
          | { invokeCallback?: (fnId: string, args: unknown[]) => unknown }
          | undefined;
        if (reconciler?.invokeCallback) {
          return reconciler.invokeCallback(fnId, args);
        }
        logger.warn(`[rill:${this.id}] No invoker found for ${fnId}`);
        return undefined;
      },
      // Guest callback releaser - routes release calls to Guest's registry
      guestReleaseCallback: (fnId) => {
        // fn_xxx_N pattern: Guest's globalCallbackRegistry (via RillReconciler)
        const reconciler = this.context?.getGlobal('RillReconciler') as
          | { releaseCallback?: (fnId: string) => void }
          | undefined;
        if (reconciler?.releaseCallback) {
          reconciler.releaseCallback(fnId);
        }
        // Note: fn_N pattern (sandbox __registerCallback) doesn't need explicit release
        // as those callbacks are managed by the sandbox's own lifecycle
      },
      hostReceiver: (batch: BridgeOperationBatch) => {
        // Props are already decoded by Bridge
        if (this.receiver) {
          const stats = this.receiver.applyBatch(batch as OperationBatch);

          // Record activity for diagnostics via DiagnosticsCollector
          this.diagnostics.recordBatch(stats);

          // Emit operation event for DevTools
          this.emit('operation', batch as OperationBatch);
        } else {
          logger.warn(`[rill:${this.id}] No receiver to apply batch!`);
        }
      },
      guestReceiver: async (message: BridgeHostMessage) => {
        // Message is already decoded by Bridge
        if (this.context) {
          if (this.options.debug) {
            this.options.logger.log(`[rill:${this.id}] guestReceiver message`, {
              type: message.type,
              keys: typeof message === 'object' && message ? Object.keys(message) : [],
            });
          }

          // REF_METHOD_RESULT needs special handling - dispatch directly in sandbox context
          // because __handleHostEvent is defined in sandbox, not accessible from native function
          if (message.type === 'REF_METHOD_RESULT') {
            this.context.setGlobal('__refResultMessage', message);
            await this.evalCode(
              "globalThis.__handleHostEvent('__REF_RESULT__', __refResultMessage)"
            );
            this.context.setGlobal('__refResultMessage', undefined);
            return;
          }

          await this.dispatchMessageToGuest(message);
        }
      },
    });

    if (debug) {
      logger.log(`[rill:${this.id}] initializeRuntime: BridgeV2 created, injecting polyfills...`);
    }

    await this.injectPolyfills();
    if (debug) {
      logger.log(`[rill:${this.id}] initializeRuntime: polyfills done, injecting runtimeAPI...`);
    }
    await this.injectRuntimeAPI();
    if (debug) logger.log(`[rill:${this.id}] initializeRuntime: done`);

    const dur = Date.now() - start;
    this.options.onMetric?.('engine.initializeRuntime', dur);
  }

  /**
   * Inject polyfills into sandbox
   */
  private async injectPolyfills(): Promise<void> {
    if (!this.context) return;

    const logger = this.options.logger;
    const debug = this.options.debug;

    // Helper to log setGlobal calls for debugging (synchronous)
    // Reason: setGlobal can accept any serializable value
    const setGlobalWithLog = (name: string, value: unknown): void => {
      if (debug) logger.log(`[rill:${this.id}] setGlobal: ${name} starting...`);
      const start = Date.now();
      try {
        this.context!.setGlobal(name, value);
        if (debug)
          logger.log(`[rill:${this.id}] setGlobal: ${name} done (${Date.now() - start}ms)`);
      } catch (e) {
        logger.error(`[rill:${this.id}] setGlobal: ${name} failed:`, e);
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
    const injectGuestBundle = async () => {
      try {
        // Check if already injected (e.g., from previous load)
        const alreadyInjected = this.context?.getGlobal('__REACT_SHIM__');
        if (alreadyInjected === true) {
          if (debug) logger.log(`[rill:${this.id}] Guest bundle already injected, skipping`);
          return;
        }

        // Single eval for entire Guest bundle
        await this.evalCode(GUEST_BUNDLE_CODE);

        if (debug) logger.log(`[rill:${this.id}] Guest bundle injected (shims + reconciler)`);
      } catch (e) {
        logger.error(`[rill:${this.id}] Failed to inject Guest bundle:`, e);
        throw e;
      }
    };

    // Inject RillSDK as global variable for IIFE bundles
    // Bundle format: (function(ReactJSXRuntime, React, RillSDK) { ... })(ReactJSXRuntime, React, RillSDK)
    const RillSDKModule = createRillSDKModule();
    setGlobalWithLog('RillSDK', RillSDKModule);

    // Provide minimal CommonJS globals for bundles built as CJS
    const cjsGlobals = createCommonJSGlobals();
    setGlobalWithLog('module', cjsGlobals.module);
    setGlobalWithLog('exports', cjsGlobals.exports);

    // Provide @rill/let global for bundles built as external (CLI)
    // IMPORTANT: render/unmount/unmountAll must use sandbox's RillReconciler instance
    // to ensure reconcilerMap state is shared with Guest code
    const getSandboxReconciler = (): RillReconcilerGlobal | undefined =>
      this.context?.getGlobal('RillReconciler') as RillReconcilerGlobal | undefined;

    const wrapRender = (...args: unknown[]) => {
      try {
        const el = args[0] as {
          type?: unknown;
          __rillTypeMarker?: string;
          __rillFragmentType?: string;
          props?: Record<string, unknown>;
        };
        const info = [
          `elementType=${typeof el}`,
          `type=${String(el?.type)}`,
          `marker=${String(el?.__rillTypeMarker)}`,
          `fragment=${String(el?.__rillFragmentType)}`,
          `propsKeys=${el?.props ? Object.keys(el.props).join(',') : 'null'}`,
          `sendToHostType=${typeof args[1]}`,
        ].join(' | ');
        if (debug) logger.log(`[rill:${this.id}] RillLet.render called | ${info}`);
      } catch {
        if (debug) logger.log(`[rill:${this.id}] RillLet.render called (log format failed)`);
      }
      try {
        const reconciler = getSandboxReconciler();
        if (!reconciler?.render) {
          throw new Error('[rill] RillReconciler not found in sandbox');
        }
        const ret = reconciler.render(args[0], args[1]);
        if (debug) logger.log(`[rill:${this.id}] RillReconciler.render returned`);
        return ret;
      } catch (e) {
        logger.error(`[rill:${this.id}] RillLet.render error`, e);
        throw e;
      }
    };

    const wrapUnmount = (sendToHost?: unknown) => {
      if (debug) logger.log(`[rill:${this.id}] RillLet.unmount called`);
      const reconciler = getSandboxReconciler();
      return reconciler?.unmount?.(sendToHost);
    };

    const wrapUnmountAll = () => {
      if (debug) logger.log(`[rill:${this.id}] RillLet.unmountAll called`);
      const reconciler = getSandboxReconciler();
      return reconciler?.unmountAll?.();
    };

    // invokeCallback/hasCallback use Engine's callbackRegistry (not reconciler's)
    const invokeCallback = (fnId: string, args: unknown[]) => {
      return this.callbackRegistry.invoke(fnId, args);
    };
    const hasCallback = (fnId: string) => {
      return this.callbackRegistry.has(fnId);
    };

    const RillLetModule =
      this.context.getGlobal?.('RillLet') ||
      ({
        ...RillSDKModule,
        render: wrapRender,
        unmount: wrapUnmount,
        unmountAll: wrapUnmountAll,
        invokeCallback,
        hasCallback,
      } as unknown);
    setGlobalWithLog('RillLet', RillLetModule);

    const engineId = this.id;

    // console - Register each method separately for JSC sandbox compatibility
    // JSC sandbox can't handle objects with function properties via RN bridge
    setGlobalWithLog('__console_log', (...args: unknown[]) => {
      if (debug) logger.log(`[rill:${engineId}][Guest]`, ...formatConsoleArgs(args));
    });
    setGlobalWithLog('__console_warn', (...args: unknown[]) => {
      logger.warn(`[rill:${engineId}][Guest]`, ...formatConsoleArgs(args));
    });
    setGlobalWithLog('__console_error', (...args: unknown[]) => {
      logger.error(`[rill:${engineId}][Guest]`, ...formatConsoleArgs(args));
    });
    setGlobalWithLog('__console_debug', (...args: unknown[]) => {
      if (debug) logger.log(`[rill:${engineId}][Guest:debug]`, ...formatConsoleArgs(args));
    });
    setGlobalWithLog('__console_info', (...args: unknown[]) => {
      if (debug) logger.log(`[rill:${engineId}][Guest:info]`, ...formatConsoleArgs(args));
    });

    // Inject Guest Bundle (includes shims, console, runtime helpers, reconciler)
    // Single eval for entire Guest runtime
    await injectGuestBundle();

    // require: module loader for Guest code
    // Note: Globals like __useHostEvent, __getConfig, __sendEventToHost are defined AFTER require.
    // They are accessed lazily when require('rill/sdk') is called (after injectPolyfills completes).
    setGlobalWithLog('require', (moduleName: string) => {
      if (debug) logger.log(`[rill:${this.id}] require("${moduleName}")`);

      if (!this.options.requireWhitelist.has(moduleName)) {
        throw new RequireError(`[rill] Unsupported require("${moduleName}")`);
      }

      switch (moduleName) {
        case 'react': {
          // Return Guest's React shim (injected via Guest bundle)
          // This avoids cross-engine serialization of complex Host objects
          const React = this.context?.getGlobal('React');
          if (!React) {
            throw new Error('[rill] React shim not found in Guest. Did injectReactShims fail?');
          }
          return React;
        }
        case 'react-native':
          // Return a minimal RN shim - real RN module not available in sandbox
          return createReactNativeShim();
        case 'react/jsx-runtime': {
          // Return Guest's JSX runtime shim (injected via injectReactShims)
          const JSXRuntime = this.context?.getGlobal('ReactJSXRuntime');
          if (!JSXRuntime) {
            throw new Error(
              '[rill] ReactJSXRuntime shim not found in Guest. Did injectReactShims fail?'
            );
          }
          return JSXRuntime;
        }
        case 'react/jsx-dev-runtime': {
          // Return Guest's JSX dev runtime shim (same as production runtime)
          const JSXDevRuntime = this.context?.getGlobal('ReactJSXDevRuntime');
          if (!JSXDevRuntime) {
            throw new Error(
              '[rill] ReactJSXDevRuntime shim not found in Guest. Did injectReactShims fail?'
            );
          }
          return JSXDevRuntime;
        }
        case 'rill/reconciler': {
          // Return Guest's RillReconciler (injected via injectGuestReconciler)
          // Reconciler now runs entirely in Guest
          const GuestReconciler = this.context?.getGlobal('RillReconciler') as
            | RillReconcilerGlobal
            | undefined;
          if (!GuestReconciler) {
            throw new Error(
              '[rill] RillReconciler not found in Guest. Did injectGuestReconciler fail?'
            );
          }

          // Engine-bound wrapper:
          // - 记录最近一次 render(root, sendToHost) 的参数
          // - 提供 scheduleRender() 供 Guest hooks 触发 rerender
          // - 重置 hook index 以支持 useState
          const engine = this;
          const render = (element: unknown, sendToHost?: unknown) => {
            engine.lastRenderedElement = element;
            if (typeof sendToHost === 'function') {
              engine.lastRenderedSendToHost = sendToHost as SendToHost;
            }
            // Reset hook index before each render
            try {
              const hooks = this.context?.getGlobal('__rillHooks') as RillHooksState | undefined;
              if (hooks) {
                hooks.index = 0;
                hooks.rootElement = element;
                hooks.sendToHost = sendToHost;
              }
            } catch (e) {
              if (debug) logger.warn('[rill] Failed to access hooks for render:', e);
            }
            return GuestReconciler.render(element, sendToHost);
          };
          const scheduleRender = () => {
            if (!engine.lastRenderedElement) return;
            const sendFn = engine.lastRenderedSendToHost ?? engine.sendToHostFn;
            if (typeof sendFn !== 'function') return;
            // Reset hook index before re-render
            try {
              const hooks = this.context?.getGlobal('__rillHooks') as RillHooksState | undefined;
              if (hooks) {
                hooks.index = 0;
              }
            } catch (e) {
              if (debug) logger.warn('[rill] Failed to access hooks for scheduleRender:', e);
            }
            return GuestReconciler.render(engine.lastRenderedElement, sendFn);
          };
          return { ...GuestReconciler, render, scheduleRender };
        }
        case '@rill/let':
          // Guest SDK module - provides component names (strings), host hooks, and reconciler
          // Component names are used by rill reconciler to look up registered components
          // Host communication hooks are accessed lazily from sandbox globals
          return {
            // React Native components (as string names)
            View: 'View',
            Text: 'Text',
            Image: 'Image',
            ScrollView: 'ScrollView',
            TouchableOpacity: 'TouchableOpacity',
            Button: 'Button',
            ActivityIndicator: 'ActivityIndicator',
            FlatList: 'FlatList',
            TextInput: 'TextInput',
            Switch: 'Switch',
            // Host communication hooks (lazily accessed from sandbox globals)
            useHostEvent: this.context?.getGlobal('__useHostEvent'),
            useConfig: this.context?.getGlobal('__getConfig'),
            useSendToHost: () => this.context?.getGlobal('__sendEventToHost'),
            // Reconciler functions - use sandbox's RillReconciler instance
            // This ensures reconcilerMap state is shared with Guest code
            render: (element: unknown, sendToHost: unknown) => {
              const reconciler = this.context?.getGlobal('RillReconciler') as
                | RillReconcilerGlobal
                | undefined;
              return reconciler?.render?.(element, sendToHost);
            },
            unmount: (sendToHost: unknown) => {
              const reconciler = this.context?.getGlobal('RillReconciler') as
                | RillReconcilerGlobal
                | undefined;
              return reconciler?.unmount?.(sendToHost);
            },
            unmountAll: () => {
              const reconciler = this.context?.getGlobal('RillReconciler') as
                | RillReconcilerGlobal
                | undefined;
              return reconciler?.unmountAll?.();
            },
          };
        default:
          throw new Error(`[rill] Unsupported require("${moduleName}")`);
      }
    });

    // React/JSX shims are already injected before require was set up
    // No need for lazy getters - Guest has its own React implementation

    // Inject timer polyfills using TimerManager
    setGlobalWithLog('setTimeout', this.timerManager.createSetTimeoutPolyfill());
    setGlobalWithLog('clearTimeout', this.timerManager.createClearTimeoutPolyfill());
    setGlobalWithLog('setInterval', this.timerManager.createSetIntervalPolyfill());
    setGlobalWithLog('clearInterval', this.timerManager.createClearIntervalPolyfill());

    // queueMicrotask
    setGlobalWithLog('queueMicrotask', (fn: () => void) => {
      nativeQueueMicrotask(() => {
        try {
          fn();
        } catch (error) {
          logger.error('[Guest] queueMicrotask error:', error);
        }
      });
    });

    // Unhandled Promise Rejection monitoring
    // This catches Promise rejections that are not handled with .catch()
    // Note: Support varies by sandbox environment (vm/worker/none)
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
        this.errorCount++;
        this.lastErrorAt = Date.now();

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
      setGlobalWithLog('onunhandledrejection', unhandledRejectionHandler);
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
  }

  /**
   * Inject runtime API into sandbox
   */
  private async injectRuntimeAPI(): Promise<void> {
    if (!this.context) return;

    const debug = this.options.debug;
    const logger = this.options.logger;
    // 在 Guest 沙箱内部建立专用事件总线，避免 Host 直接持有并调用 Guest 回调。
    await this.evalCode(`
      (function() {
        var listeners = globalThis.__rillHostEventListeners;
        if (!listeners) {
          listeners = new Map();
          globalThis.__rillHostEventListeners = listeners;
        }
        globalThis.__rillHostEventListenerCounts =
          globalThis.__rillHostEventListenerCounts || {};
        globalThis.__rillLastHostEventDispatch =
          globalThis.__rillLastHostEventDispatch || null;

        globalThis.__rillUseHostEvent = function(eventName, callback) {
          if (!listeners.has(eventName)) {
            listeners.set(eventName, new Set());
          }
          var set = listeners.get(eventName);
          set.add(callback);
          globalThis.__rillHostEventListenerCounts[eventName] = set.size;
          return function() {
            try {
              set.delete(callback);
              globalThis.__rillHostEventListenerCounts[eventName] = set.size;
            } catch (_) {}
          };
        };

        // 兼容仍然读取 __useHostEvent 的旧代码路径。
        globalThis.__useHostEvent = globalThis.__rillUseHostEvent;
        globalThis.__handleHostEvent = function(eventName, payload) {
          var set = listeners.get(eventName);
          globalThis.__rillLastHostEventDispatch = {
            eventName: eventName,
            listenerCount: set ? set.size : 0
          };
          if (!set) {
            return;
          }
          set.forEach(function(listener) {
            try {
              listener(payload);
            } catch (e) {
              if (globalThis.console && typeof globalThis.console.error === 'function') {
                globalThis.console.error('[rill] Host event listener error:', e);
              }
            }
          });
        };
        globalThis.__rillHandleHostEvent = globalThis.__handleHostEvent;
      })();
    `);

    // __rill_register_component_type: register Guest function components on Host so they survive JSI
    const engineId = this.id;
    const registerComponentType = (fn: unknown) => {
      try {
        // Use sandbox's RillReconciler for component type registration
        const reconciler = this.context?.getGlobal('RillReconciler') as
          | RillReconcilerGlobal
          | undefined;
        return reconciler?.registerComponentType?.(fn, engineId) ?? null;
      } catch {
        // ignore
      }
      return null;
    };
    this.context.setGlobal('__rill_register_component_type', registerComponentType);

    // __sendToHost: Receives batch from Guest, delegates to Bridge
    // Bridge handles all serialization via TypeRules and routes fn_N calls via guestInvoker
    const sendToHost = (batch: OperationBatch | SerializedOperationBatch) => {
      if (this.bridge) {
        this.bridge.sendToHost(batch);
      }
    };

    // Save reference for callback registry access
    this.sendToHostFn = sendToHost;

    // Inject __sendToHost for Guest code
    // Bridge.sendToHost handles all serialization via TypeRules
    this.context.setGlobal('__sendToHost', sendToHost);

    // __sendOperation: Send a single operation directly to Host (bypasses batching)
    // Used by Remote Ref for immediate REF_CALL delivery
    this.context.setGlobal('__sendOperation', (op: unknown) => {
      if (!this.bridge || !op || typeof op !== 'object') return;

      // Wrap single operation in a minimal batch for Bridge compatibility
      // Note: op contains raw BridgeValue (not yet serialized), Bridge.sendToHost will encode it
      const batch: BridgeOperationBatch = {
        version: 1,
        batchId: Date.now(), // Use timestamp as unique batch ID
        operations: [op as BridgeOperationBatch['operations'][0]],
      };

      if (debug) {
        logger.log(`[rill:${this.id}] __sendOperation:`, (op as { op?: string }).op);
      }

      this.bridge.sendToHost(batch);
    });

    // __rill_schedule_render: allow Guest hooks (useState/useEffect) to request a rerender.
    // Implementation uses the last root element recorded via require('rill/reconciler').render.
    //
    // IMPORTANT: Must use the SAME RillReconciler module instance that Guest code uses.
    // - Guest code calls: require('rill/reconciler').render(element, sendToHost)
    // - This stores the reconciler instance in that module's reconcilerMap
    // - Re-render must use the same module instance to find the existing reconciler
    //
    // Engine imports RillReconciler at top-level, but that's a DIFFERENT module instance
    // than the one injected into sandbox (via injectGuestReconciler / getGlobal('RillReconciler')).
    // Using the wrong instance would create a new reconciler each time, breaking diff.
    this.context.setGlobal('__rill_schedule_render', () => {
      if (!this.lastRenderedElement) return;
      const sendFn = this.lastRenderedSendToHost ?? this.sendToHostFn;
      if (typeof sendFn !== 'function') return;
      try {
        // Use the RillReconciler instance injected into sandbox (same as Guest code uses)
        const SandboxReconciler = this.context?.getGlobal('RillReconciler') as
          | RillReconcilerGlobal
          | undefined;
        if (SandboxReconciler?.render) {
          SandboxReconciler.render(this.lastRenderedElement, sendFn);
        } else {
          logger.warn(
            `[rill:${this.id}] __rill_schedule_render: RillReconciler not found in sandbox`
          );
        }
      } catch (e) {
        logger.error(`[rill:${this.id}] __rill_schedule_render error:`, e);
      }
    });

    // __getConfig: Get initial configuration
    this.context.setGlobal('__getConfig', () => this.config);

    // __sendEventToHost: Send event to host
    // Reason: Event payload can be any serializable type
    this.context.setGlobal('__sendEventToHost', (eventName: string, payload?: unknown) => {
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

    // __handleHostMessage: Handle messages from host
    // Capture context for closure - native functions can't access sandbox's globalThis directly
    const sandboxContext = this.context;
    this.context.setGlobal('__handleHostMessage', (message: HostMessage) => {
      try {
        switch (message.type) {
          case 'CALL_FUNCTION': {
            // Invoke registered callback (must get from sandbox context, not Host's globalThis)
            const invokeCallback = sandboxContext.getGlobal('__invokeCallback') as
              | ((fnId: string, args: unknown[]) => unknown)
              | undefined;
            if (typeof invokeCallback === 'function') {
              invokeCallback(message.fnId, message.args);
            }
            break;
          }
          case 'HOST_EVENT': {
            // Trigger host event listeners (must get from sandbox context)
            const handleHostEvent = sandboxContext.getGlobal('__handleHostEvent') as
              | ((eventName: string, payload: unknown) => void)
              | undefined;
            if (typeof handleHostEvent === 'function') {
              handleHostEvent(message.eventName, message.payload);
            }
            break;
          }
          case 'CONFIG_UPDATE':
            // Update config (handled by engine, no action needed in guest)
            break;
          case 'DESTROY':
            // Cleanup (handled by engine, no action needed in guest)
            break;
          // Note: REF_METHOD_RESULT is handled directly in guestReceiver
          // because it needs async Promise handling
        }
      } catch (e) {
        logger.error(`[rill:${this.id}] __handleHostMessage error:`, e);
      }
    });

    // Skip RillSDK/ReactNative hooks update for JSC sandbox
    // The hooks (__useHostEvent, __getConfig, __sendEventToHost) are already available as global functions
    // Bundles use require('rill/sdk') which returns these via the callback proxy mechanism
    // Trying to pass an object with getGlobal results (Promises in JSC) causes serialization issues
    if (debug) {
      logger.log(
        `[rill:${this.id}] injectRuntimeAPI: skipping RillSDK hooks update (available via require())`
      );
    }

    // All setGlobal operations are now synchronous - no need to wait
    if (debug) {
      logger.log(`[rill:${this.id}] injectRuntimeAPI: all setGlobal operations done`);
    }

    // Inject DevTools Guest shim if enabled
    if (this._devtools) {
      try {
        await this.evalCode(DEVTOOLS_SHIM);
        if (debug) {
          logger.log(`[rill:${this.id}] injectRuntimeAPI: DevTools shim injected`);
        }
      } catch (e) {
        logger.warn(`[rill:${this.id}] Failed to inject DevTools shim:`, e);
      }
    }
  }

  /**
   * Helper to evaluate code - uses evalAsync if available (for Worker providers),
   * otherwise falls back to sync eval.
   * Note: evalAsync is a non-standard extension for async-only providers.
   */
  private async evalCode(code: string): Promise<void> {
    if (!this.context) return;
    // Check for non-standard evalAsync (Worker providers)
    // Reason: evalAsync returns arbitrary type from dynamic code execution
    const ctx = this.context as JSEngineContext & {
      evalAsync?: (code: string) => Promise<unknown>;
    };
    if (ctx.evalAsync) {
      await ctx.evalAsync(code);
    } else {
      this.context.eval(code);
    }
  }

  /**
   * 将 Host 消息按类型拆开发送到 Guest，避免把整包对象再次注入沙箱。
   */
  private async dispatchMessageToGuest(message: BridgeHostMessage): Promise<void> {
    if (!this.context) return;

    const logger = this.options.logger;
    const debug = this.options.debug;

    try {
      switch (message.type) {
        case 'CALL_FUNCTION': {
          // QuickJS JSI 限制同 HOST_EVENT，使用 JSON 字面量嵌入 eval 字符串
          const fnId = message.fnId;
          const argsJson = JSON.stringify(message.args);
          try {
            this.context.eval(`globalThis.__invokeCallback("${fnId}", ${argsJson})`);
          } catch (evalErr) {
            console.error(`[Host→Guest] eval __invokeCallback 失败: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`);
            logger.error(`[rill:${this.id}] dispatchMessageToGuest CALL_FUNCTION eval error:`, evalErr);
          }
          return;
        }

        case 'HOST_EVENT': {
          // QuickJS JSI 的 getGlobal 返回的函数引用，从 Host 侧直接调用不会在沙箱中执行。
          // 必须通过 context.eval() 在沙箱内部调用。
          // 注意: 使用 __rillHandleHostEvent 而非 __handleHostEvent，
          // 因为 globals-setup.ts 会覆盖 __handleHostEvent，其内部使用空的 __hostEventListeners，
          // 而 SDK 通过 __rillUseHostEvent 注册的回调在 __rillHostEventListeners 中，
          // 只有 __rillHandleHostEvent (injectRuntimeAPI 版本) 才能找到这些回调。
          // QuickJS 的 context.eval() 会在执行后自动 drain pending jobs（微任务），
          // 确保 Promise .then() 回调能正常触发。
          const eventName = message.eventName;
          const payloadJson = message.payload === undefined || message.payload === null
            ? 'null'
            : JSON.stringify(message.payload);
          try {
            this.context.eval(`globalThis.__rillHandleHostEvent("${eventName}", ${payloadJson})`);
          } catch (evalErr) {
            console.error(`[Host→Guest] eval __rillHandleHostEvent 失败: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`);
            logger.error(`[rill:${this.id}] dispatchMessageToGuest HOST_EVENT eval error:`, evalErr);
          }

          return;
        }

        case 'CONFIG_UPDATE': {
          if (debug) {
            logger.log(`[rill:${this.id}] dispatch CONFIG_UPDATE`, {
              configKeys: Object.keys(message.config ?? {}),
            });
          }

          this.context.setGlobal('__hostConfigPatch', message.config);
          await this.evalCode(
            `
              // 将配置更新限制在 Guest 的配置对象上，避免依赖整包消息注入。
              globalThis.__config = globalThis.__config || {};
              Object.assign(globalThis.__config, __hostConfigPatch);
            `
          );
          this.context.setGlobal('__hostConfigPatch', undefined);
          return;
        }

        case 'PROMISE_RESOLVE': {
          if (debug) {
            logger.log(`[rill:${this.id}] dispatch PROMISE_RESOLVE`, {
              promiseId: message.promiseId,
            });
          }
          return;
        }

        case 'PROMISE_REJECT': {
          if (debug) {
            logger.log(`[rill:${this.id}] dispatch PROMISE_REJECT`, {
              promiseId: message.promiseId,
              errorName: message.error.__name,
            });
          }
          return;
        }

        case 'DESTROY': {
          if (debug) {
            logger.log(`[rill:${this.id}] dispatch DESTROY`);
          }

          await this.evalCode(
            `
              // 清空 Guest 侧事件监听，保持与原来的 DESTROY 语义一致。
              globalThis.__handleHostMessage({ type: 'DESTROY' });
            `
          );
          return;
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
          : String(error);
      console.error(
        `[rill:${this.id}] dispatchMessageToGuest error type=${message.type} ${errorMessage}`
      );
      logger.error(
        `[rill:${this.id}] dispatchMessageToGuest error type=${message.type}: ${errorMessage}`
      );
      throw error;
    }
  }

  /**
   * Execute bundle code in sandbox
   */
  private async executeBundle(code: string): Promise<void> {
    const start = Date.now();
    if (!this.context) {
      throw new Error('[rill] Context not initialized');
    }

    try {
      await this.evalCode(code);
      const dur = Date.now() - start;
      this.options.onMetric?.('engine.executeBundle', dur, { size: code.length });
    } catch (error) {
      this.options.logger.error('[rill] Bundle execution error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      throw new ExecutionError(err.message);
    }
  }

  /**
   * Send message to sandbox
   *
   * Delegates to Bridge for unified communication handling
   */
  async sendToSandbox(message: HostMessage): Promise<void> {
    if (this.destroyed || !this.bridge) {
      return;
    }

    const start = Date.now();
    await this.bridge.sendToGuest(message);
    const duration = Date.now() - start;

    this.options.onMetric?.('bridge.sendToSandbox', duration, { type: message.type });

    // Handle DESTROY message - cleanup Engine state
    if (message.type === 'DESTROY') {
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
  private _sendEventInternal(eventName: string, payload?: unknown): void {
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
      type: 'HOST_EVENT',
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
      type: 'CONFIG_UPDATE',
      config,
    });
  }

  /**
   * Create Receiver
   */
  createReceiver(onUpdate: () => void): Receiver {
    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.id}] Creating Receiver`);
    }
    this.receiver = new Receiver(
      this.registry,
      (message) => this.sendToSandbox(message),
      onUpdate,
      {
        onMetric: this.options.onMetric,
        maxBatchSize: this.options.receiverMaxBatchSize,
        // Use Bridge's releaseCallback for proper Host/Guest routing
        releaseCallback: (fnId) => this.bridge?.releaseCallback(fnId),
      }
    );

    // BridgeV2 is now connected via the hostReceiver in the constructor, so setBridge is obsolete.

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
   * Health snapshot for observability
   */
  getHealth(): EngineHealth {
    return {
      loaded: this.loaded,
      destroyed: this.destroyed,
      errorCount: this.errorCount,
      lastErrorAt: this.lastErrorAt,
      receiverNodes: this.receiver?.nodeCount ?? 0,
      batching: false,
    };
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
    // Host's callbackRegistry (for manual operations via __sendToHost)
    const hostCount = this.callbackRegistry.size;

    // Guest's globalCallbackRegistry (for reconciler usage)
    let guestCount = 0;
    if (this.context) {
      const reconciler = this.context.getGlobal('RillReconciler') as
        | RillReconcilerGlobal
        | undefined;
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
      const reconciler = this.context?.getGlobal('RillReconciler') as
        | RillReconcilerGlobal
        | undefined;
      reconciler?.unregisterComponentTypes?.(this.id);
    } catch {
      // ignore
    }

    // Clear all pending timers
    this.clearAllTimers();

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
      const reconciler = this.context?.getGlobal('RillReconciler') as
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

  /**
   * Get resource statistics for monitoring
   */
  getResourceStats(): { timers: number; nodes: number; callbacks: number } {
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
