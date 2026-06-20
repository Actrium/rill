// TypeScript types and re-export for oxc-adapter.js
// The actual implementation is in oxc-adapter.js to avoid Bun/TypeScript module loading issues with oxc-parser

export type ScanDetail = {
  moduleId: string;
  kind: 'import' | 'export' | 'require' | 'dynamic';
  start?: number;
  end?: number;
};

export type ScanResult = {
  static: string[]; // from import/export and require('literal')
  dynamicLiteral: string[]; // from import('literal')
  dynamicNonLiteral: number; // count of import(expr) that is not string literal
  evalCount: number; // number of eval(...) calls
  details: ScanDetail[];
};

export type HostImportSpecifier = {
  imported: string | null;
  local: string;
  kind: 'named' | 'default' | 'namespace' | 'bare';
};

export type HostModuleImport = {
  moduleId: string;
  specifiers: HostImportSpecifier[];
  kind: 'import' | 'export' | 'require' | 'dynamic';
  start?: number;
  end?: number;
};

export type HostBoundaryViolation = {
  code:
    | 'host-import-bare'
    | 'host-import-default'
    | 'host-import-namespace'
    | 'host-reexport'
    | 'host-require'
    | 'host-dynamic-import';
  moduleId: string;
  message: string;
  start?: number;
  end?: number;
};

export type HostBoundaryScanResult = {
  hostImports: HostModuleImport[];
  hostCapabilities: string[];
  guestExports: string[];
  hasDefaultExport: boolean;
  violations: HostBoundaryViolation[];
};

export type PropHint = {
  location: string;
  element: string;
  props: Record<string, string>;
};

export type JSXAnalysisResult = {
  propHints: PropHint[];
  stats: {
    totalElements: number;
    jsiSafeProps: number;
    functionProps: number;
    unknownProps: number;
  };
};

/**
 * Analyze module dependencies using oxc-parser
 *
 * Uses oxc-parser's built-in module information and Visitor API
 * for comprehensive dependency scanning.
 */
export function analyzeModuleIDs(code: string): ScanResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const impl = require('./oxc-adapter.js');
  return impl.analyzeModuleIDs(code);
}

/**
 * Analyze Guest/Host boundary declarations.
 *
 * This extracts static `host:*` imports, named Guest exports, and
 * boundary-shape violations that must be rejected before runtime.
 */
export function analyzeHostBoundary(code: string): HostBoundaryScanResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const impl = require('./oxc-adapter.js');
  return impl.analyzeHostBoundary(code);
}

/**
 * Analyze JSX props and infer types for JSI optimization
 *
 * Uses oxc-parser to parse JSX/TSX and infer prop types from literal values.
 * Returns type hints that can be used at runtime for JSI zero-copy optimization.
 */
export function analyzeJSXProps(code: string): JSXAnalysisResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const impl = require('./oxc-adapter.js');
  return impl.analyzeJSXProps(code);
}
