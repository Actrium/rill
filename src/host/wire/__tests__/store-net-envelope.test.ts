import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeEnvelope,
  decodeRequest as decodeRbs1Request,
  encodeEnvelope,
  encodeResult as encodeRbs1Result,
  hoistSentinels,
  isRbs1,
  LIMITS,
  RBS1_MAGIC,
  reviveSentinels,
  StoreNetEnvelopeError,
  type StoreNetReason,
} from '../store-net-envelope';

const CONTRACTS = join(import.meta.dir, '../../../../contracts');

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// ============================================================
// framing primitives
// ============================================================

describe('store-net-envelope — framing primitives', () => {
  it('encodeEnvelope lays out magic, jsonLen, json, segCount, segments (LE)', () => {
    const json = '{"v":{"$b":0}}';
    const seg = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const out = encodeEnvelope(json, [seg]);
    const view = new DataView(out.buffer);
    expect(view.getUint32(0, true)).toBe(RBS1_MAGIC);
    expect(view.getUint32(4, true)).toBe(json.length);
    expect(new TextDecoder().decode(out.subarray(8, 8 + json.length))).toBe(json);
    expect(view.getUint32(8 + json.length, true)).toBe(1); // segCount
    expect(view.getUint32(12 + json.length, true)).toBe(4); // segLen
    expect(out.length).toBe(12 + json.length + 4 + seg.length);
  });

  it('decodeEnvelope round-trips json + segments, including 0x00/0xFF', () => {
    const json = '{"a":{"$b":0},"b":{"$b":1}}';
    const s0 = new Uint8Array([0x00, 0xff, 0x00, 0xff]);
    const s1 = new Uint8Array([]);
    const frame = encodeEnvelope(json, [s0, s1]);
    const dec = decodeEnvelope(frame);
    expect(new TextDecoder().decode(dec.json)).toBe(json);
    expect(dec.segments).toHaveLength(2);
    expect([...dec.segments[0]]).toEqual([0x00, 0xff, 0x00, 0xff]);
    expect(dec.segments[1].length).toBe(0);
  });

  it('isRbs1 compares the full u32 magic, not byte 0', () => {
    expect(isRbs1(new Uint8Array([0x52, 0x42, 0x53, 0x31]))).toBe(true);
    // shares byte 0 with RCNV / RILL but differs at byte 1 — must NOT match.
    expect(isRbs1(new Uint8Array([0x52, 0x43, 0x4e, 0x56]))).toBe(false); // RCNV
    expect(isRbs1(new Uint8Array([0x52, 0x49, 0x4c, 0x4c]))).toBe(false); // RILL
    expect(isRbs1(new Uint8Array([0x7b]))).toBe(false); // '{' plain JSON
  });
});

// ============================================================
// sentinel walking + back-compat
// ============================================================

describe('store-net-envelope — hoist / revive', () => {
  it('hoists nested Uint8Array to {"$b":N} in walk order and revives', () => {
    const value = {
      a: new Uint8Array([0xaa]),
      b: [new Uint8Array([0xbb, 0xbb]), new Uint8Array([])],
      c: 'plain',
    };
    const { control, segments } = hoistSentinels(value);
    expect(control).toEqual({ a: { $b: 0 }, b: [{ $b: 1 }, { $b: 2 }], c: 'plain' });
    expect(segments).toHaveLength(3);
    const revived = reviveSentinels(control, segments) as typeof value;
    expect([...revived.a]).toEqual([0xaa]);
    expect([...revived.b[0]]).toEqual([0xbb, 0xbb]);
    expect(revived.b[1].length).toBe(0);
    expect(revived.c).toBe('plain');
  });

  it('encodeResult returns null (plain JSON) for a segment-free result — back-compat', () => {
    expect(encodeRbs1Result({ version: 1 })).toBeNull();
    expect(encodeRbs1Result(null)).toBeNull();
    expect(encodeRbs1Result({ nested: { a: [1, 2, 3], b: 'x' } })).toBeNull();
  });

  it('encodeResult frames an RBS1 envelope for a byte-carrying result', () => {
    const frame = encodeRbs1Result({ value: new Uint8Array([1, 2, 3]), version: 4 });
    expect(frame).not.toBeNull();
    const revived = decodeRbs1Request(frame as Uint8Array) as { value: Uint8Array; version: number };
    expect([...revived.value]).toEqual([1, 2, 3]);
    expect(revived.version).toBe(4);
  });

  it('decodeRbs1Request revives {"$b":N} into Uint8Array for dispatch', () => {
    const frame = encodeEnvelope('{"key":"k","value":{"$b":0}}', [new Uint8Array([9, 9])]);
    const args = decodeRbs1Request(frame) as { key: string; value: Uint8Array };
    expect(args.key).toBe('k');
    expect(args.value).toBeInstanceOf(Uint8Array);
    expect([...args.value]).toEqual([9, 9]);
  });

  it('rejects reserved "$b" key ONLY when the value also carries bytes (collision guard)', () => {
    // The collision is only breakable when an envelope is framed. A segment-free
    // value with a literal `$b` key takes the plain-JSON path (never revived) and
    // MUST ride through unchanged — the back-compat invariant. Parity with Rust.
    const reason = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(StoreNetEnvelopeError);
        return (e as StoreNetEnvelopeError).reason;
      }
      return null;
    };
    // Harmless: no byte streams -> passes through, no throw.
    expect(reason(() => hoistSentinels({ $b: 0 }))).toBeNull();
    expect(hoistSentinels({ $b: 0 })).toEqual({ control: { $b: 0 }, segments: [] });
    expect(reason(() => hoistSentinels([{ $b: 1 }]))).toBeNull();
    // Dangerous: mixed with a real byte stream (segment 0 exists, so the collision
    // would revive to bytes, not fail-closed on an out-of-range index) -> reject.
    expect(reason(() => hoistSentinels({ payload: new Uint8Array([9]), meta: { $b: 0 } }))).toBe(
      'bad-sentinel'
    );
  });

  it('a segment-free "$b" result yields the identical plain-JSON reply (back-compat)', () => {
    // The always-on host reply path (resolve -> encodeResult) must return null for
    // a non-binary result even when it contains `$b`, so the caller emits the
    // byte-for-byte-same JSON.stringify bytes as before this guard existed.
    expect(encodeRbs1Result({ $b: 7, note: 'plain' })).toBeNull();
  });
});

// ============================================================
// random-structure round-trip property (R2 acceptance)
// ============================================================

describe('store-net-envelope — random round-trip property', () => {
  // mulberry32: a seeded, deterministic PRNG (no Math.random — a failure is a
  // fixed, replayable counter-example). Returns a float in [0, 1).
  const makeRng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Random JSON-ish value with Uint8Array leaves. Keys are `k0..` (never the
  // reserved `$b`); numbers are small integers (exact JSON round-trip); byte
  // streams draw the full 0x00..0xFF range and may be empty. Random NESTING and
  // segment placement is the structural coverage the fixed vectors cannot give.
  const gen = (rng: () => number, depth: number): unknown => {
    const below = (n: number) => Math.floor(rng() * n);
    switch (depth === 0 ? below(5) : below(7)) {
      case 0:
        return null;
      case 1:
        return rng() < 0.5;
      case 2:
        return below(1_000_000) - 500_000;
      case 3: {
        let s = '';
        for (let i = below(8); i > 0; i--) s += String.fromCharCode(97 + below(26));
        return s;
      }
      case 4: {
        const b = new Uint8Array(below(24));
        for (let i = 0; i < b.length; i++) b[i] = below(256);
        return b;
      }
      case 5:
        return Array.from({ length: below(5) }, () => gen(rng, depth - 1));
      default: {
        const o: Record<string, unknown> = {};
        for (let i = below(5); i > 0; i--) o[`k${i}`] = gen(rng, depth - 1);
        return o;
      }
    }
  };

  // Normalize Uint8Array leaves to tagged number arrays so a structural
  // `toEqual` compares byte CONTENT (not view identity/offset) at any depth.
  const norm = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return { __b: [...v] };
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = norm(val);
      return o;
    }
    return v;
  };

  it('encode → decode is the identity for random nested byte-carrying values', () => {
    const rng = makeRng(0x1234_5678);
    for (let iter = 0; iter < 1000; iter++) {
      // Root is always an object (store/net values are structured), values random.
      const root: Record<string, unknown> = {};
      for (let i = (Math.floor(rng() * 5) as number) + 1; i > 0; i--) root[`k${i}`] = gen(rng, 4);
      // Full host path: hoist any bytes into an RBS1 frame, else plain JSON; then
      // decode back. `encodeResult` returns null when there are no byte streams.
      const frame = encodeRbs1Result(root);
      const decoded = frame === null ? JSON.parse(JSON.stringify(root)) : decodeRbs1Request(frame);
      expect(norm(decoded)).toEqual(norm(root));
    }
  });
});

// ============================================================
// fail-closed cap negatives (every reason token)
// ============================================================

describe('store-net-envelope — fail-closed', () => {
  const expectReason = (fn: () => unknown, reason: StoreNetReason) => {
    try {
      fn();
      throw new Error(`expected ${reason}`);
    } catch (e) {
      expect(e).toBeInstanceOf(StoreNetEnvelopeError);
      expect((e as StoreNetEnvelopeError).reason).toBe(reason);
    }
  };

  it('bad-magic on a plain-JSON body and a corrupt frame', () => {
    expectReason(() => decodeEnvelope(new TextEncoder().encode('{"x":1}')), 'bad-magic');
    const frame = encodeEnvelope('{}', [new Uint8Array([1])]);
    frame[1] ^= 0xff;
    expectReason(() => decodeEnvelope(frame), 'bad-magic');
  });

  it('truncated at every prefix and on trailing bytes', () => {
    const frame = encodeEnvelope('{"v":{"$b":0}}', [new Uint8Array([1, 2, 3, 4])]);
    for (let cut = 4; cut < frame.length; cut++) {
      expect(() => decodeEnvelope(frame.subarray(0, cut))).toThrow(StoreNetEnvelopeError);
    }
    const extra = new Uint8Array(frame.length + 1);
    extra.set(frame);
    expectReason(() => decodeEnvelope(extra), 'truncated');
  });

  it('too-many-segments on encode and decode', () => {
    const segs = Array.from({ length: LIMITS.maxSegments + 1 }, () => new Uint8Array([0]));
    expectReason(() => encodeEnvelope('{}', segs), 'too-many-segments');
    // decode: forge a header with an over-cap segCount.
    const buf = new Uint8Array(12);
    new DataView(buf.buffer).setUint32(0, RBS1_MAGIC, true);
    new DataView(buf.buffer).setUint32(8, LIMITS.maxSegments + 1, true);
    expectReason(() => decodeEnvelope(buf), 'too-many-segments');
  });

  it('segment-too-big on encode and decode', () => {
    const big = new Uint8Array(LIMITS.maxSegmentBytes + 1);
    expectReason(() => encodeEnvelope('{"v":{"$b":0}}', [big]), 'segment-too-big');
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, RBS1_MAGIC, true);
    dv.setUint32(8, 1, true); // segCount
    dv.setUint32(12, LIMITS.maxSegmentBytes + 1, true); // segLen over cap
    expectReason(() => decodeEnvelope(buf), 'segment-too-big');
  });

  it('json-too-big on encode and decode', () => {
    const big = ' '.repeat(LIMITS.maxJsonBytes + 1);
    expectReason(() => encodeEnvelope(big, []), 'json-too-big');
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, RBS1_MAGIC, true);
    dv.setUint32(4, LIMITS.maxJsonBytes + 1, true);
    expectReason(() => decodeEnvelope(buf), 'json-too-big');
  });

  it('envelope-too-big on a whole buffer over the aggregate cap', () => {
    const buf = new Uint8Array(LIMITS.maxEnvelopeBytes + 1);
    new DataView(buf.buffer).setUint32(0, RBS1_MAGIC, true);
    expectReason(() => decodeEnvelope(buf), 'envelope-too-big');
  });

  it('bad-segment-ref and bad-sentinel on revive', () => {
    const outOfRange = encodeEnvelope('{"v":{"$b":5}}', [new Uint8Array([1])]);
    expectReason(() => decodeRbs1Request(outOfRange), 'bad-segment-ref');
    const extraKey = encodeEnvelope('{"v":{"$b":0,"x":1}}', [new Uint8Array([1])]);
    expectReason(() => decodeRbs1Request(extraKey), 'bad-sentinel');
    const nonInt = encodeEnvelope('{"v":{"$b":"0"}}', [new Uint8Array([1])]);
    expectReason(() => decodeRbs1Request(nonInt), 'bad-sentinel');
  });

  it('bad-json when the control plane is not JSON', () => {
    const frame = encodeEnvelope('{not json', []);
    expectReason(() => decodeRbs1Request(frame), 'bad-json');
  });

  it('envelope-too-big on the ENCODE side when segments aggregate past the cap', () => {
    // The decode-side aggregate check is above; this locks the matching encode
    // guard (four at-cap 1 MiB segments already exceed the 4 MiB envelope cap).
    const segs = Array.from(
      { length: 4 },
      () => new Uint8Array(LIMITS.maxSegmentBytes)
    );
    expectReason(() => encodeEnvelope('{}', segs), 'envelope-too-big');
  });
});

// ============================================================
// at-cap acceptance (strict `>` caps: exactly-at-limit succeeds)
// ============================================================

describe('store-net-envelope — at-cap acceptance', () => {
  it('exactly MAX_SEGMENTS segments round-trips', () => {
    const segs = Array.from({ length: LIMITS.maxSegments }, () => new Uint8Array([0x5a]));
    const frame = encodeEnvelope('{}', segs);
    expect(decodeEnvelope(frame).segments).toHaveLength(LIMITS.maxSegments);
  });

  it('a json of exactly maxJsonBytes is accepted', () => {
    const json = ' '.repeat(LIMITS.maxJsonBytes);
    const frame = encodeEnvelope(json, [new Uint8Array([1])]);
    expect(decodeEnvelope(frame).json).toHaveLength(LIMITS.maxJsonBytes);
  });

  it('a frame whose total length is exactly maxEnvelopeBytes is accepted', () => {
    // Layout = 12 (magic+jsonLen+segCount) + jsonLen + Σ(4 + segLen). Size four
    // segments to land the total exactly on the cap; frame.length self-checks.
    const segCount = 4;
    const header = 12 + '{}'.length;
    const body = LIMITS.maxEnvelopeBytes - header - segCount * 4;
    const per = Math.floor(body / segCount);
    const rem = body % segCount;
    expect(per + rem).toBeLessThanOrEqual(LIMITS.maxSegmentBytes);
    const segs = Array.from(
      { length: segCount },
      (_, i) => new Uint8Array(per + (i === 0 ? rem : 0))
    );
    const frame = encodeEnvelope('{}', segs);
    expect(frame.length).toBe(LIMITS.maxEnvelopeBytes);
    expect(() => decodeEnvelope(frame)).not.toThrow();
  });
});

// ============================================================
// cross-language golden lock (Rust encoder is the oracle)
// ============================================================

describe('store-net-envelope — golden cross-language lock', () => {
  interface GoldenSeg {
    hex?: string;
    fill?: string;
    len?: number;
  }
  interface GoldenVector {
    name: string;
    kind: 'plain' | 'envelope';
    controlPlane: string;
    segments: GoldenSeg[];
    rawJsonHex?: string;
    envelopeLen?: number;
    envelopeHex?: string;
  }
  const golden = JSON.parse(
    readFileSync(join(CONTRACTS, 'store-net-bytes.golden.json'), 'utf8')
  ) as { vectors: GoldenVector[] };

  const segBytes = (s: GoldenSeg): Uint8Array =>
    s.hex !== undefined ? fromHex(s.hex) : new Uint8Array(s.len ?? 0).fill(Number.parseInt(s.fill ?? '0', 16));

  it('locks the schema caps to the generated Rust/TS constants', () => {
    const schema = JSON.parse(readFileSync(join(CONTRACTS, 'store-net-bytes.json'), 'utf8')) as {
      magic: { u32le: number };
      limits: Record<string, { value: number }>;
    };
    expect(RBS1_MAGIC).toBe(schema.magic.u32le);
    expect(LIMITS.maxSegments).toBe(schema.limits.maxSegments.value);
    expect(LIMITS.maxSegmentBytes).toBe(schema.limits.maxSegmentBytes.value);
    expect(LIMITS.maxEnvelopeBytes).toBe(schema.limits.maxEnvelopeBytes.value);
    expect(LIMITS.maxJsonBytes).toBe(schema.limits.maxJsonBytes.value);
  });

  for (const v of golden.vectors) {
    it(`vector "${v.name}" (${v.kind})`, () => {
      if (v.kind === 'plain') {
        // Back-compat: raw JSON, NOT an envelope.
        const raw = new TextEncoder().encode(v.controlPlane);
        expect(toHex(raw)).toBe(v.rawJsonHex);
        expect(isRbs1(raw)).toBe(false);
        return;
      }
      const segs = v.segments.map(segBytes);
      // TS encoder reproduces the Rust golden bytes exactly (cross-language).
      const frame = encodeEnvelope(v.controlPlane, segs);
      expect(frame.length).toBe(v.envelopeLen);
      if (v.envelopeHex) {
        expect(toHex(frame)).toBe(v.envelopeHex);
      }
      // TS decoder reconstructs the source structure.
      const dec = decodeEnvelope(frame);
      expect(new TextDecoder().decode(dec.json)).toBe(v.controlPlane);
      expect(dec.segments.length).toBe(segs.length);
      dec.segments.forEach((got, i) => expect([...got]).toEqual([...segs[i]]));
    });
  }
});
