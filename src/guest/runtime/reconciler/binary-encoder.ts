/**
 * binary-encoder.ts
 *
 * LEGACY / DORMANT op-batch codec (encoder half; decoder is
 * src/shared/bridge/binary-protocol.ts). This is the SAME guest→host op-batch
 * BINARY wire format described by contracts/op-batch-wire.json, but it is NOT on
 * the live path — JSON is the real transport (see BinaryProtocolConfig, default
 * 'json'); this pair exists only for tests/benchmarks. It is kept BYTE-ALIGNED
 * with contracts/op-batch-wire.json and is superseded by the authoritative
 * implementations locked to that schema: the Rust encoder
 * (crates/rill-guest/src/wire_encode.rs, the byte oracle) plus the streaming
 * decoders (src/host/wire/wire-decoder.ts, native WireDecoder.cpp), all
 * conformance-tested against the golden/matrix vectors. Per the maturity
 * roadmap this pair is to be REPLACED by a wire_encode.rs port when the web
 * op-batch route is promoted — do not extend it with new features; only keep it
 * from drifting off the schema.
 *
 * P3-X.3: Guest-side Binary Instruction Encoder
 *
 * Encodes SerializedOperationBatch into compact binary format
 * for efficient Guest→Host communication.
 *
 * Features:
 *   - String interning for deduplication
 *   - ArrayBuffer output (transferable)
 *   - Zero-copy where possible
 *   - Compatible with C++ InstructionDecoder
 *
 * Target KPIs:
 *   - Encoding: 5x faster than JSON.stringify
 *   - Size: 60% smaller than JSON
 */

import type {
  ReviewedUnknown,
  SerializedOperation,
  SerializedOperationBatch,
  SerializedValue,
  SerializedValueObject,
} from '../../../shared/types';
import { createUtf8Encoder, nowMs } from './sandbox-compat';

// ============================================
// Constants (must match InstructionFormat.h)
// ============================================

/** Magic number: "RILL" in little-endian */
const RILL_MAGIC = 0x4c4c4952;

/** Protocol version */
const PROTOCOL_VERSION = 1;

/** Operation type codes */
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

/** Value type codes */
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

/** Batch flags */
const BatchFlags = {
  NONE: 0x00,
  DELTA_INTERN: 0x01,
  STRUCTURAL_ONLY: 0x02,
  HAS_TIMESTAMPS: 0x04,
} as const;

/** Header size in bytes */
const HEADER_SIZE = 16;

/** Maximum intern table size */
const MAX_INTERN_STRINGS = 65535;

// ============================================
// Types
// ============================================

export interface EncodingStats {
  inputEstimatedBytes: number;
  outputBytes: number;
  encodingMs: number;
  internedStrings: number;
  totalStringsEncoded: number;
  operationCount: number;
  compressionRatio: number;
  internHitRate: number;
}

export interface BinaryEncoderConfig {
  /** Initial buffer size (default: 8KB) */
  initialBufferSize?: number;
  /** Maximum buffer size (default: 16MB) */
  maxBufferSize?: number;
  /** Persist intern table across batches */
  persistentIntern?: boolean;
  /** Include timestamps in operations */
  includeTimestamps?: boolean;
}

// ============================================
// Binary Encoder Class
// ============================================

/**
 * Binary encoder for operation batches
 *
 * Usage:
 *   const encoder = new BinaryEncoder();
 *   const binary = encoder.encodeBatch(batch);
 *   // Send binary ArrayBuffer to host
 */
export class BinaryEncoder {
  private buffer: ArrayBuffer;
  private view: DataView;
  private uint8: Uint8Array;
  private pos = 0;

  // String interning
  private internMap = new Map<string, number>();
  private internTable: string[] = [];
  private internStartIndex = 0;

  // Configuration
  private config: Required<BinaryEncoderConfig>;

  // Statistics
  private stats: EncodingStats = {
    inputEstimatedBytes: 0,
    outputBytes: 0,
    encodingMs: 0,
    internedStrings: 0,
    totalStringsEncoded: 0,
    operationCount: 0,
    compressionRatio: 1,
    internHitRate: 0,
  };

  constructor(config: BinaryEncoderConfig = {}) {
    this.config = {
      initialBufferSize: config.initialBufferSize ?? 8192,
      maxBufferSize: config.maxBufferSize ?? 16 * 1024 * 1024,
      persistentIntern: config.persistentIntern ?? true,
      includeTimestamps: config.includeTimestamps ?? false,
    };

    this.buffer = new ArrayBuffer(this.config.initialBufferSize);
    this.view = new DataView(this.buffer);
    this.uint8 = new Uint8Array(this.buffer);
  }

  /**
   * Encode a complete operation batch
   */
  encodeBatch(batch: SerializedOperationBatch): ArrayBuffer {
    const startTime = nowMs();

    // Reset position (keep intern table if persistent)
    this.pos = 0;
    this.internStartIndex = this.config.persistentIntern ? this.internTable.length : 0;

    if (!this.config.persistentIntern) {
      this.internMap.clear();
      this.internTable = [];
    }

    // Estimate input size for stats
    this.stats.inputEstimatedBytes = this.estimateJsonSize(batch);

    // Phase 1: Collect all strings for interning
    this.collectStrings(batch);

    // Phase 2: Write header (placeholder, will be patched)
    const headerPos = this.pos;
    this.writeHeader(batch.batchId, batch.operations.length, BatchFlags.NONE);

    // Phase 3: Write intern table
    this.writeInternTable();

    // Phase 4: Write operations
    for (const op of batch.operations) {
      this.writeOperation(op);
    }

    // Patch header with actual values
    this.patchHeader(headerPos, batch.operations.length);

    // Calculate stats
    const endTime = nowMs();
    this.stats.encodingMs = endTime - startTime;
    this.stats.outputBytes = this.pos;
    this.stats.operationCount = batch.operations.length;
    this.stats.internedStrings = this.internTable.length - this.internStartIndex;
    this.stats.compressionRatio =
      this.stats.inputEstimatedBytes > 0
        ? this.stats.outputBytes / this.stats.inputEstimatedBytes
        : 1;
    this.stats.internHitRate =
      this.stats.totalStringsEncoded > 0
        ? 1 - this.stats.internedStrings / this.stats.totalStringsEncoded
        : 0;

    // Return trimmed buffer
    return this.buffer.slice(0, this.pos);
  }

  /**
   * Get encoding statistics from last batch
   */
  getStats(): EncodingStats {
    return { ...this.stats };
  }

  /**
   * Clear intern table (for testing or memory management)
   */
  clearInternTable(): void {
    this.internMap.clear();
    this.internTable = [];
    this.internStartIndex = 0;
  }

  /**
   * Get current intern table size
   */
  getInternTableSize(): number {
    return this.internTable.length;
  }

  // ============================================
  // Private: String Collection
  // ============================================

  private collectStrings(batch: SerializedOperationBatch): void {
    for (const op of batch.operations) {
      this.collectOperationStrings(op);
    }
  }

  private collectOperationStrings(op: SerializedOperation): void {
    switch (op.op) {
      case 'CREATE':
        this.internString(op.type);
        this.collectPropsStrings(op.props);
        break;

      case 'UPDATE':
        this.collectPropsStrings(op.props);
        if (op.removedProps) {
          for (const prop of op.removedProps) {
            this.internString(prop);
          }
        }
        break;

      case 'TEXT':
        this.internString(op.text);
        break;

      case 'REF_CALL':
        this.internString(op.method);
        this.internString(op.callId);
        this.collectValueStrings(op.args);
        break;
    }
  }

  private collectPropsStrings(props: SerializedValueObject): void {
    for (const [key, value] of Object.entries(props)) {
      this.internString(key);
      this.collectValueStrings(value);
    }
  }

  private collectValueStrings(value: SerializedValue | SerializedValue[]): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectValueStrings(item);
      }
      return;
    }

    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      this.internString(value);
      return;
    }

    if (typeof value === 'object') {
      // Check for serialized special types
      if ('__type' in value) {
        const typed = value as { __type: string; [key: string]: ReviewedUnknown };
        switch (typed.__type) {
          case 'function':
            this.internString(typed.__fnId as string);
            if (typed.__name) this.internString(typed.__name as string);
            if (typed.__sourceFile) this.internString(typed.__sourceFile as string);
            break;
          case 'error':
            this.internString(typed.__name as string);
            this.internString(typed.__message as string);
            // Always intern stack (empty string if undefined)
            this.internString((typed.__stack as string) ?? '');
            break;
          case 'regexp':
            this.internString(typed.__source as string);
            this.internString(typed.__flags as string);
            break;
          case 'promise':
            this.internString(typed.__promiseId as string);
            break;
        }
        return;
      }

      // Regular object
      for (const [key, val] of Object.entries(value)) {
        this.internString(key);
        this.collectValueStrings(val as SerializedValue);
      }
    }
  }

  private internString(str: string): number {
    this.stats.totalStringsEncoded++;

    const existing = this.internMap.get(str);
    if (existing !== undefined) {
      return existing;
    }

    if (this.internTable.length >= MAX_INTERN_STRINGS) {
      throw new Error('Intern table overflow');
    }

    const index = this.internTable.length;
    this.internTable.push(str);
    this.internMap.set(str, index);
    return index;
  }

  // ============================================
  // Private: Header
  // ============================================

  private writeHeader(batchId: number, opCount: number, flags: number): void {
    this.ensureCapacity(HEADER_SIZE);

    this.writeU32(RILL_MAGIC);
    this.writeU16(PROTOCOL_VERSION);
    this.writeU32(batchId);
    this.writeU16(opCount);
    this.writeU8(flags);
    this.writeU8(0); // reserved[0]
    this.writeU8(0); // reserved[1]
    this.writeU8(0); // reserved[2]
  }

  private patchHeader(headerPos: number, opCount: number): void {
    // Patch opCount at offset 10
    this.view.setUint16(headerPos + 10, opCount, true);
  }

  // ============================================
  // Private: Intern Table
  // ============================================

  private writeInternTable(): void {
    // For now, write full table (delta encoding can be added later)
    const strings = this.internTable;

    this.writeU16(strings.length);

    const utf8 = createUtf8Encoder();
    for (const str of strings) {
      const encoded = utf8(str);
      this.writeU16(encoded.length);
      this.writeBytes(encoded);
    }
  }

  // ============================================
  // Private: Operations
  // ============================================

  private writeOperation(op: SerializedOperation): void {
    switch (op.op) {
      case 'CREATE':
        this.writeU8(OpType.CREATE);
        this.writeU32(op.id);
        this.writeU16(this.getInternIndex(op.type));
        this.writePropsTable(op.props);
        break;

      case 'UPDATE': {
        this.writeU8(OpType.UPDATE);
        this.writeU32(op.id);
        this.writePropsTable(op.props);
        // Removed props
        const removed = op.removedProps ?? [];
        this.writeU16(removed.length);
        for (const prop of removed) {
          this.writeU16(this.getInternIndex(prop));
        }
        break;
      }

      case 'DELETE':
        this.writeU8(OpType.DELETE);
        this.writeU32(op.id);
        break;

      case 'APPEND':
        this.writeU8(OpType.APPEND);
        this.writeU32(op.id);
        this.writeU32(op.parentId);
        this.writeU32(op.childId);
        break;

      case 'INSERT':
        this.writeU8(OpType.INSERT);
        this.writeU32(op.id);
        this.writeU32(op.parentId);
        this.writeU32(op.childId);
        this.writeU16(op.index);
        break;

      case 'REMOVE':
        this.writeU8(OpType.REMOVE);
        this.writeU32(op.id);
        this.writeU32(op.parentId);
        this.writeU32(op.childId);
        break;

      case 'REORDER':
        this.writeU8(OpType.REORDER);
        this.writeU32(op.id);
        this.writeU32(op.parentId);
        this.writeU16(op.childIds.length);
        for (const childId of op.childIds) {
          this.writeU32(childId);
        }
        break;

      case 'TEXT':
        this.writeU8(OpType.TEXT);
        this.writeU32(op.id);
        this.writeU16(this.getInternIndex(op.text));
        break;

      case 'REF_CALL':
        this.writeU8(OpType.REF_CALL);
        this.writeU32(op.id);
        this.writeU16(this.getInternIndex(op.method));
        this.writeU16(this.getInternIndex(op.callId));
        // Args array
        this.writeU16(op.args.length);
        for (const arg of op.args) {
          this.writeValue(arg);
        }
        break;
    }

    // Optional timestamp
    if (this.config.includeTimestamps && op.timestamp !== undefined) {
      this.writeU64(op.timestamp);
    }
  }

  // ============================================
  // Private: Props Table
  // ============================================

  private writePropsTable(props: SerializedValueObject): void {
    const entries = Object.entries(props);
    this.writeU16(entries.length);

    for (const [key, value] of entries) {
      this.writeU16(this.getInternIndex(key));
      this.writeValue(value);
    }
  }

  // ============================================
  // Private: Values
  // ============================================

  private writeValue(value: SerializedValue): void {
    if (value === null) {
      this.writeU8(ValueType.NULL);
      return;
    }

    if (value === undefined) {
      this.writeU8(ValueType.UNDEFINED);
      return;
    }

    if (typeof value === 'boolean') {
      this.writeU8(value ? ValueType.BOOL_TRUE : ValueType.BOOL_FALSE);
      return;
    }

    if (typeof value === 'number') {
      // Check if integer
      if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
        this.writeU8(ValueType.INT32);
        this.writeI32(value);
      } else {
        this.writeU8(ValueType.FLOAT64);
        this.writeF64(value);
      }
      return;
    }

    if (typeof value === 'string') {
      this.writeU8(ValueType.STRING);
      this.writeU16(this.getInternIndex(value));
      return;
    }

    if (typeof value === 'object') {
      // Check for serialized special types
      if ('__type' in value) {
        this.writeSpecialValue(value as { __type: string; [key: string]: ReviewedUnknown });
        return;
      }

      // Check for array
      if (Array.isArray(value)) {
        this.writeU8(ValueType.ARRAY);
        this.writeU16(value.length);
        for (const item of value) {
          this.writeValue(item);
        }
        return;
      }

      // Regular object
      this.writeU8(ValueType.OBJECT);
      const entries = Object.entries(value);
      this.writeU16(entries.length);
      for (const [key, val] of entries) {
        this.writeU16(this.getInternIndex(key));
        this.writeValue(val as SerializedValue);
      }
    }
  }

  private writeSpecialValue(value: { __type: string; [key: string]: ReviewedUnknown }): void {
    switch (value.__type) {
      case 'function': {
        // Byte layout locked to contracts/op-batch-wire.json values.FUNCTION:
        // fnId (internRef u16), then a u8 flags byte, then ONLY the present
        // optional fields IN ORDER — name (internRef u16, bit0), sourceFile
        // (internRef u16, bit1), sourceLine (u32 inline, NOT interned, bit2).
        // flags=0 => no metadata, one extra byte over a bare fnId. name/
        // sourceFile were interned in the collect pre-pass; here they are
        // REFERENCED via the flags (no longer orphan-interned).
        this.writeU8(ValueType.FUNCTION);
        this.writeU16(this.getInternIndex(value.__fnId as string));
        const fnName = value.__name as string | undefined;
        const fnSourceFile = value.__sourceFile as string | undefined;
        const fnSourceLine = value.__sourceLine as number | undefined;
        let fnFlags = 0x00;
        if (fnName) fnFlags |= 0x01;
        if (fnSourceFile) fnFlags |= 0x02;
        if (typeof fnSourceLine === 'number') fnFlags |= 0x04;
        this.writeU8(fnFlags);
        if (fnName) this.writeU16(this.getInternIndex(fnName));
        if (fnSourceFile) this.writeU16(this.getInternIndex(fnSourceFile));
        if (typeof fnSourceLine === 'number') this.writeU32(fnSourceLine);
        break;
      }

      case 'date': {
        this.writeU8(ValueType.DATE);
        // Parse ISO string to timestamp
        const timestamp = new Date(value.__value as string).getTime();
        this.writeF64(timestamp);
        break;
      }

      case 'error':
        this.writeU8(ValueType.ERROR);
        this.writeU16(this.getInternIndex(value.__name as string));
        this.writeU16(this.getInternIndex(value.__message as string));
        this.writeU16(this.getInternIndex((value.__stack as string) ?? ''));
        break;

      case 'regexp':
        this.writeU8(ValueType.REGEXP);
        this.writeU16(this.getInternIndex(value.__source as string));
        this.writeU16(this.getInternIndex(value.__flags as string));
        break;

      case 'map': {
        this.writeU8(ValueType.MAP);
        const mapEntries = value.__entries as [SerializedValue, SerializedValue][];
        this.writeU16(mapEntries.length);
        for (const [k, v] of mapEntries) {
          this.writeValue(k);
          this.writeValue(v);
        }
        break;
      }

      case 'set': {
        this.writeU8(ValueType.SET);
        const setValues = value.__values as SerializedValue[];
        this.writeU16(setValues.length);
        for (const v of setValues) {
          this.writeValue(v);
        }
        break;
      }

      case 'promise':
        this.writeU8(ValueType.PROMISE);
        this.writeU16(this.getInternIndex(value.__promiseId as string));
        break;

      default: {
        // Unknown type, encode as object
        this.writeU8(ValueType.OBJECT);
        const entries = Object.entries(value);
        this.writeU16(entries.length);
        for (const [key, val] of entries) {
          this.writeU16(this.getInternIndex(key));
          this.writeValue(val as SerializedValue);
        }
      }
    }
  }

  // ============================================
  // Private: Utilities
  // ============================================

  private getInternIndex(str: string): number {
    const index = this.internMap.get(str);
    if (index === undefined) {
      throw new Error(`String not interned: ${str}`);
    }
    return index;
  }

  private estimateJsonSize(batch: SerializedOperationBatch): number {
    // Quick estimate based on operation count
    // Real JSON would be larger due to formatting
    try {
      return JSON.stringify(batch).length;
    } catch {
      return batch.operations.length * 100; // Rough estimate
    }
  }

  // ============================================
  // Private: Buffer Operations
  // ============================================

  private ensureCapacity(needed: number): void {
    const required = this.pos + needed;
    if (required <= this.buffer.byteLength) return;

    // Grow buffer
    let newSize = this.buffer.byteLength * 2;
    while (newSize < required) {
      newSize *= 2;
    }

    if (newSize > this.config.maxBufferSize) {
      throw new Error(`Buffer overflow: required ${required}, max ${this.config.maxBufferSize}`);
    }

    const newBuffer = new ArrayBuffer(newSize);
    new Uint8Array(newBuffer).set(this.uint8);

    this.buffer = newBuffer;
    this.view = new DataView(this.buffer);
    this.uint8 = new Uint8Array(this.buffer);
  }

  private writeU8(value: number): void {
    this.ensureCapacity(1);
    this.uint8[this.pos++] = value;
  }

  private writeU16(value: number): void {
    this.ensureCapacity(2);
    this.view.setUint16(this.pos, value, true); // little-endian
    this.pos += 2;
  }

  private writeU32(value: number): void {
    this.ensureCapacity(4);
    this.view.setUint32(this.pos, value, true);
    this.pos += 4;
  }

  private writeU64(value: number): void {
    this.ensureCapacity(8);
    // Split into two 32-bit writes (JS doesn't have native 64-bit)
    this.view.setUint32(this.pos, value >>> 0, true);
    this.view.setUint32(this.pos + 4, Math.floor(value / 0x100000000), true);
    this.pos += 8;
  }

  private writeI32(value: number): void {
    this.ensureCapacity(4);
    this.view.setInt32(this.pos, value, true);
    this.pos += 4;
  }

  private writeF64(value: number): void {
    this.ensureCapacity(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
  }

  private writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.length);
    this.uint8.set(bytes, this.pos);
    this.pos += bytes.length;
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a binary encoder with default configuration
 */
export function createBinaryEncoder(config?: BinaryEncoderConfig): BinaryEncoder {
  return new BinaryEncoder(config);
}

/**
 * Encode a batch to binary (convenience function)
 */
export function encodeBatchToBinary(batch: SerializedOperationBatch): ArrayBuffer {
  const encoder = new BinaryEncoder();
  return encoder.encodeBatch(batch);
}
