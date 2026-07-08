/**
 * wire-decoder.ts
 *
 * ⚠️ WIP / EXPERIMENTAL — NOT wired into the live receive path.
 *
 * Streaming host-side decoder for the guest→host op-batch BINARY wire protocol.
 * The authoritative wire schema is contracts/op-batch-wire.json; the golden
 * oracle is contracts/op-batch-wire.golden.json. This decoder is generated
 * against / validated by those files and MUST NOT hand-copy any peer codec.
 *
 * Why this exists (and why it is separate from BinaryDecoder in
 * src/shared/bridge/binary-protocol.ts): the measured V8 win comes from a
 * STREAMING decode that walks each operation record and immediately hands it to
 * an `apply(op)` callback, WITHOUT materialising an intermediate
 * `operations: SerializedOperation[]` graph. Skipping that array (and the
 * transient object churn behind it) is the whole point; do not "helpfully" add
 * a mode that collects the ops into an array.
 *
 * FAIL-CLOSED contract (see limits in op-batch-wire.json):
 *   - Every read is bounds-checked against the buffer length before it happens;
 *     a malformed/truncated batch throws WireDecodeError and NOTHING partial is
 *     observable beyond the apply() calls already made for fully-decoded ops.
 *   - Bad magic / unsupported version / reserved-and-unimplemented flag bits
 *     (DELTA_INTERN, STRUCTURAL_ONLY, HAS_TIMESTAMPS) / unknown opcode / unknown
 *     value tag / out-of-range intern index / oversized batch / trailing bytes
 *     after the last op → typed throw, never an out-of-bounds read or a
 *     silently-wrapped length.
 *
 * INTEGRATION STATUS: experimental. The live path still uses PayloadEncoding
 * 'json' by default (see BinaryProtocolConfig). This file changes no defaults
 * and is not imported by the receive path — it is here for benchmarking and
 * eventual promotion.
 */

import type {
  SerializedFunction,
  SerializedOperation,
  SerializedValue,
  SerializedValueObject,
} from '../../shared/types';

// ============================================
// Wire constants (locked to contracts/op-batch-wire.json)
// ============================================

const RILL_MAGIC = 0x4c4c4952; // 'RILL', u32 LE
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 16;

// header.flags bitmask (batchFlags)
const FLAG_DELTA_INTERN = 0x01; // reserved in v1: recognise + reject
const FLAG_STRUCTURAL_ONLY = 0x02; // reserved in v1: recognise + reject
const FLAG_HAS_TIMESTAMPS = 0x04; // reserved in v1: recognise + reject (no per-op trailer in v1)
const KNOWN_FLAGS = FLAG_DELTA_INTERN | FLAG_STRUCTURAL_ONLY | FLAG_HAS_TIMESTAMPS;

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

// limits.maxBatchBytes — hard ceiling on one encoded batch buffer (16 MiB).
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

// Fail-closed guard against pathologically nested OBJECT/ARRAY/MAP/SET values.
// Locked to contracts/op-batch-wire.json limits.maxValueDepth (=64): bounds the
// recursion/allocation of nested container values so a maliciously deep value
// tree cannot overflow the C++ stack of a native peer or blow up this decoder's
// memory. 64 is generous for real RN prop/style trees (which nest a few levels).
const MAX_VALUE_DEPTH = 64;

// limits.maxTotalElements — inner element-count bound (the outer byte bound is
// maxBatchBytes). Locked to contracts/op-batch-wire.json limits.maxTotalElements
// (=1048576): the maximum number of DECODED ELEMENTS one batch may contain. An
// element is every VALUE NODE (each scalar AND each container, counted at every
// nesting level — a container's children counted in addition to the container
// itself), PLUS every REORDER childId, PLUS every UPDATE removedProp reference,
// PLUS every intern-table entry — each exactly 1, folded into ONE per-batch
// running count. Charging only value nodes left three non-value collections
// (REORDER childIds u32 each, UPDATE removedProps internRef each, intern-table
// entries) bounded solely by maxBatchBytes, so a legal <=16 MiB batch packed
// with them decoded to ~320-395 MB (measured). Folding all element kinds into
// this one cap bounds ALL decoder allocation to a single limit and closes that
// last non-value footprint path. The decoder maintains one running count over
// all element kinds and rejects fail-closed the moment it would exceed this cap,
// BEFORE allocating the offending element.
const MAX_TOTAL_ELEMENTS = 1048576;

// limits.maxDateMs — a DATE epochMs must be finite and within the ECMAScript
// Date range (±8.64e15 ms); beyond it a JS Date is Invalid (toISOString throws).
// The Rust encoder and C++ decoder share this exact domain (no drift).
const MAX_DATE_MS = 8.64e15;

// ============================================
// Typed error
// ============================================

/**
 * Every fail-closed rejection in this decoder throws this exact type, so callers
 * can distinguish a malformed batch from an unexpected host bug.
 */
export class WireDecodeError extends Error {
  /** Byte offset at which decoding failed, when known. */
  readonly offset?: number;

  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'WireDecodeError';
    this.offset = offset;
  }
}

// ============================================
// Header returned to the caller
// ============================================

export interface WireBatchHeader {
  version: number;
  batchId: number;
  opCount: number;
  flags: number;
}

/** Callback invoked once per fully-decoded operation, in wire order. */
export type ApplyOp = (op: SerializedOperation) => void;

// ============================================
// Streaming decoder
// ============================================

/**
 * Decode a binary op-batch, streaming each operation to `apply` as it is
 * decoded. No intermediate operations array is built.
 *
 * @returns the batch header (version / batchId / opCount / flags).
 * @throws {WireDecodeError} on any malformed, truncated, or oversized batch.
 */
export function decodeBatchStreaming(buffer: ArrayBuffer, apply: ApplyOp): WireBatchHeader {
  return new WireDecoder(buffer).run(apply);
}

class WireDecoder {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly len: number;
  private pos = 0;
  private intern: string[] = [];
  // limits.maxTotalElements: ONE running count of decoded ELEMENTS for THIS
  // batch, spanning every value node (bumped once per readValue, scalar or
  // container, every level) PLUS every REORDER childId, every UPDATE removedProp
  // reference, and every intern-table entry (all bulk-charged via charge()).
  // Checked against MAX_TOTAL_ELEMENTS; reset per batch in run().
  private totalValues = 0;
  // Single shared TextDecoder; fatal so invalid UTF-8 also fails closed.
  private static readonly utf8 = new TextDecoder('utf-8', { fatal: true });

  constructor(buffer: ArrayBuffer) {
    // limits.maxBatchBytes: reject an oversized buffer before touching it.
    if (buffer.byteLength > MAX_BATCH_BYTES) {
      throw new WireDecodeError(
        `Batch exceeds maxBatchBytes: ${buffer.byteLength} > ${MAX_BATCH_BYTES}`
      );
    }
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.len = buffer.byteLength;
  }

  run(apply: ApplyOp): WireBatchHeader {
    // Reset the per-batch element counter (a fresh decoder is one batch, but
    // reset explicitly so the maxTotalElements cap is unambiguously per batch).
    // This single count spans value nodes + intern entries + REORDER childIds +
    // UPDATE removedProps for the whole batch.
    this.totalValues = 0;
    const header = this.readHeader();

    // Rebuild the intern table ONCE for this batch (v1 always ships the full
    // table; DELTA_INTERN is rejected in readHeader).
    this.readInternTable();

    for (let i = 0; i < header.opCount; i++) {
      // Stream: decode one op, hand it off, keep no reference to it.
      apply(this.readOperation());
    }

    // STRICT TRAILING (contracts/op-batch-wire.json ops.$comment): a batch is
    // EXACTLY its declared opCount records — after the last one the buffer MUST
    // be fully consumed. Any leftover byte is a fail-closed whole-batch reject
    // (the encoder writes nothing after the final record). This matches the C++
    // decoder and closes the earlier drift where TS silently ignored trailers.
    if (this.pos !== this.len) {
      throw new WireDecodeError('trailing bytes after batch', this.pos);
    }

    return header;
  }

  private readHeader(): WireBatchHeader {
    // header is a fixed 16-byte prefix; require it whole up front.
    if (this.len < HEADER_SIZE) {
      throw new WireDecodeError(`Truncated header: ${this.len} < ${HEADER_SIZE} bytes`);
    }

    const magic = this.readU32();
    if (magic !== RILL_MAGIC) {
      throw new WireDecodeError(`Invalid magic: 0x${(magic >>> 0).toString(16)}`, 0);
    }

    const version = this.readU16();
    if (version !== PROTOCOL_VERSION) {
      throw new WireDecodeError(`Unsupported protocol version: ${version}`, 4);
    }

    const batchId = this.readU32();
    const opCount = this.readU16();
    const flags = this.readU8();

    // Reserved-but-unimplemented bits, and any unknown bit, fail closed in v1.
    const unknownBits = flags & ~KNOWN_FLAGS;
    if (unknownBits !== 0) {
      throw new WireDecodeError(`Unknown batch flag bits: 0x${unknownBits.toString(16)}`, 12);
    }
    if ((flags & FLAG_DELTA_INTERN) !== 0) {
      throw new WireDecodeError('DELTA_INTERN flag is reserved and unsupported in v1', 12);
    }
    if ((flags & FLAG_STRUCTURAL_ONLY) !== 0) {
      throw new WireDecodeError('STRUCTURAL_ONLY flag is reserved and unsupported in v1', 12);
    }
    if ((flags & FLAG_HAS_TIMESTAMPS) !== 0) {
      // Per the decision, HAS_TIMESTAMPS is reserved in v1: no per-op u64 trailer
      // is emitted or decoded. Reject fail-closed like the other reserved bits.
      throw new WireDecodeError('HAS_TIMESTAMPS flag is reserved and unsupported in v1', 12);
    }

    // reserved[3]: consumed (ignored on read) to reach the 16-byte boundary.
    this.pos += 3;

    return { version, batchId, opCount, flags };
  }

  // limits.maxTotalElements: fold `n` non-value elements (intern entries,
  // REORDER childIds, UPDATE removedProps) into the SAME per-batch running count
  // that readValue bumps for value nodes. Check the WHOLE count against the
  // remaining budget UP FRONT — before the array/strings are allocated or read —
  // so a batch that would overflow rejects fail-closed with nothing partial
  // materialised. `n` is always a u16 count so `totalValues + n` cannot wrap.
  private charge(n: number): void {
    if (this.totalValues + n > MAX_TOTAL_ELEMENTS) {
      throw new WireDecodeError(`total decoded elements exceed ${MAX_TOTAL_ELEMENTS}`, this.pos);
    }
    this.totalValues += n;
  }

  private readInternTable(): void {
    const count = this.readU16();
    // Charge every intern entry to the shared element budget BEFORE decoding any
    // string, so a table packed to the u16 max cannot inflate past the cap.
    this.charge(count);
    // Grow lazily (push), never `new Array(count)`: uniform with the value path,
    // and each entry costs >=2 wire bytes so the allocation is bounded by bytes
    // actually consumed.
    const table: string[] = [];
    for (let i = 0; i < count; i++) {
      const byteLen = this.readU16();
      const start = this.pos;
      this.require(byteLen, 'intern string');
      // subarray (not slice) avoids a copy; TextDecoder copies anyway.
      // fatal:true makes invalid UTF-8 throw TypeError — convert to a typed
      // fail-closed reject so callers never see a raw TypeError.
      try {
        table.push(WireDecoder.utf8.decode(this.bytes.subarray(start, start + byteLen)));
      } catch {
        throw new WireDecodeError('invalid UTF-8 in intern string', start);
      }
      this.pos = start + byteLen;
    }
    this.intern = table;
  }

  private readOperation(): SerializedOperation {
    const opcode = this.readU8();
    const id = this.readU32();

    let op: SerializedOperation;

    switch (opcode) {
      case OpType.CREATE: {
        const type = this.internRef();
        const props = this.readPropsTable();
        op = { op: 'CREATE', id, type, props };
        break;
      }

      case OpType.UPDATE: {
        const props = this.readPropsTable();
        const removedCount = this.readU16();
        // Charge every removedProp reference to the shared element budget BEFORE
        // allocating/reading the list (each internRef is 1 element).
        this.charge(removedCount);
        if (removedCount === 0) {
          op = { op: 'UPDATE', id, props };
        } else {
          const removedProps: string[] = [];
          for (let i = 0; i < removedCount; i++) {
            removedProps.push(this.internRef());
          }
          op = { op: 'UPDATE', id, props, removedProps };
        }
        break;
      }

      case OpType.DELETE:
        op = { op: 'DELETE', id };
        break;

      case OpType.APPEND: {
        const parentId = this.readU32();
        const childId = this.readU32();
        op = { op: 'APPEND', id, parentId, childId };
        break;
      }

      case OpType.INSERT: {
        const parentId = this.readU32();
        const childId = this.readU32();
        const index = this.readU16();
        op = { op: 'INSERT', id, parentId, childId, index };
        break;
      }

      case OpType.REMOVE: {
        const parentId = this.readU32();
        const childId = this.readU32();
        op = { op: 'REMOVE', id, parentId, childId };
        break;
      }

      case OpType.REORDER: {
        const parentId = this.readU32();
        const childCount = this.readU16();
        // Charge every childId to the shared element budget BEFORE allocating/
        // reading the list (each u32 childId is 1 element). Without this a legal
        // <=16 MiB batch of REORDER ops packed with childIds could inflate the
        // decoded id arrays past the intended element ceiling.
        this.charge(childCount);
        const childIds: number[] = [];
        for (let i = 0; i < childCount; i++) {
          childIds.push(this.readU32());
        }
        op = { op: 'REORDER', id, parentId, childIds };
        break;
      }

      case OpType.TEXT: {
        const text = this.internRef();
        op = { op: 'TEXT', id, text };
        break;
      }

      case OpType.REF_CALL: {
        const method = this.internRef();
        const callId = this.internRef();
        const argCount = this.readU16();
        const args: SerializedValue[] = [];
        for (let i = 0; i < argCount; i++) {
          args.push(this.readValue(0));
        }
        // refId is NOT on the wire; decoder mirrors id into refId.
        op = { op: 'REF_CALL', id, refId: id, method, callId, args };
        break;
      }

      default:
        throw new WireDecodeError(`Unknown opcode: 0x${opcode.toString(16)}`, this.pos - 5);
    }

    // v1 emits NO per-op trailer (HAS_TIMESTAMPS is reserved + rejected in
    // readHeader), so a record ends exactly at its last field.
    return op;
  }

  private readPropsTable(): SerializedValueObject {
    const count = this.readU16();
    const props: SerializedValueObject = {};
    for (let i = 0; i < count; i++) {
      const key = this.internRef();
      props[key] = this.readValue(0);
    }
    return props;
  }

  private readValue(depth: number): SerializedValue {
    // limits.maxTotalElements: this readValue call decodes exactly one value
    // node (scalar or container). Count it BEFORE decoding — and before any
    // allocation — so a batch packed with many tiny values fails closed the
    // moment the running total would exceed the cap, with nothing partial
    // crossing the seam. Matches the schema definition exactly: every value
    // node at every level = 1 (a container's children are counted in addition
    // to the container itself, since each is its own readValue).
    if (++this.totalValues > MAX_TOTAL_ELEMENTS) {
      throw new WireDecodeError(`total value count exceeds ${MAX_TOTAL_ELEMENTS}`, this.pos);
    }
    const tag = this.readU8();
    // Depth cap applies to CONTAINER values only: a scalar leaf sitting inside
    // the deepest allowed container must still decode. A container entered at
    // `depth` is the (depth+1)-th in the chain; reject the (maxValueDepth+1)-th.
    // This matches the Rust encoder and C++ decoder exactly (both reject the
    // 65th container when maxValueDepth=64), keeping all three codecs locked to
    // contracts/op-batch-wire.json. A scalar-inclusive `depth > MAX` entry guard
    // would admit one extra level and diverge from the native codecs.
    if (
      depth >= MAX_VALUE_DEPTH &&
      (tag === ValueType.OBJECT ||
        tag === ValueType.ARRAY ||
        tag === ValueType.MAP ||
        tag === ValueType.SET)
    ) {
      throw new WireDecodeError(`Value nesting exceeds ${MAX_VALUE_DEPTH}`, this.pos - 1);
    }

    switch (tag) {
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
      case ValueType.FLOAT64: {
        const v = this.readF64();
        // Contract: NaN/Infinity are not legal FLOAT64 wire values. The Rust
        // encoder and C++ decoder both reject non-finite; match them so a
        // hostile guest cannot leak NaN/Inf across the seam (no drift).
        if (!Number.isFinite(v)) {
          throw new WireDecodeError('non-finite FLOAT64', this.pos - 8);
        }
        return v;
      }

      case ValueType.STRING:
        return this.internRef();

      case ValueType.FUNCTION: {
        // Layout (contracts/op-batch-wire.json values.FUNCTION): fnId internRef,
        // then a u8 flags byte, then ONLY the present optional fields IN ORDER —
        // name (internRef, bit0), sourceFile (internRef, bit1), sourceLine (u32,
        // bit2). flags=0 => no metadata, one extra byte over a bare fnId. Present
        // strings are interned like every other string; sourceLine is inline u32.
        const fnId = this.internRef();
        const fnFlags = this.readU8();
        // bits 3..7 are reserved and MUST be written 0 (contracts/op-batch-wire.json
        // values.FUNCTION flags note). A set reserved bit implies unknown trailing
        // fields we cannot length, so reject fail-closed rather than desync the
        // stream — matching the C++ decoder (WireDecoder.cpp: (fnFlags & 0xF8)).
        if ((fnFlags & 0xf8) !== 0) {
          throw new WireDecodeError(
            `FUNCTION reserved flag bit set: 0x${fnFlags.toString(16)}`,
            this.pos - 1
          );
        }
        const fn: SerializedFunction = { __type: 'function', __fnId: fnId };
        if ((fnFlags & 0x01) !== 0) fn.__name = this.internRef();
        if ((fnFlags & 0x02) !== 0) fn.__sourceFile = this.internRef();
        if ((fnFlags & 0x04) !== 0) fn.__sourceLine = this.readU32();
        return fn;
      }

      case ValueType.OBJECT: {
        const count = this.readU16();
        const obj: SerializedValueObject = {};
        for (let i = 0; i < count; i++) {
          const key = this.internRef();
          obj[key] = this.readValue(depth + 1);
        }
        return obj;
      }

      case ValueType.ARRAY: {
        const count = this.readU16();
        // Fail-closed memory guard: each element is >=1 tag byte, so a count
        // larger than the bytes remaining cannot be real. Bound the allocation
        // to the buffer BEFORE new Array(count) — otherwise a trusted u16 count
        // (up to 65535) lets a tiny nested payload preallocate ~hundreds of MB.
        this.require(count, 'array');
        // Grow lazily (push), never `new Array(count)`: a trusted u16 count
        // (up to 65535) eagerly allocates a ~512 KB butterfly per level, so a
        // depth-nested payload could stack ~maxValueDepth of them before any
        // element is read. Pushing bounds the allocation to elements actually
        // decoded (each costs >=1 buffer byte).
        const arr: SerializedValue[] = [];
        for (let i = 0; i < count; i++) {
          arr.push(this.readValue(depth + 1));
        }
        return arr;
      }

      case ValueType.DATE: {
        const ms = this.readF64();
        // new Date(x).toISOString() throws RangeError on NaN/Inf or |ms| beyond
        // the valid Date span (limits.maxDateMs). Reject fail-closed as a typed
        // error, matching the Rust encoder and C++ decoder domain.
        if (!Number.isFinite(ms) || ms < -MAX_DATE_MS || ms > MAX_DATE_MS) {
          throw new WireDecodeError('invalid Date value', this.pos - 8);
        }
        return { __type: 'date' as const, __value: new Date(ms).toISOString() };
      }

      case ValueType.ERROR: {
        const name = this.internRef();
        const message = this.internRef();
        const stack = this.internRef();
        return {
          __type: 'error' as const,
          __name: name,
          __message: message,
          __stack: stack || undefined,
        };
      }

      case ValueType.REGEXP: {
        const source = this.internRef();
        const flags = this.internRef();
        return { __type: 'regexp' as const, __source: source, __flags: flags };
      }

      case ValueType.MAP: {
        const count = this.readU16();
        // Fail-closed memory guard (see ARRAY): each entry is >=2 bytes, so
        // `count` bytes remaining is a safe lower bound to cap the allocation.
        this.require(count, 'map');
        // Grow lazily (push), never `new Array(count)` — see ARRAY.
        const entries: [SerializedValue, SerializedValue][] = [];
        for (let i = 0; i < count; i++) {
          const key = this.readValue(depth + 1);
          const value = this.readValue(depth + 1);
          entries.push([key, value]);
        }
        return { __type: 'map' as const, __entries: entries };
      }

      case ValueType.SET: {
        const count = this.readU16();
        // Fail-closed memory guard (see ARRAY): each element is >=1 tag byte.
        this.require(count, 'set');
        // Grow lazily (push), never `new Array(count)` — see ARRAY.
        const values: SerializedValue[] = [];
        for (let i = 0; i < count; i++) {
          values.push(this.readValue(depth + 1));
        }
        return { __type: 'set' as const, __values: values };
      }

      case ValueType.PROMISE:
        return { __type: 'promise' as const, __promiseId: this.internRef() };

      default:
        throw new WireDecodeError(`Unknown value tag: 0x${tag.toString(16)}`, this.pos - 1);
    }
  }

  // --- intern resolution (fail-closed on out-of-range index) ---

  private internRef(): string {
    const idx = this.readU16();
    if (idx >= this.intern.length) {
      throw new WireDecodeError(
        `Intern index out of range: ${idx} >= ${this.intern.length}`,
        this.pos - 2
      );
    }
    return this.intern[idx]!;
  }

  // --- bounds-checked scalar reads (LE) ---

  /** Throw unless `n` more bytes are available from the current position. */
  private require(n: number, what: string): void {
    if (this.pos + n > this.len) {
      throw new WireDecodeError(
        `Truncated ${what}: need ${n} byte(s), ${this.len - this.pos} remaining`,
        this.pos
      );
    }
  }

  private readU8(): number {
    this.require(1, 'u8');
    return this.bytes[this.pos++]!;
  }

  private readU16(): number {
    this.require(2, 'u16');
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  private readU32(): number {
    this.require(4, 'u32');
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  private readI32(): number {
    this.require(4, 'i32');
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  private readF64(): number {
    this.require(8, 'f64');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
}
