/**
 * @rill/shared - Protocol Layer
 *
 * Host ↔ Guest
 * - Bridge（）
 * -
 * -
 * - CallbackRegistry（）
 */

// Bridge（Host ↔ Guest ）
export {
  Bridge,
  type BridgeOptions,
  type EncodeBatchResult,
  PromiseManager,
  type PromiseManagerOptions,
  type PromiseSettleResult,
} from './bridge';
// CallbackRegistry （）
export {
  CallbackRegistry as CallbackRegistryImpl,
  globalCallbackRegistry,
} from './callback-registry';
// Serialization utilities ()
export {
  createDecoder,
  createEncoder,
  decodeObject,
  encodeObject,
} from './serialization';
// TypeRules
export {
  type CodecCallbacks,
  DEFAULT_TYPE_RULES,
  type TransportStrategy,
  type TypeRule,
} from './type-rules';
export type {
  AppendOperation,
  BaseOperation,
  // Bridge
  BridgeValue,
  BridgeValueArray,
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
  // JSI
  JSIPrimitive,
  JSISafe,
  JSISafeArray,
  JSISafeObject,
  Operation,
  OperationBatch,
  //
  OperationType,
  PromiseSettleMessage,
  RefCallOperation,
  RefMethodResultMessage,
  RemoveOperation,
  ReorderOperation,
  //  Bridge
  RequiresBridge,
  ReviewedUnknown,
  SendToHost,
  SerializedCreateOperation,
  SerializedDate,
  SerializedError,
  SerializedFunction,
  SerializedHostMessage,
  SerializedMap,
  SerializedOperation,
  SerializedOperationBatch,
  SerializedPromise,
  SerializedPromiseSettleMessage,
  SerializedProps,
  SerializedRefCallOperation,
  SerializedRefMethodResultMessage,
  SerializedRegExp,
  SerializedSet,
  SerializedSpecialType,
  SerializedUpdateOperation,
  //
  SerializedValue,
  SerializedValueArray,
  SerializedValueObject,
  TextOperation,
  UpdateOperation,
} from './types';
//
// Type Guards
export {
  HostMsg,
  isJSIPrimitive,
  isSerializedDate,
  isSerializedError,
  isSerializedFunction,
  isSerializedMap,
  isSerializedPromise,
  isSerializedRegExp,
  isSerializedSet,
  isSerializedSpecialType,
  operationHasProps,
} from './types';
