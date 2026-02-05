/**
 * @rill/shared/bridge - Communication Layer
 *
 * Bridge 是 Host/Guest 之间的通信层
 * - 只暴露两个方法：sendToHost() / sendToGuest()
 * - 内部自动处理所有编码/解码
 * - 最大化 JSI 能力：原生支持的类型直接传递，零开销
 */

import type {
  BridgeValue,
  BridgeValueObject,
  CallbackRegistry,
  CodecCallbacks,
  HostMessage,
  Operation,
  OperationBatch,
  ReviewedUnknown,
  SerializedError,
  SerializedHostMessage,
  SerializedOperation,
  SerializedOperationBatch,
  SerializedValue,
  SerializedValueObject,
  TypeRule,
} from '..';

import {
  createDecoder,
  createEncoder,
  DEFAULT_TYPE_RULES,
  HostMsg,
  isSerializedFunction,
  operationHasProps,
  decodeObject as sharedDecodeObject,
  encodeObject as sharedEncodeObject,
} from '..';
import { BinaryProtocol, type BinaryProtocolConfig } from './binary-protocol';
import { PromiseManager, type PromiseSettleResult } from './promise-manager';

/**
 * Bridge 配置选项
 */
export interface BridgeOptions {
  /**
   * Called when Guest sends an operation batch (already decoded)
   */
  onGuestOperations: (batch: OperationBatch) => void;

  /**
   * Called when Host sends a message to Guest (already decoded)
   */
  onHostMessage: (message: HostMessage) => void | Promise<void>;

  /**
   * Callback Registry
   */
  callbackRegistry: CallbackRegistry;

  /**
   * Guest 回调调用器 - 用于调用 Sandbox 中注册的回调
   * 如果提供，Bridge 会自动路由这些调用到 Guest
   */
  guestInvoker?: (fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown;

  /**
   * Guest 回调释放器 - 用于释放 Sandbox 中注册的回调
   * 如果提供，Bridge 会路由 release 调用到 Guest
   */
  guestReleaseCallback?: (fnId: string) => void;

  /**
   * 类型规则（可选，默认使用 DEFAULT_TYPE_RULES）
   */
  typeRules?: TypeRule[];

  /**
   * Promise 超时时间（毫秒），默认 30000ms (30秒)
   * 设置为 0 禁用超时
   */
  promiseTimeout?: number;

  /**
   * Binary protocol configuration (optional)
   * If provided, Bridge can accept ArrayBuffer input in sendToHost()
   */
  binaryProtocol?: BinaryProtocolConfig;

  /**
   * 调试模式
   */
  debug?: boolean;

  /**
   * Optional logger for error reporting
   * If not provided, errors will be logged to console
   */
  logger?: {
    // Reason: Logger methods accept arbitrary console arguments
    error: (...args: unknown[]) => void;
  };
}

/**
 * Result of encoding a batch with callback tracking
 */
export interface EncodeBatchResult {
  serialized: SerializedOperationBatch;
  fnIds: Set<string>;
}

/**
 * Bridge - 统一通信层
 *
 * 只暴露两个方法，内部自动处理所有编码/解码
 */
export class Bridge {
  private onGuestOperations: (batch: OperationBatch) => void;
  private onHostMessage: (message: HostMessage) => void | Promise<void>;
  private registry: CallbackRegistry;
  private guestInvoker?: (fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown;
  private guestReleaseCallback?: (fnId: string) => void;
  private typeRules: TypeRule[];
  private debug: boolean;

  // Binary protocol adapter (optional)
  private binaryProtocol: BinaryProtocol | null = null;

  // Track function IDs during encoding (for cleanup)
  private currentEncodingFnIds: Set<string> | null = null;

  // Promise handling - delegated to PromiseManager
  private promiseManager: PromiseManager;

  // Type rule context (提供给规则的能力)
  private readonly context: CodecCallbacks;

  // Encoder/Decoder functions (created using shared utilities)
  private readonly encoder: (value: ReviewedUnknown) => ReviewedUnknown;
  private readonly decoder: (value: ReviewedUnknown) => ReviewedUnknown;

  constructor(options: BridgeOptions) {
    this.onGuestOperations = options.onGuestOperations;
    this.onHostMessage = options.onHostMessage;
    this.registry = options.callbackRegistry;
    this.guestInvoker = options.guestInvoker;
    this.guestReleaseCallback = options.guestReleaseCallback;
    this.typeRules = options.typeRules ?? DEFAULT_TYPE_RULES;
    this.debug = options.debug ?? false;

    // Initialize BinaryProtocol if configured
    if (options.binaryProtocol) {
      this.binaryProtocol = new BinaryProtocol(options.binaryProtocol);
    }

    // Initialize PromiseManager
    this.promiseManager = new PromiseManager({
      timeout: options.promiseTimeout ?? 30000,
      onSendResult: (promiseId, result) => this.sendPromiseResult(promiseId, result),
      debug: this.debug,
    });

    // 初始化 type rule context (需要先声明，因为 encoder/decoder 会引用它)
    // Reason: Context must reference encoder/decoder which reference context (circular)
    this.context = {} as CodecCallbacks;

    // 使用共享工具创建 encoder 和 decoder
    this.encoder = createEncoder(this.typeRules, this.context);
    this.decoder = createDecoder(this.typeRules, this.context);

    // 完善 context（现在 encoder/decoder 已创建）
    this.context.encode = this.encoder;
    this.context.decode = this.decoder;
    this.context.logger = options.logger; // Pass logger to context for TypeRules error reporting
    this.context.registerFunction = (fn) => {
      const fnId = this.registry.register(fn as (...args: unknown[]) => unknown);
      // Track if encoding
      if (this.currentEncodingFnIds) {
        this.currentEncodingFnIds.add(fnId);
      }
      return fnId;
    };
    // invokeFunction: 智能路由到 Guest 或 Host registry
    this.context.invokeFunction = (fnId, args) => {
      // 先检查 Host registry（Host 端注册的回调）
      if (this.registry.has(fnId)) {
        return this.registry.invoke(fnId, args);
      }
      // Host registry 中没有 → 路由到 Guest sandbox
      // 包括 fn_N (sandbox __rill.registerCallback) 和 fn_xxx_N (Guest globalCallbackRegistry)
      // NOTE: args encoding is handled by TypeRules (serialized-function decode)
      if (this.guestInvoker) {
        return this.guestInvoker(fnId, args);
      }
      // 无法路由
      if (this.debug) {
        console.warn(
          `[Bridge] invokeFunction: fnId ${fnId} not found in Host registry and no guestInvoker`
        );
      }
      return undefined;
    };
    // Promise handling - delegated to PromiseManager
    this.context.registerPromise = (promise) => this.promiseManager.register(promise);
    this.context.createPendingPromise = (promiseId) => this.promiseManager.createPending(promiseId);
  }

  // ============================================
  // Public API — Guest → Host (4 explicit entry points)
  // ============================================

  /**
   * Send a raw (unencoded) operation batch from Guest to Host.
   * Used by VM providers where Guest and Host share the same runtime.
   * The batch will be encoded (Function → fnId) then decoded (fnId → proxy).
   */
  sendRawBatch(batch: OperationBatch): void {
    if (this.debug) {
      console.log('[Bridge] sendRawBatch input:', batch);
    }
    this.dispatchSerializedBatch(this.encodeBatch(batch).serialized);
  }

  /**
   * Send a pre-serialized operation batch from Guest to Host.
   * Used by WASM/Worker providers where Guest already serialized (Function → fnId).
   * Skips encoding — only decodes (fnId → proxy).
   */
  sendSerializedBatch(batch: SerializedOperationBatch): void {
    if (this.debug) {
      console.log('[Bridge] sendSerializedBatch input:', batch.operations.length, 'operations');
    }
    this.dispatchSerializedBatch(batch);
  }

  /**
   * Send a binary-encoded operation batch from Guest to Host.
   * Used by WASM providers that transfer data as ArrayBuffer.
   */
  sendBinaryBatch(buffer: ArrayBuffer): void {
    if (this.debug) {
      console.log('[Bridge] sendBinaryBatch input:', `ArrayBuffer(${buffer.byteLength})`);
    }
    if (!this.binaryProtocol) {
      this.binaryProtocol = new BinaryProtocol({ encoding: 'binary' });
    }
    const serializedBatch = this.binaryProtocol.decodeBatch(buffer);
    if (this.debug) {
      console.log(
        '[Bridge] Decoded binary batch:',
        serializedBatch.operations.length,
        'operations'
      );
    }
    this.dispatchSerializedBatch(serializedBatch);
  }

  /**
   * Send a JSON-stringified operation batch from Guest to Host.
   * Used on Android where JSI object conversion overflows native stack
   * for large batches — Guest JSON.stringify's before crossing the bridge.
   */
  sendJsonBatch(json: string): void {
    if (this.debug) {
      console.log('[Bridge] sendJsonBatch input:', `JSON string(${json.length})`);
    }
    const serializedBatch = JSON.parse(json) as SerializedOperationBatch;
    if (this.debug) {
      console.log('[Bridge] Decoded JSON batch:', serializedBatch.operations.length, 'operations');
    }
    this.dispatchSerializedBatch(serializedBatch);
  }

  /**
   * Common dispatch path: decode serialized batch, extract fnIds, and deliver.
   */
  private dispatchSerializedBatch(serializedBatch: SerializedOperationBatch): void {
    // Extract fnIds from each operation's props for cleanup tracking
    const operationFnIds = new Map<number, Set<string>>();
    for (const op of serializedBatch.operations) {
      if (operationHasProps(op)) {
        const fnIds = Bridge.extractFnIds(op.props);
        if (fnIds.size > 0) {
          operationFnIds.set(op.id, fnIds);
        }
      }
    }

    if (this.debug) {
      console.log('[Bridge] dispatch serialized:', serializedBatch);
      console.log('[Bridge] dispatch fnIds:', operationFnIds);
    }

    // Decode: fnId → Function proxy
    const decoded = this.decodeBatch(serializedBatch);

    // Attach fnIds metadata to operations for cleanup
    for (const op of decoded.operations) {
      const fnIds = operationFnIds.get(op.id);
      if (fnIds) {
        (op as Operation & { _fnIds?: Set<string> })._fnIds = fnIds;
      }
    }

    if (this.debug) {
      console.log('[Bridge] dispatch decoded:', decoded);
    }

    this.onGuestOperations(decoded);
  }

  /**
   * Host → Guest
   * 发送宿主消息，内部自动编码
   */
  async sendToGuest(message: HostMessage): Promise<void> {
    if (this.debug) {
      console.log('[Bridge] sendToGuest input:', message);
    }

    // 1. 编码
    const encoded = this.encodeHostMessage(message);

    if (this.debug) {
      console.log('[Bridge] sendToGuest encoded:', encoded);
    }

    // 2. 跨 JSI 边界

    // 3. 解码并传递给接收器
    const decoded = this.decodeHostMessage(encoded);

    if (this.debug) {
      console.log('[Bridge] sendToGuest decoded:', decoded);
    }

    await this.onHostMessage(decoded);
  }

  // ============================================
  // 内部实现 - 编码（BridgeValue → SerializedValue）
  // ============================================

  /**
   * Encode an operation batch.
   * Tracks all function IDs registered during encoding and returns them
   * alongside the serialized batch (for callback cleanup).
   */
  encodeBatch(batch: OperationBatch): EncodeBatchResult {
    this.currentEncodingFnIds = new Set<string>();

    try {
      const serialized: SerializedOperationBatch = {
        version: batch.version,
        batchId: batch.batchId,
        operations: batch.operations.map((op): SerializedOperation => {
          if (operationHasProps(op)) {
            return {
              ...op,
              props: this.encodeObject(op.props),
            };
          }
          // Handle REF_CALL - encode args
          if (op.op === 'REF_CALL') {
            return {
              ...op,
              args: op.args.map((arg) => this.encode(arg)),
            };
          }
          return op;
        }),
      };

      return { serialized, fnIds: this.currentEncodingFnIds };
    } finally {
      this.currentEncodingFnIds = null;
    }
  }

  /**
   * 编码 Host 消息
   */
  private encodeHostMessage(message: HostMessage): SerializedHostMessage {
    switch (message.type) {
      case HostMsg.CALL_FUNCTION:
        return {
          type: HostMsg.CALL_FUNCTION,
          fnId: message.fnId,
          args: message.args.map((arg) => this.encode(arg)),
        };
      case HostMsg.HOST_EVENT:
        return {
          type: HostMsg.HOST_EVENT,
          eventName: message.eventName,
          payload: this.encode(message.payload),
        };
      case HostMsg.CONFIG_UPDATE:
        return {
          type: HostMsg.CONFIG_UPDATE,
          config: this.encodeObject(message.config),
        };
      case HostMsg.DESTROY:
        return { type: HostMsg.DESTROY };
      case HostMsg.PROMISE_RESOLVE:
        return {
          type: HostMsg.PROMISE_RESOLVE,
          promiseId: message.promiseId,
          value: this.encode(message.value),
        };
      case HostMsg.PROMISE_REJECT:
        return {
          type: HostMsg.PROMISE_REJECT,
          promiseId: message.promiseId,
          error: message.error,
        };
      case HostMsg.REF_METHOD_RESULT:
        return {
          type: HostMsg.REF_METHOD_RESULT,
          refId: message.refId,
          callId: message.callId,
          result: message.result !== undefined ? this.encode(message.result) : undefined,
          error: message.error,
        };
    }
  }

  /**
   * 编码任意 BridgeValue - 使用类型规则自动分发
   */
  private encode(value: BridgeValue): SerializedValue {
    return this.encoder(value) as SerializedValue;
  }

  /**
   * 编码对象（使用共享工具）
   */
  private encodeObject(obj: BridgeValueObject): SerializedValueObject {
    return sharedEncodeObject(obj, this.encoder) as SerializedValueObject;
  }

  // ============================================
  // 内部实现 - 解码（SerializedValue → BridgeValue）
  // ============================================

  /**
   * 解码操作批次
   */
  private decodeBatch(batch: SerializedOperationBatch): OperationBatch {
    return {
      version: batch.version,
      batchId: batch.batchId,
      operations: batch.operations.map((op): Operation => {
        if (operationHasProps(op)) {
          return {
            ...op,
            props: this.decodeObject(op.props),
          };
        }
        // Handle REF_CALL - decode args
        if (op.op === 'REF_CALL') {
          return {
            ...op,
            args: op.args.map((arg) => this.decode(arg)),
          };
        }
        return op;
      }),
    };
  }

  /**
   * 解码 Host 消息
   */
  private decodeHostMessage(message: SerializedHostMessage): HostMessage {
    switch (message.type) {
      case HostMsg.CALL_FUNCTION:
        return {
          type: HostMsg.CALL_FUNCTION,
          fnId: message.fnId,
          args: message.args.map((arg) => this.decode(arg)),
        };
      case HostMsg.HOST_EVENT:
        return {
          type: HostMsg.HOST_EVENT,
          eventName: message.eventName,
          payload: this.decode(message.payload),
        };
      case HostMsg.CONFIG_UPDATE:
        return {
          type: HostMsg.CONFIG_UPDATE,
          config: this.decodeObject(message.config),
        };
      case HostMsg.DESTROY:
        return { type: HostMsg.DESTROY };
      case HostMsg.PROMISE_RESOLVE:
        // 处理 Promise 结算
        this.settlePromise(message.promiseId, {
          status: 'fulfilled',
          value: this.decode(message.value),
        });
        return {
          type: HostMsg.PROMISE_RESOLVE,
          promiseId: message.promiseId,
          value: this.decode(message.value),
        };
      case HostMsg.PROMISE_REJECT: {
        // 处理 Promise 拒绝
        const error = new Error(message.error.__message);
        error.name = message.error.__name;
        if (message.error.__stack) {
          error.stack = message.error.__stack;
        }
        this.settlePromise(message.promiseId, { status: 'rejected', reason: error });
        return {
          type: HostMsg.PROMISE_REJECT,
          promiseId: message.promiseId,
          error: message.error,
        };
      }
      case HostMsg.REF_METHOD_RESULT:
        return {
          type: HostMsg.REF_METHOD_RESULT,
          refId: message.refId,
          callId: message.callId,
          result: message.result !== undefined ? this.decode(message.result) : undefined,
          error: message.error,
        };
    }
  }

  /**
   * 解码任意 SerializedValue - 使用类型规则自动分发
   */
  private decode(value: SerializedValue): BridgeValue {
    return this.decoder(value) as BridgeValue;
  }

  /**
   * 解码对象（使用共享工具）
   */
  private decodeObject(obj: SerializedValueObject): BridgeValueObject {
    return sharedDecodeObject(obj, this.decoder) as BridgeValueObject;
  }

  // ============================================
  // Promise Methods
  // ============================================

  /**
   * 发送 Promise 结算结果到对端
   */
  private sendPromiseResult(promiseId: string, result: PromiseSettleResult): void {
    // Fire-and-forget, but MUST handle rejection to avoid unhandled Promise rejection.
    const safeSend = (p: Promise<void>) => {
      p.catch((e) => {
        if (this.debug) {
          console.warn('[Bridge] Failed to deliver promise result to guest:', e);
        }
      });
    };

    if (result.status === 'fulfilled') {
      // 发送 resolve 消息
      safeSend(
        this.sendToGuest({
          type: HostMsg.PROMISE_RESOLVE,
          promiseId,
          value: result.value as BridgeValue,
        })
      );
    } else {
      // 发送 reject 消息
      const error =
        result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      const serializedError: SerializedError = {
        __type: 'error',
        __name: error.name,
        __message: error.message,
        __stack: error.stack,
      };
      safeSend(
        this.sendToGuest({
          type: HostMsg.PROMISE_REJECT,
          promiseId,
          error: serializedError,
        })
      );
    }
  }

  /**
   * 结算待处理的 Promise - delegated to PromiseManager
   */
  private settlePromise(promiseId: string, result: PromiseSettleResult): void {
    this.promiseManager.settle(promiseId, result);
  }

  // ============================================
  // Callback Lifecycle Methods
  // ============================================

  /**
   * Release a callback - routes to Host registry or Guest as appropriate
   * Used by Receiver for cleanup
   */
  releaseCallback(fnId: string): void {
    // Check Host registry first
    if (this.registry.has(fnId)) {
      this.registry.release(fnId);
      return;
    }
    // Not in Host registry → route to Guest
    if (this.guestReleaseCallback) {
      this.guestReleaseCallback(fnId);
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Extract all function IDs from serialized props
   * Used by Receiver for callback cleanup
   */
  static extractFnIds(props: SerializedValueObject): Set<string> {
    const fnIds = new Set<string>();

    function traverse(value: SerializedValue): void {
      if (value === null || value === undefined) return;

      // Check if it's a serialized function (centralized type guard)
      if (
        typeof value === 'object' &&
        value !== null &&
        isSerializedFunction(value as SerializedValue)
      ) {
        fnIds.add((value as { __fnId: string }).__fnId);
        return;
      }

      // Recursively traverse arrays
      if (Array.isArray(value)) {
        for (const item of value) {
          traverse(item);
        }
        return;
      }

      // Recursively traverse objects
      if (typeof value === 'object') {
        for (const v of Object.values(value as Record<string, SerializedValue>)) {
          traverse(v);
        }
      }
    }

    traverse(props);
    return fnIds;
  }

  // ============================================
  // Lifecycle Methods
  // ============================================

  /**
   * Destroy the Bridge and clean up all resources.
   * Clears pending promises to prevent timeout errors during shutdown.
   */
  destroy(): void {
    // Clear pending promises to prevent timeout errors
    this.promiseManager.clear();

    // Clear callback registry
    this.registry.clear();

    // Clear binary protocol state
    if (this.binaryProtocol) {
      this.binaryProtocol.clearState();
    }
  }
}
