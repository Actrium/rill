#!/usr/bin/env node
// rill_postinstall.js – patch known react-native-macos 0.81.x build bugs.
//
// Runs automatically via npm/yarn/pnpm postinstall.
// All patches are idempotent and version-gated to 0.81.x only.
//
// Design principles:
//   - NEVER fail npm install. All errors are caught and logged as warnings.
//   - Works in flat node_modules, monorepo hoisting, pnpm, and yarn workspaces.
//   - Idempotent: safe to run multiple times.

const fs = require('fs');
const path = require('path');

const TAG = '[rill postinstall]';
const ENV_SKIP_RN_MACOS_PATCH = 'RILL_SKIP_RN_MACOS_PATCH';
const ENV_STRICT_RN_MACOS_PATCH = 'RILL_RN_MACOS_PATCH_STRICT';

function isTruthyEnv(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

// ---------------------------------------------------------------------------
// Resolve react-native-macos regardless of node_modules layout
// ---------------------------------------------------------------------------
function resolveRnMacosDir() {
  // Strategy 1: require.resolve from common project roots.
  // Works for flat node_modules, hoisted monorepos, pnpm, and most workspace setups.
  try {
    const searchPaths = [
      process.env.INIT_CWD, // npm/yarn/pnpm: original working dir of the install command
      process.cwd(), // npm: often the package dir (node_modules/rill), still OK
      path.resolve(__dirname, '..', '..'), // ../node_modules (classic)
    ]
      .filter(Boolean)
      .map((p) => path.resolve(p));

    const pkgPath = require.resolve('react-native-macos/package.json', {
      paths: Array.from(new Set(searchPaths)),
    });
    return path.dirname(pkgPath);
  } catch (_) {
    // Not installed — perfectly fine, react-native-macos is optional.
  }

  // Strategy 2: relative sibling in node_modules (classic flat layout).
  const sibling = path.resolve(__dirname, '..', '..', 'react-native-macos');
  if (fs.existsSync(path.join(sibling, 'package.json'))) {
    return sibling;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------
let didWarnReadOnly = false;

function isProbablyYarnPnpZipfs(p) {
  if (!p) return false;
  const s = String(p);
  return /[\\/]\.yarn[\\/]/.test(s) && (/[\\/]__virtual__[\\/]/.test(s) || /\.zip[\\/]/.test(s));
}

function warnReadOnlyOnce(err, rnMacosDir) {
  if (didWarnReadOnly) return;
  didWarnReadOnly = true;

  const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
  const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);

  console.warn(
    `${TAG} WARN: Cannot apply react-native-macos patch (read-only filesystem). ${code ? `code=${code} ` : ''}${msg}`
  );

  if (isProbablyYarnPnpZipfs(rnMacosDir)) {
    console.warn(`${TAG} HINT: Detected Yarn PnP/zipfs path: ${rnMacosDir}`);
  }

  console.warn(
    `${TAG} HINT: Fix options: (1) use node_modules linker / unplug react-native-macos, (2) use yarn patch, or (3) set ${ENV_SKIP_RN_MACOS_PATCH}=1 to skip (macOS build may fail on react-native-macos 0.81.x).`
  );
}

function applyPatch(filePath, description, detect, transform, rnMacosDir) {
  if (!fs.existsSync(filePath)) return { status: 'missing' };

  const src = fs.readFileSync(filePath, 'utf8');
  if (detect(src)) return { status: 'already' }; // already patched

  const patched = transform(src);
  if (patched === src) {
    console.warn(`${TAG} WARN: ${description} — pattern not found, skipping`);
    return { status: 'pattern_not_found' };
  }

  try {
    fs.writeFileSync(filePath, patched);
    console.log(`${TAG} Applied: ${description}`);
    return { status: 'applied' };
  } catch (err) {
    // Common for Yarn PnP/zipfs or readonly node_modules.
    warnReadOnlyOnce(err, rnMacosDir);
    return { status: 'write_failed' };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const strict = isTruthyEnv(process.env[ENV_STRICT_RN_MACOS_PATCH]);
  if (isTruthyEnv(process.env[ENV_SKIP_RN_MACOS_PATCH])) {
    console.log(`${TAG} Skipped react-native-macos patching (${ENV_SKIP_RN_MACOS_PATCH}=1)`);
    return;
  }

  const rnMacosDir = resolveRnMacosDir();
  if (!rnMacosDir) return; // react-native-macos not installed, nothing to do

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rnMacosDir, 'package.json'), 'utf8'));
  } catch (_) {
    return;
  }

  const version = pkg.version || '';
  const parts = version.split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);

  // Only patch 0.81.x
  if (major !== 0 || minor !== 81) return;

  let applied = 0;
  let failedToApply = 0;

  // --- Patch 1: HermesExecutorFactory.cpp missing <thread> include ---------
  // macOS SDK 26.2+ C++ headers no longer transitively include <thread>.
  const patch1 = applyPatch(
    path.join(rnMacosDir, 'ReactCommon/hermes/executor/HermesExecutorFactory.cpp'),
    'HermesExecutorFactory.cpp — add missing #include <thread>',
    (src) => src.includes('#include <thread>'),
    (src) =>
      src.replace(
        '#include "HermesExecutorFactory.h"',
        '#include "HermesExecutorFactory.h"\n\n#include <thread>'
      ),
    rnMacosDir
  );
  applied += patch1.status === 'applied' ? 1 : 0;
  failedToApply += patch1.status === 'write_failed' ? 1 : 0;

  // --- Patch 2: HermesInstance.cpp registerForProfiling() crash on macOS ---
  // SamplingProfiler is unsupported on macOS; causes EXC_BAD_ACCESS.
  const patch2 = applyPatch(
    path.join(rnMacosDir, 'ReactCommon/react/runtime/hermes/HermesInstance.cpp'),
    'HermesInstance.cpp — guard registerForProfiling() on macOS',
    (src) => src.includes('TARGET_OS_OSX'),
    (src) =>
      src.replace(
        'runtime_->registerForProfiling();',
        '#if !TARGET_OS_OSX\n    runtime_->registerForProfiling();\n#endif'
      ),
    rnMacosDir
  );
  applied += patch2.status === 'applied' ? 1 : 0;
  failedToApply += patch2.status === 'write_failed' ? 1 : 0;

  if (applied > 0) {
    console.log(`${TAG} Patched ${applied} file(s) in react-native-macos ${version}`);
  }

  if (strict && failedToApply > 0) {
    console.error(
      `${TAG} ERROR: Required react-native-macos patch could not be applied (likely read-only install). ` +
        `Set ${ENV_SKIP_RN_MACOS_PATCH}=1 to skip, or switch to a writable node_modules layout (Yarn nodeLinker=node-modules / unplug), or use yarn patch.`
    );
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  const strict = isTruthyEnv(process.env[ENV_STRICT_RN_MACOS_PATCH]);
  if (strict) {
    console.error(
      `${TAG} ERROR: react-native-macos compatibility check failed. ${err?.message ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // NEVER break npm install — log and move on.
  console.warn(`${TAG} WARN: postinstall failed, skipping. ${err.message}`);
}
