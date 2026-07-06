/**
 * @rill/shared - Protocol Layer
 *
 * Host <-> Guest shared protocol surface:
 * - Bridge
 * - serialization / type rules
 * - CallbackRegistry
 */

// Bridge (Host <-> Guest transport)
export {
  Bridge,
  type BridgeOptions,
  type EncodeBatchResult,
  PromiseManager,
  type PromiseManagerOptions,
  type PromiseSettleResult,
} from './bridge';
// CallbackRegistry
export {
  CallbackRegistry as CallbackRegistryImpl,
  globalCallbackRegistry,
} from './callback-registry';
// Web keyboard bridge protocol (issue #19, L3)
export {
  KBD_EVENT,
  KBD_SUBSCRIBE,
  KBD_UNSUBSCRIBE,
  type KeyboardSubscribePayload,
  type KeyboardUnsubscribePayload,
  type RillKeyEvent,
} from './keyboard';
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
  OPERATION_TYPES,
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
