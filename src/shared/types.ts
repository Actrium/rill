/**
 * @rill/bridge - Protocol Type System
 *
 *  JSI
 * - JSI ：，
 * -  Bridge ：/
 *
 *  Host ↔ Guest
 */

// ============================================
// Type Safety
// ============================================

/**
 * Reviewed Unknown Type
 *
 * Use of `unknown` is allowed only when it's explicit and intentional.
 * Prefer specific types when possible; otherwise use ReviewedUnknown and validate at runtime.
 */
export type ReviewedUnknown = unknown;

// ============================================
// JSI （，）
// ============================================

/**
 * JSI
 */
export type JSIPrimitive = null | undefined | boolean | number | string;

/**
 * JSI  -
 */
export type JSISafe = JSIPrimitive | JSISafeArray | JSISafeObject;

/**
 * JSI
 */
export interface JSISafeArray extends Array<JSISafe> {}

/**
 * JSI
 */
export interface JSISafeObject {
  [key: string]: JSISafe;
}

// ============================================
//  Bridge （JSI ）
// ============================================

/**
 *
 */
export type RequiresBridge =
  // biome-ignore lint/complexity/noBannedTypes: Generic function type for serialization
  Function | Date | RegExp | Error | Map<BridgeValue, BridgeValue> | Set<BridgeValue>;

// ============================================
// Bridge
// ============================================

/**
 * Bridge
 */
export type BridgeValue = JSIPrimitive | RequiresBridge | BridgeValueArray | BridgeValueObject;

/**
 * Bridge
 */
export interface BridgeValueArray extends Array<BridgeValue> {}

/**
 * Bridge
 */
export interface BridgeValueObject {
  [key: string]: BridgeValue;
}

// ============================================
//
// ============================================

/**
 *
 */
export interface SerializedFunction {
  __type: 'function';
  __fnId: string;
  __name?: string; // Original function name for DevTools
  __sourceFile?: string; // Original source file path (from Babel plugin)
  __sourceLine?: number; // Original source line number (from Babel plugin)
}

/**
 *
 */
export interface SerializedDate {
  __type: 'date';
  __value: string; // ISO 8601
}

/**
 *
 */
export interface SerializedRegExp {
  __type: 'regexp';
  __source: string;
  __flags: string;
}

/**
 *
 */
export interface SerializedError {
  __type: 'error';
  __name: string;
  __message: string;
  __stack?: string;
}

/**
 *  Map
 */
export interface SerializedMap {
  __type: 'map';
  __entries: [SerializedValue, SerializedValue][];
}

/**
 *  Set
 */
export interface SerializedSet {
  __type: 'set';
  __values: SerializedValue[];
}

/**
 *  Promise
 * Promise  ID ， promise:settle
 */
export interface SerializedPromise {
  __type: 'promise';
  __promiseId: string;
}

/**
 *
 */
export type SerializedSpecialType =
  | SerializedFunction
  | SerializedDate
  | SerializedRegExp
  | SerializedError
  | SerializedMap
  | SerializedSet
  | SerializedPromise;

/**
 *  - JSI
 */
export type SerializedValue =
  | JSIPrimitive
  | SerializedSpecialType
  | SerializedValueArray
  | SerializedValueObject;

/**
 *
 */
export interface SerializedValueArray extends Array<SerializedValue> {}

/**
 *
 */
export interface SerializedValueObject {
  [key: string]: SerializedValue;
}

// ============================================
//  (Guest → Host)
// ============================================

/**
 *
 */
export const OPERATION_TYPES = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'APPEND',
  'INSERT',
  'REMOVE',
  'REORDER',
  'TEXT',
  'REF_CALL',
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

/**
 *
 */
export interface BaseOperation {
  op: OperationType;
  id: number;
  timestamp?: number;
}

export interface CreateOperation extends BaseOperation {
  op: 'CREATE';
  type: string;
  props: BridgeValueObject;
}

export interface UpdateOperation extends BaseOperation {
  op: 'UPDATE';
  props: BridgeValueObject;
  removedProps?: string[];
}

export interface DeleteOperation extends BaseOperation {
  op: 'DELETE';
}

export interface AppendOperation extends BaseOperation {
  op: 'APPEND';
  parentId: number;
  childId: number;
}

export interface InsertOperation extends BaseOperation {
  op: 'INSERT';
  parentId: number;
  childId: number;
  index: number;
}

export interface RemoveOperation extends BaseOperation {
  op: 'REMOVE';
  parentId: number;
  childId: number;
}

export interface ReorderOperation extends BaseOperation {
  op: 'REORDER';
  parentId: number;
  childIds: number[];
}

export interface TextOperation extends BaseOperation {
  op: 'TEXT';
  text: string;
}

/**
 * Remote Ref
 * Guest  Host （ focus, blur, scrollTo）
 */
export interface RefCallOperation extends BaseOperation {
  op: 'REF_CALL';
  refId: number; //  ID（ nodeMap  id ）
  method: string; // ：focus, blur, measure, scrollTo
  args: BridgeValue[]; //
  callId: string; // （ Promise ）
}

/**
 *  REF_CALL
 */
export interface SerializedRefCallOperation extends BaseOperation {
  op: 'REF_CALL';
  refId: number;
  method: string;
  args: SerializedValue[];
  callId: string;
}

/**
 *  - Discriminated Union
 */
export type Operation =
  | CreateOperation
  | UpdateOperation
  | DeleteOperation
  | AppendOperation
  | InsertOperation
  | RemoveOperation
  | ReorderOperation
  | TextOperation
  | RefCallOperation;

/**
 *
 */
export interface OperationBatch {
  version: number;
  batchId: number;
  operations: Operation[];
}

/**
 *
 */
export interface SerializedOperationBatch {
  version: number;
  batchId: number;
  operations: SerializedOperation[];
}

/**
 *  CREATE
 */
export interface SerializedCreateOperation extends BaseOperation {
  op: 'CREATE';
  type: string;
  props: SerializedValueObject;
}

/**
 *  UPDATE
 */
export interface SerializedUpdateOperation extends BaseOperation {
  op: 'UPDATE';
  props: SerializedValueObject;
  removedProps?: string[];
}

/**
 *  - props  SerializedValueObject
 */
export type SerializedOperation =
  | SerializedCreateOperation
  | SerializedUpdateOperation
  | DeleteOperation
  | AppendOperation
  | InsertOperation
  | RemoveOperation
  | ReorderOperation
  | TextOperation
  | SerializedRefCallOperation;

/**
 *  props
 */
export function operationHasProps(
  op: Operation | SerializedOperation
): op is CreateOperation | UpdateOperation | SerializedCreateOperation | SerializedUpdateOperation {
  return op.op === 'CREATE' || op.op === 'UPDATE';
}

// ============================================
//  (Host → Guest)
// ============================================

export enum HostMsg {
  CALL_FUNCTION = 'CALL_FUNCTION',
  HOST_EVENT = 'HOST_EVENT',
  CONFIG_UPDATE = 'CONFIG_UPDATE',
  DESTROY = 'DESTROY',
  PROMISE_RESOLVE = 'PROMISE_RESOLVE',
  PROMISE_REJECT = 'PROMISE_REJECT',
  REF_METHOD_RESULT = 'REF_METHOD_RESULT',
}

export interface CallFunctionMessage {
  type: HostMsg.CALL_FUNCTION;
  fnId: string;
  args: BridgeValue[];
}

export interface HostEventMessage {
  type: HostMsg.HOST_EVENT;
  eventName: string;
  payload: BridgeValue;
}

export interface ConfigUpdateMessage {
  type: HostMsg.CONFIG_UPDATE;
  config: BridgeValueObject;
}

export interface DestroyMessage {
  type: HostMsg.DESTROY;
}

/**
 * Remote Ref
 * Host  Guest
 */
export interface RefMethodResultMessage {
  type: HostMsg.REF_METHOD_RESULT;
  refId: number; //  ID
  callId: string; // （ REF_CALL ）
  result?: BridgeValue; //
  error?: SerializedError; //
}

/**
 * Host → Guest
 */
export type HostMessage =
  | CallFunctionMessage
  | HostEventMessage
  | ConfigUpdateMessage
  | DestroyMessage
  | PromiseSettleMessage
  | RefMethodResultMessage;

/**
 * Promise  -  Promise
 */
export type PromiseSettleMessage =
  | { type: HostMsg.PROMISE_RESOLVE; promiseId: string; value: BridgeValue }
  | { type: HostMsg.PROMISE_REJECT; promiseId: string; error: SerializedError };

/**
 *  REF_METHOD_RESULT
 */
export interface SerializedRefMethodResultMessage {
  type: HostMsg.REF_METHOD_RESULT;
  refId: number;
  callId: string;
  result?: SerializedValue;
  error?: SerializedError;
}

export type SerializedHostMessage =
  | { type: HostMsg.CALL_FUNCTION; fnId: string; args: SerializedValue[] }
  | { type: HostMsg.HOST_EVENT; eventName: string; payload: SerializedValue }
  | { type: HostMsg.CONFIG_UPDATE; config: SerializedValueObject }
  | { type: HostMsg.DESTROY }
  | SerializedPromiseSettleMessage
  | SerializedRefMethodResultMessage;

/**
 *  Promise
 */
export type SerializedPromiseSettleMessage =
  | { type: HostMsg.PROMISE_RESOLVE; promiseId: string; value: SerializedValue }
  | { type: HostMsg.PROMISE_REJECT; promiseId: string; error: SerializedError };

// ============================================
// Callback Registry
// ============================================

/**
 * Callback Registry -
 *
 * Note: Uses ReviewedUnknown for flexibility with existing implementations.
 * The actual serialization/deserialization is handled by Bridge.
 */
export interface CallbackRegistry {
  /**
   * ， fnId
   */
  register(fn: (...args: ReviewedUnknown[]) => ReviewedUnknown): string;

  /**
   *  fnId
   */
  invoke(fnId: string, args: ReviewedUnknown[]): ReviewedUnknown;

  /**
   *  fnId
   */
  has(fnId: string): boolean;

  /**
   *  fnId
   */
  remove(fnId: string): void;

  /**
   *
   */
  clear(): void;

  /**
   *
   */
  retain(fnId: string): void;

  /**
   * ，
   */
  release(fnId: string): void;

  /**
   *
   */
  getRefCount(fnId: string): number;

  /**
   *  Map（ globalThis.__rill.callbacks）
   */
  getMap(): Map<string, (...args: ReviewedUnknown[]) => ReviewedUnknown>;

  /**
   *
   */
  readonly size: number;
}

// ============================================
//
// ============================================

/**
 *  props
 */
export type SerializedProps = SerializedValueObject;

/**
 * Send operations from Guest to Host.
 * The batch format depends on the provider:
 * - VM: OperationBatch (raw, same runtime)
 * - WASM binary: ArrayBuffer
 * - Native sandbox: string (JSON-serialized to avoid JSI stack overflow)
 */
export type SendToHost = (
  batch: OperationBatch | SerializedOperationBatch | ArrayBuffer | string
) => void;

// ============================================
// Type Guards
// ============================================

/**
 *  JSI
 */
export function isJSIPrimitive(value: BridgeValue): value is JSIPrimitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  );
}

/**
 *
 */
export function isSerializedFunction(value: SerializedValue): value is SerializedFunction {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedFunction).__type === 'function' &&
    '__fnId' in value
  );
}

/**
 *
 */
export function isSerializedDate(value: SerializedValue): value is SerializedDate {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedDate).__type === 'date'
  );
}

/**
 *
 */
export function isSerializedRegExp(value: SerializedValue): value is SerializedRegExp {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedRegExp).__type === 'regexp'
  );
}

/**
 *
 */
export function isSerializedError(value: SerializedValue): value is SerializedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedError).__type === 'error'
  );
}

/**
 *  Map
 */
export function isSerializedMap(value: SerializedValue): value is SerializedMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedMap).__type === 'map'
  );
}

/**
 *  Set
 */
export function isSerializedSet(value: SerializedValue): value is SerializedSet {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedSet).__type === 'set'
  );
}

/**
 *  Promise
 */
export function isSerializedPromise(value: SerializedValue): value is SerializedPromise {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as SerializedPromise).__type === 'promise' &&
    '__promiseId' in value
  );
}

/**
 *
 */
export function isSerializedSpecialType(value: SerializedValue): value is SerializedSpecialType {
  return (
    isSerializedFunction(value) ||
    isSerializedDate(value) ||
    isSerializedRegExp(value) ||
    isSerializedError(value) ||
    isSerializedMap(value) ||
    isSerializedSet(value) ||
    isSerializedPromise(value)
  );
}
