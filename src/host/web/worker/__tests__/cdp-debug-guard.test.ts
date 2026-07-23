/**
 * Code-split guard for the FAT CDP debug wasm (design P2), the debug-only counterpart of
 * the DWARF-free fixture guard (src/host/wasm-guest/__tests__/wasm-guest-dwarf.test.ts).
 *
 * The debug artifact (native/quickjs/build-debug/quickjs-cdp-debug.{mjs,wasm}) is ~3.6MB —
 * Asyncify roughly triples the wasm and the CDP engine is dev-only. It MUST reach a
 * production build only through the dynamic `import()` in cdp-debug-session.ts, so a bundler
 * splits it into a chunk fetched lazily when a debug session starts. A single STATIC import
 * of the factory anywhere in src/ would drag those 3.6MB into every production bundle.
 *
 * This guard fails the build if:
 *   - any non-test file under src/ statically imports the debug artifact, or names the
 *     Emscripten factory export `createQuickJSCdpDebug`; and it asserts positively that
 *   - cdp-debug-session.ts DOES reach it via a dynamic `import()` (the split path exists).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(import.meta.dir, '..', '..', '..', '..'); // → src/
const ARTIFACT_TOKEN = 'quickjs-cdp-debug';
const FACTORY_EXPORT = 'createQuickJSCdpDebug';
const SESSION_FILE = join(import.meta.dir, '..', 'cdp-debug-session.ts');

/** Every .ts source under src/, excluding test files and __tests__ dirs. */
function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      productionSources(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Match a STATIC import that pulls a module whose specifier contains `token`. */
function hasStaticImportOf(source: string, token: string): boolean {
  // `import ... from '…token…'`  and bare `import '…token…'` — but NOT dynamic `import(`.
  const fromForm = new RegExp(`import[^;\\n]*?from\\s*['"][^'"]*${token}[^'"]*['"]`);
  const bareForm = new RegExp(`import\\s+['"][^'"]*${token}[^'"]*['"]`);
  return fromForm.test(source) || bareForm.test(source);
}

describe('the 3.6MB fat CDP debug wasm stays out of the production bundle', () => {
  const sources = productionSources(SRC_ROOT);

  it('scans a non-empty set of production sources', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('no production source statically imports the debug artifact', () => {
    const offenders = sources.filter((f) =>
      hasStaticImportOf(readFileSync(f, 'utf8'), ARTIFACT_TOKEN)
    );
    expect(offenders).toEqual([]);
  });

  it('no production source references the debug factory export by name', () => {
    // A static reference to `createQuickJSCdpDebug` implies a static import of the factory.
    // cdp-debug-session.ts reaches it via the module's DEFAULT export, never by this name.
    const offenders = sources.filter((f) => readFileSync(f, 'utf8').includes(FACTORY_EXPORT));
    expect(offenders).toEqual([]);
  });

  it('cdp-debug-session.ts reaches the artifact ONLY via a dynamic import()', () => {
    const src = readFileSync(SESSION_FILE, 'utf8');
    // Positive: the code-split path exists (a dynamic import of the artifact specifier).
    expect(src).toContain('import(');
    expect(src).toContain(ARTIFACT_TOKEN);
    // Negative: never a static import of it.
    expect(hasStaticImportOf(src, ARTIFACT_TOKEN)).toBe(false);
  });
});

describe('the guard actually detects a static import', () => {
  it('flags a synthetic static import of the debug artifact', () => {
    const bad = "import createQuickJSCdpDebug from '../build-debug/quickjs-cdp-debug.mjs';";
    expect(hasStaticImportOf(bad, ARTIFACT_TOKEN)).toBe(true);
  });

  it('does not flag a dynamic import of the debug artifact', () => {
    const good = "const m = await import('../build-debug/quickjs-cdp-debug.mjs');";
    expect(hasStaticImportOf(good, ARTIFACT_TOKEN)).toBe(false);
  });
});
