import { describe, expect, it } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';

// Size guard for the compiled Rust guest fixtures.
//
// The guest SDK is #![no_std]; its global allocator is talc (a small no_std
// crate). If someone accidentally pulls `std` into the guest — or swaps in a
// heavyweight allocator — the .wasm balloons by hundreds of KiB. These ceilings
// sit well above the real sizes (talc itself added only ~0.6–1.4 KiB per guest
// over the retired bump allocator) but far below any std-bloat regression, so a
// breach means "something dragged in a large dependency", not normal drift.
//
// Rebuild fixtures with crates/build.sh after changing any guest. If a guest
// legitimately grows past its ceiling, bump the ceiling here in the same change.
const KIB = 1024;

// fixture filename -> ceiling in KiB (generous headroom over the measured size).
const CEILINGS: Record<string, number> = {
  'kv-guest.wasm': 32,
  'seq-guest.wasm': 32,
  'ui-guest.wasm': 32,
  'event-guest.wasm': 32,
  'heap-churn-guest.wasm': 32,
  'canvas-guest.wasm': 64,
  'canvas-present-guest.wasm': 48,
  'canvas-gpu-guest.wasm': 96,
  'canvas-escape-guest.wasm': 64,
  'asset-guest.wasm': 48,
};

describe('guest .wasm size guard (no accidental std / heavy-dep bloat)', () => {
  for (const [fixture, ceilingKiB] of Object.entries(CEILINGS)) {
    it(`${fixture} stays under ${ceilingKiB} KiB`, () => {
      const path = join(import.meta.dir, 'fixtures', fixture);
      const bytes = statSync(path).size;
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(ceilingKiB * KIB);
    });
  }
});
