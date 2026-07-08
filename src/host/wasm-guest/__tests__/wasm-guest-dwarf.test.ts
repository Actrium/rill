import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guards the DWARF boundary for the native-guest debugging story (Wasm-V8,
// T1.1). The shipped, byte-reproducible release fixtures MUST NOT carry DWARF:
// it would balloon them by hundreds of KiB (a debug guest is ~7x larger) and
// leak absolute source paths. DWARF only ever belongs in the throwaway
// crates/debug-artifacts/ built by `RILL_GUEST_DEBUG=1 crates/build.sh`.
// See docs/native-guest-debugging.zh.md.

// Minimal wasm reader: list the module's custom-section names. Binary layout is
// magic(4) + version(4), then sections of [id:u8][size:varu32][payload]; a
// custom section (id 0) begins its payload with [nameLen:varu32][nameBytes].
function customSectionNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  let p = 8; // skip magic + version
  const readVarU32 = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bytes[p++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  };
  const decoder = new TextDecoder();
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = readVarU32();
    const end = p + size;
    if (id === 0) {
      const nameLen = readVarU32();
      names.push(decoder.decode(bytes.subarray(p, p + nameLen)));
    }
    p = end;
  }
  return names;
}

const fixturesDir = join(import.meta.dir, 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.wasm'));

describe('shipped wasm fixtures carry no DWARF', () => {
  it('finds fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const file of fixtures) {
    it(`${file} has no .debug_* custom section`, () => {
      const bytes = new Uint8Array(readFileSync(join(fixturesDir, file)));
      const debug = customSectionNames(bytes).filter((n) => n.startsWith('.debug'));
      expect(debug).toEqual([]);
    });
  }
});

describe('the guard actually detects DWARF', () => {
  it('flags a synthetic module with a .debug_info custom section', () => {
    const nameBytes = new TextEncoder().encode('.debug_info');
    // custom section: id=0, size, [nameLen][name]; all lengths < 128 -> 1-byte LEB128.
    const payload = [nameBytes.length, ...nameBytes];
    const wasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
      0x00, payload.length, ...payload, // custom section
    ]);
    expect(customSectionNames(wasm)).toContain('.debug_info');
  });
});
