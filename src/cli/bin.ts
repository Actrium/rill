#!/usr/bin/env bun
/**
 * Rill CLI
 *
 * Guest bundler tool
 */

import { program } from 'commander';
import { version } from '../../package.json';
import type { AnalyzeOptions, BuildOptions } from './build';
import { build } from './build';

type BuildCommandOptions = Omit<Partial<BuildOptions>, 'contract'> & {
  contract?: string;
};

type AnalyzeCommandOptions = Omit<AnalyzeOptions, 'contract' | 'contractFile'> & {
  contract?: string;
};

program
  .name('rill')
  .description('Rill CLI - Build dynamic UI guests for React Native')
  .version(version);

program
  .command('build')
  .description('Build a guest bundle (with strict SDK guard by default)')
  .argument('<entry>', 'Entry file path (e.g., src/guest.tsx)')
  .option('-o, --outfile <path>', 'Output file path', 'dist/bundle.js')
  .option('--no-minify', 'Disable minification')
  .option('--sourcemap', 'Generate sourcemap')
  .option('--watch', 'Watch mode for development')
  .option('--metafile <path>', 'Output build metadata to file')
  .option('--contract <path>', 'Contract module path exporting `contract` or default contract')
  .option('--capability-manifest <path>', 'Output host capability manifest to file')
  .option('--no-strict', 'Disable strict post-build dependency guard (not recommended)')
  .option(
    '--strict-peer-versions',
    'Fail build if React/reconciler versions mismatch recommended matrix'
  )
  .option('--footer <path>', 'Custom footer file (replaces default auto-render)')
  .option('--dev', 'Dev mode - inject source locations for DevTools navigation')
  .action(async (entry: string, options: BuildCommandOptions) => {
    try {
      const buildOpts: BuildOptions = {
        entry,
        outfile: options.outfile ?? 'dist/bundle.js',
        minify: options.minify ?? true,
        sourcemap: options.sourcemap ?? false,
        watch: options.watch ?? false,
        strict: options.strict ?? true,
        strictPeerVersions: options.strictPeerVersions ?? false,
      };
      if (options.metafile !== undefined) {
        buildOpts.metafile = options.metafile;
      }
      if (options.contract !== undefined) {
        buildOpts.contractFile = options.contract;
      }
      if (options.capabilityManifest !== undefined) {
        buildOpts.capabilityManifest = options.capabilityManifest;
      }
      if (options.footer !== undefined) {
        buildOpts.footer = options.footer;
      }
      if (options.dev !== undefined) {
        buildOpts.dev = options.dev;
      }
      await build(buildOpts);
    } catch (error) {
      console.error('Build failed:', error);
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Analyze a built guest bundle for disallowed runtime deps')
  .argument('<bundle>', 'Bundle file path (e.g., dist/bundle.js)')
  .option('-w, --whitelist <mods...>', 'Whitelisted module IDs', [
    'react',
    'react-native',
    'react/jsx-runtime',
    'rill/guest',
  ])
  .option('--contract <path>', 'Contract module path exporting `contract` or default contract')
  .option('--fail-on-violation', 'Fail when non-whitelisted deps are found')
  .option('--treat-eval-as-violation', 'Treat eval() usage as violation')
  .option(
    '--treat-dynamic-non-literal-as-violation',
    'Treat dynamic import with non-literal specifier as violation'
  )
  .action(async (bundle: string, opts: AnalyzeCommandOptions) => {
    try {
      const { analyze } = await import('./build');
      const analyzeOpts: AnalyzeOptions = {};
      if (opts.whitelist !== undefined) analyzeOpts.whitelist = opts.whitelist;
      if (opts.contract !== undefined) analyzeOpts.contractFile = opts.contract;
      if (opts.failOnViolation !== undefined) analyzeOpts.failOnViolation = opts.failOnViolation;
      if (opts.treatEvalAsViolation !== undefined)
        analyzeOpts.treatEvalAsViolation = opts.treatEvalAsViolation;
      if (opts.treatDynamicNonLiteralAsViolation !== undefined)
        analyzeOpts.treatDynamicNonLiteralAsViolation = opts.treatDynamicNonLiteralAsViolation;
      await analyze(bundle, analyzeOpts);
    } catch (error) {
      console.error('Analyze failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Initialize a new guest project')
  .argument('[name]', 'Project name', 'my-rill-guest')
  .action(async (name: string) => {
    const fs = await import('fs');
    const path = await import('path');
    const targetDir = path.resolve(process.cwd(), name);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const srcDir = path.join(targetDir, 'src');
    if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

    // package.json
    const pkgPath = path.join(targetDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      const pkg = {
        name,
        version: '0.1.0',
        private: true,
        scripts: {
          build: 'rill build src/guest.tsx -o dist/bundle.js',
          analyze: 'rill analyze dist/bundle.js',
        },
        devDependencies: {
          '@types/bun': 'latest',
          typescript: '^5.0.0',
        },
        dependencies: {
          react: '^18.0.0',
          rill: 'latest',
        },
      };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }

    // tsconfig.json (best practices)
    const tsconfigPath = path.join(targetDir, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
      fs.writeFileSync(
        tsconfigPath,
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2020',
              module: 'ESNext',
              jsx: 'react-jsx',
              moduleResolution: 'Bundler',
              moduleDetection: 'force',
              allowArbitraryExtensions: false,
              allowJs: false,
              resolveJsonModule: true,
              isolatedModules: true,
              useDefineForClassFields: true,
              strict: true,
              skipLibCheck: true,
              esModuleInterop: true,
              forceConsistentCasingInFileNames: true,
              noFallthroughCasesInSwitch: true,
              noUncheckedIndexedAccess: true,
              noImplicitOverride: true,
              noPropertyAccessFromIndexSignature: true,
              verbatimModuleSyntax: true,
              types: ['bun-types'],
            },
            include: ['src'],
          },
          null,
          2
        )
      );
    }

    // src/guest.tsx
    const guestPath = path.join(srcDir, 'guest.tsx');
    if (!fs.existsSync(guestPath)) {
      const guest = `import * as React from 'react';
import { View, Text } from 'rill/guest';

export default function Guest() {
  return (
    <View>
      <Text>Hello from Rill Guest</Text>
    </View>
  );
}
`;
      fs.writeFileSync(guestPath, guest);
    }

    console.log(`Initialized guest project at ${targetDir}`);
    console.log('Next steps:');
    console.log(`  cd ${name}`);
    console.log('  npm install');
    console.log('  npx rill build src/guest.tsx -o dist/bundle.js');
  });

program.parse();
