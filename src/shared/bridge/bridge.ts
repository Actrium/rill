/**
 * @rill/shared/bridge - Communication Layer
 *
 * Bridge  Host/Guest
 * - ：sendToHost() / sendToGuest()
 * - /
 * -  JSI ：，
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
 * Bridge
 */
export interface BridgeOptions {
  /**
   * Called when Guest sends an operation batch (already decoded)
   */
  onGuestOperations: (batch: OperationBatch) => void;

  /**
   * Called with the SERIALIZED batch (callbacks as `{__fnId}` markers, not live functions)
   * before it is decoded. When set, the Bridge forwards the serialized batch here and SKIPS
   * local decode + {@link onGuestOperations} entirely.
   *
   * This is the seam the off-main-thread worker host uses: the worker holds the sandbox but
   * has no renderer, so it ships the structured-clone-safe serialized batch across the worker
   * boundary; the main thread decodes it (turning `{__fnId}` back into proxies that invoke the
   * guest callback over postMessage). Leave unset for in-thread engines.
   */
  onSerializedBatch?: (batch: SerializedOperationBatch) => void;

  /**
   * Called when Host sends a message to Guest (already decoded)
   */
  onHostMessage: (message: HostMessage) => void | Promise<void>;

  /**
   * Callback Registry
   */
  callbackRegistry: CallbackRegistry;

  /**
   * Guest  -  Sandbox
   * ，Bridge  Guest
   */
  guestInvoker?: (fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown;

  /**
   * Guest  -  Sandbox
   * ，Bridge  release  Guest
   */
  guestReleaseCallback?: (fnId: string) => void;

  /**
   * （， DEFAULT_TYPE_RULES）
   */
  typeRules?: TypeRule[];

  /**
   * Promise （）， 30000ms (30)
   *  0
   */
  promiseTimeout?: number;

  /**
   * Binary protocol configuration (optional)
   * If provided, Bridge can accept ArrayBuffer input in sendToHost()
   */
  binaryProtocol?: BinaryProtocolConfig;

  /**
   *
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
 * Bridge -
 *
 * ，/
 */
export class Bridge {
  private onGuestOperations: (batch: OperationBatch) => void;
  private onSerializedBatch?: (batch: SerializedOperationBatch) => void;
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

  // Type rule context ()
  private readonly context: CodecCallbacks;

  // Encoder/Decoder functions (created using shared utilities)
  private readonly encoder: (value: ReviewedUnknown) => ReviewedUnknown;
  private readonly decoder: (value: ReviewedUnknown) => ReviewedUnknown;

  constructor(options: BridgeOptions) {
    this.onGuestOperations = options.onGuestOperations;
    this.onSerializedBatch = options.onSerializedBatch;
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

    //  type rule context (， encoder/decoder )
    // Reason: Context must reference encoder/decoder which reference context (circular)
    this.context = {} as CodecCallbacks;

    //  encoder  decoder
    this.encoder = createEncoder(this.typeRules, this.context);
    this.decoder = createDecoder(this.typeRules, this.context);

    //  context（ encoder/decoder ）
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
    // invokeFunction:  Guest  Host registry
    this.context.invokeFunction = (fnId, args) => {
      //  Host registry（Host ）
      if (this.registry.has(fnId)) {
        return this.registry.invoke(fnId, args);
      }
      // Host registry  →  Guest sandbox
      //  fn_N (sandbox __rill.registerCallback)  fn_xxx_N (Guest globalCallbackRegistry)
      // NOTE: args encoding is handled by TypeRules (serialized-function decode)
      if (this.guestInvoker) {
        return this.guestInvoker(fnId, args);
      }
      //
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
    // Off-main-thread worker host: forward the structured-clone-safe serialized batch and skip
    // local decode. The worker has no renderer, and its callback proxies could not cross the
    // worker boundary anyway — the main thread decodes and wires callbacks back over postMessage.
    if (this.onSerializedBatch) {
      this.onSerializedBatch(serializedBatch);
      return;
    }

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
   * ，
   */
  async sendToGuest(message: HostMessage): Promise<void> {
    if (this.debug) {
      console.log('[Bridge] sendToGuest input:', message);
    }

    // 1.
    const encoded = this.encodeHostMessage(message);

    if (this.debug) {
      console.log('[Bridge] sendToGuest encoded:', encoded);
    }

    // 2.  JSI

    // 3.
    const decoded = this.decodeHostMessage(encoded);

    if (this.debug) {
      console.log('[Bridge] sendToGuest decoded:', decoded);
    }

    await this.onHostMessage(decoded);
  }

  // ============================================
  //  - （BridgeValue → SerializedValue）
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
   *  Host
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
   *  BridgeValue -
   */
  private encode(value: BridgeValue): SerializedValue {
    return this.encoder(value) as SerializedValue;
  }

  /**
   * （）
   */
  private encodeObject(obj: BridgeValueObject): SerializedValueObject {
    return sharedEncodeObject(obj, this.encoder) as SerializedValueObject;
  }

  // ============================================
  //  - （SerializedValue → BridgeValue）
  // ============================================

  /**
   *
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
   *  Host
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
        //  Promise
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
        //  Promise
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
   *  SerializedValue -
   */
  private decode(value: SerializedValue): BridgeValue {
    return this.decoder(value) as BridgeValue;
  }

  /**
   * （）
   */
  private decodeObject(obj: SerializedValueObject): BridgeValueObject {
    return sharedDecodeObject(obj, this.decoder) as BridgeValueObject;
  }

  // ============================================
  // Promise Methods
  // ============================================

  /**
   *  Promise
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
      //  resolve
      safeSend(
        this.sendToGuest({
          type: HostMsg.PROMISE_RESOLVE,
          promiseId,
          value: result.value as BridgeValue,
        })
      );
    } else {
      //  reject
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
   *  Promise - delegated to PromiseManager
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
