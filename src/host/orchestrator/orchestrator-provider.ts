/**
 * OrchestratorProvider - JSEngineProvider that delegates to native __RillOrchestrator.
 *
 * Instead of creating a sandbox runtime/context directly in TS, this provider
 * creates a "virtual" runtime and context that route all operations through
 * the native C++ Orchestrator via JSI.
 *
 * This allows the host Engine to transparently work with either:
 * - Direct sandbox providers (JSC/QuickJS/VM) — existing path
 * - Orchestrator-managed tenants — new path (this file)
 *
 * The Orchestrator manages the actual sandbox lifecycle in native code,
 * while the Engine retains its polyfill injection, Bridge setup, and
 * event handling logic unchanged.
 */

import type {
  JSEngineProvider,
  JSEngineRuntime,
  JSEngineRuntimeOptions,
  SandboxScope,
} from '../sandbox/types/provider';
import type { ReviewedUnknown } from '../types';
import type {
  BusEventData,
  ChannelPolicyConfig,
  EventBusStats,
  OrchestratorTenantConfig,
  RillOrchestratorJSI,
} from './types';

/**
 * Options for creating an OrchestratorProvider.
 */
export interface OrchestratorProviderOptions {
  /** Tenant configuration for createTenant */
  tenantConfig: OrchestratorTenantConfig;
  /** Execution timeout (ms), passed to createTenant */
  timeout?: number;
}

/**
 * A SandboxScope that delegates to the native Orchestrator's per-tenant API.
 * All eval/inject/extract calls are routed through JSI to the C++ TenantHandle.
 */
class OrchestratorContext implements SandboxScope {
  private tenantId: number;
  private orchestrator: RillOrchestratorJSI;
  private disposed = false;

  constructor(tenantId: number, orchestrator: RillOrchestratorJSI) {
    this.tenantId = tenantId;
    this.orchestrator = orchestrator;
  }

  eval = (code: string): ReviewedUnknown => {
    if (this.disposed) {
      throw new Error('[OrchestratorContext] Context has been disposed');
    }
    return this.orchestrator.evalInTenant(this.tenantId, code);
  };

  inject = (name: string, value: ReviewedUnknown): void => {
    if (this.disposed) return;
    this.orchestrator.setTenantGlobal(this.tenantId, name, value);
  };

  extract = (name: string): ReviewedUnknown => {
    if (this.disposed) return undefined;
    return this.orchestrator.getTenantGlobal(this.tenantId, name);
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    // Context disposal is handled by Orchestrator's destroyTenant.
    // We don't call destroyTenant here because the Runtime owns the lifecycle.
  };

  // --- Timer delegation (P0.2: routed to TenantThread via native) ---

  /**
   * Schedule a timeout on the tenant's dedicated thread.
   * Returns a native timer ID for cancellation.
   */
  scheduleTimeout = (callbackId: string, delayMs: number): number => {
    if (this.disposed) {
      throw new Error('[OrchestratorContext] Context has been disposed');
    }
    return this.orchestrator.scheduleTenantTimeout(this.tenantId, callbackId, delayMs);
  };

  /**
   * Schedule an interval on the tenant's dedicated thread.
   * Returns a native timer ID for cancellation.
   */
  scheduleInterval = (callbackId: string, intervalMs: number): number => {
    if (this.disposed) {
      throw new Error('[OrchestratorContext] Context has been disposed');
    }
    return this.orchestrator.scheduleTenantInterval(this.tenantId, callbackId, intervalMs);
  };

  /**
   * Cancel a previously scheduled timer.
   */
  cancelTimer = (timerId: number): void => {
    if (this.disposed) return;
    this.orchestrator.cancelTenantTimer(this.tenantId, timerId);
  };

  // --- Permission / quota queries (P1) ---

  canUseComponent = (name: string): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.canUseComponent(this.tenantId, name);
  };

  canUseAPI = (api: string): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.canUseAPI(this.tenantId, api);
  };

  isOverQuota = (): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.isOverQuota(this.tenantId);
  };

  isNearQuota = (): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.isNearQuota(this.tenantId);
  };

  // --- EventBus delegation (P2) ---

  /** Publish an event to the cross-tenant EventBus. */
  busPublish = (event: BusEventData): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.busPublish({
      ...event,
      sourceTenantId: event.sourceTenantId ?? this.tenantId,
    });
  };

  /** Broadcast a system event to all subscribers on a channel. */
  busBroadcast = (channel: string, name: string, payload: string): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.busBroadcast(channel, name, payload);
  };

  /** Send a unicast event to a specific tenant. */
  busUnicast = (
    targetTenantId: number,
    channel: string,
    name: string,
    payload: string
  ): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.busUnicast(targetTenantId, channel, name, payload);
  };

  /** Send a multicast event to selected tenants. */
  busMulticast = (
    targetTenantIds: number[],
    channel: string,
    name: string,
    payload: string
  ): boolean => {
    if (this.disposed) return false;
    return this.orchestrator.busMulticast(targetTenantIds, channel, name, payload);
  };

  /** Subscribe to events on a channel. Returns subscription ID. */
  busSubscribe = (channel: string, filter: string): number => {
    if (this.disposed) return 0;
    return this.orchestrator.busSubscribe(this.tenantId, channel, filter);
  };

  /** Cancel a subscription. */
  busUnsubscribe = (subscriptionId: number): void => {
    if (this.disposed) return;
    this.orchestrator.busUnsubscribe(subscriptionId);
  };

  /** Cancel all subscriptions for this tenant. */
  busUnsubscribeAll = (): void => {
    if (this.disposed) return;
    this.orchestrator.busUnsubscribeAll(this.tenantId);
  };

  /** Get EventBus statistics. */
  busGetStats = (): EventBusStats => {
    return this.orchestrator.busGetStats();
  };

  /** Create a channel with the given policy. */
  busCreateChannel = (policy: ChannelPolicyConfig): void => {
    if (this.disposed) return;
    this.orchestrator.busCreateChannel(policy);
  };
}

/**
 * A JSEngineRuntime that wraps an Orchestrator-managed tenant.
 * createContext() returns an OrchestratorContext bound to the tenant ID.
 */
class OrchestratorRuntime implements JSEngineRuntime {
  private tenantId: number;
  private orchestrator: RillOrchestratorJSI;
  private disposed = false;

  constructor(tenantId: number, orchestrator: RillOrchestratorJSI) {
    this.tenantId = tenantId;
    this.orchestrator = orchestrator;
  }

  createContext = (): SandboxScope => {
    if (this.disposed) {
      throw new Error('[OrchestratorRuntime] Runtime has been disposed');
    }
    // The native sandbox context was already created by createTenant.
    // We return a TS wrapper that delegates to the per-tenant JSI methods.
    return new OrchestratorContext(this.tenantId, this.orchestrator);
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.orchestrator.destroyTenant(this.tenantId);
  };

  /** Expose tenant ID for Engine-level orchestration (e.g., pause/resume) */
  get id(): number {
    return this.tenantId;
  }

  // --- Timer lifecycle (P0.2) ---

  /** Pause all timers on this tenant's thread. */
  pauseTimers = (): void => {
    if (this.disposed) return;
    this.orchestrator.pauseTenantTimers(this.tenantId);
  };

  /** Resume all timers on this tenant's thread. */
  resumeTimers = (): void => {
    if (this.disposed) return;
    this.orchestrator.resumeTenantTimers(this.tenantId);
  };
}

/**
 * JSEngineProvider that creates tenants via native __RillOrchestrator.
 *
 * Usage:
 * ```typescript
 * const provider = new OrchestratorProvider({
 *   tenantConfig: { appId: 'com.example.app' },
 * });
 * const engine = new Engine({ sandbox: 'orchestrator', orchestrator: { appId: 'com.example' } });
 * ```
 */
export class OrchestratorProvider implements JSEngineProvider {
  private config: OrchestratorTenantConfig;

  constructor(options: OrchestratorProviderOptions) {
    this.config = { ...options.tenantConfig };
    if (options.timeout != null) {
      this.config.timeout = options.timeout;
    }
  }

  createRuntime = (options?: JSEngineRuntimeOptions): JSEngineRuntime => {
    const orchestrator = globalThis.__RillOrchestrator;
    if (!orchestrator) {
      throw new Error(
        '[OrchestratorProvider] __RillOrchestrator not available. ' +
          'Ensure the native module is installed before creating an Engine.'
      );
    }

    // Merge runtime options into tenant config
    const config: OrchestratorTenantConfig = { ...this.config };
    if (options?.timeout != null) {
      config.timeout = options.timeout;
    }
    if (options?.memoryLimit != null) {
      config.quota = { ...config.quota, maxHeapBytes: options.memoryLimit };
    }

    // Create tenant in native layer — synchronous JSI call
    const tenantId = orchestrator.createTenant(config);

    return new OrchestratorRuntime(tenantId, orchestrator);
  };

  /**
   * Check if the native Orchestrator is available in the current runtime.
   */
  static isAvailable(): boolean {
    return typeof globalThis.__RillOrchestrator !== 'undefined';
  }
}
