import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeCanvasBatch,
  decodeCanvasBatchStreaming,
  decodeCanvasFrame,
  peekCanvasHeader,
  CanvasDecodeError,
  type CanvasOp,
} from '../canvas-wire-decoder';
// The op-batch decoder shares the wire home; used here to prove the two magics
// cross-reject (a canvas buffer fails the op-batch decoder and vice-versa).
import { decodeBatchStreaming, WireDecodeError } from '../wire-decoder';

// The golden oracle: source frame (canvasId/frameId/ops in the guest DrawList
// JSON shape) paired with its exact on-the-wire hex. Produced byte-for-byte by
// the Rust encoder (crates/rill-guest/src/canvas_encode.rs) — same file the
// Rust re-encode test locks against. contracts/canvas-wire.golden.json.
interface GoldenVector {
  name: string;
  description: string;
  frame: { canvasId: string; frameId: number; ops: CanvasOp[] };
  hex: string;
  byteLength: number;
}

const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/canvas-wire.golden.json'), 'utf-8')
) as { version: number; vectors: GoldenVector[] };

const OP_BATCH_GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/op-batch-wire.golden.json'), 'utf-8')
) as { version: number; vectors: { hex: string }[] };

/** hex string -> Uint8Array (frame buffer). */
function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** ArrayBuffer over exactly the frame bytes (op-batch decoder wants ArrayBuffer). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const byName = (n: string): GoldenVector => {
  const v = GOLDEN.vectors.find((x) => x.name === n);
  if (!v) throw new Error(`golden vector not found: ${n}`);
  return v;
};

// ============================================================
// Golden conformance: decode every vector to its expected op array
// ============================================================

describe('canvas decoder — golden conformance', () => {
  it('has the expected vector count (locked to the Rust oracle)', () => {
    expect(GOLDEN.vectors.length).toBe(27);
  });

  for (const v of GOLDEN.vectors) {
    it(`decodes '${v.name}' to its exact op array`, () => {
      const buf = fromHex(v.hex);
      expect(buf.byteLength).toBe(v.byteLength);

      // One-shot, frame-atomic form.
      const ops = decodeCanvasBatch(buf);
      expect(ops).toEqual(v.frame.ops);

      // Header form recovers canvasId + frameId + opCount alongside the ops.
      const framed = decodeCanvasFrame(buf);
      expect(framed.ops).toEqual(v.frame.ops);
      expect(framed.header.canvasId).toBe(v.frame.canvasId);
      expect(framed.header.frameId).toBe(v.frame.frameId);
      expect(framed.header.opCount).toBe(v.frame.ops.length);
      expect(framed.header.version).toBe(1);
      expect(framed.header.flags).toBe(0);

      // Header-only peek matches the full decode's header.
      const peeked = peekCanvasHeader(buf);
      expect(peeked).toEqual(framed.header);

      // Streaming form yields the identical op sequence.
      const streamed = [...decodeCanvasBatchStreaming(buf)];
      expect(streamed).toEqual(v.frame.ops);
    });
  }

  it('accepts an ArrayBuffer as well as a Uint8Array view', () => {
    const v = byName('move-to');
    const u8 = fromHex(v.hex);
    expect(decodeCanvasBatch(toArrayBuffer(u8))).toEqual(v.frame.ops);
  });

  it('decodes the at-limit (maxOps=20000) frame without tripping op-budget', () => {
    const v = byName('at-limit-ops');
    const framed = decodeCanvasFrame(fromHex(v.hex));
    expect(framed.header.opCount).toBe(20000);
    expect(framed.ops.length).toBe(20000);
  });

  it('interns a repeated color to a single table entry (shared string)', () => {
    const v = byName('repeated-colors');
    const ops = decodeCanvasBatch(fromHex(v.hex));
    expect(ops).toEqual(v.frame.ops);
  });

  it('decodes multibyte fillText (byte length != char count)', () => {
    const v = byName('fill-text-multibyte');
    const ops = decodeCanvasBatch(fromHex(v.hex)) as Extract<CanvasOp, { op: 'fillText' }>[];
    expect(ops[0].text).toBe((v.frame.ops[0] as { text: string }).text);
  });
});

// ============================================================
// Negative cases: every one fails closed with a typed reason
// ============================================================

/** Replace `count` bytes at byte offset `at` (in the hex-decoded buffer) with `repl`. */
function mutate(hex: string, at: number, repl: number[]): Uint8Array {
  const u8 = fromHex(hex);
  for (let i = 0; i < repl.length; i++) u8[at + i] = repl[i]!;
  return u8;
}

function expectReason(fn: () => unknown, reason: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CanvasDecodeError);
  expect((thrown as CanvasDecodeError).reason).toBe(reason as CanvasDecodeError['reason']);
}

describe('canvas decoder — fail-closed negatives', () => {
  const empty = byName('empty').hex;
  const beginPath = byName('begin-path').hex;
  const moveTo = byName('move-to').hex;
  const setFill = byName('set-fill-style').hex;
  const fillText = byName('fill-text').hex;

  it('bad-magic: header magic is not RCNV', () => {
    // Overwrite magic with 'RILL' (op-batch's) — differs at byte 1.
    expectReason(() => decodeCanvasBatch(mutate(empty, 0, [0x52, 0x49, 0x4c, 0x4c])), 'bad-magic');
  });

  it('bad-version: unsupported protocol version', () => {
    // version u16 at byte 4.
    expectReason(() => decodeCanvasBatch(mutate(empty, 4, [0x02, 0x00])), 'bad-version');
  });

  it('reserved-flag: a reserved flag bit is set', () => {
    // flags u8 at byte 14 (COORDS_F32 = 0x01 is reserved in v1).
    expectReason(() => decodeCanvasBatch(mutate(empty, 14, [0x01])), 'reserved-flag');
  });

  it('op-budget: header opCount exceeds maxOps (checked BEFORE the loop)', () => {
    // opCount u32 at byte 10 -> 20001 (0x4e21), one over maxOps=20000.
    expectReason(() => decodeCanvasBatch(mutate(empty, 10, [0x21, 0x4e, 0x00, 0x00])), 'op-budget');
  });

  it('string-too-big: oversized canvasId byteLen', () => {
    // canvasId byteLen u16 at byte 16 -> 257 (> maxStringBytes 256).
    expectReason(() => decodeCanvasBatch(mutate(empty, 16, [0x01, 0x01])), 'string-too-big');
  });

  it('string-too-big: oversized intern color byteLen', () => {
    // set-fill-style: intern entry byteLen u16 at byte 21 -> 257.
    expectReason(() => decodeCanvasBatch(mutate(setFill, 21, [0x01, 0x01])), 'string-too-big');
  });

  it('bad UTF-8 in an interned color fails closed', () => {
    // set-fill-style color bytes start at byte 23 ('#'=0x23); 0xff is never a
    // valid UTF-8 lead byte -> the fatal TextDecoder rejects the whole frame.
    expectReason(() => decodeCanvasBatch(mutate(setFill, 23, [0xff])), 'truncated');
  });

  it('text-too-big: fillText textLen exceeds maxTextBytes (checked before reading text)', () => {
    // fill-text textLen u32 sits after opcode(1)+x(8)+y(8): op record starts at
    // byte 21 (opcode 0x0f), so textLen is at byte 21+1+8+8 = 38 -> 8193.
    expectReason(() => decodeCanvasBatch(mutate(fillText, 38, [0x01, 0x20, 0x00, 0x00])), 'text-too-big');
  });

  it('intern-overflow: intern count exceeds maxInternStrings', () => {
    // empty frame: intern count u16 is the last field (byte 19) -> 4097 (> 4096).
    expectReason(() => decodeCanvasBatch(mutate(empty, 19, [0x01, 0x10])), 'intern-overflow');
  });

  it('bad-intern-ref: setFillStyle references an index past the table', () => {
    // set-fill-style: op record is opcode 0x0c at byte 30, internRef u16 at 31.
    // Table count is 1, so idx 1 is out of range.
    expectReason(() => decodeCanvasBatch(mutate(setFill, 31, [0x01, 0x00])), 'bad-intern-ref');
  });

  it('bad-opcode: unknown opcode byte', () => {
    // begin-path: opcode is the last byte (offset 21). 0x63 (99) is undefined.
    expectReason(() => decodeCanvasBatch(mutate(beginPath, 21, [0x63])), 'bad-opcode');
  });

  it('bad-opcode: arc.ccw is neither 0 nor 1', () => {
    const arc = byName('arc-cw').hex;
    // arc record: opcode(1)+5*f64(40) = 41 bytes, ccw is the last byte.
    const u8 = fromHex(arc);
    u8[u8.length - 1] = 0x02; // ccw = 2 -> malformed
    expectReason(() => decodeCanvasBatch(u8), 'bad-opcode');
  });

  it('non-finite: an f64 coordinate is +Infinity', () => {
    // move-to: op record at byte 21 (opcode 0x03), x f64 at byte 22.
    // +Infinity = 0x7ff0000000000000 -> LE bytes 00 00 00 00 00 00 f0 7f.
    expectReason(
      () => decodeCanvasBatch(mutate(moveTo, 22, [0, 0, 0, 0, 0, 0, 0xf0, 0x7f])),
      'non-finite'
    );
  });

  it('truncated: buffer underruns mid-record', () => {
    // move-to minus its last 4 bytes -> y f64 read underruns.
    const u8 = fromHex(moveTo).subarray(0, byName('move-to').byteLength - 4);
    expectReason(() => decodeCanvasBatch(u8), 'truncated');
  });

  it('truncated: trailing bytes after exactly opCount records', () => {
    // A valid empty frame + one extra byte -> strict-trailing reject.
    const u8 = fromHex(empty);
    const padded = new Uint8Array(u8.length + 1);
    padded.set(u8);
    padded[u8.length] = 0xff;
    expectReason(() => decodeCanvasBatch(padded), 'truncated');
  });

  it('truncated: buffer shorter than the fixed 16-byte header', () => {
    expectReason(() => decodeCanvasBatch(new Uint8Array(8)), 'truncated');
  });

  it('frame-too-big: buffer exceeds maxBatchBytes', () => {
    const tooBig = new Uint8Array(8 * 1024 * 1024 + 1);
    expectReason(() => decodeCanvasBatch(tooBig), 'frame-too-big');
  });

  it('streaming form rejects op-budget UP FRONT (before yielding any op)', () => {
    // Even the lazy iterator validates the header/budget eagerly: constructing
    // the iterator throws, so no op is ever yielded from an over-budget frame.
    expectReason(
      () => decodeCanvasBatchStreaming(mutate(empty, 10, [0x21, 0x4e, 0x00, 0x00])),
      'op-budget'
    );
  });
});

// ============================================================
// Cross-magic: the two sister wires reject each other's buffers
// ============================================================

describe('canvas / op-batch magics cross-reject', () => {
  it('the op-batch decoder rejects a canvas (RCNV) buffer', () => {
    const canvasBuf = toArrayBuffer(fromHex(byName('empty').hex));
    expect(() => decodeBatchStreaming(canvasBuf, () => {})).toThrow(WireDecodeError);
  });

  it('the canvas decoder rejects an op-batch (RILL) buffer with bad-magic', () => {
    const opBatchBuf = fromHex(OP_BATCH_GOLDEN.vectors[0]!.hex);
    expectReason(() => decodeCanvasBatch(opBatchBuf), 'bad-magic');
  });
});
