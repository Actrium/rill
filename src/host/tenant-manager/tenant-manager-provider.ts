/**
 * TenantManagerProvider - JSEngineProvider that delegates to native __RillTenantManager.
 *
 * Instead of creating a sandbox runtime/context directly in TS, this provider
 * creates a "virtual" runtime and context that route all operations through
 * the native C++ TenantManager via JSI.
 *
 * This allows the host Engine to transparently work with either:
 * - Direct sandbox providers (JSC/QuickJS/VM) — existing path
 * - TenantManager-managed tenants — new path (this file)
 *
 * The TenantManager manages the actual sandbox lifecycle in native code,
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
  RillTenantManagerJSI,
  TenantConfig,
} from './types';

/**
 * Options for creating an TenantManagerProvider.
 */
export interface TenantManagerProviderOptions {
  /** Tenant configuration for createTenant */
  tenantConfig: TenantConfig;
  /** Execution timeout (ms), passed to createTenant */
  timeout?: number;
}

/**
 * A SandboxScope that delegates to the native TenantManager's per-tenant API.
 * All eval/inject/extract calls are routed through JSI to the C++ TenantHandle.
 */
class TenantManagerContext implements SandboxScope {
  private tenantId: number;
  private tenantManager: RillTenantManagerJSI;
  private disposed = false;

  constructor(tenantId: number, tenantManager: RillTenantManagerJSI) {
    this.tenantId = tenantId;
    this.tenantManager = tenantManager;
  }

  eval = (code: string): ReviewedUnknown => {
    if (this.disposed) {
      throw new Error('[TenantManagerContext] Context has been disposed');
    }
    return this.tenantManager.evalInTenant(this.tenantId, code);
  };

  inject = (name: string, value: ReviewedUnknown): void => {
    if (this.disposed) return;
    this.tenantManager.setTenantGlobal(this.tenantId, name, value);
  };

  extract = (name: string): ReviewedUnknown => {
    if (this.disposed) return undefined;
    return this.tenantManager.getTenantGlobal(this.tenantId, name);
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    // Context disposal is handled by TenantManager's destroyTenant.
    // We don't call destroyTenant here because the Runtime owns the lifecycle.
  };

  // --- Timer delegation (P0.2: routed to TenantThread via native) ---

  /**
   * Schedule a timeout on the tenant's dedicated thread.
   * Returns a native timer ID for cancellation.
   */
  scheduleTimeout = (callbackId: string, delayMs: number): number => {
    if (this.disposed) {
      throw new Error('[TenantManagerContext] Context has been disposed');
    }
    return this.tenantManager.scheduleTenantTimeout(this.tenantId, callbackId, delayMs);
  };

  /**
   * Schedule an interval on the tenant's dedicated thread.
   * Returns a native timer ID for cancellation.
   */
  scheduleInterval = (callbackId: string, intervalMs: number): number => {
    if (this.disposed) {
      throw new Error('[TenantManagerContext] Context has been disposed');
    }
    return this.tenantManager.scheduleTenantInterval(this.tenantId, callbackId, intervalMs);
  };

  /**
   * Cancel a previously scheduled timer.
   */
  cancelTimer = (timerId: number): void => {
    if (this.disposed) return;
    this.tenantManager.cancelTenantTimer(this.tenantId, timerId);
  };

  // --- Permission / quota queries (P1) ---

  canUseComponent = (name: string): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.canUseComponent(this.tenantId, name);
  };

  canUseAPI = (api: string): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.canUseAPI(this.tenantId, api);
  };

  isOverQuota = (): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.isOverQuota(this.tenantId);
  };

  isNearQuota = (): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.isNearQuota(this.tenantId);
  };

  // --- EventBus delegation (P2) ---

  /** Publish an event to the cross-tenant EventBus. */
  busPublish = (event: BusEventData): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.busPublish({
      ...event,
      sourceTenantId: event.sourceTenantId ?? this.tenantId,
    });
  };

  /** Broadcast a system event to all subscribers on a channel. */
  busBroadcast = (channel: string, name: string, payload: string): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.busBroadcast(channel, name, payload);
  };

  /** Send a unicast event to a specific tenant. */
  busUnicast = (
    targetTenantId: number,
    channel: string,
    name: string,
    payload: string
  ): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.busUnicast(targetTenantId, channel, name, payload);
  };

  /** Send a multicast event to selected tenants. */
  busMulticast = (
    targetTenantIds: number[],
    channel: string,
    name: string,
    payload: string
  ): boolean => {
    if (this.disposed) return false;
    return this.tenantManager.busMulticast(targetTenantIds, channel, name, payload);
  };

  /** Subscribe to events on a channel. Returns subscription ID. */
  busSubscribe = (channel: string, filter: string): number => {
    if (this.disposed) return 0;
    return this.tenantManager.busSubscribe(this.tenantId, channel, filter);
  };

  /** Cancel a subscription. */
  busUnsubscribe = (subscriptionId: number): void => {
    if (this.disposed) return;
    this.tenantManager.busUnsubscribe(subscriptionId);
  };

  /** Cancel all subscriptions for this tenant. */
  busUnsubscribeAll = (): void => {
    if (this.disposed) return;
    this.tenantManager.busUnsubscribeAll(this.tenantId);
  };

  /** Get EventBus statistics. */
  busGetStats = (): EventBusStats => {
    return this.tenantManager.busGetStats();
  };

  /** Create a channel with the given policy. */
  busCreateChannel = (policy: ChannelPolicyConfig): void => {
    if (this.disposed) return;
    this.tenantManager.busCreateChannel(policy);
  };
}

/**
 * A JSEngineRuntime that wraps an TenantManager-managed tenant.
 * createContext() returns an TenantManagerContext bound to the tenant ID.
 */
class TenantManagerRuntime implements JSEngineRuntime {
  private tenantId: number;
  private tenantManager: RillTenantManagerJSI;
  private disposed = false;

  constructor(tenantId: number, tenantManager: RillTenantManagerJSI) {
    this.tenantId = tenantId;
    this.tenantManager = tenantManager;
  }

  createContext = (): SandboxScope => {
    if (this.disposed) {
      throw new Error('[TenantManagerRuntime] Runtime has been disposed');
    }
    // The native sandbox context was already created by createTenant.
    // We return a TS wrapper that delegates to the per-tenant JSI methods.
    return new TenantManagerContext(this.tenantId, this.tenantManager);
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.tenantManager.destroyTenant(this.tenantId);
  };

  /** Expose tenant ID for Engine-level orchestration (e.g., pause/resume) */
  get id(): number {
    return this.tenantId;
  }

  // --- Timer lifecycle (P0.2) ---

  /** Pause all timers on this tenant's thread. */
  pauseTimers = (): void => {
    if (this.disposed) return;
    this.tenantManager.pauseTenantTimers(this.tenantId);
  };

  /** Resume all timers on this tenant's thread. */
  resumeTimers = (): void => {
    if (this.disposed) return;
    this.tenantManager.resumeTenantTimers(this.tenantId);
  };
}

/**
 * JSEngineProvider that creates tenants via native __RillTenantManager.
 *
 * Usage:
 * ```typescript
 * const provider = new TenantManagerProvider({
 *   tenantConfig: { appId: 'com.example.app' },
 * });
 * const engine = new Engine({ sandbox: 'tenant-manager', tenant: { appId: 'com.example' } });
 * ```
 */
export class TenantManagerProvider implements JSEngineProvider {
  private config: TenantConfig;

  constructor(options: TenantManagerProviderOptions) {
    this.config = { ...options.tenantConfig };
    if (options.timeout != null) {
      this.config.timeout = options.timeout;
    }
  }

  createRuntime = (options?: JSEngineRuntimeOptions): JSEngineRuntime => {
    const tenantManager = globalThis.__RillTenantManager;
    if (!tenantManager) {
      throw new Error(
        '[TenantManagerProvider] __RillTenantManager not available. ' +
          'Ensure the native module is installed before creating an Engine.'
      );
    }

    // Merge runtime options into tenant config
    const config: TenantConfig = { ...this.config };
    if (options?.timeout != null) {
      config.timeout = options.timeout;
    }
    if (options?.memoryLimit != null) {
      config.quota = { ...config.quota, maxHeapBytes: options.memoryLimit };
    }

    // Create tenant in native layer — synchronous JSI call
    const tenantId = tenantManager.createTenant(config);

    return new TenantManagerRuntime(tenantId, tenantManager);
  };

  /**
   * Check if the native TenantManager is available in the current runtime.
   */
  static isAvailable(): boolean {
    return typeof globalThis.__RillTenantManager !== 'undefined';
  }
}
