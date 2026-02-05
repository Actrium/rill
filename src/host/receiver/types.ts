/**
 * Receiver Type Definitions
 *
 * Types and interfaces for the instruction receiver.
 */

import type { CallbackRegistry, HostMessage } from '../types';

// ============================================
// Global Debug Declarations
// ============================================

declare global {
  // Note: Previously we stored APPEND/TouchableOpacity/function debug tracking
  // in globalThis.__APPEND_*, __TOUCHABLE_*, __RECEIVER_FUNCTION_*, __LAST_FUNCTION_*.
  // These have been removed to avoid leaking memory and polluting host globals.
  // eslint-disable-next-line no-var
  var __RECEIVER_APPEND_CALLS: never;
  // eslint-disable-next-line no-var
  var __APPEND_PARENT_IDS: never;
  // eslint-disable-next-line no-var
  var __APPEND_DETAILS: never;
}

// ============================================
// Utility
// ============================================

/**
 * Polyfill queueMicrotask if not available
 */
export const safeQueueMicrotask =
  typeof queueMicrotask !== 'undefined'
    ? queueMicrotask
    : (callback: () => void) => Promise.resolve().then(callback);

// ============================================
// Core Types
// ============================================

/**
 * Message send function type
 */
export type SendToSandbox = (message: HostMessage) => void | Promise<void>;

/**
 * Receiver only needs CallbackRegistry's release method
 */
export type ReceiverCallbackRegistry = Pick<CallbackRegistry, 'release'>;

// ============================================
// Options
// ============================================

export interface ReceiverOptions {
  onMetric?: (name: string, value: number, extra?: Record<string, unknown>) => void;
  maxBatchSize?: number;
  debug?: boolean;
  /**
   * Callback registry for function cleanup
   * @deprecated Use releaseCallback instead for proper Guest/Host routing
   */
  callbackRegistry?: ReceiverCallbackRegistry;
  /**
   * Function to release callbacks - routes to Host or Guest registry as appropriate
   * Takes priority over callbackRegistry if both are provided
   */
  releaseCallback?: (fnId: string) => void;
  /**
   * Attribution window (aggregate recent N seconds) for trend attribution ("who/why consuming").
   * @default 5000
   */
  attributionWindowMs?: number;
  /**
   * Attribution history retention (ms), older entries are discarded.
   * @default 60000
   */
  attributionHistoryMs?: number;
  /**
   * Maximum attribution history samples (batch count), for memory limit fallback.
   * @default 200
   */
  attributionMaxSamples?: number;
}

// ============================================
// Statistics Types
// ============================================

export interface ReceiverApplyStats {
  batchId?: number;
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  at: number;
  durationMs: number;

  /**
   * Node count change before/after batch (for "who is growing")
   */
  nodesBefore: number;
  nodesAfter: number;
  nodeDelta: number;

  /**
   * Operation distribution for this batch (applied only)
   */
  opCounts: Record<string, number>;

  /**
   * Skipped operation distribution (only when backpressure/limit triggered)
   */
  skippedOpCounts: Record<string, number>;

  /**
   * Top N node types touched in this batch (for attribution)
   */
  topNodeTypes: Array<{ type: string; ops: number }>;
  topNodeTypesSkipped: Array<{ type: string; ops: number }>;
}

export interface ReceiverStats {
  nodeCount: number;
  rootChildrenCount: number;
  renderCount: number;
  lastRenderAt: number | null;
  lastRenderDurationMs: number | null;
  totalBatches: number;
  totalOps: {
    received: number;
    applied: number;
    skipped: number;
    failed: number;
  };
  lastApply: ReceiverApplyStats | null;
  attribution: ReceiverAttributionWindow | null;
}

export type ReceiverAttributionWorstKind = 'largest' | 'slowest' | 'mostSkipped' | 'mostGrowth';

export interface ReceiverAttributionWorstBatch {
  kind: ReceiverAttributionWorstKind;
  batchId?: number;
  at: number;
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  durationMs: number;
  nodeDelta: number;
}

export interface ReceiverAttributionWindow {
  /**
   * Time window covered by this aggregation (ms)
   */
  windowMs: number;
  /**
   * Number of batch samples within the window
   */
  sampleCount: number;
  /**
   * Total ops in window (received)
   */
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  /**
   * Sum of applyBatch duration within window (ms)
   */
  durationMs: number;
  /**
   * Sum of node delta within window (rough indicator of tree growing/shrinking)
   */
  nodeDelta: number;
  /**
   * Operation distribution within window (applied aggregation)
   */
  opCounts: Record<string, number>;
  /**
   * Skipped operation distribution within window (skipped aggregation)
   */
  skippedOpCounts: Record<string, number>;
  /**
   * Top N node types touched within window (applied aggregation)
   */
  topNodeTypes: Array<{ type: string; ops: number }>;
  /**
   * Top N node types touched within window (skipped aggregation)
   */
  topNodeTypesSkipped: Array<{ type: string; ops: number }>;
  /**
   * Worst batch samples within window (for quick identification of "large/slow/skip surge/node growth")
   */
  worstBatches: ReceiverAttributionWorstBatch[];
}

/**
 * Internal apply sample for attribution tracking
 */
export interface ReceiverApplySample extends ReceiverApplyStats {
  // Inherits all ReceiverApplyStats fields
}
