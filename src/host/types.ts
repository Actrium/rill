/**
 * Rill Core Type Definitions
 *
 *  bridge/types.ts
 *
 */

// ============================================
//  Bridge
// ============================================

export type {
  AppendOperation,
  BaseOperation,
  // Bridge
  BridgeValue,
  BridgeValueObject,
  //
  CallbackRegistry,
  CallFunctionMessage,
  ConfigUpdateMessage,
  CreateOperation,
  DeleteOperation,
  DestroyMessage,
  HostEventMessage,
  HostMessage,
  InsertOperation,
  Operation,
  OperationBatch,
  //
  OperationType,
  RefCallOperation,
  RefMethodResultMessage,
  RemoveOperation,
  ReorderOperation,
  //
  SendToHost,
  SerializedCreateOperation,
  SerializedError,
  SerializedFunction,
  SerializedHostMessage,
  SerializedOperation,
  SerializedOperationBatch,
  SerializedProps,
  SerializedRefCallOperation,
  SerializedUpdateOperation,
  //
  SerializedValue,
  TextOperation,
  UpdateOperation,
} from '../shared';
export { HostMsg, isSerializedFunction, operationHasProps } from '../shared';

// Import for local use in this file
import type { BridgeValueObject as _BridgeValueObject } from '../shared';

// Re-declare for local use (TypeScript limitation with export type)
type LocalBridgeValueObject = _BridgeValueObject;

// ============================================
// Type Safety
// ============================================

/**
 * Reviewed Unknown Type
 *
 * Use of `unknown` requires explicit approval through this type alias.
 * Direct usage of `unknown` will be flagged by the check:unknown script.
 *
 * Valid scenarios for ReviewedUnknown:
 * 1. JSON.parse returns - validated with type guards afterward
 * 2. Third-party library requirements (e.g., React Reconciler HostConfig)
 * 3. Error handling (catch blocks) - use `catch (error: unknown)` directly
 * 4. Callback function arguments where signature is truly dynamic
 *
 * Invalid scenarios (use specific types instead):
 * - Known data structures -> Define interface
 * - Constrained value types -> Define union type
 * - Need runtime checking -> Add type guard function
 */
export type ReviewedUnknown = unknown;

// ============================================
// Property Types (Runtime Internal)
// ============================================

/**
 * Valid prop value types that can be serialized across boundaries
 * More type-safe than `unknown` - explicitly defines allowed types
 */
export type PropValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | PropValue[]
  | { [key: string]: PropValue }
  | ((...args: unknown[]) => unknown) // Callback functions
  | Date // Will be serialized to string
  | RegExp // Will be serialized to {source, flags}
  | Error // Will be serialized to {name, message, stack}
  | Map<PropValue, PropValue> // Will be serialized to entries array
  | Set<PropValue>; // Will be serialized to values array

// ============================================
// Virtual Node Types (Runtime Internal)
// ============================================

/**
 * Valid prop value types for VNode
 * Constrains what can be passed as props (more type-safe than `unknown`)
 */
export type VNodePropValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | VNodePropValue[]
  | { [key: string]: VNodePropValue }
  | ((...args: unknown[]) => unknown);

/**
 * Virtual node (internal representation)
 */
export interface VNode {
  id: number;
  type: string;
  props: Record<string, VNodePropValue>;
  children: VNode[];
  parent: VNode | null;
  /** Registered callback function IDs for cleanup */
  registeredFnIds?: Set<string>;
}

/**
 * Node instance (host side)
 * Uses BridgeValueObject for props since operations are decoded by Bridge
 */
export interface NodeInstance {
  id: number;
  type: string;
  props: LocalBridgeValueObject;
  children: number[];
  /** Registered callback function IDs for cleanup (Host side) */
  registeredFnIds?: Set<string>;
}

// ============================================
// Style Types (from shared style-types.ts)
// ============================================

export type {
  FlexAlign,
  FlexDirection,
  FlexJustify,
  ImageSource,
  LayoutEvent,
  ScrollEvent,
  StyleObject,
  StyleProp,
} from '../shared/style-types';

