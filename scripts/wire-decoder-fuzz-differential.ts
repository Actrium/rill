/**
 * wire-decoder-fuzz-differential.ts — TS side of the differential fuzz harness
 * (NEW; opt-in). Lives under scripts/ (outside the app tsconfig `include`, like
 * the other bun scripts) so it never runs in — or typechecks with — the normal
 * unit suite. Run it explicitly via bun (see scripts/fuzz-wire-differential.sh),
 * AFTER the C++ driver (native/core/test/fuzz_wire_decoder.cpp) has generated
 * the shared corpus.
 *
 * WHAT IT DOES
 *   1. Reads the byte-identical corpus.bin the C++ driver produced.
 *   2. Decodes each input with the TS decoder (decodeBatchStreaming from
 *      ./wire-decoder), and asserts the FAIL-CLOSED contract: the decoder either
 *      throws WireDecodeError (a typed reject) OR yields a fully-valid batch —
 *      any OTHER thrown type (raw RangeError/TypeError/…) is a CONFIRMED
 *      non-typed-error defect and is recorded with the exact bytes.
 *   3. Builds a canonical string of each accepted batch using the SAME grammar
 *      as the C++ driver (numbers by IEEE double bits; strings hex; object/prop
 *      keys sorted by raw bytes with last-write-wins; dates as TimeClipped ms).
 *   4. Reads the C++ result stream and diffs per input:
 *        - DIFFERENTIAL AGREEMENT: TS-accepts iff C++-accepts;
 *        - on mutual accept, the canonical forms must be equal.
 *      Any accept/reject divergence or value divergence is a CONFIRMED drift bug
 *      and is recorded with the exact bytes (hex).
 *   5. Prints a JSON report (counts + every confirmed defect) and exits nonzero
 *      if any defect was found.
 */

import { readFileSync } from 'node:fs';
import { decodeBatchStreaming, WireDecodeError } from '../src/host/wasm-guest/wire-decoder';
import type { SerializedOperation, SerializedValue } from '../src/shared/types';

// ---- corpus.bin reader ("RFZC" magic + u32 count + [u32 len, bytes]...) ----

function readCorpus(path: string): Uint8Array[] {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 8 || buf[0] !== 0x52 || buf[1] !== 0x46 || buf[2] !== 0x5a || buf[3] !== 0x43) {
    throw new Error('bad corpus magic');
  }
  const count = dv.getUint32(4, true);
  const inputs: Uint8Array[] = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(off, true);
    off += 4;
    inputs.push(buf.subarray(off, off + len));
    off += len;
  }
  return inputs;
}

// ---- canonical serialization (MUST match fuzz_wire_decoder.cpp) ----

const HEX = '0123456789abcdef';
function hexOfBytes(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]! >> 4] + HEX[b[i]! & 0x0f];
  return s;
}
const enc = new TextEncoder();
function hexOfString(s: string): string {
  return hexOfBytes(enc.encode(s));
}

const bitsView = new DataView(new ArrayBuffer(8));
function bitsHexOfDouble(n: number): string {
  bitsView.setFloat64(0, n, true);
  const lo = bitsView.getUint32(0, true);
  const hi = bitsView.getUint32(4, true);
  return ((BigInt(hi) << 32n) | BigInt(lo)).toString(16).padStart(16, '0');
}

// Detect the decoder's "special" value objects (function/date/error/regexp/
// map/set/promise) vs a plain SerializedValueObject.
function isTagged(v: object): v is { __type: string } {
  return typeof (v as { __type?: unknown }).__type === 'string';
}

function keyedInner(obj: Record<string, SerializedValue>): string {
  // Sort keys by their raw-byte (hex) order and emit last value per key. A JS
  // object already de-duplicates keys (last-write-wins) and re-orders integer
  // keys; sorting by hex(bytes) neutralises the ordering so it is not a false
  // drift vs the C++ vector.
  const parts: Array<[string, string]> = [];
  for (const k of Object.keys(obj)) {
    parts.push([hexOfString(k), cvValue(obj[k] as SerializedValue)]);
  }
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return parts.map(([hk, cv]) => `k${hk}=${cv}`).join(',');
}

function cvValue(v: SerializedValue): string {
  if (v === null) return 'N';
  if (v === undefined) return 'U';
  if (typeof v === 'boolean') return v ? 'b1' : 'b0';
  // All JS numbers are IEEE doubles; canonicalise by bits (INT32 and integral
  // FLOAT64 collapse to the same value on the JS host — that is not a drift).
  if (typeof v === 'number') return '#' + bitsHexOfDouble(v);
  if (typeof v === 'string') return 's' + hexOfString(v);
  if (Array.isArray(v)) {
    return 'a[' + v.map((x) => cvValue(x as SerializedValue)).join(',') + ']';
  }
  if (typeof v === 'object') {
    if (isTagged(v)) {
      const t = (v as { __type: string }).__type;
      switch (t) {
        case 'function':
          return 'fn' + hexOfString((v as { __fnId: string }).__fnId);
        case 'promise':
          return 'pr' + hexOfString((v as { __promiseId: string }).__promiseId);
        case 'date': {
          // Match C++: TimeClipped integral ms. Date.parse of the ISO string the
          // decoder produced returns exactly that integer.
          const ms = Date.parse((v as { __value: string }).__value);
          return 'd' + Math.trunc(ms).toString();
        }
        case 'error': {
          const e = v as { __name: string; __message: string; __stack?: string };
          return `e(${hexOfString(e.__name)},${hexOfString(e.__message)},${hexOfString(e.__stack ?? '')})`;
        }
        case 'regexp': {
          const r = v as { __source: string; __flags: string };
          return `r(${hexOfString(r.__source)},${hexOfString(r.__flags)})`;
        }
        case 'map': {
          const m = v as { __entries: [SerializedValue, SerializedValue][] };
          return 'm[' + m.__entries.map(([k, val]) => `(${cvValue(k)}~${cvValue(val)})`).join(',') + ']';
        }
        case 'set': {
          const s = v as { __values: SerializedValue[] };
          return 'S[' + s.__values.map((x) => cvValue(x)).join(',') + ']';
        }
        default:
          // Unknown tagged shape: fall through to plain-object handling.
          break;
      }
    }
    return 'o{' + keyedInner(v as Record<string, SerializedValue>) + '}';
  }
  return '?';
}

function opCanonical(op: SerializedOperation): string {
  const id = (op as { id: number }).id;
  let out: string;
  switch (op.op) {
    case 'CREATE':
      out = `C${id} t=${hexOfString(op.type)} p={${keyedInner(op.props as Record<string, SerializedValue>)}}`;
      break;
    case 'UPDATE': {
      const removed = (op as { removedProps?: string[] }).removedProps ?? [];
      out = `U${id} p={${keyedInner(op.props as Record<string, SerializedValue>)}} rm=[${removed
        .map((r) => hexOfString(r))
        .join(',')}]`;
      break;
    }
    case 'DELETE':
      out = `D${id}`;
      break;
    case 'APPEND':
      out = `A${id} ${op.parentId} ${op.childId}`;
      break;
    case 'INSERT':
      out = `I${id} ${op.parentId} ${op.childId} ${op.index}`;
      break;
    case 'REMOVE':
      out = `R${id} ${op.parentId} ${op.childId}`;
      break;
    case 'REORDER':
      out = `O${id} ${op.parentId} [${op.childIds.join(',')}]`;
      break;
    case 'TEXT':
      out = `T${id} ${hexOfString(op.text)}`;
      break;
    case 'REF_CALL':
      out = `K${id} m=${hexOfString(op.method)} c=${hexOfString(op.callId)} args=[${op.args
        .map((a) => cvValue(a as SerializedValue))
        .join(',')}]`;
      break;
    default:
      out = `?${id}`;
  }
  const ts = (op as { timestamp?: number }).timestamp;
  if (ts !== undefined) out += ` ts=${bitsHexOfDouble(ts)}`;
  return out;
}

interface TsResult {
  accept: boolean;
  canonical?: string;
  rejectReason?: string; // WireDecodeError.message when the reject was typed
  nonTypedError?: string; // set only when a non-WireDecodeError escaped
}

function decodeTs(input: Uint8Array): TsResult {
  const ops: SerializedOperation[] = [];
  // Copy into a fresh, exactly-sized ArrayBuffer so DataView offsets start at 0.
  // (input is a Node Buffer subarray whose .buffer is the WHOLE corpus file; a
  // fresh Uint8Array gives the decoder just this record.)
  const copy = new Uint8Array(input.length);
  copy.set(input);
  const ab = copy.buffer;
  try {
    const header = decodeBatchStreaming(ab, (op) => ops.push(op));
    const canonical =
      `V${header.version} B${header.batchId} F${header.flags} ops=${ops.length} [` +
      ops.map(opCanonical).join(' ; ') +
      ']';
    return { accept: true, canonical };
  } catch (err) {
    if (err instanceof WireDecodeError) return { accept: false, rejectReason: err.message };
    // Any other error type is a fail-closed-contract violation (defect).
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { accept: false, nonTypedError: name };
  }
}

// ---- C++ results reader ----

function readCppResults(path: string): Array<{ accept: boolean; canonical?: string; reason?: string }> {
  const text = readFileSync(path, 'latin1'); // bytes 1:1 (canonical is ASCII hex-safe)
  const out: Array<{ accept: boolean; canonical?: string; reason?: string }> = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = n;
    const line = text.slice(i, j);
    i = j + 1;
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (line[0] === 'R') out.push({ accept: false, reason: tab >= 0 ? line.slice(tab + 1) : '' });
    else if (line[0] === 'A') out.push({ accept: true, canonical: tab >= 0 ? line.slice(tab + 1) : '' });
  }
  return out;
}

// ---- driver ----

// Normalise a decoder reject message to a stable class tag: drop the trailing
// "(at byte N)" and any ": <dynamic detail>", leaving just the reason kind.
function classify(reason: string | undefined): string {
  if (!reason) return 'unknown';
  let r = reason.replace(/\s*\(at byte \d+\)\s*$/, '');
  const colon = r.indexOf(':');
  if (colon >= 0) r = r.slice(0, colon);
  return r.trim();
}

function main(): void {
  const [corpusPath, cppResultsPath] = process.argv.slice(2);
  if (!corpusPath || !cppResultsPath) {
    console.error('usage: bun wire-decoder.fuzz.ts <corpus.bin> <cpp.results>');
    process.exit(2);
  }

  const inputs = readCorpus(corpusPath);
  const cpp = readCppResults(cppResultsPath);
  if (cpp.length !== inputs.length) {
    console.error(`mismatch: corpus=${inputs.length} cpp_results=${cpp.length}`);
    process.exit(2);
  }

  const SAMPLE_CAP = 12; // keep the report bounded; distinct classes are grouped
  interface Bug {
    kind: string;
    index: number;
    bytesHex: string;
    detail: string;
  }
  const bugs: Bug[] = [];
  const classCounts: Record<string, number> = {};
  const pushBug = (kind: string, index: number, input: Uint8Array, detail: string) => {
    classCounts[kind] = (classCounts[kind] ?? 0) + 1;
    if ((classCounts[kind] ?? 0) <= SAMPLE_CAP) {
      bugs.push({ kind, index, bytesHex: hexOfBytes(input), detail });
    }
  };

  let tsAccept = 0;
  let tsReject = 0;
  let bothAccept = 0;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const ts = decodeTs(input);
    const c = cpp[i]!;

    if (ts.nonTypedError) {
      pushBug('ts-non-typed-error', i, input, ts.nonTypedError);
    }

    if (ts.accept) tsAccept++;
    else tsReject++;

    // (a)/(b) crash/non-typed on the C++ side are caught by ASan aborting the
    // generator process (this driver only ever sees a clean corpus).

    // (c) differential agreement on accept/reject. Label the class by WHICH
    // decoder rejected and why, so the distinct drift classes auto-separate.
    if (ts.accept !== c.accept) {
      const reason = ts.accept ? classify(c.reason) : classify(ts.rejectReason);
      const kind =
        (ts.accept ? 'divergence-ts-accept-cpp-reject' : 'divergence-cpp-accept-ts-reject') +
        `:${reason}`;
      pushBug(
        kind,
        i,
        input,
        `ts=${ts.accept ? 'ACCEPT' : 'REJECT'} cpp=${c.accept ? 'ACCEPT' : 'REJECT'} reason=${
          ts.accept ? `cpp:${c.reason}` : `ts:${ts.rejectReason}`
        }`
      );
      continue;
    }

    if (ts.accept && c.accept) {
      bothAccept++;
      if (ts.canonical !== c.canonical) {
        pushBug(
          'divergence-value-mismatch',
          i,
          input,
          `ts=<${ts.canonical}> cpp=<${c.canonical}>`
        );
      }
    }
  }

  const totalBugs = Object.values(classCounts).reduce((a, b) => a + b, 0);
  const report = {
    totalInputs: inputs.length,
    tsAccepted: tsAccept,
    tsRejected: tsReject,
    bothAccepted: bothAccept,
    confirmedDefects: totalBugs,
    defectClasses: classCounts,
    // A bounded sample per class (exact reproducing bytes as hex).
    sample: bugs,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(totalBugs > 0 ? 1 : 0);
}

main();
