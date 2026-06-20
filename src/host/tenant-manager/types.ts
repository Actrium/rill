/**
 * TypeScript type definitions for the native __RillTenantManager HostObject.
 *
 * This HostObject is installed by the C++ RillTenantManager on the Host JS runtime
 * via JSI. It provides multi-tenant sandbox lifecycle management.
 */

import type { ReviewedUnknown } from '../types';

/**
 * Tenant configuration passed to createTenant.
 */
export interface TenantConfig {
  appId: string;
  debug?: boolean;
  timeout?: number;
  quota?: {
    /** Preferred: heap budget in bytes (maps to native ResourceQuota.maxHeapBytes). */
    maxHeapBytes?: number;
    /** @deprecated Use maxHeapBytes. Kept for backward compatibility. */
    maxMemoryBytes?: number;
    maxTimers?: number;
    maxCallbacks?: number;
  };
  /** API whitelist — empty = allow all */
  apis?: string[];
}

/**
 * Tenant info returned by getTenantInfo.
 */
export interface TenantInfo {
  id: number;
  appId: string;
  state: number;
  disposed: boolean;
  quota: {
    activeTimers: number;
    maxTimers: number;
    activeCallbacks: number;
    maxCallbacks: number;
    currentHeapBytes: number;
    maxHeapBytes: number;
  };
  violations: {
    componentDenied: number;
    apiDenied: number;
    quotaExceeded: number;
  };
  overQuota: boolean;
  nearQuota: boolean;
}

/**
 * Metrics returned by getMetrics.
 */
export interface TenantManagerMetrics {
  totalTenants: number;
  registryTotal: number;
  registryActive: number;
  running: number;
  paused: number;
  error: number;
  activeThreads: number;
}

/**
 * Host callbacks from native → Host JS.
 */
export interface TenantManagerHostCallbacks {
  onBatch?: (tenantId: number, batch: ReviewedUnknown) => void;
  onEvent?: (tenantId: number, name: string, payload: ReviewedUnknown) => void;
  onError?: (tenantId: number, message: string) => void;
  onLog?: (tenantId: number, level: string, message: string) => void;
  onTimer?: (tenantId: number, callbackId: string) => void;
}

/**
 * The native __RillTenantManager HostObject interface.
 * Installed as `globalThis.__RillTenantManager` when the native module is loaded.
 */
export interface RillTenantManagerJSI {
  // --- Tenant lifecycle ---
  createTenant(config: TenantConfig): number;
  destroyTenant(tenantId: number): void;
  pauseTenant(tenantId: number): void;
  resumeTenant(tenantId: number): void;

  // --- Code loading ---
  loadBundle(tenantId: number, code: string): void;

  // --- Communication ---
  sendEvent(tenantId: number, name: string, payload?: ReviewedUnknown): void;
  broadcast(name: string, payload?: ReviewedUnknown): void;

  // --- Host callbacks ---
  setHostCallbacks(callbacks: TenantManagerHostCallbacks): void;

  // --- Metrics ---
  getTenantInfo(tenantId: number): TenantInfo;
  getMetrics(): TenantManagerMetrics;

  // --- Per-tenant context operations (Engine delegation) ---
  evalInTenant(tenantId: number, code: string): ReviewedUnknown;
  setTenantGlobal(tenantId: number, name: string, value: ReviewedUnknown): void;
  getTenantGlobal(tenantId: number, name: string): ReviewedUnknown;

  // --- Per-tenant timer operations (P0.2: managed by TenantThread) ---
  scheduleTenantTimeout(tenantId: number, callbackId: string, delayMs: number): number;
  scheduleTenantInterval(tenantId: number, callbackId: string, intervalMs: number): number;
  cancelTenantTimer(tenantId: number, timerId: number): void;
  pauseTenantTimers(tenantId: number): void;
  resumeTenantTimers(tenantId: number): void;

  // --- Permission / quota queries (P1) ---
  canUseComponent(tenantId: number, componentName: string): boolean;
  canUseAPI(tenantId: number, apiName: string): boolean;
  isOverQuota(tenantId: number): boolean;
  isNearQuota(tenantId: number): boolean;

  // --- EventBus operations (P2) ---
  busPublish(event: BusEventData): boolean;
  busBroadcast(channel: string, name: string, payload: string): boolean;
  busUnicast(targetTenantId: number, channel: string, name: string, payload: string): boolean;
  busMulticast(targetTenantIds: number[], channel: string, name: string, payload: string): boolean;
  busSubscribe(tenantId: number, channel: string, filter: string): number;
  busUnsubscribe(subscriptionId: number): void;
  busUnsubscribeAll(tenantId: number): void;
  busGetStats(): EventBusStats;
  busCreateChannel(policy: ChannelPolicyConfig): void;
}

// --- EventBus types (P2) ---

/**
 * Event priority levels matching native EventPriority enum.
 */
export enum EventPriority {
  Critical = 0,
  High = 1,
  Normal = 2,
  Low = 3,
}

/**
 * A cross-tenant bus event.
 */
export interface BusEventData {
  channel: string;
  name: string;
  payload: string; // JSON-serialized
  priority?: EventPriority;
  sourceTenantId?: number; // 0 = system event
}

/**
 * Channel policy for EventBus.createChannel.
 */
export interface ChannelPolicyConfig {
  name: string;
  systemOnly?: boolean;
  requirePermission?: boolean;
  maxSubscribers?: number;
  maxEventsPerSecond?: number;
  maxPayloadBytes?: number;
  persistent?: boolean;
}

/**
 * EventBus statistics.
 */
export interface EventBusStats {
  totalPublished: number;
  totalDelivered: number;
  totalDropped: number;
  activeSubscriptions: number;
  activeChannels: number;
}

/**
 * Augment globalThis to include __RillTenantManager.
 */
declare global {
  // eslint-disable-next-line no-var
  var __RillTenantManager: RillTenantManagerJSI | undefined;
}
