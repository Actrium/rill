/**
 * Engine Types and Interfaces
 */

import type { RuntimeCollectorConfig } from '../../devtools/runtime';
import type { OrchestratorTenantConfig } from '../orchestrator/types';
import type { Receiver, ReceiverStats } from '../receiver';
import type { ComponentMap, ComponentRegistry } from '../registry';
import type { BridgeValueObject, OperationBatch } from '../types';

/**
 * Engine configuration options
 */
export interface EngineOptions {
  /**
   * Explicitly select a sandbox mode.
   * - `vm`: (Default on Node/Bun) Uses Node's `vm` module for a secure, native sandbox.
   * - `jsc`: Uses JavaScriptCore via JSI (Apple platforms only).
   * - `quickjs`: Uses QuickJS via JSI (cross-platform native).
   * - `wasm-quickjs`: Uses QuickJS via WASM (cross-platform, web-compatible).
   * - `none`: Runs code directly in the host context via `eval`. Insecure, but fast and easy to debug.
   * If not set, the best available provider for the environment is chosen automatically.
   */
  sandbox?: 'vm' | 'jsc' | 'hermes' | 'quickjs' | 'wasm-quickjs' | 'orchestrator' | 'none';

  /**
   * Orchestrator tenant configuration.
   * Required when sandbox='orchestrator' or when __RillOrchestrator is auto-detected.
   * At minimum, `appId` must be provided.
   */
  orchestrator?: OrchestratorTenantConfig;

  /**
   * Execution timeout (milliseconds)
   * @default 5000
   */
  timeout?: number;

  /**
   * Enable debug mode
   * @default false
   */
  debug?: boolean;

  /**
   * Custom logger
   */
  logger?: {
    // Reason: Logger methods accept arbitrary console arguments
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };

  /**
   * Allowed modules for sandbox require()
   * If not provided, a safe default whitelist will be used
   */
  requireWhitelist?: readonly string[];

  /**
   * Performance metrics reporter hook
   * Called with metric name and duration in ms
   */
  onMetric?: (name: string, value: number, extra?: Record<string, unknown>) => void;

  /**
   * Maximum operations per batch applied by Receiver
   * Excess operations are skipped to protect host performance
   * @default 5000
   */
  receiverMaxBatchSize?: number;

  /**
   * Diagnostics parameters (for Host-side Task Manager/Resource Monitor)
   */
  diagnostics?: {
    /**
     * Stats window (ms) for calculating ops/s and batch/s
     * @default 5000
     */
    activityWindowMs?: number;
    /**
     * Activity sample retention duration (ms), for timeline aggregation
     * @default 60000
     */
    activityHistoryMs?: number;
    /**
     * Timeline bucket width (ms)
     * @default 2000
     */
    activityBucketMs?: number;
  };

  /**
   * DevTools configuration
   * - true: Enable with default settings
   * - false/undefined: Disable (default)
   * - RuntimeCollectorConfig: Enable with custom settings
   */
  devtools?: boolean | RuntimeCollectorConfig;
}

/**
 * Message from guest to host
 */
export interface GuestMessage {
  event: string;
  // Reason: Event payload can be any serializable type
  payload: unknown;
}

/**
 * DevTools console entry (from Guest)
 */
export interface DevToolsConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  // Reason: console.log/error/etc accept arbitrary arguments
  args: unknown[];
  timestamp: number;
  stack?: string;
}

/**
 * DevTools error entry (from Guest)
 */
export interface DevToolsError {
  message: string;
  stack?: string;
  timestamp: number;
  fatal: boolean;
}

/**
 * Engine event types
 */
export interface EngineEvents {
  load: () => void;
  error: (error: Error) => void;
  destroy: () => void;
  operation: (batch: OperationBatch) => void;
  message: (message: GuestMessage) => void;
  /**
   * Fatal error event - emitted when the engine encounters an unrecoverable error
   * such as execution timeout. The engine will be automatically destroyed after this event.
   */
  fatalError: (error: Error) => void;
  /**
   * Emitted when engine is paused
   */
  pause: () => void;
  /**
   * Emitted when engine is resumed
   */
  resume: () => void;
  /**
   * Emitted when the Receiver finishes applying a batch and the UI tree has changed.
   * Subscribe to this event instead of passing a callback to createReceiver().
   */
  update: () => void;
  /**
   * DevTools: Console log from Guest sandbox
   */
  devtoolsConsole: (entry: DevToolsConsoleEntry) => void;
  /**
   * DevTools: Error from Guest sandbox
   */
  devtoolsError: (error: DevToolsError) => void;
  /**
   * DevTools: Guest devtools is ready
   */
  devtoolsReady: (data: Record<string, unknown>) => void;
}

/**
 * Health snapshot for observability
 */
export interface EngineHealth {
  loaded: boolean;
  destroyed: boolean;
  errorCount: number;
  lastErrorAt: number | null;
  receiverNodes: number;
  batching: boolean;
}

/**
 * Resource statistics for monitoring
 */
export interface ResourceStats {
  timers: number;
  nodes: number;
  callbacks: number;
}

export interface EngineActivityStats {
  /**
   * Stats window (ms), used for calculating ops/s and batch/s
   */
  windowMs: number;
  /**
   * ops/s within recent window
   */
  opsPerSecond: number;
  /**
   * batch/s within recent window
   */
  batchesPerSecond: number;
  /**
   * Total batches received
   */
  totalBatches: number;
  /**
   * Total ops received (by batch.operations.length)
   */
  totalOps: number;
  /**
   * Last batch info
   */
  lastBatch: {
    batchId: number;
    at: number;
    totalOps: number;
    applyDurationMs: number | null;
  } | null;

  /**
   * Activity timeline (for Host-side trend charts/attribution hints)
   * - points are fixed-width bucket aggregations (ops/batch/skip/apply duration)
   * - suitable for sparkline / bar chart
   */
  timeline?: EngineActivityTimeline;
}

export interface EngineActivityTimelinePoint {
  /**
   * Bucket end timestamp (ms)
   */
  at: number;
  /**
   * Total ops in bucket
   */
  ops: number;
  /**
   * Batch count in bucket
   */
  batches: number;
  /**
   * Ops skipped by Receiver in bucket (backpressure signal)
   */
  skippedOps: number;
  /**
   * Average applyBatch duration in bucket (ms), null if no samples
   */
  applyDurationMsAvg: number | null;
  /**
   * Max applyBatch duration in bucket (ms), null if no samples
   */
  applyDurationMsMax: number | null;
}

export interface EngineActivityTimeline {
  /**
   * Timeline coverage window (ms)
   */
  windowMs: number;
  /**
   * Single time bucket width (ms)
   */
  bucketMs: number;
  /**
   * Buckets sorted from oldest to newest
   */
  points: EngineActivityTimelinePoint[];
}

/**
 * Engine diagnostics snapshot (for Host-side "Task Manager/Resource Monitor")
 */
export interface EngineDiagnostics {
  id: string;
  health: EngineHealth;
  resources: ResourceStats;
  activity: EngineActivityStats;
  receiver: ReceiverStats | null;
  host: {
    lastEventName: string | null;
    lastEventAt: number | null;
    lastPayloadBytes: number | null;
  };
  guest: {
    lastEventName: string | null;
    lastEventAt: number | null;
    lastPayloadBytes: number | null;
    sleeping: boolean | null;
    sleepingAt: number | null;
  };
}

/**
 * Optional load settings for engine.loadBundle().
 */
export interface LoadBundleOptions {
  /**
   * Optional Hermes bytecode asset path (.hbc).
   * When supported by the active sandbox context, Engine will execute this
   * bytecode instead of source text for the final guest bundle eval.
   */
  bytecodeAssetPath?: string;
}

/**
 * Common engine interface
 */
export interface IEngine {
  /**
   * Unique engine identifier
   */
  readonly id: string;

  /**
   * Register custom components
   */
  register(components: ComponentMap): void;

  /**
   * Load and execute Guest code.
   *
   * Always returns a Promise that resolves when the bundle has been loaded
   * and executed. For sync providers the work completes before the Promise
   * settles, so callers can simply `await engine.loadBundle(...)`.
   */
  loadBundle(
    source: string,
    initialProps?: Record<string, unknown>,
    options?: LoadBundleOptions
  ): Promise<void>;

  /**
   * Subscribe to engine events
   * @returns Unsubscribe function
   */
  on<K extends keyof EngineEvents>(
    event: K,
    listener: EngineEvents[K] extends () => void
      ? () => void
      : (data: Parameters<EngineEvents[K]>[0]) => void
  ): () => void;

  /**
   * Send event to sandbox guest
   */
  // Reason: Event payload can be any serializable type
  sendEvent(eventName: string, payload?: unknown): void;

  /**
   * Update configuration
   */
  updateConfig(config: BridgeValueObject): void;

  /**
   * Create Receiver for rendering.
   * Listen for 'update' events via engine.on('update', ...) to know when to re-render.
   */
  createReceiver(): Receiver;

  /**
   * Get current Receiver
   */
  getReceiver(): Receiver | null;

  /**
   * Get component registry
   */
  getRegistry(): ComponentRegistry;

  /**
   * Check if bundle is loaded
   */
  readonly isLoaded: boolean;

  /**
   * Check if engine is destroyed
   */
  readonly isDestroyed: boolean;

  /**
   * Check if engine is paused
   */
  readonly isPaused: boolean;

  /**
   * Pause the engine - freeze timers and queue incoming events
   * Timer clocks are frozen (not just callbacks blocked)
   */
  pause(): void;

  /**
   * Resume the engine - unfreeze timers and flush queued events
   * Timers continue from where they left off
   */
  resume(): void;

  /**
   * Get diagnostic snapshot (health, resources, activity, receiver stats).
   * Single entry point for all observability data.
   */
  getDiagnostics(): EngineDiagnostics;

  /**
   * Set maximum number of listeners per event before warning
   * @param n - Maximum listener count (default: 10)
   */
  setMaxListeners(n: number): void;

  /**
   * Get current maximum listener threshold
   */
  getMaxListeners(): number;

  /**
   * Destroy engine and release resources
   */
  destroy(): void;
}

/**
 * Event listener type
 */
export type EventListener<T> = (data: T) => void;

/**
 * Error types for better classification
 */
export class RequireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequireError';
  }
}

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
