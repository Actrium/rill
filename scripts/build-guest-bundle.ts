#!/usr/bin/env bun

/**
 * Build Guest Bundle
 *
 * Compiles the Guest runtime bundle (React + reconciler + SDK) into a single
 * minified JS string that can be injected into the Guest sandbox at runtime.
 *
 * Required output:
 *  - TypeScript export for Engine: `src/guest/build/bundle.ts`
 *
 * Optional outputs (flags):
 *  - `--write-js`     → `src/guest/build/guest-bundle.js` (for inspection)
 *  - `--write-merged` → `src/guest/build/guest-bundle.merged.ts` (for debugging)
 *  - `--debug`        → non-minified bundle
 *
 * Usage:
 *   bun scripts/build-guest-bundle.ts
 *   bun scripts/build-guest-bundle.ts --debug
 *   bun scripts/build-guest-bundle.ts --write-js
 *   bun scripts/build-guest-bundle.ts --write-merged
 */

import * as babel from '@babel/core';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const GUEST_DIR = path.join(ROOT, 'src', 'guest');
const RUNTIME_DIR = path.join(GUEST_DIR, 'runtime');

const INPUT = path.join(GUEST_DIR, 'bundle.ts');
const OUTPUT_DIR = path.join(GUEST_DIR, 'build');
const OUTPUT_BUNDLE_TS = path.join(OUTPUT_DIR, 'bundle.ts');
const OUTPUT_JS = path.join(OUTPUT_DIR, 'guest-bundle.js');
const OUTPUT_TS_MERGED = path.join(OUTPUT_DIR, 'guest-bundle.merged.ts');

const TEMP_DIR = '/tmp/rill-guest-build';
const TEMP_FILE = path.join(TEMP_DIR, 'guest-bundle.js');

// Flags
const isDebug = process.argv.includes('--debug');
const shouldWriteJSFile = process.argv.includes('--write-js');
const shouldWriteMergedTS = process.argv.includes('--write-merged');

/**
 * Generate merged TypeScript for debugging
 * Concatenates key source files in a readable order (best-effort).
 */
async function generateMergedTS(): Promise<string> {
  // Files are relative to RUNTIME_DIR, except bundle.ts which is in GUEST_DIR.
  const runtimeFiles = [
    'init.ts',
    'globals-setup.ts',
    'react-global.ts',
    'reconciler/types.ts',
    'reconciler/operation-collector.ts',
    'reconciler/guest-encoder.ts',
    'reconciler/element-transform.ts',
    'reconciler/host-config.ts',
    'reconciler/devtools.ts',
    'reconciler/reconciler-manager.ts',
    'reconciler/index.ts',
  ];

  const header = `/**
 * Guest Bundle - Merged TypeScript Source
 *
 * AUTO-GENERATED - DO NOT EDIT
 * Run: bun scripts/build-guest-bundle.ts --write-merged
 *
 * Generated: ${new Date().toISOString()}
 */

`;

  let merged = header;

  for (const file of runtimeFiles) {
    const filePath = path.join(RUNTIME_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const content = await Bun.file(filePath).text();
    merged += `\n// ============================================\n`;
    merged += `// FILE: runtime/${file}\n`;
    merged += `// ============================================\n\n`;
    merged += content;
    merged += '\n';
  }

  const bundlePath = path.join(GUEST_DIR, 'bundle.ts');
  if (fs.existsSync(bundlePath)) {
    const content = await Bun.file(bundlePath).text();
    merged += `\n// ============================================\n`;
    merged += `// FILE: bundle.ts\n`;
    merged += `// ============================================\n\n`;
    merged += content;
    merged += '\n';
  }

  return merged;
}

async function build(): Promise<void> {
  console.log('Building Guest Bundle...');
  console.log(`  Input: ${INPUT}`);
  console.log(`  Output TS (export): ${OUTPUT_BUNDLE_TS}`);
  if (shouldWriteJSFile) console.log(`  Output JS: ${OUTPUT_JS}`);
  if (shouldWriteMergedTS) console.log(`  Output TS (merged): ${OUTPUT_TS_MERGED}`);
  console.log(`  Mode: ${isDebug ? 'debug' : 'production'}`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  // 1) (Optional) merged TS for debugging
  if (shouldWriteMergedTS) {
    console.log('\n1. Generating merged TypeScript...');
    const mergedTS = await generateMergedTS();
    fs.writeFileSync(OUTPUT_TS_MERGED, mergedTS);
    console.log(`   Wrote: ${OUTPUT_TS_MERGED} (${(mergedTS.length / 1024).toFixed(2)} KB)`);
  }

  // 2) Build with Bun (IIFE)
  console.log(`\n${shouldWriteMergedTS ? 2 : 1}. Building JavaScript bundle...`);
  const result = await Bun.build({
    entrypoints: [INPUT],
    outdir: TEMP_DIR,
    target: 'browser',
    format: 'iife',
    minify: !isDebug,
    naming: 'guest-bundle.[ext]',
    external: [], // Bundle everything (React + SDK + reconciler)
  });

  if (!result.success) {
    console.error('Build failed:');
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  let jsCode = await Bun.file(TEMP_FILE).text();

  // 2b) Transpile to ES5 for widest guest-engine compatibility (e.g. Hermes sandbox).
  console.log('   Transpiling to ES5 with Babel...');
  const babelResult = await babel.transformAsync(jsCode, {
    presets: [
      [
        '@babel/preset-env',
        {
          targets: { ie: '11' },
          modules: false,
        },
      ],
    ],
    compact: !isDebug,
    minified: !isDebug,
  });
  if (!babelResult?.code) {
    throw new Error('Babel transformation failed');
  }
  jsCode = babelResult.code;

  const jsSizeKB = (jsCode.length / 1024).toFixed(2);
  console.log(`   Bundle size: ${jsSizeKB} KB (${jsCode.length} bytes)`);

  // 3) (Optional) write JS bundle
  if (shouldWriteJSFile) {
    fs.writeFileSync(OUTPUT_JS, jsCode);
    console.log(`   Wrote: ${OUTPUT_JS}`);
  }

  // 4) Write TS export for Engine
  console.log(`\n${shouldWriteMergedTS ? 3 : 2}. Generating TypeScript export...`);
  const tsExport = `/**
 * Guest Bundle Export (Auto-generated)
 *
 * DO NOT EDIT - Generated by scripts/build-guest-bundle.ts
 * Run: bun scripts/build-guest-bundle.ts
 *
 * This code is injected into Guest sandbox to provide:
 * - React runtime + JSX runtimes
 * - rill/sdk (Guest SDK)
 * - RillReconciler (render/unmount/etc.)
 *
 * Size: ${jsSizeKB} KB (${isDebug ? 'debug' : 'minified'})
 * Generated: ${new Date().toISOString()}
 */

export const GUEST_BUNDLE_CODE = ${JSON.stringify(jsCode)};

export const GUEST_BUNDLE_SIZE = ${jsCode.length};

export const GUEST_BUNDLE_DEBUG = ${isDebug};
`;

  fs.writeFileSync(OUTPUT_BUNDLE_TS, tsExport);
  console.log(`   Wrote: ${OUTPUT_BUNDLE_TS}`);

  // Cleanup
  try {
    fs.unlinkSync(TEMP_FILE);
  } catch {
    // ignore
  }

  console.log('\n✓ Build complete!');
}

build().catch((err: unknown) => {
  console.error('Build failed:', err);
  process.exit(1);
});
