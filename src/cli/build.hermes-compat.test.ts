/**
 * Hermes compatibility tests for the build pipeline.
 *
 * Hermes' compiler rejects async arrow functions ("async functions are
 * unsupported") while accepting `async function`. The build pipeline must
 * therefore (a) transform every async arrow out of the final bundle,
 * including ones coming from .mjs/.cjs modules, and (b) fail the build if
 * one slips through anyway (e.g. via a custom footer).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

function countAsyncArrows(code: string): number {
  const oxc = require('oxc-parser');
  const parsed = oxc.parseSync(code, { sourceType: 'script' });
  expect(parsed.errors ?? []).toHaveLength(0);
  let count = 0;
  const stack: unknown[] = [JSON.parse(parsed.program)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const record = node as Record<string, unknown>;
    if (record.type === 'ArrowFunctionExpression' && record.async === true) count++;
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return count;
}

describe('Hermes compat (async arrow elimination)', () => {
  let tempDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rill-hermes-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // .mjs dependency: previously bypassed the Babel filter entirely
    fs.writeFileSync(
      path.join(srcDir, 'loader.mjs'),
      `export const loadRemote = async (url) => ({ url, ok: true });\n`
    );

    fs.writeFileSync(
      path.join(srcDir, 'guest.tsx'),
      `
      import { View, Text } from 'rill/guest';
      import { loadRemote } from './loader.mjs';

      const fetchTitle = async () => {
        const result = await loadRemote('demo://title');
        return result.ok ? 'ready' : 'failed';
      };

      export default function Guest() {
        const onPress = async () => {
          const title = await fetchTitle();
          return title;
        };
        return <View onPress={onPress}><Text>Hello</Text></View>;
      }
    `
    );

    fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('produces a bundle with zero async arrows (entry + .mjs dep)', async () => {
    const { build } = await import('./build');
    await build({
      entry: 'src/guest.tsx',
      outfile: 'dist/bundle.js',
      minify: false,
      sourcemap: false,
      watch: false,
      strict: true,
    });

    const bundle = fs.readFileSync(path.join(tempDir, 'dist/bundle.js'), 'utf-8');
    // Sources above contain 3 async arrows; all must be gone from the artifact
    expect(countAsyncArrows(bundle)).toBe(0);
    // ...converted, not dropped: their bodies survive as async function expressions
    expect(bundle).toContain('async function');
    expect(bundle).toContain('loadRemote');
  });

  it('fails the build when a custom footer smuggles an async arrow past Babel', async () => {
    const footerPath = path.join(tempDir, 'footer.js');
    fs.writeFileSync(footerPath, `globalThis.__bootGuest = async () => { return 'boot'; };\n`);

    const { build } = await import('./build');
    await expect(
      build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: false,
        sourcemap: false,
        watch: false,
        strict: true,
        footer: footerPath,
      })
    ).rejects.toThrow(/Hermes compat guard/);
  });
});
