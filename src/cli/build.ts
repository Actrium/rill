/**
 * Rill CLI - Build
 *
 * Bun-based guest bundler
 */

import type { BunPlugin } from 'bun';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { isHostModuleId, type RillContractShape, validateContract } from '../contract';

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
   * Contract object used to validate host:* imports and Guest exports.
   */
  contract?: RillContractShape;

  /**
   * Path to a contract module. The module must export `contract` or a default contract.
   */
  contractFile?: string;

  /**
   * Capability manifest output path.
   */
  capabilityManifest?: string;

  /**
   * Custom footer file path (replaces default auto-render footer)
   * Used for custom render logic (e.g., a host-specific layout hook)
   */
  footer?: string;

  /**
   * Dev mode - inject source location into functions for DevTools navigation
   * @default false
   */
  dev?: boolean;
}

export interface AnalyzeOptions {
  whitelist?: string[];
  failOnViolation?: boolean;
  treatEvalAsViolation?: boolean;
  treatDynamicNonLiteralAsViolation?: boolean;
  contract?: RillContractShape;
  contractFile?: string;
}

export interface AnalyzeResult {
  modules: string[];
  hostCapabilities: string[];
  guestExports: string[];
  violations: string[];
}

export interface GuestCapabilitiesManifest {
  contractVersion: string | null;
  hostCapabilities: string[];
  guestExports: string[];
  /**
   * Used host capabilities whose untrusted guest->host input is NOT validated by
   * a boundary schema (rpc without `parseInput`, subscription without
   * `parseEvent`). Empty when no contract is supplied. A sealed-tier publish gate
   * should reject a non-empty list.
   */
  unschemed: string[];
}

/**
 * Runtime injection code
 * Sets up necessary global environment before bundle execution
 */
const RUNTIME_INJECT = `
// Rill Runtime Inject
(function() {
  'use strict';

  // Initialize __rill namespace
  if (!globalThis.__rill) { globalThis.__rill = {}; }
  var __rill = globalThis.__rill;

  // Callback registry - persist across re-executions
  if (!__rill.callbacks) {
    __rill.callbacks = new Map();
  }
  if (typeof __rill.callbackId !== 'number') {
    __rill.callbackId = 0;
  }

  // Register callback
  if (typeof __rill.registerCallback !== 'function') {
    __rill.registerCallback = function(fn) {
      var id = 'fn_' + (++__rill.callbackId);
      __rill.callbacks.set(id, fn);
      return id;
    };
  }

  // Invoke callback
  if (typeof __rill.invokeCallback !== 'function') {
    __rill.invokeCallback = function(fnId, args) {
      var fn = __rill.callbacks.get(fnId);
      if (fn) {
        try {
          return fn.apply(null, args || []);
        } catch (e) {
          console.error('[rill] Callback execution error for', fnId);
          console.error('[rill] Error message:', e && e.message ? e.message : String(e));
          console.error('[rill] Error stack:', e && e.stack ? e.stack : 'no stack');
          throw e;
        }
      } else {
        console.warn('[rill] Callback not found:', fnId);
      }
    };
  }

  // Remove callback
  if (typeof __rill.removeCallback !== 'function') {
    __rill.removeCallback = function(fnId) {
      __rill.callbacks.delete(fnId);
    };
  }

  // Host event listeners
  if (!__rill.eventListeners) {
    __rill.eventListeners = new Map();
  }
  var __eventListeners = __rill.eventListeners;

  // Register host event listener
  if (typeof globalThis.__rill_onHostEvent !== 'function') {
    globalThis.__rill_onHostEvent = function(eventName, callback) {
      if (!__eventListeners.has(eventName)) {
        __eventListeners.set(eventName, new Set());
      }
      var set = __eventListeners.get(eventName);
      set.add(callback);
      return function() {
        try { set.delete(callback); } catch (_) {}
      };
    };
  }

  // Handle host event
  if (typeof __rill.dispatchEvent !== 'function') {
    __rill.dispatchEvent = function(eventName, payload) {
      var listeners = __eventListeners.get(eventName);
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
  }

  // Handle host message
  if (typeof globalThis.__rill_handleMessage !== 'function') {
    globalThis.__rill_handleMessage = function(message) {
      switch (message.type) {
        case 'CALL_FUNCTION':
          __rill.invokeCallback(message.fnId, message.args);
          break;
        case 'HOST_EVENT':
          __rill.dispatchEvent(message.eventName, message.payload);
          break;
        case 'CONFIG_UPDATE':
          if (__rill.config) {
            Object.assign(__rill.config, message.config);
          }
          break;
        case 'DESTROY':
          __eventListeners.clear();
          break;
      }
    };
  }

  // Config storage
  if (!__rill.config) {
    __rill.config = globalThis.__rill_getConfig ? globalThis.__rill_getConfig() : {};
  }

  // Host module resolver. Bundled host:* imports are rewritten to this hook.
  // The host populates __rill.hostModules (see Engine.injectHostModules); an
  // unregistered capability fails closed.
  if (typeof globalThis.__rill_importHostModule !== 'function') {
    globalThis.__rill_importHostModule = function(moduleId) {
      if (__rill.hostModules && __rill.hostModules[moduleId]) {
        return __rill.hostModules[moduleId];
      }

      throw new Error('[rill] Host module not registered: ' + moduleId);
    };
  }

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
  if (typeof __rill_sendBatch === 'function' && typeof globalThis.__rill !== 'undefined' && globalThis.__rill.guest) {
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

      var GuestExport = globalThis.__rill.guest;
      var Component = typeof GuestExport === 'function'
        ? GuestExport
        : (GuestExport.default || GuestExport);

      if (!Component || typeof Component !== 'function') {
        console.warn('[rill] No valid component found in guest export');
        return;
      }

      console.log('[rill] Auto-rendering guest component');
      RillReconciler.render(React.createElement(Component), __rill_sendBatch);
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
  'rill/guest': 'RillGuest',
};

const HOST_MODULE_EXTERNAL = 'host:*';

/**
 * Map a source file path to the Bun loader that should process the
 * Babel-transformed output.
 */
function loaderForPath(filePath: string): 'tsx' | 'ts' | 'jsx' | 'js' {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (/\.[cm]?ts$/.test(filePath)) return 'ts';
  if (filePath.endsWith('.jsx')) return 'jsx';
  return 'js';
}

/**
 * Babel parser plugins per file kind: `typescript` and `jsx` together force
 * TSX parsing, which misreads `<T>() => ...` generic arrows in plain .ts, so
 * only .tsx gets both.
 */
function parserPluginsForPath(
  filePath: string
): NonNullable<import('@babel/core').ParserOptions['plugins']> {
  if (filePath.endsWith('.tsx')) return ['typescript', 'jsx', 'decorators-legacy'];
  if (/\.[cm]?ts$/.test(filePath)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

/**
 * Create Bun plugin for pre-bundle Babel transforms.
 *
 * Always transforms arrow functions → function expressions: Hermes' compiler
 * (verified on hermes-engine 0.11.0 and the hermesc bundled with RN 0.81.5)
 * rejects async arrow functions with "async functions are unsupported" while
 * accepting `async function`. Babel's arrow-functions transform aliases
 * `this`/`arguments`/`new.target`, so the conversion is semantically safe
 * across all engines (QuickJS/JSC/WASM/Hermes).
 *
 * A failed per-file transform is only a warning here — the post-build Hermes
 * compat guard fails the build if an async arrow reaches the final bundle.
 * In dev mode the source-location injection plugin is added on top.
 */
async function createBabelPlugin(options: { dev: boolean }): Promise<BunPlugin> {
  const babel = await import('@babel/core');
  // Pass the plugin as a module object, not a string: Babel resolves string
  // plugin names against the build cwd, which silently fails when `rill build`
  // runs outside a tree where the package is hoisted.
  const arrowFunctionsTransform = (await import('@babel/plugin-transform-arrow-functions')).default;
  const transformPlugins: import('@babel/core').PluginItem[] = [arrowFunctionsTransform];
  if (options.dev) {
    transformPlugins.push((await import('./babel-plugin-function-source-location')).default);
  }

  return {
    name: 'babel-hermes-compat',
    setup(build) {
      // Cover every JS/TS flavor Bun may bundle, including .mjs/.cjs/.mts/.cts
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const contents = await Bun.file(args.path).text();

        try {
          const result = await babel.transformAsync(contents, {
            filename: args.path, // Use original file path!
            plugins: transformPlugins,
            parserOpts: {
              // CJS deps are scripts, not modules; top-level `return` is legal there
              sourceType: 'unambiguous',
              allowReturnOutsideFunction: true,
              plugins: parserPluginsForPath(args.path),
            },
            generatorOpts: {
              retainLines: true, // Preserve line numbers
            },
          });

          if (result?.code) {
            return {
              contents: result.code,
              loader: loaderForPath(args.path),
            };
          }
        } catch (err) {
          // Pass the original file through; the post-build guard catches any
          // async arrow this file would have contributed to the bundle
          console.warn(`[babel] Transform failed for ${args.path}:`, (err as Error).message);
        }

        return undefined; // Let Bun handle it normally
      });
    },
  };
}

/**
 * Scan an oxc-parser program (JSON string) for async arrow functions.
 * String literals in the bundle (e.g. React warnings quoting "async () =>")
 * are AST values, not nodes, so they cannot false-positive.
 */
function findAsyncArrows(programJson: string): { count: number; firstOffset: number } {
  let count = 0;
  let firstOffset = -1;
  // Reason: walking raw oxc AST JSON; nodes are heterogeneous and only
  // type/async/start fields are inspected after narrowing
  const stack: unknown[] = [JSON.parse(programJson)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const record = node as Record<string, unknown>;
    if (record.type === 'ArrowFunctionExpression' && record.async === true) {
      count++;
      const start = typeof record.start === 'number' ? record.start : -1;
      if (firstOffset === -1 || (start !== -1 && start < firstOffset)) firstOffset = start;
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return { count, firstOffset };
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

type HostBoundaryScanResult = import('./oxc-adapter').HostBoundaryScanResult;

interface ContractOptions {
  contract?: RillContractShape;
  contractFile?: string;
}

interface CollectedHostBoundary {
  hostModuleIds: string[];
  hostCapabilities: string[];
  guestExports: string[];
  violations: string[];
}

async function resolveContract(options: ContractOptions): Promise<RillContractShape | undefined> {
  if (options.contract) {
    validateContract(options.contract);
    return options.contract;
  }

  if (!options.contractFile) {
    return undefined;
  }

  const contractPath = path.resolve(process.cwd(), options.contractFile);
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract file not found: ${contractPath}`);
  }

  const contractModule = await import(pathToFileURL(contractPath).href);
  const contract = contractModule.contract ?? contractModule.default;

  if (!contract) {
    throw new Error(`Contract file must export "contract" or default: ${contractPath}`);
  }

  validateContract(contract);
  return contract;
}

function createHostBoundaryCollector(entryPath: string): {
  plugin: BunPlugin;
  getResult: () => CollectedHostBoundary;
} {
  const hostModuleIds = new Set<string>();
  const hostCapabilities = new Set<string>();
  const guestExports = new Set<string>();
  const violations: string[] = [];
  let analyzerPromise: Promise<typeof import('./oxc-adapter')> | undefined;

  const getAnalyzer = () => {
    analyzerPromise ??= import('./oxc-adapter');
    return analyzerPromise;
  };

  return {
    plugin: {
      name: 'rill-host-boundary-analysis',
      setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
          if (args.path.includes(`${path.sep}node_modules${path.sep}`)) {
            return undefined;
          }

          const contents = await Bun.file(args.path).text();
          const { analyzeHostBoundary } = await getAnalyzer();
          const scan = analyzeHostBoundary(contents);
          const isEntry = path.resolve(args.path) === entryPath;

          mergeHostBoundaryScan(args.path, scan, {
            hostModuleIds,
            hostCapabilities,
            guestExports: isEntry ? guestExports : undefined,
            violations,
          });

          return undefined;
        });
      },
    },

    getResult() {
      return {
        hostModuleIds: Array.from(hostModuleIds).sort(),
        hostCapabilities: Array.from(hostCapabilities).sort(),
        guestExports: Array.from(guestExports).sort(),
        violations: [...violations],
      };
    },
  };
}

function mergeHostBoundaryScan(
  filePath: string,
  scan: HostBoundaryScanResult,
  target: {
    hostModuleIds: Set<string>;
    hostCapabilities: Set<string>;
    guestExports?: Set<string>;
    violations: string[];
  }
): void {
  for (const hostImport of scan.hostImports) {
    target.hostModuleIds.add(hostImport.moduleId);
  }

  for (const capability of scan.hostCapabilities) {
    target.hostCapabilities.add(capability);
  }

  if (target.guestExports) {
    for (const exportName of scan.guestExports) {
      target.guestExports.add(exportName);
    }
  }

  for (const violation of scan.violations) {
    target.violations.push(`${path.relative(process.cwd(), filePath)}: ${violation.message}`);
  }
}

function validateBoundaryAgainstContract(
  boundary: Pick<CollectedHostBoundary, 'hostCapabilities' | 'guestExports'>,
  contract: RillContractShape,
  options: { checkMissingGuestExports?: boolean } = {}
): string[] {
  const violations: string[] = [];

  for (const capability of boundary.hostCapabilities) {
    const [moduleId, exportName] = splitCapabilityName(capability);
    if (!moduleId || !exportName) continue;

    const moduleSpec = contract.hostModules[moduleId as keyof typeof contract.hostModules];

    if (!moduleSpec) {
      violations.push(`Host module "${moduleId}" is not declared in contract.`);
      continue;
    }

    if (!(exportName in moduleSpec)) {
      violations.push(`Host capability "${capability}" is not declared in contract.`);
    }
  }

  for (const exportName of boundary.guestExports) {
    if (!(exportName in contract.guestExports)) {
      violations.push(`Guest export "${exportName}" is not declared in contract.`);
    }
  }

  if (options.checkMissingGuestExports ?? true) {
    for (const exportName of Object.keys(contract.guestExports)) {
      if (!boundary.guestExports.includes(exportName)) {
        violations.push(`Guest export "${exportName}" is declared in contract but not exported.`);
      }
    }
  }

  return violations;
}

function splitCapabilityName(capability: string): [string | null, string | null] {
  const dotIndex = capability.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === capability.length - 1) {
    return [null, null];
  }

  return [capability.slice(0, dotIndex), capability.slice(dotIndex + 1)];
}

function throwBoundaryViolations(violations: string[]): void {
  if (violations.length === 0) {
    return;
  }

  throw new Error(`Rill boundary violations:\n- ${violations.join('\n- ')}`);
}

function rewriteHostModuleRequires(code: string, moduleIds: string[]): string {
  let rewritten = code;

  for (const moduleId of moduleIds) {
    const pattern = new RegExp(`require\\(["']${escapeRegExp(moduleId)}["']\\)`, 'g');
    rewritten = rewritten.replace(
      pattern,
      `globalThis.__rill_importHostModule(${JSON.stringify(moduleId)})`
    );
  }

  return rewritten;
}

function createGuestCapabilitiesManifest(
  boundary: Pick<CollectedHostBoundary, 'hostCapabilities' | 'guestExports'>,
  contract?: RillContractShape
): GuestCapabilitiesManifest {
  // Of the capabilities actually used by the guest, flag those whose untrusted
  // input crosses unvalidated: rpc without parseInput / subscription without
  // parseEvent. (parseOutput is host->guest and not required.)
  const unschemed = contract
    ? [...boundary.hostCapabilities]
        .filter((capability) => {
          const sep = capability.indexOf('.');
          const moduleId = capability.slice(0, sep);
          const exportName = capability.slice(sep + 1);
          const descriptor =
            contract.hostModules[moduleId as keyof typeof contract.hostModules]?.[exportName];
          if (!descriptor) return false; // undeclared use is already a build violation
          return descriptor.kind === 'subscription'
            ? !descriptor.schema?.parseEvent
            : !descriptor.schema?.parseInput;
        })
        .sort()
    : [];
  return {
    contractVersion: contract?.version ?? null,
    hostCapabilities: [...boundary.hostCapabilities].sort(),
    guestExports: [...boundary.guestExports].sort(),
    unschemed,
  };
}

// Reason: JSON artifact writer accepts arbitrary serializable manifest-like values.
function writeJsonFile(filePath: string, value: unknown): void {
  const fullPath = path.resolve(process.cwd(), filePath);
  const directory = path.dirname(fullPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(fullPath, JSON.stringify(value, null, 2));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Execute build using Bun.build
 */
export async function build(options: BuildOptions): Promise<void> {
  const startTime = Date.now();

  const { entry, outfile, minify, sourcemap, watch, metafile, footer, capabilityManifest } =
    options;
  const strict = options.strict ?? true;
  const contract = await resolveContract(options);

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
  const hostBoundaryCollector = createHostBoundaryCollector(entryPath);
  plugins.push(hostBoundaryCollector.plugin);

  // Always-on Babel: arrow→function for Hermes sandbox compat; +source-location in dev.
  console.log('Hermes compat: transforming arrow functions to function expressions...');
  if (options.dev) {
    console.log('Dev mode: enabling source location injection...');
  }
  plugins.push(await createBabelPlugin({ dev: options.dev ?? false }));

  // Build with Bun
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: outDir,
    target: 'browser',
    format: 'cjs',
    naming: `${outFileName.replace(/\.js$/, '')}.[ext]`,
    minify,
    sourcemap: sourcemap ? 'external' : 'none',
    external: [...Object.keys(EXTERNALS), HOST_MODULE_EXTERNAL],
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

  const hostBoundary = hostBoundaryCollector.getResult();
  throwBoundaryViolations([
    ...hostBoundary.violations,
    ...(contract ? validateBoundaryAgainstContract(hostBoundary, contract) : []),
  ]);

  // Post-process: wrap in IIFE with globals mapping
  const targetPath = path.join(outDir, outFileName);
  let bundleCode = await Bun.file(result.outputs[0]!.path).text();

  // Note: Dev mode source location injection is now done via Bun plugin (pre-bundle)
  // This ensures __sourceFile contains original file path, not bundle path

  // Analyze JSX props for JSI optimization
  console.log('\nAnalyzing JSX props for JSI optimization...');
  let jsxAnalysis: import('./oxc-adapter').JSXAnalysisResult = {
    propHints: [],
    stats: {
      totalElements: 0,
      jsiSafeProps: 0,
      functionProps: 0,
      unknownProps: 0,
    },
  };
  try {
    const { analyzeJSXProps } = await import('./oxc-adapter');
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
  bundleCode = rewriteHostModuleRequires(bundleCode, hostBoundary.hostModuleIds);

  // For CJS output, module.exports carries the default export
  // After transforming externals, capture default into globalThis.__rill.guest
  const captureExports = `
try {
  var __rillModuleExports = (typeof module !== 'undefined' && module && module.exports) ? module.exports : (typeof exports !== 'undefined' ? exports : undefined);
  if (__rillModuleExports) {
    if (!globalThis.__rill) { globalThis.__rill = {}; }
    globalThis.__rill.guest = __rillModuleExports.default || __rillModuleExports;
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
        whitelist: ['react', 'react-native', 'react/jsx-runtime', 'rill/guest'],
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

  // Validate bundle syntax via AST parse (no execution, no mock globals needed)
  try {
    const oxc = require('oxc-parser');
    const result = oxc.parseSync(wrappedCode, { sourceType: 'script' });
    if (result.errors && result.errors.length > 0) {
      const msgs = result.errors.map((e: { message: string }) => e.message).join('\n  ');
      throw new Error(`Syntax errors:\n  ${msgs}`);
    }
    console.log('   Syntax validation: PASS');

    // Hermes compat guard: async arrows crash Hermes hosts at compile time
    // ("async functions are unsupported"). The pre-bundle Babel pass eliminates
    // them; this catches anything that slipped through (a dep the transform
    // failed on, a custom footer, future loader gaps).
    const asyncArrows = findAsyncArrows(result.program);
    if (asyncArrows.count > 0) {
      throw new Error(
        `Hermes compat guard: ${asyncArrows.count} async arrow function(s) reached the final bundle ` +
          `(first at offset ${asyncArrows.firstOffset}). The bundle would fail to compile on Hermes hosts; ` +
          'ensure the offending source is covered by the Babel arrow transform.'
      );
    }
    console.log('   Hermes compat guard: PASS (no async arrows)');
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

  if (capabilityManifest) {
    writeJsonFile(capabilityManifest, createGuestCapabilitiesManifest(hostBoundary, contract));
    console.log(`   Capability manifest: ${capabilityManifest}`);
  }
}

/**
 * Analyze bundle for disallowed dependencies
 */
export async function analyze(
  bundlePath: string,
  options?: AnalyzeOptions
): Promise<AnalyzeResult> {
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
  const { analyzeHostBoundary, analyzeModuleIDs } = await import('./oxc-adapter');
  const scan = await analyzeModuleIDs(content);
  const shouldAnalyzeBoundary = content.includes('host:') || /\bexport\b/.test(content);
  const boundary = shouldAnalyzeBoundary
    ? analyzeHostBoundary(content)
    : {
        hostImports: [],
        hostCapabilities: [],
        guestExports: [],
        hasDefaultExport: false,
        violations: [],
      };
  const found = new Set<string>([
    ...scan.static,
    ...scan.dynamicLiteral,
    ...scan.details.map((d) => d.moduleId).filter(Boolean),
  ] as string[]);

  const whitelist = new Set(
    options?.whitelist ?? ['react', 'react-native', 'react/jsx-runtime', 'rill/guest']
  );

  const violations: string[] = Array.from(found).filter((m) => {
    if (whitelist.has(m)) return false;
    if (isHostModuleId(m)) return false;
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

  for (const violation of boundary.violations) {
    violations.push(violation.message);
  }

  const contract = await resolveContract(options ?? {});
  if (contract) {
    violations.push(
      ...validateBoundaryAgainstContract(boundary, contract, {
        checkMissingGuestExports: false,
      })
    );
  }

  if (boundary.hostCapabilities.length > 0) {
    console.log('  Host capabilities:');
    for (const capability of boundary.hostCapabilities) {
      console.log(`    - ${capability}`);
    }
  }

  if (boundary.guestExports.length > 0) {
    console.log('  Guest exports:');
    for (const exportName of boundary.guestExports) {
      console.log(`    - ${exportName}`);
    }
  }

  if (violations.length > 0) {
    const hasOnlyModuleViolations = violations.every(
      (violation) =>
        found.has(violation) ||
        violation.startsWith('dynamic_import_non_literal:') ||
        violation.startsWith('eval_calls:')
    );
    const msg = hasOnlyModuleViolations
      ? `Found non-whitelisted modules: ${violations.join(', ')}`
      : `Found Rill boundary violations: ${violations.join(', ')}`;
    if (options?.failOnViolation) {
      throw new Error(msg);
    } else {
      console.warn(`  ⚠ Warning: ${msg}`);
    }
  }

  return {
    modules: Array.from(found).sort(),
    hostCapabilities: boundary.hostCapabilities,
    guestExports: boundary.guestExports,
    violations,
  };
}
