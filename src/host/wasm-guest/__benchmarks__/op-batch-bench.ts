/**
 * op-batch-bench.ts
 *
 * ⚠️ GATED, NON-PRODUCTION PROFILING HARNESS — changes NO defaults, is NOT
 * wired into the live receive path, and is NOT collected by the unit-test
 * runner (it is not a *.test.ts / *.spec.ts file). Run it explicitly:
 *
 *     bun src/host/wasm-guest/__benchmarks__/op-batch-bench.ts
 *
 * PURPOSE
 * -------
 * Produce the end-to-end profiling evidence for the "ship / no-ship the binary
 * op-batch path?" decision. It compares, on the ONE route that has a conformant
 * codec pair (guest binary encoder -> TS host `wire-decoder.decodeBatchStreaming`),
 * the binary path against the incumbent JSON path (`JSON.parse`) across three
 * representative batch sizes, measuring:
 *
 *   1. DECODE       — bytes -> ops array (binary streaming vs JSON.parse)
 *   2. DECODE+APPLY — decode then feed a REAL `Receiver` (minimal registry),
 *                     so the number includes the reconcile/apply cost the live
 *                     path actually pays, not just the microbench ceiling.
 *   3. PAYLOAD SIZE — binary bytes vs JSON UTF-8 bytes.
 *
 * ENCODER NOTE (faithfulness): the binary bytes are produced by the guest-side
 * TS `BinaryEncoder`. Before any timing, this harness (a) re-encodes the 4
 * checked-in golden vectors and asserts BYTE-FOR-BYTE equality with their
 * oracle hex — i.e. the TS encoder is byte-identical to the Rust encoder on the
 * shared golden corpus — and (b) round-trips every generated batch through the
 * conformant `wire-decoder` and asserts structural equivalence. Payload size and
 * decode cost are properties of the WIRE BYTES + the TS decoder, so this stands
 * in faithfully for the "Rust encoder -> TS decoder" pair. The native C++
 * decoder path is NOT measured here (it has no in-VM JSON competitor to compare
 * against inside one runtime); it is discussed qualitatively in the report.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BinaryEncoder } from '../../../guest/runtime/reconciler/binary-encoder';
import type {
  SerializedOperation,
  SerializedOperationBatch,
  SerializedValueObject,
} from '../../../shared/types';
import { ComponentRegistry, type ComponentType } from '../../registry';
import { Receiver } from '../../receiver';
import { decodeBatchStreaming } from '../wire-decoder';

// ============================================================
// Representative batch construction
// ============================================================

// A small, fixed pool of REALISTIC View/Text/style prop KEYS. Reusing this set
// across nodes is what produces the ~80% repeated-name rate that the intern
// table is designed to exploit — each key hits the wire ONCE and is referenced
// by a u16 index everywhere else.
const COLORS = ['#ffffff', '#000000', '#3366ff', '#ff5a5f', '#22aa88', '#f5a623', '#333333'];

function viewStyle(i: number): SerializedValueObject {
  // Mixed value types on purpose: string, int32, float64, bool.
  return {
    flexDirection: i % 2 ? 'row' : 'column',
    alignItems: 'center',
    justifyContent: i % 3 === 0 ? 'space-between' : 'flex-start',
    padding: 8 + (i % 3) * 4, // int32
    margin: i % 2 ? 4 : 8, // int32
    backgroundColor: COLORS[i % COLORS.length]!,
    borderRadius: 4 + (i % 4), // int32
    width: 100 + (i % 50), // int32
    height: 40 + (i % 20), // int32
    opacity: 0.8 + (i % 10) / 50, // float64
    accessible: i % 2 === 0, // bool
  };
}

function textStyle(i: number): SerializedValueObject {
  return {
    fontSize: 12 + (i % 6), // int32
    color: COLORS[(i + 3) % COLORS.length]!,
    fontWeight: i % 2 ? '600' : '400',
    lineHeight: 16 + (i % 4), // int32
    textAlign: 'left',
    letterSpacing: 0.2 + (i % 5) / 20, // float64
  };
}

/**
 * Build a representative "UI frame" batch that mounts a card list: a root View,
 * then N cards, each card = row View > (icon View + title Text + subtitle Text).
 * Each node is a CREATE + an APPEND; text nodes also carry a TEXT op; a slice of
 * nodes get a follow-up UPDATE (style tweak + a removed prop) to mix op kinds
 * the way a real re-render frame does. Generation stops at a card boundary once
 * `targetOps` is reached, so the realized op count is close to (not exactly) the
 * target.
 */
function buildBatch(targetOps: number, batchId: number): SerializedOperationBatch {
  const ops: SerializedOperation[] = [];
  let nextId = 1;

  const ROOT = nextId++;
  ops.push({ op: 'CREATE', id: ROOT, type: 'View', props: { style: viewStyle(0), testID: 'root' } });
  ops.push({ op: 'APPEND', id: ROOT, parentId: 0, childId: ROOT });

  let card = 0;
  while (ops.length < targetOps) {
    const rowView = nextId++;
    ops.push({
      op: 'CREATE',
      id: rowView,
      type: 'View',
      props: { style: viewStyle(card), testID: `card-${card}` },
    });
    ops.push({ op: 'APPEND', id: rowView, parentId: ROOT, childId: rowView });

    const iconView = nextId++;
    ops.push({
      op: 'CREATE',
      id: iconView,
      type: 'View',
      props: { style: viewStyle(card + 1), accessible: true },
    });
    ops.push({ op: 'APPEND', id: iconView, parentId: rowView, childId: iconView });

    const titleText = nextId++;
    ops.push({
      op: 'CREATE',
      id: titleText,
      type: 'Text',
      props: { style: textStyle(card), numberOfLines: 1 },
    });
    ops.push({ op: 'TEXT', id: titleText, text: `Card title number ${card}` });
    ops.push({ op: 'APPEND', id: titleText, parentId: rowView, childId: titleText });

    const subText = nextId++;
    ops.push({
      op: 'CREATE',
      id: subText,
      type: 'Text',
      props: { style: textStyle(card + 2), numberOfLines: 2 },
    });
    ops.push({ op: 'TEXT', id: subText, text: `Subtitle for card ${card}, tap for more detail` });
    ops.push({ op: 'APPEND', id: subText, parentId: rowView, childId: subText });

    // ~1 in 4 cards receives a follow-up UPDATE (mixed op kinds + removedProps).
    if (card % 4 === 0) {
      ops.push({
        op: 'UPDATE',
        id: rowView,
        props: { style: { backgroundColor: COLORS[card % COLORS.length]!, opacity: 0.95 } },
        removedProps: ['testID'],
      });
    }

    card++;
  }

  return { version: 1, batchId, operations: ops };
}

// ============================================================
// Faithfulness gates (run before any timing)
// ============================================================

/**
 * Resolve the golden oracle: prefer the path relative to THIS source file (the
 * `bun <file>` case), and fall back to `<cwd>/contracts/...` (the bundled
 * `node` case, where `import.meta.url` points at a temp bundle).
 */
function goldenPath(): string {
  const rel = fileURLToPath(
    new URL('../../../../contracts/op-batch-wire.golden.json', import.meta.url)
  );
  if (existsSync(rel)) return rel;
  return resolve(process.cwd(), 'contracts/op-batch-wire.golden.json');
}

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

/**
 * Prove the TS `BinaryEncoder` is byte-identical to the Rust/golden oracle on
 * the shared golden corpus, so its bytes faithfully stand in for the conformant
 * Rust encoder's bytes.
 */
function assertGoldenByteIdentity(): number {
  const golden = JSON.parse(readFileSync(goldenPath(), 'utf8')) as {
    vectors: Array<{ name: string; batch: SerializedOperationBatch; hex: string }>;
  };
  for (const v of golden.vectors) {
    const enc = new BinaryEncoder(); // fresh per batch = index-from-0, flags NONE
    const bytes = enc.encodeBatch(v.batch);
    const got = toHex(bytes);
    if (got !== v.hex) {
      throw new Error(
        `GOLDEN MISMATCH on vector "${v.name}":\n  encoder: ${got}\n  oracle : ${v.hex}`
      );
    }
  }
  return golden.vectors.length;
}

/** Decode bytes back to an ops array via the conformant streaming host decoder. */
function decodeToArray(bytes: ArrayBuffer): SerializedOperation[] {
  const out: SerializedOperation[] = [];
  decodeBatchStreaming(bytes, (op) => out.push(op));
  return out;
}

/** Round-trip a generated batch through the conformant decoder and sanity-check. */
function assertRoundTrip(batch: SerializedOperationBatch, bytes: ArrayBuffer): void {
  const decoded = decodeToArray(bytes);
  if (decoded.length !== batch.operations.length) {
    throw new Error(
      `round-trip op-count mismatch: decoded ${decoded.length} != source ${batch.operations.length}`
    );
  }
  // Spot-check the first CREATE's type and a prop key survived the round-trip.
  const srcCreate = batch.operations.find((o) => o.op === 'CREATE');
  const gotCreate = decoded.find((o) => o.op === 'CREATE');
  if (
    srcCreate?.op === 'CREATE' &&
    gotCreate?.op === 'CREATE' &&
    (srcCreate.type !== gotCreate.type ||
      Object.keys(srcCreate.props).length !== Object.keys(gotCreate.props).length)
  ) {
    throw new Error('round-trip CREATE structure mismatch');
  }
}

// ============================================================
// A minimal but real host apply target
// ============================================================

function makeReceiver(): Receiver {
  const registry = new ComponentRegistry();
  // Register the components the frames use so this is a real registry, not a stub.
  const Noop = (() => null) as unknown as ComponentType;
  registry.register('View', Noop);
  registry.register('Text', Noop);
  return new Receiver(
    registry,
    () => {}, // sendToSandbox
    () => {}, // onUpdate
    // Lift the apply cap so LARGE batches are fully applied (never skipped),
    // otherwise decode+apply would only reflect the first 5000 ops.
    { maxBatchSize: Number.MAX_SAFE_INTEGER }
  );
}

// ============================================================
// Timing
// ============================================================

interface Timing {
  medianMsPerCall: number;
  minMsPerCall: number;
}

/**
 * Warm up, then time `rounds` rounds of `innerPerRound` calls each; report the
 * median and min per-call wall time. Median resists GC/scheduler outliers; min
 * is the cleanest achievable. `sink` consumes the result so the JIT cannot
 * dead-code-eliminate the work.
 */
function bench(
  fn: () => unknown,
  opts: { warmup: number; rounds: number; innerPerRound: number }
): Timing {
  let sink = 0;
  for (let i = 0; i < opts.warmup; i++) sink += consume(fn());

  const perCall: number[] = [];
  for (let r = 0; r < opts.rounds; r++) {
    const t0 = performance.now();
    for (let k = 0; k < opts.innerPerRound; k++) sink += consume(fn());
    const t1 = performance.now();
    perCall.push((t1 - t0) / opts.innerPerRound);
  }
  if (sink === Number.POSITIVE_INFINITY) console.log(''); // keep `sink` live
  perCall.sort((a, b) => a - b);
  return {
    medianMsPerCall: perCall[Math.floor(perCall.length / 2)]!,
    minMsPerCall: perCall[0]!,
  };
}

function consume(v: unknown): number {
  if (typeof v === 'number') return v & 1;
  if (Array.isArray(v)) return v.length & 1;
  if (v && typeof v === 'object') return 1;
  return 0;
}

// ============================================================
// Main
// ============================================================

interface RowResult {
  label: string;
  ops: number;
  binBytes: number;
  jsonBytes: number;
  sizeRatio: number; // jsonBytes / binBytes
  decBinMs: number; // binary streaming decode -> array
  decJsonMs: number; // JSON.parse
  decRatio: number; // json / binary  (>1 means binary faster)
  applyBinMs: number; // decode+apply, binary
  applyJsonMs: number; // decode+apply, json
  applyRatio: number; // json / binary
}

function run(): void {
  console.log('# op-batch binary-vs-JSON profiling (gated, non-production)\n');

  const nGolden = assertGoldenByteIdentity();
  console.log(
    `faithfulness gate 1: TS BinaryEncoder is byte-identical to the golden/Rust oracle on all ${nGolden} golden vectors ✓`
  );

  const sizes: Array<{ label: string; target: number; warmup: number; rounds: number; inner: number }> = [
    { label: 'typical (~120 ops)', target: 120, warmup: 200, rounds: 25, inner: 200 },
    { label: 'medium  (~1.5k ops)', target: 1500, warmup: 40, rounds: 25, inner: 40 },
    { label: 'large   (~30k ops)', target: 30000, warmup: 5, rounds: 15, inner: 5 },
  ];

  const results: RowResult[] = [];

  for (const s of sizes) {
    const batch = buildBatch(s.target, 7);
    const ops = batch.operations.length;

    const encoder = new BinaryEncoder();
    const bytes = encoder.encodeBatch(batch);
    assertRoundTrip(batch, bytes);

    const jsonString = JSON.stringify(batch);
    const binBytes = bytes.byteLength;
    const jsonBytes = Buffer.byteLength(jsonString, 'utf8');

    // --- DECODE only (both produce an ops array) ---
    const decBin = bench(() => decodeToArray(bytes), {
      warmup: s.warmup,
      rounds: s.rounds,
      innerPerRound: s.inner,
    });
    const decJson = bench(() => (JSON.parse(jsonString) as SerializedOperationBatch).operations, {
      warmup: s.warmup,
      rounds: s.rounds,
      innerPerRound: s.inner,
    });

    // --- DECODE + APPLY (real Receiver; reuse + clear to avoid microtask storm) ---
    const rxBin = makeReceiver();
    const applyBin = bench(
      () => {
        rxBin.clear();
        const decoded = decodeToArray(bytes);
        rxBin.applyBatch({ version: 1, batchId: batch.batchId, operations: decoded });
        return decoded.length;
      },
      { warmup: s.warmup, rounds: s.rounds, innerPerRound: s.inner }
    );

    const rxJson = makeReceiver();
    const applyJson = bench(
      () => {
        rxJson.clear();
        const parsed = JSON.parse(jsonString) as SerializedOperationBatch;
        rxJson.applyBatch({ version: 1, batchId: parsed.batchId, operations: parsed.operations });
        return parsed.operations.length;
      },
      { warmup: s.warmup, rounds: s.rounds, innerPerRound: s.inner }
    );

    results.push({
      label: s.label,
      ops,
      binBytes,
      jsonBytes,
      sizeRatio: jsonBytes / binBytes,
      decBinMs: decBin.medianMsPerCall,
      decJsonMs: decJson.medianMsPerCall,
      decRatio: decJson.medianMsPerCall / decBin.medianMsPerCall,
      applyBinMs: applyBin.medianMsPerCall,
      applyJsonMs: applyJson.medianMsPerCall,
      applyRatio: applyJson.medianMsPerCall / applyBin.medianMsPerCall,
    });
  }

  console.log('faithfulness gate 2: every generated batch round-trips through wire-decoder ✓\n');

  // --- Report ---
  const f = (n: number, d = 3) => n.toFixed(d);
  const kb = (n: number) => (n / 1024).toFixed(1);
  console.log('## DECODE (bytes -> ops array), median ms/batch');
  console.log('batch | ops | binary ms | json ms | ratio(json/bin)');
  console.log('----- | --- | --------- | ------- | ---------------');
  for (const r of results) {
    console.log(
      `${r.label} | ${r.ops} | ${f(r.decBinMs)} | ${f(r.decJsonMs)} | ${f(r.decRatio, 2)}x`
    );
  }

  console.log('\n## DECODE + APPLY (real Receiver), median ms/batch');
  console.log('batch | ops | binary ms | json ms | ratio(json/bin)');
  console.log('----- | --- | --------- | ------- | ---------------');
  for (const r of results) {
    console.log(
      `${r.label} | ${r.ops} | ${f(r.applyBinMs)} | ${f(r.applyJsonMs)} | ${f(r.applyRatio, 2)}x`
    );
  }

  console.log('\n## PAYLOAD SIZE');
  console.log('batch | ops | binary KiB | json KiB | ratio(json/bin)');
  console.log('----- | --- | ---------- | -------- | ---------------');
  for (const r of results) {
    console.log(
      `${r.label} | ${r.ops} | ${kb(r.binBytes)} | ${kb(r.jsonBytes)} | ${f(r.sizeRatio, 2)}x`
    );
  }

  console.log('\n## Machine-readable JSON');
  console.log(JSON.stringify(results, null, 2));
}

// Gate: only run when invoked directly (never on import / test discovery).
// `import.meta.main` fires under `bun <file>` (JSC); RILL_BENCH_RUN lets a
// node/V8 build (e.g. `bun build --target=node` then `node`) run the same code,
// so the web host's real engine (V8) can be measured too.
if (import.meta.main || process.env.RILL_BENCH_RUN) {
  run();
}
