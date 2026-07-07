import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SerializedOperation } from '../../../shared/types';
import {
  decodeBatchStreaming,
  WireDecodeError,
  type WireBatchHeader,
} from '../wire-decoder';

// The golden oracle: batch JSON paired with its exact on-the-wire hex.
// contracts/op-batch-wire.golden.json — same file every codec locks against.
interface GoldenVector {
  name: string;
  description: string;
  batch: { version: number; batchId: number; operations: SerializedOperation[] };
  hex: string;
  byteLength: number;
}

const GOLDEN = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../contracts/op-batch-wire.golden.json'),
    'utf-8'
  )
) as { version: number; vectors: GoldenVector[] };

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

/** Streaming decode → collect ops (test-only; the decoder itself builds no array). */
function decodeToOps(buffer: ArrayBuffer): {
  header: WireBatchHeader;
  ops: SerializedOperation[];
} {
  const ops: SerializedOperation[] = [];
  const header = decodeBatchStreaming(buffer, (op) => ops.push(op));
  return { header, ops };
}

describe('wire-decoder golden vectors', () => {
  for (const vec of GOLDEN.vectors) {
    it(`decodes '${vec.name}' back to the source batch`, () => {
      const buffer = hexToArrayBuffer(vec.hex);
      expect(buffer.byteLength).toBe(vec.byteLength);

      const { header, ops } = decodeToOps(buffer);

      expect(header.version).toBe(vec.batch.version);
      expect(header.batchId).toBe(vec.batch.batchId);
      expect(header.opCount).toBe(vec.batch.operations.length);
      // Streaming must reproduce the source operations exactly.
      expect(ops).toEqual(vec.batch.operations);
    });
  }

  it('streams ops in wire order without building an array in the decoder', () => {
    // mixed-five-ops exercises CREATE/CREATE/APPEND/TEXT/UPDATE in order.
    const vec = GOLDEN.vectors.find((v) => v.name === 'mixed-five-ops')!;
    const seen: string[] = [];
    decodeBatchStreaming(hexToArrayBuffer(vec.hex), (op) => seen.push(op.op));
    expect(seen).toEqual(['CREATE', 'CREATE', 'APPEND', 'TEXT', 'UPDATE']);
  });
});

describe('wire-decoder fail-closed rejections', () => {
  const goodHex = GOLDEN.vectors.find((v) => v.name === 'one-create')!.hex;

  it('rejects a bad magic', () => {
    const buf = hexToArrayBuffer(goodHex);
    new Uint8Array(buf)[0] = 0x00; // corrupt 'R'
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
  });

  it('rejects an unsupported version', () => {
    const buf = hexToArrayBuffer(goodHex);
    new Uint8Array(buf)[4] = 0x02; // version u16 low byte -> 2
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/version/i);
  });

  it('rejects reserved DELTA_INTERN flag', () => {
    const buf = hexToArrayBuffer(goodHex);
    new Uint8Array(buf)[12] = 0x01; // flags byte = DELTA_INTERN
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
  });

  it('rejects a truncated header', () => {
    const buf = hexToArrayBuffer(goodHex).slice(0, 10);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/truncated/i);
  });

  it('rejects a truncated body (declared op never fully present)', () => {
    // Cut mid-operation: header + intern survive, the op record is chopped.
    const buf = hexToArrayBuffer(goodHex).slice(0, 24);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
  });

  it('rejects an out-of-range intern index', () => {
    // one-create: bytes for `type = internRef 0` sit at the CREATE record.
    // Layout: 18 header+intern-count already consumed conceptually; the intern
    // string 'View' + opcode + id precede the type ref. Corrupt the type ref to
    // an index (0x00ff) far beyond the 1-entry table.
    const buf = hexToArrayBuffer(goodHex);
    const u8 = new Uint8Array(buf);
    // Find the type internRef: header(16)+internCount(2)+byteLen(2)+'View'(4)
    // + opcode(1) + id(4) = offset 29 for the 2-byte type ref.
    u8[29] = 0xff;
    u8[30] = 0x00;
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/intern index/i);
  });

  it('rejects an oversized batch buffer', () => {
    const huge = new ArrayBuffer(16 * 1024 * 1024 + 1);
    expect(() => decodeBatchStreaming(huge, () => {})).toThrow(/maxBatchBytes/i);
  });
});

// ---------------------------------------------------------------------------
// Adversarial fail-closed holes: memory-DoS, out-of-range Date, bad UTF-8.
// Each must throw the typed WireDecodeError — never RangeError/TypeError/OOM.
// ---------------------------------------------------------------------------

/** Little-endian byte writer for hand-crafting adversarial wire buffers. */
class ByteWriter {
  private readonly parts: number[] = [];
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  f64(v: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    for (const x of b) this.parts.push(x);
    return this;
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 0xff);
    return this;
  }
  raw(arr: number[]): this {
    for (const x of arr) this.parts.push(x & 0xff);
    return this;
  }
  build(): ArrayBuffer {
    return new Uint8Array(this.parts).buffer;
  }
}

/** 16-byte header + intern table ["View","k"], opCount=1. */
function writeCreateWithOneProp(w: ByteWriter): void {
  // header: magic 'RILL', version 1, batchId 0, opCount 1, flags 0, reserved[3]
  w.u32(0x4c4c4952).u16(1).u32(0).u16(1).u8(0).raw([0, 0, 0]);
  // intern table: index0='View' (CREATE type), index1='k' (prop key)
  w.u16(2);
  w.u16(4).ascii('View');
  w.u16(1).ascii('k');
  // op CREATE: opcode, id, type internRef=0, propsCount=1, key internRef=1
  w.u8(0x01).u32(1).u16(0).u16(1).u16(1);
}

/** Wrap a single value (written by `value`) as prop `k` of one CREATE op. */
function batchWithValue(value: (w: ByteWriter) => void): ArrayBuffer {
  const w = new ByteWriter();
  writeCreateWithOneProp(w);
  value(w);
  return w.build();
}

describe('wire-decoder MEMORY-DoS (nested collection preallocation)', () => {
  it('rejects an ARRAY whose u16 count exceeds the bytes remaining, without preallocating', () => {
    // tag ARRAY + count=65535, but zero elements follow: require() caps the
    // allocation to the buffer, so new Array(65535) is never reached.
    const buf = batchWithValue((w) => w.u8(0x09).u16(0xffff));
    expect(buf.byteLength).toBeLessThan(64); // proof: attack payload is tiny
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
  });

  it('rejects the same amplification for SET and MAP', () => {
    const set = batchWithValue((w) => w.u8(0x0e).u16(0xffff));
    const map = batchWithValue((w) => w.u8(0x0d).u16(0xffff));
    expect(() => decodeBatchStreaming(set, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(map, () => {})).toThrow(WireDecodeError);
  });

  it('rejects a deeply nested ARRAY via the depth guard, from a tiny buffer', () => {
    // 70 nested ARRAYs (each count=1) → exceeds maxValueDepth (64). The buffer
    // is a few hundred bytes; rejection must happen with no huge allocation.
    const buf = batchWithValue((w) => {
      for (let i = 0; i < 70; i++) w.u8(0x09).u16(1);
      w.u8(0x09).u16(0); // innermost empty array
    });
    expect(buf.byteLength).toBeLessThan(300);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
  });
});

describe('wire-decoder depth-cap boundary (parity with Rust/C++)', () => {
  it('decodes a value nested exactly at maxValueDepth (64 containers)', () => {
    // 63 nested ARRAY(count=1) + innermost ARRAY(count=0) = 64 containers. The
    // deepest container sits at decoder-depth 63 (< 64) and must decode.
    const buf = batchWithValue((w) => {
      for (let i = 0; i < 63; i++) w.u8(0x09).u16(1);
      w.u8(0x09).u16(0);
    });
    expect(() => decodeBatchStreaming(buf, () => {})).not.toThrow();
  });

  it('rejects a value nested one past maxValueDepth (65 containers)', () => {
    // 64 nested ARRAY(count=1) + innermost ARRAY(count=0) = 65 containers. The
    // 65th container is at decoder-depth 64 and must be rejected — matching the
    // Rust encoder and C++ decoder (which reject the 65th container).
    const buf = batchWithValue((w) => {
      for (let i = 0; i < 64; i++) w.u8(0x09).u16(1);
      w.u8(0x09).u16(0);
    });
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/nesting exceeds 64/i);
  });
});

describe('wire-decoder FLOAT64 non-finite guard (parity with Rust/C++)', () => {
  it('rejects a NaN FLOAT64 as WireDecodeError', () => {
    const buf = batchWithValue((w) => w.u8(0x05).f64(NaN));
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/non-finite/i);
  });

  it('rejects +Infinity and -Infinity FLOAT64', () => {
    const pos = batchWithValue((w) => w.u8(0x05).f64(Infinity));
    const neg = batchWithValue((w) => w.u8(0x05).f64(-Infinity));
    expect(() => decodeBatchStreaming(pos, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(neg, () => {})).toThrow(WireDecodeError);
  });

  it('still decodes a finite FLOAT64 after the guard', () => {
    const buf = batchWithValue((w) => w.u8(0x05).f64(3.5));
    const { ops } = decodeToOps(buf);
    const props = (ops[0] as Extract<SerializedOperation, { op: 'CREATE' }>).props;
    expect(props.k).toBe(3.5);
  });
});

describe('wire-decoder DATE range guard', () => {
  it('rejects a Date ms of 1e300 as WireDecodeError (not RangeError)', () => {
    const buf = batchWithValue((w) => w.u8(0x0a).f64(1e300));
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/invalid Date/i);
  });

  it('rejects a NaN Date ms as WireDecodeError', () => {
    const buf = batchWithValue((w) => w.u8(0x0a).f64(NaN));
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
  });

  it('still decodes a valid Date (epoch) after the guard', () => {
    const buf = batchWithValue((w) => w.u8(0x0a).f64(0));
    const { ops } = decodeToOps(buf);
    const props = (ops[0] as Extract<SerializedOperation, { op: 'CREATE' }>).props;
    expect(props.k).toEqual({ __type: 'date', __value: '1970-01-01T00:00:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// limits.maxTotalElements (=1048576): running value-node count across the whole
// batch. Every value node at every nesting level (scalar OR container) = 1. A
// batch whose node count would exceed the cap must reject fail-closed BEFORE
// materialising the offending value — never inflating a small buffer into a
// multi-hundred-MB decoded structure.
// ---------------------------------------------------------------------------

const MAX_TOTAL_ELEMENTS = 1048576;

/**
 * Build a CREATE whose single prop `k` is `outer` nested ARRAYs, each holding
 * `inner` NULL scalars. Total value-node count = 1 (top) + outer*(1 + inner).
 * The NULL tag is 0x00, so the element region is left zero-filled (no per-byte
 * writes) — this keeps a ~1M-node buffer to ~1 MB and builds it fast.
 */
function nestedArrayBatch(outer: number, inner: number): ArrayBuffer {
  const prefix = new ByteWriter();
  writeCreateWithOneProp(prefix); // header + intern + CREATE up to (incl) key ref
  prefix.u8(0x09).u16(outer); // top-level ARRAY: tag + count
  const head = new Uint8Array(prefix.build());

  const innerBlock = 3 + inner; // inner ARRAY tag(1) + count(2) + inner NULL bytes
  const out = new Uint8Array(head.length + outer * innerBlock);
  out.set(head, 0);
  const dv = new DataView(out.buffer);
  let p = head.length;
  for (let m = 0; m < outer; m++) {
    out[p] = 0x09; // inner ARRAY tag
    dv.setUint16(p + 1, inner, true); // inner count
    // the `inner` NULL (0x00) element tags are already zero-filled
    p += innerBlock;
  }
  return out.buffer;
}

describe('wire-decoder maxTotalElements (total value-node cap)', () => {
  it('rejects a batch whose value-node count exceeds the cap, without a multi-hundred-MB allocation', () => {
    // 17 * 65536 + 1 = 1,114,113 value nodes > 1,048,576 cap, packed in ~1 MB.
    const buf = nestedArrayBatch(17, 65535);
    const nodeCount = 1 + 17 * (1 + 65535);
    expect(nodeCount).toBeGreaterThan(MAX_TOTAL_ELEMENTS);
    // The attack buffer is ~1 MB — the point of the cap is that this does NOT
    // inflate into the hundreds of MB an uncapped decode would allocate.
    expect(buf.byteLength).toBeLessThan(2 * 1024 * 1024);

    // Bound the allocation incurred by the (failing) decode: the cap must trip
    // early, so heap growth stays far below a multi-hundred-MB blow-up.
    const before = process.memoryUsage().heapUsed;
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/total value count exceeds/i);
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(300 * 1024 * 1024);
  });

  it('decodes a batch whose value-node count sits just under the cap', () => {
    // 15 * 65536 + 1 = 983,041 value nodes < 1,048,576 cap: must decode fully,
    // proving the counter admits a large-but-legal batch (no false trip).
    const outer = 15;
    const inner = 65535;
    const nodeCount = 1 + outer * (1 + inner);
    expect(nodeCount).toBeLessThan(MAX_TOTAL_ELEMENTS);

    const buf = nestedArrayBatch(outer, inner);
    const { header, ops } = decodeToOps(buf);
    expect(header.opCount).toBe(1);
    const props = (ops[0] as Extract<SerializedOperation, { op: 'CREATE' }>).props;
    const top = props.k as unknown[];
    expect(Array.isArray(top)).toBe(true);
    expect(top.length).toBe(outer);
    expect((top[0] as unknown[]).length).toBe(inner);
    expect((top[0] as unknown[])[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// limits.maxTotalElements — BROADENED cap: the single per-batch running count
// now also charges the three non-value collections (REORDER childIds, UPDATE
// removedProps, and intern-table entries), not just value nodes. Each of these
// is only u16-capped per op (65535) but the aggregate across maxOps ops used to
// be bounded solely by maxBatchBytes, so a legal <=16 MiB batch packed with them
// decoded to ~320-395 MB. Charging every element to the one counter and
// rejecting BEFORE allocating the offending op's list bounds that footprint.
// ---------------------------------------------------------------------------

/**
 * Batch of `ops` REORDER records, each declaring `per` childIds (left 0), with
 * an EMPTY intern table and NO value nodes — so the shared element counter is
 * driven ENTIRELY by REORDER childIds. The childId bytes are all present, so an
 * uncharged decoder would materialise ~ops*per number[] entries (~hundreds of
 * MB); the broadened decoder must trip the moment the running childId total
 * would exceed the cap, before allocating the offending op's list.
 */
function reorderPackedBatch(ops: number, per: number): ArrayBuffer {
  const opBytes = 1 + 4 + 4 + 2 + per * 4; // opcode,id,parentId,childCount,childIds
  const prelude = 16 + 2; // 16-byte header + intern count(=0)
  const out = new Uint8Array(prelude + ops * opBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x4c4c4952, true); // magic 'RILL'
  dv.setUint16(4, 1, true); // version
  dv.setUint32(6, 0, true); // batchId
  dv.setUint16(10, ops, true); // opCount
  out[12] = 0; // flags; reserved[3] already 0
  dv.setUint16(16, 0, true); // intern count = 0
  let p = prelude;
  for (let o = 0; o < ops; o++) {
    out[p] = 0x07; // REORDER opcode
    dv.setUint32(p + 1, o + 1, true); // id
    dv.setUint32(p + 5, 1, true); // parentId
    dv.setUint16(p + 9, per, true); // childCount; childIds left 0
    p += opBytes;
  }
  return out.buffer;
}

/**
 * Batch of `ops` UPDATE records (empty props), each declaring `per` removedProps
 * (all internRef 0 → the single interned string 'k'), driving the shared element
 * counter ENTIRELY via UPDATE removedProps. Same amplification shape as
 * reorderPackedBatch but for the removedProps (internRef) collection.
 */
function removedPropsPackedBatch(ops: number, per: number): ArrayBuffer {
  const opBytes = 1 + 4 + 2 + 2 + per * 2; // opcode,id,propsCount(0),removedCount,removed refs
  const prelude = 16 + 2 + (2 + 1); // header + intern count(1) + ['k']
  const out = new Uint8Array(prelude + ops * opBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x4c4c4952, true);
  dv.setUint16(4, 1, true);
  dv.setUint32(6, 0, true);
  dv.setUint16(10, ops, true);
  out[12] = 0;
  let p = 16;
  dv.setUint16(p, 1, true); // intern count = 1
  p += 2;
  dv.setUint16(p, 1, true); // byteLen = 1
  p += 2;
  out[p] = 0x6b; // 'k'
  p += 1;
  for (let o = 0; o < ops; o++) {
    out[p] = 0x02; // UPDATE opcode
    dv.setUint32(p + 1, o + 1, true); // id
    dv.setUint16(p + 5, 0, true); // propsCount = 0
    dv.setUint16(p + 7, per, true); // removedCount; removed refs left 0 (='k')
    p += opBytes;
  }
  return out.buffer;
}

describe('wire-decoder maxTotalElements (non-value collections charged too)', () => {
  it('rejects a batch whose REORDER childIds push the total over the cap, without a multi-hundred-MB allocation', () => {
    // 17 * 65535 = 1,114,095 childIds > 1,048,576 cap. The counter trips on the
    // 17th op's charge (16 * 65535 = 1,048,560 already charged), BEFORE its
    // childIds are read — so nothing near the old ~380 MB childId decode occurs.
    const buf = reorderPackedBatch(17, 65535);
    expect(17 * 65535).toBeGreaterThan(MAX_TOTAL_ELEMENTS);

    const before = process.memoryUsage().heapUsed;
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/total decoded elements exceed/i);
    const after = process.memoryUsage().heapUsed;
    // Early trip: heap growth stays far below the old ~380 MB childId peak.
    expect(after - before).toBeLessThan(300 * 1024 * 1024);
  });

  it('rejects a batch whose UPDATE removedProps push the total over the cap, without a multi-hundred-MB allocation', () => {
    // 17 * 65535 removedProp internRefs > cap; trips on the 17th op's charge
    // (1 intern entry + 16 * 65535 = 1,048,561 already charged), BEFORE reading
    // that op's removed refs.
    const buf = removedPropsPackedBatch(17, 65535);
    expect(1 + 17 * 65535).toBeGreaterThan(MAX_TOTAL_ELEMENTS);

    const before = process.memoryUsage().heapUsed;
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/total decoded elements exceed/i);
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(300 * 1024 * 1024);
  });

  it('decodes an under-cap batch containing REORDER childIds and UPDATE removedProps', () => {
    const w = new ByteWriter();
    // header opCount=2, intern ['a','b']
    w.u32(0x4c4c4952).u16(1).u32(0).u16(2).u8(0).raw([0, 0, 0]);
    w.u16(2).u16(1).ascii('a').u16(1).ascii('b');
    // REORDER id=1 parentId=1 childIds=[10,20,30]
    w.u8(0x07).u32(1).u32(1).u16(3).u32(10).u32(20).u32(30);
    // UPDATE id=2 props{} removedProps=['a','b'] (internRefs 0,1)
    w.u8(0x02).u32(2).u16(0).u16(2).u16(0).u16(1);

    const { header, ops } = decodeToOps(w.build());
    expect(header.opCount).toBe(2);
    expect(ops[0]).toEqual({ op: 'REORDER', id: 1, parentId: 1, childIds: [10, 20, 30] });
    expect(ops[1]).toEqual({ op: 'UPDATE', id: 2, props: {}, removedProps: ['a', 'b'] });
  });
});

describe('wire-decoder intern-table UTF-8 guard', () => {
  it('rejects invalid UTF-8 (FF FE) in an intern string as WireDecodeError', () => {
    const w = new ByteWriter();
    // header with opCount 0, then one intern string of 2 invalid bytes.
    w.u32(0x4c4c4952).u16(1).u32(0).u16(0).u8(0).raw([0, 0, 0]);
    w.u16(1); // intern count = 1
    w.u16(2).raw([0xff, 0xfe]); // byteLen 2, invalid UTF-8
    const buf = w.build();
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(WireDecodeError);
    expect(() => decodeBatchStreaming(buf, () => {})).toThrow(/UTF-8/i);
  });
});
