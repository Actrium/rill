/**
 * Rill CLI - Build
 *
 * Bun-based guest bundler
 */

import * as babel from '@babel/core';
import type { BunPlugin } from 'bun';
import fs from 'fs';
import path from 'path';

/**
 * Build options
 */
export interface BuildOptions {
  /**
   * Enforce post-build dependency guard to prevent runtime requires in guest bundle.
   * If true (default), the analyzer will fail the build when detecting disallowed modules.
   */
  strict?: boolean;
  /** strict peer versions */
  strictPeerVersions?: boolean;
  /**
   * Entry file path
   */
  entry: string;

  /**
   * Output file path
   * @default 'dist/bundle.js'
   */
  outfile: string;

  /**
   * Enable minification
   * @default true
   */
  minify: boolean;

  /**
   * Generate sourcemap
   * @default false
   */
  sourcemap: boolean;

  /**
   * Enable watch mode
   * @default false
   */
  watch: boolean;

  /**
   * Metadata output path
   */
  metafile?: string;

  /**
   * Custom footer file path (replaces default auto-render footer)
   * Used for custom render logic (e.g., askc usePanels hook)
   */
  footer?: string;

  /**
   * Dev mode - inject source location into functions for DevTools navigation
   * @default false
   */
  dev?: boolean;
}

/**
 * Runtime injection code
 * Sets up necessary global environment before bundle execution
 */
const RUNTIME_INJECT = `
// Rill Runtime Inject
(function() {
  'use strict';

  // Callback registry - persist across re-executions
  if (!globalThis.__callbacks) {
    globalThis.__callbacks = new Map();
    globalThis.__callbackId = 0;
  }

  // Register callback
  globalThis.__registerCallback = function(fn) {
    var id = 'fn_' + (++globalThis.__callbackId);
    globalThis.__callbacks.set(id, fn);
    return id;
  };

  // Invoke callback
  globalThis.__invokeCallback = function(fnId, args) {
    var fn = globalThis.__callbacks.get(fnId);
    if (fn) {
      try {
        return fn.apply(null, args || []);
      } catch (e) {
        console.error('[rill] Callback execution error for', fnId);
        console.error('[rill] Error type:', typeof e);
        console.error('[rill] Error message:', e && e.message ? e.message : String(e));
        console.error('[rill] Error stack:', e && e.stack ? e.stack : 'no stack');
        console.error('[rill] Error name:', e && e.name ? e.name : 'no name');
        throw e;
      }
    } else {
      console.warn('[rill] Callback not found:', fnId);
      console.warn('[rill] Available callbacks:', Array.from(globalThis.__callbacks.keys()).join(', '));
    }
  };

  // Remove callback
  globalThis.__removeCallback = function(fnId) {
    globalThis.__callbacks.delete(fnId);
  };

  // Host event listeners
  var __hostEventListeners = new Map();

  // Register host event listener
  globalThis.__useHostEvent = function(eventName, callback) {
    if (!__hostEventListeners.has(eventName)) {
      __hostEventListeners.set(eventName, new Set());
    }
    __hostEventListeners.get(eventName).add(callback);
  };

  // Handle host event
  globalThis.__handleHostEvent = function(eventName, payload) {
    var listeners = __hostEventListeners.get(eventName);
    if (listeners) {
      listeners.forEach(function(listener) {
        try {
          listener(payload);
        } catch (e) {
          console.error('[rill] Host event listener error:', e);
        }
      });
    }
  };

  // Handle host message
  globalThis.__handleHostMessage = function(message) {
    switch (message.type) {
      case 'CALL_FUNCTION':
        globalThis.__invokeCallback(message.fnId, message.args);
        break;
      case 'HOST_EVENT':
        globalThis.__handleHostEvent(message.eventName, message.payload);
        break;
      case 'CONFIG_UPDATE':
        if (globalThis.__config) {
          Object.assign(globalThis.__config, message.config);
        }
        break;
      case 'DESTROY':
        __hostEventListeners.clear();
        break;
    }
  };

  // Config storage
  globalThis.__config = globalThis.__getConfig ? globalThis.__getConfig() : {};

})();
`;

/**
 * Auto-render footer code (generic)
 * Uses RillReconciler.render for rendering default component export
 *
 * For custom render logic (e.g., usePanels hook), use --footer option
 */
const AUTO_RENDER_FOOTER = `
/* Auto-render */
(function() {
  if (typeof __sendToHost === 'function' && typeof globalThis.__RillGuest !== 'undefined') {
    try {
      var React = globalThis.React;
      if (!React) {
        console.error('[rill] React not found, cannot auto-render');
        return;
      }

      var RillReconciler = globalThis.RillReconciler;
      if (!RillReconciler || !RillReconciler.render) {
        console.error('[rill] RillReconciler not found, cannot auto-render');
        return;
      }

      var GuestExport = globalThis.__RillGuest;
      var Component = typeof GuestExport === 'function'
        ? GuestExport
        : (GuestExport.default || GuestExport);

      if (!Component || typeof Component !== 'function') {
        console.warn('[rill] No valid component found in guest export');
        return;
      }

      console.log('[rill] Auto-rendering guest component');
      RillReconciler.render(React.createElement(Component), __sendToHost);
    } catch (error) {
      console.error('[rill] Auto-render failed:', error);
    }
  }
})();
`;

/**
 * External modules and their global variable names
 */
const EXTERNALS: Record<string, string> = {
  react: 'React',
  'react/jsx-runtime': 'ReactJSXRuntime',
  'react/jsx-dev-runtime': 'ReactJSXDevRuntime',
  'react-native': 'ReactNative',
  'rill/sdk': 'RillSDK',
  '@rill/let': 'RillLet', // deprecated alias
};

/**
 * Create Bun plugin for pre-bundle Babel transforms (dev mode source location injection)
 */
async function createBabelPlugin(): Promise<BunPlugin> {
  const functionSourceLocationPlugin = (await import('./babel-plugin-function-source-location'))
    .default;

  return {
    name: 'babel-source-location',
    setup(build) {
      // Only process source files (tsx, ts, jsx, js)
      build.onLoad({ filter: /\.(tsx?|jsx?)$/ }, async (args) => {
        const contents = await Bun.file(args.path).text();

        try {
          const result = await babel.transformAsync(contents, {
            filename: args.path, // Use original file path!
            plugins: [functionSourceLocationPlugin],
            parserOpts: {
              sourceType: 'module',
              plugins: ['typescript', 'jsx'],
            },
            generatorOpts: {
              retainLines: true, // Preserve line numbers
            },
          });

          if (result?.code) {
            return {
              contents: result.code,
              loader: args.path.endsWith('.tsx')
                ? 'tsx'
                : args.path.endsWith('.ts')
                  ? 'ts'
                  : args.path.endsWith('.jsx')
                    ? 'jsx'
                    : 'js',
            };
          }
        } catch (err) {
          // If Babel fails, return original content
          console.warn(`[babel] Transform failed for ${args.path}:`, (err as Error).message);
        }

        return undefined; // Let Bun handle it normally
      });
    },
  };
}

/**
 * Alias shim for externals that Bun may rename (e.g., __React)
 */
const EXTERNAL_ALIAS_SHIM = `
// External alias shim (React/JSX/ReactNative)
try { if (typeof __React === 'undefined' && typeof React !== 'undefined') { var __React = React; } } catch {}
try { if (typeof __ReactJSXRuntime === 'undefined' && typeof ReactJSXRuntime !== 'undefined') { var __ReactJSXRuntime = ReactJSXRuntime; } } catch {}
try { if (typeof __ReactJSXDevRuntime === 'undefined' && typeof ReactJSXDevRuntime !== 'undefined') { var __ReactJSXDevRuntime = ReactJSXDevRuntime; } } catch {}
try { if (typeof __ReactNative === 'undefined' && typeof ReactNative !== 'undefined') { var __ReactNative = ReactNative; } } catch {}
`;

/**
 * Execute build using Bun.build
 */
export async function build(options: BuildOptions): Promise<void> {
  const startTime = Date.now();

  const { entry, outfile, minify, sourcemap, watch, metafile, footer } = options;
  const strict = options.strict ?? true;

  // Validate entry file
  const entryPath = path.resolve(process.cwd(), entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry file not found: ${entryPath}`);
  }

  // Ensure output directory exists
  const outDir = path.dirname(path.resolve(process.cwd(), outfile));
  const outFileName = path.basename(outfile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(`Building ${entry}...`);

  if (watch) {
    console.log('Watch mode not yet implemented for Bun.build');
    console.log('Use: bun --watch build.ts for now');
    return;
  }

  // Create plugins array
  const plugins: BunPlugin[] = [];

  // In dev mode, add Babel plugin for source location injection
  if (options.dev) {
    console.log('Dev mode: enabling source location injection...');
    plugins.push(await createBabelPlugin());
  }

  // Build with Bun
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: outDir,
    target: 'browser',
    format: 'cjs',
    naming: `${outFileName.replace(/\.js$/, '')}.[ext]`,
    minify,
    sourcemap: sourcemap ? 'external' : 'none',
    external: Object.keys(EXTERNALS),
    plugins,
    define: {
      'process.env.NODE_ENV': '"production"',
      __DEV__: 'false',
    },
  });

  if (!result.success) {
    console.error('Build failed:');
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error('Bun build failed');
  }

  // Post-process: wrap in IIFE with globals mapping
  const targetPath = path.join(outDir, outFileName);
  let bundleCode = await Bun.file(result.outputs[0]!.path).text();

  // Note: Dev mode source location injection is now done via Bun plugin (pre-bundle)
  // This ensures __sourceFile contains original file path, not bundle path

  // Analyze JSX props for JSI optimization
  console.log('\nAnalyzing JSX props for JSI optimization...');
  let jsxAnalysis: import('./oxcAdapter').JSXAnalysisResult = {
    propHints: [],
    stats: {
      totalElements: 0,
      jsiSafeProps: 0,
      functionProps: 0,
      unknownProps: 0,
    },
  };
  try {
    const { analyzeJSXProps } = await import('./oxcAdapter');
    jsxAnalysis = analyzeJSXProps(bundleCode);

    if (jsxAnalysis.stats) {
      console.log(`  ✓ Analyzed ${jsxAnalysis.stats.totalElements} JSX elements`);
      console.log(`  ✓ Found ${jsxAnalysis.stats.jsiSafeProps} JSI-safe props`);
      console.log(`  ✓ Found ${jsxAnalysis.stats.functionProps} function props`);
      if (jsxAnalysis.stats.unknownProps > 0) {
        console.log(
          `  ⚠ ${jsxAnalysis.stats.unknownProps} props with unknown types (will use fallback)`
        );
      }
    }
  } catch (err) {
    console.warn('  ⚠ JSX analysis failed:', (err as Error).message);
    console.warn('  ℹ Continuing without type hints');
  }

  // Transform external imports to global variable references
  // Bun marks externals as require() calls, we need to map them to globals
  for (const [mod, globalName] of Object.entries(EXTERNALS)) {
    // Replace require("module") with global variable
    const requirePattern = new RegExp(`require\\(["']${mod.replace('/', '\\/')}["']\\)`, 'g');
    bundleCode = bundleCode.replace(requirePattern, globalName);
  }

  // For CJS output, module.exports carries the default export
  // After transforming externals, capture default into globalThis.__RillGuest
  const captureExports = `
try {
  var __rillModuleExports = (typeof module !== 'undefined' && module && module.exports) ? module.exports : (typeof exports !== 'undefined' ? exports : undefined);
  if (__rillModuleExports) {
    globalThis.__RillGuest = __rillModuleExports.default || __rillModuleExports;
  }
} catch {}
`;

  const modifiedBundle = `${bundleCode}\n${captureExports}`;

  // Determine footer: custom or default
  let footerCode = AUTO_RENDER_FOOTER;
  if (footer) {
    const footerPath = path.resolve(footer);
    if (fs.existsSync(footerPath)) {
      footerCode = fs.readFileSync(footerPath, 'utf-8');
      console.log(`Using custom footer: ${footerPath}`);
    } else {
      console.warn(`⚠ Custom footer not found: ${footerPath}, using default`);
    }
  }

  // Wrap with runtime inject and auto-render footer
  // JSI optimization is handled directly in createElement (see RUNTIME_INJECT)
  const wrappedCode = `/* Rill Guest Bundle - Generated by rill-cli */
${RUNTIME_INJECT}
${EXTERNAL_ALIAS_SHIM}
${modifiedBundle}
${footerCode}
/* End of Rill Guest Bundle */`;

  // Write final bundle
  await Bun.write(targetPath, wrappedCode);

  // 拷贝 bun 输出中的非 JS 资产（图片等）到目标目录
  // 当 outDir 与最终目标目录不同时需要拷贝；相同时图片已在目标位置，无需拷贝
  for (const output of result.outputs) {
    if (output.path === targetPath) continue;
    const ext = path.extname(output.path).toLowerCase();
    if (ext !== '.js' && ext !== '.map') {
      const destPath = path.join(outDir, path.basename(output.path));
      if (output.path !== destPath) {
        fs.copyFileSync(output.path, destPath);
      }
      console.log(`   Asset: ${path.basename(output.path)}`);
    }
  }
  // 删除 bun 原始输出中的 JS/Map 文件（非 JS 资产保留在目标目录）
  for (const output of result.outputs) {
    if (output.path === targetPath) continue;
    const ext = path.extname(output.path).toLowerCase();
    if ((ext === '.js' || ext === '.map') && fs.existsSync(output.path)) {
      fs.unlinkSync(output.path);
    }
  }

  // Post-build strict dependency guard
  if (strict) {
    try {
      await analyze(targetPath, {
        whitelist: ['react', 'react-native', 'react/jsx-runtime', '@rill/let'],
        failOnViolation: true,
        treatEvalAsViolation: true,
        treatDynamicNonLiteralAsViolation: true,
      });
      console.log('   Strict guard: PASS');
    } catch (guardErr) {
      console.error('\n❌ Strict guard failed:');
      if (guardErr instanceof Error) console.error(`   ${guardErr.message}`);
      throw guardErr;
    }
  }

  // Validate bundle can be loaded with Function constructor
  try {
    const mockExports: Record<string, unknown> = {};
    const mockGlobals: Record<string, unknown> = {
      React: { createElement: () => ({}) },
      ReactJSXRuntime: { jsx: () => ({}), jsxs: () => ({}) },
      ReactJSXDevRuntime: { jsx: () => ({}), jsxs: () => ({}) },
      ReactNative: {},
      RillReconciler: { render: () => {}, unmount: () => {} },
      RillLet: {
        View: 'View',
        Text: 'Text',
        useHostEvent: () => {},
        useConfig: () => ({}),
        useSendToHost: () => () => {},
      },
      RillSDK: {
        View: 'View',
        Text: 'Text',
        useHostEvent: () => {},
        useConfig: () => ({}),
        useSendToHost: () => () => {},
      },
      module: { exports: mockExports },
      exports: mockExports,
      __React: null,
      __ReactJSXRuntime: null,
      __ReactJSXDevRuntime: null,
      __ReactNative: null,
    };
    // Alias externals to __React* variants
    mockGlobals.__React = mockGlobals.React;
    mockGlobals.__ReactJSXRuntime = mockGlobals.ReactJSXRuntime;
    mockGlobals.__ReactJSXDevRuntime = mockGlobals.ReactJSXDevRuntime;
    mockGlobals.__ReactNative = mockGlobals.ReactNative;

    // Mock require function that returns mock globals based on module name
    const mockRequire = (name: string) => {
      if (name === 'react') return mockGlobals.React;
      if (name === 'react/jsx-runtime') return mockGlobals.ReactJSXRuntime;
      if (name === 'react/jsx-dev-runtime') return mockGlobals.ReactJSXDevRuntime;
      if (name === 'react-native') return mockGlobals.ReactNative;
      if (name === 'rill/sdk') return mockGlobals.RillSDK;
      if (name === '@rill/let') return mockGlobals.RillLet;
      return {};
    };
    const globalNames = ['require', ...Object.keys(mockGlobals)];
    const globalValues = [mockRequire, ...Object.values(mockGlobals)];
    new Function(...globalNames, wrappedCode)(...globalValues);
    console.log('   Syntax validation: PASS');
  } catch (validationErr) {
    console.error('\n❌ Bundle validation failed:');
    if (validationErr instanceof Error) {
      console.error('   Error:', validationErr.message);
    }
    throw validationErr;
  }

  // Output build info
  const stats = fs.statSync(targetPath);
  const sizeKB = (stats.size / 1024).toFixed(2);
  const duration = Date.now() - startTime;

  console.log(`✅ Build successful!`);
  console.log(`   File: ${outfile}`);
  console.log(`   Size: ${sizeKB} KB`);
  console.log(`   Time: ${duration}ms`);

  // Output metafile
  if (metafile) {
    const metaInfo = {
      inputs: { [entry]: { bytes: fs.statSync(entryPath).size } },
      outputs: { [outfile]: { bytes: stats.size } },
    };
    fs.writeFileSync(path.resolve(process.cwd(), metafile), JSON.stringify(metaInfo, null, 2));
    console.log(`   Metafile: ${metafile}`);
  }
}

/**
 * Analyze bundle for disallowed dependencies
 */
export async function analyze(
  bundlePath: string,
  options?: {
    whitelist?: string[];
    failOnViolation?: boolean;
    treatEvalAsViolation?: boolean;
    treatDynamicNonLiteralAsViolation?: boolean;
  }
): Promise<void> {
  const fullPath = path.resolve(process.cwd(), bundlePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Bundle not found: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const stats = fs.statSync(fullPath);

  console.log('Bundle Analysis:');
  console.log(`  File: ${bundlePath}`);
  console.log(`  Size: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log(`  Lines: ${content.split('\n').length}`);

  // Use oxc adapter for module analysis
  const { analyzeModuleIDs } = await import('./oxcAdapter');
  const scan = await analyzeModuleIDs(content);
  const found = new Set<string>([
    ...scan.static,
    ...scan.dynamicLiteral,
    ...scan.details.map((d) => d.moduleId).filter(Boolean),
  ] as string[]);

  const whitelist = new Set(
    options?.whitelist ?? ['react', 'react-native', 'react/jsx-runtime', '@rill/let']
  );

  const violations: string[] = Array.from(found).filter((m) => {
    if (whitelist.has(m)) return false;
    if (m.startsWith('./') || m.startsWith('../')) return false;
    if (/^(data:|blob:|http:|https:|file:)/.test(m)) return false;
    if (m.includes('\0')) return false;
    return true;
  });

  if (options?.treatDynamicNonLiteralAsViolation && scan.dynamicNonLiteral > 0) {
    violations.push(`dynamic_import_non_literal:${scan.dynamicNonLiteral}`);
  }
  if (options?.treatEvalAsViolation && scan.evalCount > 0) {
    violations.push(`eval_calls:${scan.evalCount}`);
  }

  if (violations.length > 0) {
    const msg = `Found non-whitelisted modules: ${violations.join(', ')}`;
    if (options?.failOnViolation) {
      throw new Error(msg);
    } else {
      console.warn(`  ⚠ Warning: ${msg}`);
    }
  }
}
