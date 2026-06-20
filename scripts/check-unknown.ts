#!/usr/bin/env bun
/**
 * Check for unapproved unknown type usage
 *
 * This script scans TypeScript files for direct `unknown` usage
 * and flags any that don't have proper approval comments.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

interface UnknownUsage {
  file: string;
  line: number;
  code: string;
  approved: boolean;
  reason?: string;
}

const APPROVED_PATTERNS = [
  /ReviewedUnknown/,
  /catch\s*\([^)]*:\s*unknown\)/, // Error handling
  /useUnknownInCatchVariables/, // tsconfig
  /type\s+\w+\s*=.*unknown/, // Type alias definition
  /export type ReviewedUnknown/, // ReviewedUnknown definition itself
  /__console_\w+.*args:\s*unknown\[\]/, // Console method implementations
  /formatArgs?\(.*unknown/, // Format functions for console
  /EventListener<unknown>/, // Event listener type parameter
  /recordCallback.*args:\s*unknown\[\]/, // DevTools callback recording
  /recordHostEvent.*payload\?:\s*unknown/, // DevTools event recording
  /emit.*data:\s*unknown/, // DevTools emit method
  /on\?.*handler:.*args:\s*unknown\[\]/, // Event handler signatures
  /\.on\(.*args:\s*unknown\[\]/, // Event listener registrations
  /eval:.*code:\s*string.*:\s*unknown/, // Sandbox eval method
  /inject:.*value:\s*unknown/, // Sandbox inject method
  /extract:.*:\s*unknown/, // Sandbox extract method
  /toJSON.*value:\s*unknown/, // JSON serialization helpers
  /\.\.\.args:\s*unknown\[\]/, // Rest parameters in functions
  /sendDevToolsMessage.*data:\s*unknown/, // DevTools message data
  /invokeCallback.*args:\s*unknown\[\].*:\s*unknown/, // Callback invocation
  /registerComponentType.*fn:\s*unknown/, // Component registration
  /isComponentTypeRef.*value:\s*unknown/, // Type guard functions
  /useSendToHost.*payload\?:\s*unknown/, // SDK send hook
  /useEffect.*deps\?:\s*unknown\[\]/, // React hook deps
  /updatePayload|typeOrPrevProps|prevPropsOrNextProps|nextPropsOrInternalHandle|_internalHandleMaybe/, // Reconciler internal params
  /\$\$typeof:.*type:\s*unknown.*props:\s*unknown/, // React element shape
  /React as \{ Component\?: unknown \}/, // React.Component runtime type check
];

const APPROVED_FILES = [
  'src/runtime/types.ts', // Core type definitions
  'src/let/types.ts',
  'src/runtime/bridge/types.ts',
  'src/devtools/types.ts', // DevTools type definitions
  'src/host/sandbox/types/provider.ts', // Sandbox provider interface types
  'src/sandbox-native/JSCModule.ts', // Native JSC interface
  'src/sandbox-native/QuickJSModule.ts', // Native QuickJS interface
  'src/sandbox-native/index.ts', // Sandbox native exports
];

function scanFile(filePath: string): UnknownUsage[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const usages: UnknownUsage[] = [];

  lines.forEach((line, index) => {
    if (!line.includes('unknown')) return;

    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;

    // Check if it's a type usage (not string literal)
    if (!line.match(/:\s*unknown|<unknown>|extends\s+unknown|\|\s*unknown/)) return;

    // Check if approved by pattern
    const isApprovedByPattern = APPROVED_PATTERNS.some((pattern) => pattern.test(line));

    // Check if file is in approved list
    const isApprovedFile = APPROVED_FILES.some((f) => filePath.includes(f));

    // Check for reason comment in previous lines (up to 3 lines back)
    let reason: string | undefined;
    for (let i = 1; i <= 3 && index - i >= 0; i++) {
      const prevLine = lines[index - i] || '';
      const reasonMatch = prevLine.match(/\/\/\s*(Reason|REVIEWED):\s*(.+)/i);
      if (reasonMatch) {
        reason = reasonMatch[2];
        break;
      }
    }

    usages.push({
      file: filePath,
      line: index + 1,
      code: line.trim(),
      approved: isApprovedByPattern || isApprovedFile || !!reason,
      reason,
    });
  });

  return usages;
}

function scanDirectory(dir: string): UnknownUsage[] {
  let results: UnknownUsage[] = [];

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      results = results.concat(scanDirectory(fullPath));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.bench.ts')
    ) {
      results = results.concat(scanFile(fullPath));
    }
  }

  return results;
}

// Main
console.log('🔍 Scanning for unknown usage...\n');

const usages = scanDirectory('src');
const unapproved = usages.filter((u) => !u.approved);

console.log(`📊 Total unknown usages: ${usages.length}`);
console.log(`✅ Approved: ${usages.length - unapproved.length}`);
console.log(`⚠️  Needs review: ${unapproved.length}\n`);

if (unapproved.length > 0) {
  console.log('⚠️  Unapproved unknown usages:\n');

  unapproved.slice(0, 20).forEach((u) => {
    console.log(`📍 ${u.file}:${u.line}`);
    console.log(`   ${u.code}`);
    console.log(`   💡 Add "// Reason: ..." comment or use ReviewedUnknown\n`);
  });

  if (unapproved.length > 20) {
    console.log(`... and ${unapproved.length - 20} more\n`);
  }

  console.log('📖 See UNKNOWN_POLICY.md for guidelines');
  process.exit(1);
} else {
  console.log('🎉 All unknown usages are approved!');
  process.exit(0);
}
