/**
 * Receiver Module
 *
 * Exports receiver types, utilities, and main Receiver class.
 */

// Main Receiver class
export { Receiver } from './receiver';
// Re-export stats tracker
export { AttributionTracker } from './stats';
// Re-export types
export type {
  ReceiverApplySample,
  ReceiverApplyStats,
  ReceiverAttributionWindow,
  ReceiverAttributionWorstBatch,
  ReceiverAttributionWorstKind,
  ReceiverCallbackRegistry,
  ReceiverOptions,
  ReceiverStats,
  SendToSandbox,
} from './types';
// Re-export utilities
export { safeQueueMicrotask } from './types';
