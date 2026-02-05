/**
 * @rill/bridge - Protocol Type System
 *
 * 基于 JSI 能力定义的完整类型系统
 * - JSI 原生支持的类型：直接传递，零开销
 * - 需要 Bridge 处理的类型：序列化/反序列化
 *
 * 这是 Host ↔ Guest 共享的协议层
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
// JSI 原生支持（直接传递，零开销）
// ============================================

/**
 * JSI 原语类型
 */
export type JSIPrimitive = null | undefined | boolean | number | string;

/**
 * JSI 安全类型 - 可直接跨边界传递
 */
export type JSISafe = JSIPrimitive | JSISafeArray | JSISafeObject;

/**
 * JSI 安全数组
 */
export interface JSISafeArray extends Array<JSISafe> {}

/**
 * JSI 安全对象
 */
export interface JSISafeObject {
  [key: string]: JSISafe;
}

// ============================================
// 需要 Bridge 处理（JSI 无法直接传递）
// ============================================

/**
 * 需要序列化的类型
 */
export type RequiresBridge =
  // biome-ignore lint/complexity/noBannedTypes: Generic function type for serialization
  Function | Date | RegExp | Error | Map<BridgeValue, BridgeValue> | Set<BridgeValue>;

// ============================================
// Bridge 完整类型
// ============================================

/**
 * Bridge 支持的完整值类型
 */
export type BridgeValue = JSIPrimitive | RequiresBridge | BridgeValueArray | BridgeValueObject;

/**
 * Bridge 值数组
 */
export interface BridgeValueArray extends Array<BridgeValue> {}

/**
 * Bridge 值对象
 */
export interface BridgeValueObject {
  [key: string]: BridgeValue;
}

// ============================================
// 序列化后的类型
// ============================================

/**
 * 序列化函数
 */
export interface SerializedFunction {
  __type: 'function';
  __fnId: string;
  __name?: string; // Original function name for DevTools
  __sourceFile?: string; // Original source file path (from Babel plugin)
  __sourceLine?: number; // Original source line number (from Babel plugin)
}

/**
 * 序列化日期
 */
export interface SerializedDate {
  __type: 'date';
  __value: string; // ISO 8601
}

/**
 * 序列化正则
 */
export interface SerializedRegExp {
  __type: 'regexp';
  __source: string;
  __flags: string;
}

/**
 * 序列化错误
 */
export interface SerializedError {
  __type: 'error';
  __name: string;
  __message: string;
  __stack?: string;
}

/**
 * 序列化 Map
 */
export interface SerializedMap {
  __type: 'map';
  __entries: [SerializedValue, SerializedValue][];
}

/**
 * 序列化 Set
 */
export interface SerializedSet {
  __type: 'set';
  __values: SerializedValue[];
}

/**
 * 序列化 Promise
 * Promise 通过 ID 跟踪，结果通过 promise:settle 消息异步传回
 */
export interface SerializedPromise {
  __type: 'promise';
  __promiseId: string;
}

/**
 * 所有序列化特殊类型
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
 * 序列化后的值 - JSI 安全
 */
export type SerializedValue =
  | JSIPrimitive
  | SerializedSpecialType
  | SerializedValueArray
  | SerializedValueObject;

/**
 * 序列化值数组
 */
export interface SerializedValueArray extends Array<SerializedValue> {}

/**
 * 序列化值对象
 */
export interface SerializedValueObject {
  [key: string]: SerializedValue;
}

// ============================================
// 操作类型 (Guest → Host)
// ============================================

/**
 * 操作类型枚举
 */
export type OperationType =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'APPEND'
  | 'INSERT'
  | 'REMOVE'
  | 'REORDER'
  | 'TEXT'
  | 'REF_CALL';

/**
 * 基础操作接口
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
 * Remote Ref 方法调用操作
 * Guest 调用 Host 组件实例方法（如 focus, blur, scrollTo）
 */
export interface RefCallOperation extends BaseOperation {
  op: 'REF_CALL';
  refId: number; // 节点 ID（与 nodeMap 中的 id 一致）
  method: string; // 方法名：focus, blur, measure, scrollTo 等
  args: BridgeValue[]; // 方法参数
  callId: string; // 调用唯一标识（用于 Promise 匹配）
}

/**
 * 序列化后的 REF_CALL 操作
 */
export interface SerializedRefCallOperation extends BaseOperation {
  op: 'REF_CALL';
  refId: number;
  method: string;
  args: SerializedValue[];
  callId: string;
}

/**
 * 操作 - Discriminated Union
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
 * 操作批次
 */
export interface OperationBatch {
  version: number;
  batchId: number;
  operations: Operation[];
}

/**
 * 序列化后的操作批次
 */
export interface SerializedOperationBatch {
  version: number;
  batchId: number;
  operations: SerializedOperation[];
}

/**
 * 序列化后的 CREATE 操作
 */
export interface SerializedCreateOperation extends BaseOperation {
  op: 'CREATE';
  type: string;
  props: SerializedValueObject;
}

/**
 * 序列化后的 UPDATE 操作
 */
export interface SerializedUpdateOperation extends BaseOperation {
  op: 'UPDATE';
  props: SerializedValueObject;
  removedProps?: string[];
}

/**
 * 序列化后的操作 - props 使用 SerializedValueObject
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
 * 检查操作是否包含 props
 */
export function operationHasProps(
  op: Operation | SerializedOperation
): op is CreateOperation | UpdateOperation | SerializedCreateOperation | SerializedUpdateOperation {
  return op.op === 'CREATE' || op.op === 'UPDATE';
}

// ============================================
// 消息类型 (Host → Guest)
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
 * Remote Ref 方法调用结果消息
 * Host 返回给 Guest 的方法调用结果
 */
export interface RefMethodResultMessage {
  type: HostMsg.REF_METHOD_RESULT;
  refId: number; // 节点 ID
  callId: string; // 调用唯一标识（与 REF_CALL 对应）
  result?: BridgeValue; // 成功时的返回值
  error?: SerializedError; // 失败时的错误信息
}

/**
 * Host → Guest 消息
 */
export type HostMessage =
  | CallFunctionMessage
  | HostEventMessage
  | ConfigUpdateMessage
  | DestroyMessage
  | PromiseSettleMessage
  | RefMethodResultMessage;

/**
 * Promise 结算消息 - 用于异步传递 Promise 结果
 */
export type PromiseSettleMessage =
  | { type: HostMsg.PROMISE_RESOLVE; promiseId: string; value: BridgeValue }
  | { type: HostMsg.PROMISE_REJECT; promiseId: string; error: SerializedError };

/**
 * 序列化后的 REF_METHOD_RESULT 消息
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
 * 序列化后的 Promise 结算消息
 */
export type SerializedPromiseSettleMessage =
  | { type: HostMsg.PROMISE_RESOLVE; promiseId: string; value: SerializedValue }
  | { type: HostMsg.PROMISE_REJECT; promiseId: string; error: SerializedError };

// ============================================
// Callback Registry 接口
// ============================================

/**
 * Callback Registry - 管理跨边界函数调用
 *
 * Note: Uses ReviewedUnknown for flexibility with existing implementations.
 * The actual serialization/deserialization is handled by Bridge.
 */
export interface CallbackRegistry {
  /**
   * 注册函数，返回 fnId
   */
  register(fn: (...args: ReviewedUnknown[]) => ReviewedUnknown): string;

  /**
   * 通过 fnId 调用函数
   */
  invoke(fnId: string, args: ReviewedUnknown[]): ReviewedUnknown;

  /**
   * 检查 fnId 是否存在
   */
  has(fnId: string): boolean;

  /**
   * 移除指定 fnId
   */
  remove(fnId: string): void;

  /**
   * 清理所有注册的函数
   */
  clear(): void;

  /**
   * 增加引用计数
   */
  retain(fnId: string): void;

  /**
   * 减少引用计数，计数归零时移除
   */
  release(fnId: string): void;

  /**
   * 获取引用计数
   */
  getRefCount(fnId: string): number;

  /**
   * 获取内部 Map（用于同步到 globalThis.__rill.callbacks）
   */
  getMap(): Map<string, (...args: ReviewedUnknown[]) => ReviewedUnknown>;

  /**
   * 当前注册的函数数量
   */
  readonly size: number;
}

// ============================================
// 便捷类型别名
// ============================================

/**
 * 序列化后的 props 对象
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
 * 检查是否为 JSI 原语类型
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
 * 检查是否为序列化函数
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
 * 检查是否为序列化日期
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
 * 检查是否为序列化正则
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
 * 检查是否为序列化错误
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
 * 检查是否为序列化 Map
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
 * 检查是否为序列化 Set
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
 * 检查是否为序列化 Promise
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
 * 检查是否为任意序列化特殊类型
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
