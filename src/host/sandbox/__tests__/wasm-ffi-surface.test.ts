/**
 * FFI surface reconciliation guard for the QuickJS WASM bridge.
 *
 * The exported C surface is hand-maintained in THREE places that must agree, or
 * something breaks silently:
 *   1. native/quickjs/src/wasm_bindings.c   — the `EXPORT qjs_*` definitions
 *   2. native/quickjs/CMakeLists.wasm.txt   — EXPORTED_FUNCTIONS (`_qjs_*`);
 *      a symbol missing here is dead-stripped by emscripten -> runtime failure
 *   3. src/host/sandbox/wasm/quickjs-sandbox.d.ts — the typed module surface;
 *      a symbol missing here loses type coverage (this drifted once: an existing
 *      export went untyped for a release before anyone noticed)
 *
 * There is no codegen tying them together, so this test IS the tie: it extracts
 * the symbol set from each source and asserts all three are identical. When you
 * add or remove a `qjs_*` export, update all three; this test names exactly what
 * fell out of sync.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** `EXPORT <type> qjs_name(` definitions in the C source (each on one line). */
function cExports(src: string): Set<string> {
  const out = new Set<string>();
  for (const line of src.split('\n')) {
    // Skip the `#define EXPORT ...` macro lines — they carry no function name.
    if (/^\s*#\s*define\s+EXPORT\b/.test(line)) continue;
    const m = line.match(/\bEXPORT\b.*?\b(qjs_[a-z0-9_]+)\s*\(/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** `_qjs_*` identifiers referenced in a file, normalized without the leading `_`. */
function underscoreQjs(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/_qjs_[a-z0-9_]+/g)) {
    out.add(m[0].slice(1));
  }
  return out;
}

const sorted = (s: Set<string>): string[] => [...s].sort();
const missing = (from: Set<string>, ref: Set<string>): string[] =>
  sorted(from).filter((k) => !ref.has(k));

describe('QuickJS WASM FFI surface stays reconciled across its three sources', () => {
  const c = cExports(read('native/quickjs/src/wasm_bindings.c'));
  const dts = underscoreQjs(read('src/host/sandbox/wasm/quickjs-sandbox.d.ts'));
  const cmake = underscoreQjs(read('native/quickjs/CMakeLists.wasm.txt'));

  it('extracts a non-trivial C export set (guards against a broken extractor)', () => {
    // If the regex silently matched nothing the equality checks below would pass
    // vacuously against each other — anchor on a couple of known-stable exports.
    expect(c.size).toBeGreaterThan(5);
    expect(c.has('qjs_init')).toBe(true);
    expect(c.has('qjs_eval')).toBe(true);
  });

  it('CMakeLists EXPORTED_FUNCTIONS covers every C export (missing = dead-stripped at runtime)', () => {
    expect(missing(c, cmake)).toEqual([]);
  });

  it('d.ts declares every C export (missing = untyped module member)', () => {
    expect(missing(c, dts)).toEqual([]);
  });

  it('has no CMakeLists or d.ts entry without a backing C export (no zombie declarations)', () => {
    expect(missing(cmake, c)).toEqual([]);
    expect(missing(dts, c)).toEqual([]);
  });
});
