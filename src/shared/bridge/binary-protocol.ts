/**
 * binary-protocol.ts
 *
 * LEGACY / DORMANT op-batch codec (decoder half; encoder is
 * src/guest/runtime/reconciler/binary-encoder.ts). This is the SAME guest→host
 * op-batch BINARY wire format described by contracts/op-batch-wire.json, but it
 * is NOT on the live path — JSON is the real transport (BinaryProtocolConfig
 * defaults to 'json'); this pair exists only for tests/benchmarks. It is kept
 * BYTE-ALIGNED with contracts/op-batch-wire.json and is superseded by the
 * authoritative implementations locked to that schema: the Rust encoder
 * (crates/rill-guest/src/wire_encode.rs, the byte oracle) plus the streaming
 * decoders (src/host/wire/wire-decoder.ts, native WireDecoder.cpp), all
 * conformance-tested against the golden/matrix vectors. Per the maturity
 * roadmap this pair is to be REPLACED by a wire_encode.rs port when the web
 * op-batch route is promoted — do not extend it with new features; only keep it
 * from drifting off the schema.
 *
 * P3-X.5: Bridge Binary Protocol Adapter
 *
 * Provides binary encoding/decoding support for Bridge.
 * Allows switching between JSON and Binary protocols based on configuration.
 *
 * Usage:
 *   const protocol = new BinaryProtocol({ encoding: 'binary' });
 *   const binary = protocol.encodeBatch(batch);
 *   const decoded = protocol.decodeBatch(binary);
 */

import { BinaryEncoder } from '../../guest/runtime/reconciler/binary-encoder';
import type {
  SerializedFunction,
  SerializedOperation,
  SerializedOperationBatch,
  SerializedValue,
  SerializedValueObject,
} from '../types';

// ============================================
// Types
// ============================================

/**
 * Payload encoding type
 */
export type PayloadEncoding = 'json' | 'binary';

/**
 * Binary protocol configuration
 */
export interface BinaryProtocolConfig {
  /**
   * Encoding type (default: 'json')
   */
  encoding?: PayloadEncoding;

  /**
   * Persist string intern table across batches (default: true)
   */
  persistentIntern?: boolean;

  /**
   * Include timestamps in operations (default: false)
   */
  includeTimestamps?: boolean;

  /**
   * Enable debug logging (default: false)
   */
  debug?: boolean;
}

/**
 * Decoded binary batch result
 */
export interface DecodedBinaryBatch {
  version: number;
  batchId: number;
  opCount: number;
  operations: SerializedOperation[];
}

/**
 * Protocol statistics
 */
export interface ProtocolStats {
  encoding: PayloadEncoding;
  lastEncodingMs: number;
  lastDecodingMs: number;
  lastInputBytes: number;
  lastOutputBytes: number;
  compressionRatio: number;
  totalBatchesEncoded: number;
  totalBatchesDecoded: number;
}

// ============================================
// Constants (must match InstructionFormat.h)
// ============================================

const RILL_MAGIC = 0x4c4c4952;
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 16;

const OpType = {
  CREATE: 0x01,
  UPDATE: 0x02,
  DELETE: 0x03,
  APPEND: 0x04,
  INSERT: 0x05,
  REMOVE: 0x06,
  REORDER: 0x07,
  TEXT: 0x08,
  REF_CALL: 0x09,
} as const;

const ValueType = {
  NULL: 0x00,
  UNDEFINED: 0x01,
  BOOL_FALSE: 0x02,
  BOOL_TRUE: 0x03,
  INT32: 0x04,
  FLOAT64: 0x05,
  STRING: 0x06,
  FUNCTION: 0x07,
  OBJECT: 0x08,
  ARRAY: 0x09,
  DATE: 0x0a,
  ERROR: 0x0b,
  REGEXP: 0x0c,
  MAP: 0x0d,
  SET: 0x0e,
  PROMISE: 0x0f,
} as const;

// ============================================
// Binary Decoder (Host side)
// ============================================

/**
 * Decode binary batch to SerializedOperationBatch
 * This is used on the Host side to decode binary data from Guest
 */
class BinaryDecoder {
  private view: DataView;
  private uint8: Uint8Array;
  private pos = 0;
  private internTable: string[] = [];

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.uint8 = new Uint8Array(buffer);
  }

  decode(): DecodedBinaryBatch {
    // Read header
    const magic = this.readU32();
    if (magic !== RILL_MAGIC) {
      throw new Error(`Invalid magic number: 0x${magic.toString(16)}`);
    }

    const version = this.readU16();
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }

    const batchId = this.readU32();
    const opCount = this.readU16();
    const flags = this.readU8();
    this.pos += 3; // Skip reserved bytes

    // Read intern table
    this.readInternTable();

    // Read operations
    const operations: SerializedOperation[] = [];
    for (let i = 0; i < opCount; i++) {
      operations.push(this.readOperation(flags));
    }

    // Full-consumption check: every declared op has been read, so the buffer
    // must be exactly spent. Trailing bytes mean either a corrupt/oversized
    // frame or a desynced stream we silently mis-parsed — reject fail-closed,
    // matching the authoritative streaming decoder (wire-decoder.ts) which also
    // refuses a batch that does not end on a frame boundary. Reachable because
    // Engine.injectRuntimeAPI routes ArrayBuffer batches through
    // Bridge.sendBinaryBatch() into this decoder.
    if (this.pos !== this.uint8.length) {
      throw new Error(`Trailing bytes after batch: consumed ${this.pos} of ${this.uint8.length}`);
    }

    return {
      version,
      batchId,
      opCount,
      operations,
    };
  }

  private readInternTable(): void {
    const count = this.readU16();
    this.internTable = [];

    for (let i = 0; i < count; i++) {
      const length = this.readU16();
      const bytes = this.uint8.slice(this.pos, this.pos + length);
      this.pos += length;
      this.internTable.push(new TextDecoder().decode(bytes));
    }
  }

  private readOperation(flags: number): SerializedOperation {
    const opType = this.readU8();
    const nodeId = this.readU32();
    const hasTimestamps = (flags & 0x04) !== 0;

    let op: SerializedOperation;

    switch (opType) {
      case OpType.CREATE: {
        const typeIndex = this.readU16();
        const props = this.readPropsTable();
        op = {
          op: 'CREATE',
          id: nodeId,
          type: this.internTable[typeIndex] ?? '',
          props,
        };
        break;
      }

      case OpType.UPDATE: {
        const props = this.readPropsTable();
        const removedCount = this.readU16();
        const removedProps: string[] = [];
        for (let i = 0; i < removedCount; i++) {
          const idx = this.readU16();
          removedProps.push(this.internTable[idx] ?? '');
        }
        op = {
          op: 'UPDATE',
          id: nodeId,
          props,
          removedProps: removedProps.length > 0 ? removedProps : undefined,
        };
        break;
      }

      case OpType.DELETE:
        op = { op: 'DELETE', id: nodeId };
        break;

      case OpType.APPEND: {
        const parentId = this.readU32();
        const childId = this.readU32();
        op = { op: 'APPEND', id: nodeId, parentId, childId };
        break;
      }

      case OpType.INSERT: {
        const parentId = this.readU32();
        const childId = this.readU32();
        const index = this.readU16();
        op = { op: 'INSERT', id: nodeId, parentId, childId, index };
        break;
      }

      case OpType.REMOVE: {
        const parentId = this.readU32();
        const childId = this.readU32();
        op = { op: 'REMOVE', id: nodeId, parentId, childId };
        break;
      }

      case OpType.REORDER: {
        const parentId = this.readU32();
        const childCount = this.readU16();
        const childIds: number[] = [];
        for (let i = 0; i < childCount; i++) {
          childIds.push(this.readU32());
        }
        op = { op: 'REORDER', id: nodeId, parentId, childIds };
        break;
      }

      case OpType.TEXT: {
        const textIndex = this.readU16();
        op = { op: 'TEXT', id: nodeId, text: this.internTable[textIndex] ?? '' };
        break;
      }

      case OpType.REF_CALL: {
        const methodIndex = this.readU16();
        const callIdIndex = this.readU16();
        const argsCount = this.readU16();
        const args: SerializedValue[] = [];
        for (let i = 0; i < argsCount; i++) {
          args.push(this.readValue());
        }
        op = {
          op: 'REF_CALL',
          id: nodeId,
          refId: nodeId,
          method: this.internTable[methodIndex] ?? '',
          callId: this.internTable[callIdIndex] ?? '',
          args,
        };
        break;
      }

      default:
        throw new Error(`Unknown operation type: 0x${opType.toString(16)}`);
    }

    // Read optional timestamp
    if (hasTimestamps) {
      const timestamp = this.readU64();
      (op as SerializedOperation & { timestamp?: number }).timestamp = timestamp;
    }

    return op;
  }

  private readPropsTable(): SerializedValueObject {
    const count = this.readU16();
    const props: SerializedValueObject = {};

    for (let i = 0; i < count; i++) {
      const keyIndex = this.readU16();
      const key = this.internTable[keyIndex] ?? '';
      props[key] = this.readValue();
    }

    return props;
  }

  private readValue(): SerializedValue {
    const type = this.readU8();

    switch (type) {
      case ValueType.NULL:
        return null;

      case ValueType.UNDEFINED:
        return undefined as unknown as SerializedValue;

      case ValueType.BOOL_FALSE:
        return false;

      case ValueType.BOOL_TRUE:
        return true;

      case ValueType.INT32:
        return this.readI32();

      case ValueType.FLOAT64:
        return this.readF64();

      case ValueType.STRING: {
        const idx = this.readU16();
        return this.internTable[idx] ?? '';
      }

      case ValueType.FUNCTION: {
        // Byte layout locked to contracts/op-batch-wire.json values.FUNCTION:
        // fnId (internRef u16), a u8 flags byte, then ONLY the present optional
        // fields IN ORDER — name (internRef u16, bit0), sourceFile (internRef
        // u16, bit1), sourceLine (u32 inline, NOT interned, bit2). flags=0 =>
        // no metadata. Mirrors src/host/wire/wire-decoder.ts.
        const fnIdIdx = this.readU16();
        const fn: SerializedFunction = {
          __type: 'function' as const,
          __fnId: this.internTable[fnIdIdx] ?? '',
        };
        const fnFlags = this.readU8();
        // bits 3..7 are reserved and MUST be written 0 (contracts/
        // op-batch-wire.json values.FUNCTION flags note). A set reserved bit
        // implies unknown trailing fields we cannot length, so reject
        // fail-closed rather than desync the stream — matching
        // wire-decoder.ts and the C++ WireDecoder.
        if ((fnFlags & 0xf8) !== 0) {
          throw new Error(`FUNCTION reserved flag bit set: 0x${fnFlags.toString(16)}`);
        }
        if ((fnFlags & 0x01) !== 0) fn.__name = this.internTable[this.readU16()] ?? '';
        if ((fnFlags & 0x02) !== 0) fn.__sourceFile = this.internTable[this.readU16()] ?? '';
        if ((fnFlags & 0x04) !== 0) fn.__sourceLine = this.readU32();
        return fn;
      }

      case ValueType.OBJECT: {
        const count = this.readU16();
        const obj: SerializedValueObject = {};
        for (let i = 0; i < count; i++) {
          const keyIdx = this.readU16();
          const key = this.internTable[keyIdx] ?? '';
          obj[key] = this.readValue();
        }
        return obj;
      }

      case ValueType.ARRAY: {
        const count = this.readU16();
        const arr: SerializedValue[] = [];
        for (let i = 0; i < count; i++) {
          arr.push(this.readValue());
        }
        return arr;
      }

      case ValueType.DATE: {
        const timestamp = this.readF64();
        return {
          __type: 'date' as const,
          __value: new Date(timestamp).toISOString(),
        };
      }

      case ValueType.ERROR: {
        const nameIdx = this.readU16();
        const msgIdx = this.readU16();
        const stackIdx = this.readU16();
        return {
          __type: 'error' as const,
          __name: this.internTable[nameIdx] ?? 'Error',
          __message: this.internTable[msgIdx] ?? '',
          __stack: this.internTable[stackIdx] || undefined,
        };
      }

      case ValueType.REGEXP: {
        const sourceIdx = this.readU16();
        const flagsIdx = this.readU16();
        return {
          __type: 'regexp' as const,
          __source: this.internTable[sourceIdx] ?? '',
          __flags: this.internTable[flagsIdx] ?? '',
        };
      }

      case ValueType.MAP: {
        const count = this.readU16();
        const entries: [SerializedValue, SerializedValue][] = [];
        for (let i = 0; i < count; i++) {
          const key = this.readValue();
          const value = this.readValue();
          entries.push([key, value]);
        }
        return {
          __type: 'map' as const,
          __entries: entries,
        };
      }

      case ValueType.SET: {
        const count = this.readU16();
        const values: SerializedValue[] = [];
        for (let i = 0; i < count; i++) {
          values.push(this.readValue());
        }
        return {
          __type: 'set' as const,
          __values: values,
        };
      }

      case ValueType.PROMISE: {
        const promiseIdIdx = this.readU16();
        return {
          __type: 'promise' as const,
          __promiseId: this.internTable[promiseIdIdx] ?? '',
        };
      }

      default:
        throw new Error(`Unknown value type: 0x${type.toString(16)}`);
    }
  }

  // Read helpers
  private readU8(): number {
    return this.uint8[this.pos++]!;
  }

  private readU16(): number {
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  private readU32(): number {
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  private readU64(): number {
    const low = this.view.getUint32(this.pos, true);
    const high = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    return low + high * 0x100000000;
  }

  private readI32(): number {
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  }

  private readF64(): number {
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }
}

// ============================================
// Binary Protocol Class
// ============================================

/**
 * Binary protocol adapter for Bridge
 *
 * Handles encoding/decoding of operation batches in binary format.
 * Can be used standalone or integrated with Bridge.
 */
export class BinaryProtocol {
  private config: Required<BinaryProtocolConfig>;
  private encoder: BinaryEncoder | null = null;
  private stats: ProtocolStats;

  constructor(config: BinaryProtocolConfig = {}) {
    this.config = {
      encoding: config.encoding ?? 'json',
      persistentIntern: config.persistentIntern ?? true,
      includeTimestamps: config.includeTimestamps ?? false,
      debug: config.debug ?? false,
    };

    this.stats = {
      encoding: this.config.encoding,
      lastEncodingMs: 0,
      lastDecodingMs: 0,
      lastInputBytes: 0,
      lastOutputBytes: 0,
      compressionRatio: 1,
      totalBatchesEncoded: 0,
      totalBatchesDecoded: 0,
    };

    if (this.config.encoding === 'binary') {
      this.encoder = new BinaryEncoder({
        persistentIntern: this.config.persistentIntern,
        includeTimestamps: this.config.includeTimestamps,
      });
    }
  }

  /**
   * Get current encoding type
   */
  getEncoding(): PayloadEncoding {
    return this.config.encoding;
  }

  /**
   * Set encoding type
   */
  setEncoding(encoding: PayloadEncoding): void {
    if (this.config.encoding === encoding) return;

    this.config.encoding = encoding;
    this.stats.encoding = encoding;

    if (encoding === 'binary' && !this.encoder) {
      this.encoder = new BinaryEncoder({
        persistentIntern: this.config.persistentIntern,
        includeTimestamps: this.config.includeTimestamps,
      });
    }
  }

  /**
   * Encode batch to appropriate format
   */
  encodeBatch(batch: SerializedOperationBatch): ArrayBuffer | string {
    const startTime = performance.now();

    let result: ArrayBuffer | string;
    let outputBytes: number;

    if (this.config.encoding === 'binary' && this.encoder) {
      result = this.encoder.encodeBatch(batch);
      outputBytes = result.byteLength;

      if (this.config.debug) {
        const stats = this.encoder.getStats();
        console.log('[BinaryProtocol] Encoded binary:', {
          operations: batch.operations.length,
          outputBytes,
          internedStrings: stats.internedStrings,
          compressionRatio: stats.compressionRatio,
        });
      }
    } else {
      result = JSON.stringify(batch);
      outputBytes = result.length;
    }

    const endTime = performance.now();

    // Update stats
    this.stats.lastEncodingMs = endTime - startTime;
    this.stats.lastOutputBytes = outputBytes;
    this.stats.totalBatchesEncoded++;

    return result;
  }

  /**
   * Decode batch from appropriate format
   */
  decodeBatch(data: ArrayBuffer | string): SerializedOperationBatch {
    const startTime = performance.now();

    let result: SerializedOperationBatch;

    if (data instanceof ArrayBuffer) {
      // Binary format
      const decoder = new BinaryDecoder(data);
      const decoded = decoder.decode();

      result = {
        version: decoded.version,
        batchId: decoded.batchId,
        operations: decoded.operations,
      };

      this.stats.lastInputBytes = data.byteLength;
    } else {
      // JSON format
      result = JSON.parse(data) as SerializedOperationBatch;
      this.stats.lastInputBytes = data.length;
    }

    const endTime = performance.now();

    // Update stats
    this.stats.lastDecodingMs = endTime - startTime;
    this.stats.totalBatchesDecoded++;

    if (this.config.debug) {
      console.log('[BinaryProtocol] Decoded batch:', {
        operations: result.operations.length,
        decodingMs: this.stats.lastDecodingMs,
      });
    }

    return result;
  }

  /**
   * Check if data is binary format
   */
  // Reason: Type guard input is untrusted at the Bridge boundary
  isBinaryFormat(data: unknown): data is ArrayBuffer {
    if (!(data instanceof ArrayBuffer)) return false;
    if (data.byteLength < HEADER_SIZE) return false;

    const view = new DataView(data);
    return view.getUint32(0, true) === RILL_MAGIC;
  }

  /**
   * Get protocol statistics
   */
  getStats(): ProtocolStats {
    return { ...this.stats };
  }

  /**
   * Clear encoder state (intern table)
   */
  clearState(): void {
    if (this.encoder) {
      this.encoder.clearInternTable();
    }
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a binary protocol adapter
 */
export function createBinaryProtocol(config?: BinaryProtocolConfig): BinaryProtocol {
  return new BinaryProtocol(config);
}

/**
 * Detect payload encoding from data
 */
// Reason: Payload input is untrusted at the Bridge boundary
export function detectPayloadEncoding(data: unknown): PayloadEncoding {
  if (data instanceof ArrayBuffer) {
    const view = new DataView(data);
    if (data.byteLength >= 4 && view.getUint32(0, true) === RILL_MAGIC) {
      return 'binary';
    }
  }
  return 'json';
}
