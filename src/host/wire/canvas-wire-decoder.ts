/**
 * canvas-wire-decoder.ts
 *
 * ⚠️ WIP / EXPERIMENTAL — NOT wired into the live receive path.
 *
 * Zero-DOM host-side decoder for the guest→host CANVAS binary wire protocol.
 * The authoritative wire schema is contracts/canvas-wire.json; the golden oracle
 * is contracts/canvas-wire.golden.json (produced byte-for-byte by the Rust
 * encoder crates/rill-guest/src/canvas_encode.rs). This decoder is validated
 * against those files and MUST NOT hand-copy any peer codec.
 *
 * ZERO-DOM: this module references NO `document`, `HTMLCanvasElement`,
 * `CanvasRenderingContext2D`, or any other DOM/browser type. It decodes bytes
 * into a plain, JSON-shaped op array (the exact shape the guest DrawList JSON
 * path emits). The host replays that array onto its own <Canvas> surface. This
 * lets the platform bundle the decoder anywhere (worker, node, edge) without
 * special handling.
 *
 * FRAME ATOMICITY (contracts/canvas-wire.json ops.$comment): the one-shot
 * `decodeCanvasBatch` decodes the ENTIRE frame into an in-memory op array FIRST
 * and only returns it if the whole frame is valid; on ANY violation it throws
 * and NOTHING partial is observable — the host replays the full array or drops
 * the whole frame. `decodeCanvasBatchStreaming` yields ops lazily for callers
 * that stream, but still validates the whole header + op budget UP FRONT (before
 * yielding the first op), so a decode-amplification frame is rejected before any
 * work; a caller that needs atomicity buffers the yielded ops itself.
 *
 * FAIL-CLOSED contract (see reasons + limits in contracts/canvas-wire.json):
 *   - Every read is bounds-checked against the buffer length before it happens.
 *   - Bad magic / unsupported version / any reserved-or-unknown flag bit /
 *     opCount over budget / oversized frame / intern-table overflow / oversized
 *     canvasId or color string / oversized fillText / out-of-range intern ref /
 *     unknown opcode / malformed arc.ccw / non-finite f64 / buffer underrun /
 *     trailing bytes after exactly opCount records → typed `CanvasDecodeError`
 *     carrying one of the contract `reasons` tokens, never an out-of-bounds read
 *     or a silently-wrapped length.
 *
 * INTEGRATION STATUS: experimental. No live path imports it yet; it ships off.
 */

// ============================================
// Wire constants (locked to contracts/canvas-wire.json)
// ============================================

// magic.u32le — 0x564e4352 = 'RCNV' (bytes 52 43 4E 56). DISTINCT from op-batch's
// 0x4c4c4952 ('RILL'): the two differ at the 2nd byte, so a canvas frame fed to
// the op-batch decoder — and vice-versa — fails the u32 magic compare at once.
const CANVAS_MAGIC = 0x564e4352;
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 16;

// frameFlags: NONE is the only value a v1 encoder emits. COORDS_F32 (0x01) and
// every other bit are RESERVED in v1 → a decoder rejects any nonzero flags byte
// fail-closed (reason 'reserved-flag').
const FLAG_NONE = 0x00;

// opcodes (contracts/canvas-wire.json opcodes) — u8 tag leading every op record.
const Op = {
  beginPath: 1,
  closePath: 2,
  moveTo: 3,
  lineTo: 4,
  rect: 5,
  arc: 6,
  fill: 7,
  stroke: 8,
  fillRect: 9,
  strokeRect: 10,
  clearRect: 11,
  setFillStyle: 12,
  setStrokeStyle: 13,
  setLineWidth: 14,
  fillText: 15,
  save: 16,
  restore: 17,
  translate: 18,
  scale: 19,
  rotate: 20,
  setTransform: 21,
} as const;

// limits (contracts/canvas-wire.json limits) — all fail-closed.
const MAX_OPS = 20000; // maxOps — pre-checked against header.opCount BEFORE the loop.
const MAX_INTERN_STRINGS = 4096; // maxInternStrings — distinct color strings per frame.
const MAX_STRING_BYTES = 256; // maxStringBytes — canvasId / color string byte length.
const MAX_TEXT_BYTES = 8192; // maxTextBytes — fillText inline text byte length.
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // maxBatchBytes — 8 MiB hard ceiling per frame.

// ============================================
// Reason vocabulary + typed error
// ============================================

/**
 * The stable fail-closed reason tokens from contracts/canvas-wire.json `reasons`.
 * The host surfaces the token in its `host:canvas.draw` failure response
 * ({ ok:false, dropped:<opCount>, reason:<token> }).
 */
export type CanvasDecodeReason =
  | 'bad-magic'
  | 'bad-version'
  | 'reserved-flag'
  | 'op-budget'
  | 'frame-too-big'
  | 'intern-overflow'
  | 'string-too-big'
  | 'text-too-big'
  | 'bad-intern-ref'
  | 'bad-opcode'
  | 'non-finite'
  | 'truncated';

/**
 * Every fail-closed rejection throws this exact type, carrying the contract
 * `reason` token so callers can log the same word the Rust encoder uses and can
 * distinguish a malformed frame from an unexpected host bug.
 */
export class CanvasDecodeError extends Error {
  /** The contract `reasons` token for this rejection. */
  readonly reason: CanvasDecodeReason;
  /** Byte offset at which decoding failed, when known. */
  readonly offset?: number;

  constructor(reason: CanvasDecodeReason, message: string, offset?: number) {
    super(
      offset === undefined ? `${reason}: ${message}` : `${reason}: ${message} (at byte ${offset})`
    );
    this.name = 'CanvasDecodeError';
    this.reason = reason;
    this.offset = offset;
  }
}

// ============================================
// Decoded op + header shapes
// ============================================

/**
 * A decoded canvas op. The union is keyed on `op` and mirrors, field-for-field,
 * the guest DrawList JSON shape (crates/rill-guest/src/lib.rs canvas module and
 * the graphics-seams.json host:canvas.ops whitelist), so a golden vector's
 * `frame.ops` deep-equals `decodeCanvasBatch(fromHex(vector.hex))`.
 */
export type CanvasOp =
  | { op: 'beginPath' }
  | { op: 'closePath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number }
  | { op: 'arc'; x: number; y: number; r: number; start: number; end: number; ccw: boolean }
  | { op: 'fill' }
  | { op: 'stroke' }
  | { op: 'fillRect'; x: number; y: number; w: number; h: number }
  | { op: 'strokeRect'; x: number; y: number; w: number; h: number }
  | { op: 'clearRect'; x: number; y: number; w: number; h: number }
  | { op: 'setFillStyle'; color: string }
  | { op: 'setStrokeStyle'; color: string }
  | { op: 'setLineWidth'; w: number }
  | { op: 'fillText'; x: number; y: number; text: string }
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'translate'; x: number; y: number }
  | { op: 'scale'; x: number; y: number }
  | { op: 'rotate'; angle: number }
  | { op: 'setTransform'; a: number; b: number; c: number; d: number; e: number; f: number };

/** Frame-level metadata read from the fixed header + inline canvasId. */
export interface CanvasBatchHeader {
  version: number;
  frameId: number;
  /** The single target <Canvas> id for the whole frame (inline, not interned). */
  canvasId: string;
  opCount: number;
  flags: number;
}

/** Accepts an ArrayBuffer or any Uint8Array view (worker payloads arrive as the latter). */
export type CanvasWireInput = ArrayBuffer | Uint8Array;

// ============================================
// Public API
// ============================================

/**
 * Decode a whole canvas frame into a validated op array (frame-atomic): the
 * entire frame is decoded first; on ANY violation this throws and returns
 * nothing partial. Pre-checks header.opCount <= maxOps BEFORE the loop.
 *
 * @throws {CanvasDecodeError} on any malformed / truncated / oversized frame.
 */
export function decodeCanvasBatch(input: CanvasWireInput): CanvasOp[] {
  const d = new CanvasDecoder(input);
  d.readPrelude();
  const ops: CanvasOp[] = new Array(d.header.opCount);
  for (let i = 0; i < d.header.opCount; i++) {
    ops[i] = d.readOp();
  }
  d.finish();
  return ops;
}

/**
 * Decode a whole canvas frame, returning its header (incl. canvasId) alongside
 * the validated op array. Same frame-atomic guarantees as `decodeCanvasBatch`;
 * use this when the host needs the target canvasId / frameId as well as the ops.
 */
export function decodeCanvasFrame(input: CanvasWireInput): {
  header: CanvasBatchHeader;
  ops: CanvasOp[];
} {
  const d = new CanvasDecoder(input);
  d.readPrelude();
  const ops: CanvasOp[] = new Array(d.header.opCount);
  for (let i = 0; i < d.header.opCount; i++) {
    ops[i] = d.readOp();
  }
  d.finish();
  return { header: d.header, ops };
}

/**
 * Streaming form: yields ops one at a time in wire order. The full header + op
 * budget (magic / version / flags / opCount <= maxOps / frame-too-big) and the
 * canvasId + intern table are validated UP FRONT — before the first op is
 * yielded — so a decode-amplification frame is rejected without any per-op work.
 * The strict-trailing check runs after the last op. A caller that needs frame
 * atomicity buffers the yielded ops and drops them all if iteration throws.
 *
 * @throws {CanvasDecodeError} eagerly on a bad header/budget (before yielding),
 *   and mid-iteration on a malformed / truncated op record.
 */
export function decodeCanvasBatchStreaming(input: CanvasWireInput): IterableIterator<CanvasOp> {
  const d = new CanvasDecoder(input);
  // Eager: validate the entire header + prelude BEFORE returning the generator,
  // so opCount-over-budget and friends fail closed up front (not lazily on first
  // .next()). The generator below only walks the already-budgeted op records.
  d.readPrelude();
  return d.streamOps();
}

/**
 * Validate + read only the frame header and its inline canvasId (and the intern
 * table), returning the frame metadata without decoding any op. Useful for a
 * host that wants to resolve/short-circuit an unknown-canvas frame early, or
 * peek frameId, before committing to a full decode.
 *
 * @throws {CanvasDecodeError} on a bad header / oversized frame / bad canvasId.
 */
export function peekCanvasHeader(input: CanvasWireInput): CanvasBatchHeader {
  const d = new CanvasDecoder(input);
  d.readPrelude();
  return d.header;
}

// ============================================
// Decoder
// ============================================

class CanvasDecoder {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  /** Frame length in bytes (independent of any larger backing buffer). */
  private readonly len: number;
  /** Read cursor, RELATIVE to `base` (0 = frame start). */
  private pos = 0;
  private intern: string[] = [];

  // header is populated by readPrelude(); readers below assume it exists.
  header!: CanvasBatchHeader;

  // Single shared fatal TextDecoder so invalid UTF-8 also fails closed.
  private static readonly utf8 = new TextDecoder('utf-8', { fatal: true });

  constructor(input: CanvasWireInput) {
    let buffer: ArrayBuffer;
    let base: number;
    let len: number;
    if (input instanceof Uint8Array) {
      buffer = input.buffer as ArrayBuffer;
      base = input.byteOffset;
      len = input.byteLength;
    } else {
      buffer = input;
      base = 0;
      len = input.byteLength;
    }
    // limits.maxBatchBytes: reject an oversized frame before touching it.
    if (len > MAX_BATCH_BYTES) {
      throw new CanvasDecodeError('frame-too-big', `${len} > ${MAX_BATCH_BYTES}`);
    }
    this.view = new DataView(buffer, base, len);
    this.bytes = new Uint8Array(buffer, base, len);
    this.len = len;
  }

  /**
   * Read + validate the fixed 16-byte header, the inline canvasId and the intern
   * table (everything before the op records). Leaves `pos` at the first op.
   */
  readPrelude(): void {
    const header = this.readHeader();
    this.readCanvasId(header);
    this.readInternTable();
    this.header = header;
  }

  private readHeader(): CanvasBatchHeader {
    // header is a fixed 16-byte prefix; require it whole up front.
    if (this.len < HEADER_SIZE) {
      throw new CanvasDecodeError('truncated', `header ${this.len} < ${HEADER_SIZE} bytes`);
    }

    const magic = this.readU32();
    if (magic !== CANVAS_MAGIC) {
      throw new CanvasDecodeError('bad-magic', `0x${(magic >>> 0).toString(16)}`, 0);
    }

    const version = this.readU16();
    if (version !== PROTOCOL_VERSION) {
      throw new CanvasDecodeError('bad-version', `${version}`, 4);
    }

    const frameId = this.readU32();
    const opCount = this.readU32();
    const flags = this.readU8();

    // frameFlags: NONE is the only legal value in v1. COORDS_F32 and every other
    // bit are reserved → reject fail-closed.
    if (flags !== FLAG_NONE) {
      throw new CanvasDecodeError('reserved-flag', `0x${flags.toString(16)}`, 14);
    }

    // opCount vs maxOps: the decode-amplification guard, checked BEFORE the loop
    // (a tiny buffer claiming a huge op stream is rejected here, not by underrun).
    if (opCount > MAX_OPS) {
      throw new CanvasDecodeError('op-budget', `${opCount} > ${MAX_OPS}`, 10);
    }

    // reserved[1]: consumed (ignored on read) to reach the 16-byte boundary. A
    // nonzero reserved byte MUST NOT reject (forward-compat), per the schema.
    this.pos += 1;

    return { version, frameId, canvasId: '', opCount, flags };
  }

  private readCanvasId(header: CanvasBatchHeader): void {
    const byteLen = this.readU16();
    if (byteLen > MAX_STRING_BYTES) {
      throw new CanvasDecodeError(
        'string-too-big',
        `canvasId ${byteLen} > ${MAX_STRING_BYTES}`,
        this.pos - 2
      );
    }
    header.canvasId = this.readUtf8(byteLen, 'canvasId');
  }

  private readInternTable(): void {
    const count = this.readU16();
    // intern-overflow: table count must not exceed maxInternStrings.
    if (count > MAX_INTERN_STRINGS) {
      throw new CanvasDecodeError(
        'intern-overflow',
        `${count} > ${MAX_INTERN_STRINGS}`,
        this.pos - 2
      );
    }
    // Grow lazily (push), never `new Array(count)`: each entry costs >=2 wire
    // bytes so the allocation is bounded by bytes actually consumed.
    const table: string[] = [];
    for (let i = 0; i < count; i++) {
      const byteLen = this.readU16();
      if (byteLen > MAX_STRING_BYTES) {
        throw new CanvasDecodeError(
          'string-too-big',
          `color ${byteLen} > ${MAX_STRING_BYTES}`,
          this.pos - 2
        );
      }
      table.push(this.readUtf8(byteLen, 'intern color'));
    }
    this.intern = table;
  }

  /** Generator over the op records; validates strict-trailing after the last. */
  *streamOps(): IterableIterator<CanvasOp> {
    for (let i = 0; i < this.header.opCount; i++) {
      yield this.readOp();
    }
    this.finish();
  }

  /**
   * STRICT TRAILING (contracts/canvas-wire.json ops.$comment): a frame is EXACTLY
   * its declared opCount records — after the last, the buffer MUST be fully
   * consumed. Any leftover byte is a fail-closed whole-frame reject.
   */
  finish(): void {
    if (this.pos !== this.len) {
      throw new CanvasDecodeError(
        'truncated',
        `trailing bytes after ${this.header.opCount} ops`,
        this.pos
      );
    }
  }

  readOp(): CanvasOp {
    const opStart = this.pos;
    const opcode = this.readU8();
    switch (opcode) {
      case Op.beginPath:
        return { op: 'beginPath' };
      case Op.closePath:
        return { op: 'closePath' };
      case Op.moveTo:
        return { op: 'moveTo', x: this.readF64(), y: this.readF64() };
      case Op.lineTo:
        return { op: 'lineTo', x: this.readF64(), y: this.readF64() };
      case Op.rect:
        return {
          op: 'rect',
          x: this.readF64(),
          y: this.readF64(),
          w: this.readF64(),
          h: this.readF64(),
        };
      case Op.arc: {
        const x = this.readF64();
        const y = this.readF64();
        const r = this.readF64();
        const start = this.readF64();
        const end = this.readF64();
        const ccw = this.readBool();
        return { op: 'arc', x, y, r, start, end, ccw };
      }
      case Op.fill:
        return { op: 'fill' };
      case Op.stroke:
        return { op: 'stroke' };
      case Op.fillRect:
        return {
          op: 'fillRect',
          x: this.readF64(),
          y: this.readF64(),
          w: this.readF64(),
          h: this.readF64(),
        };
      case Op.strokeRect:
        return {
          op: 'strokeRect',
          x: this.readF64(),
          y: this.readF64(),
          w: this.readF64(),
          h: this.readF64(),
        };
      case Op.clearRect:
        return {
          op: 'clearRect',
          x: this.readF64(),
          y: this.readF64(),
          w: this.readF64(),
          h: this.readF64(),
        };
      case Op.setFillStyle:
        return { op: 'setFillStyle', color: this.internRef() };
      case Op.setStrokeStyle:
        return { op: 'setStrokeStyle', color: this.internRef() };
      case Op.setLineWidth:
        return { op: 'setLineWidth', w: this.readF64() };
      case Op.fillText: {
        const x = this.readF64();
        const y = this.readF64();
        const textLen = this.readU32();
        if (textLen > MAX_TEXT_BYTES) {
          throw new CanvasDecodeError(
            'text-too-big',
            `${textLen} > ${MAX_TEXT_BYTES}`,
            this.pos - 4
          );
        }
        const text = this.readUtf8(textLen, 'fillText text');
        return { op: 'fillText', x, y, text };
      }
      case Op.save:
        return { op: 'save' };
      case Op.restore:
        return { op: 'restore' };
      case Op.translate:
        return { op: 'translate', x: this.readF64(), y: this.readF64() };
      case Op.scale:
        return { op: 'scale', x: this.readF64(), y: this.readF64() };
      case Op.rotate:
        return { op: 'rotate', angle: this.readF64() };
      case Op.setTransform:
        return {
          op: 'setTransform',
          a: this.readF64(),
          b: this.readF64(),
          c: this.readF64(),
          d: this.readF64(),
          e: this.readF64(),
          f: this.readF64(),
        };
      default:
        throw new CanvasDecodeError('bad-opcode', `0x${opcode.toString(16)}`, opStart);
    }
  }

  // --- intern resolution (fail-closed on out-of-range index) ---

  private internRef(): string {
    const idx = this.readU16();
    if (idx >= this.intern.length) {
      throw new CanvasDecodeError(
        'bad-intern-ref',
        `${idx} >= ${this.intern.length}`,
        this.pos - 2
      );
    }
    return this.intern[idx]!;
  }

  // --- bounds-checked reads (all little-endian) ---

  /** Throw unless `n` more bytes are available from the current position. */
  private require(n: number, what: string): void {
    if (this.pos + n > this.len) {
      throw new CanvasDecodeError(
        'truncated',
        `${what}: need ${n}, ${this.len - this.pos} remaining`,
        this.pos
      );
    }
  }

  private readUtf8(byteLen: number, what: string): string {
    const start = this.pos;
    this.require(byteLen, what);
    // subarray (not slice) avoids a copy; TextDecoder copies anyway. fatal:true
    // makes invalid UTF-8 throw — convert to a typed fail-closed reject.
    // NOTE: subarray offsets are relative to this.bytes, whose backing view is
    // already based at `base`, so no extra offset arithmetic is needed here.
    let out: string;
    try {
      out = CanvasDecoder.utf8.decode(this.bytes.subarray(start, start + byteLen));
    } catch {
      throw new CanvasDecodeError('truncated', `invalid UTF-8 in ${what}`, start);
    }
    this.pos = start + byteLen;
    return out;
  }

  private readBool(): boolean {
    const b = this.readU8();
    // arc.ccw is a u8 bool: exactly 0 or 1. Any other byte is a malformed record.
    if (b === 0) return false;
    if (b === 1) return true;
    throw new CanvasDecodeError('bad-opcode', `arc.ccw not 0/1: ${b}`, this.pos - 1);
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

  private readF64(): number {
    this.require(8, 'f64');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    // Contract: every f64 on the wire MUST be finite; NaN/±Infinity are rejected
    // (canvas requires finite numbers), mirroring the guest DrawList finite latch.
    if (!Number.isFinite(v)) {
      throw new CanvasDecodeError('non-finite', 'NaN or Infinity', this.pos - 8);
    }
    return v;
  }
}
