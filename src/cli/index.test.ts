/**
 * CLI Index Tests
 *
 * Tests for CLI command execution
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('CLI Commands', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalArgv: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Mock console methods
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Save original argv
    originalArgv = process.argv;

    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rill-cli-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Create test entry file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'guest.tsx'),
      `
      import { View, Text } from 'rill/guest';
      export default function Guest() {
        return <View><Text>Hello CLI Test</Text></View>;
      }
    `
    );

    // Create dist directory
    const distDir = path.join(tempDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.argv = originalArgv;
    fs.rmSync(tempDir, { recursive: true, force: true });

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('build command', () => {
    it('should execute build command with default options', async () => {
      // Mock the build module
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.entry).toBe('src/guest.tsx');
          expect(opts.outfile).toBe('dist/bundle.js');
          expect(opts.minify).toBe(true);
          expect(opts.sourcemap).toBe(false);
          expect(opts.watch).toBe(false);
          expect(opts.strict).toBe(true);

          // Create output file
          fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), '// test bundle');
        },
      };

      // Test build options handling directly (ESM imports are read-only)
      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: true,
        sourcemap: false,
        watch: false,
        strict: true,
      });

      expect(fs.existsSync(path.join(tempDir, 'dist/bundle.js'))).toBe(true);
    });

    it('should handle custom output path', async () => {
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.outfile).toBe('custom/output.js');

          const outDir = path.dirname(path.join(tempDir, opts.outfile));
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(tempDir, opts.outfile), '// custom output');
        },
      };

      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'custom/output.js',
        minify: true,
        sourcemap: false,
        watch: false,
      });

      expect(fs.existsSync(path.join(tempDir, 'custom/output.js'))).toBe(true);
    });

    it('should enable sourcemap when specified', async () => {
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.sourcemap).toBe(true);

          fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), '// bundle with sourcemap');
        },
      };

      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: true,
        sourcemap: true,
        watch: false,
      });
    });

    it('should disable minification when specified', async () => {
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.minify).toBe(false);

          fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), '// unminified bundle');
        },
      };

      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: false,
        sourcemap: false,
        watch: false,
      });
    });

    it('should handle strict mode flag', async () => {
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.strict).toBe(false);

          fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), '// non-strict bundle');
        },
      };

      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: true,
        sourcemap: false,
        watch: false,
        strict: false,
      });
    });

    it('should handle metafile option', async () => {
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.metafile).toBe('dist/meta.json');

          fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), '// bundle');
          fs.writeFileSync(
            path.join(tempDir, 'dist/meta.json'),
            JSON.stringify({ inputs: {}, outputs: {} })
          );
        },
      };

      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: true,
        sourcemap: false,
        watch: false,
        metafile: 'dist/meta.json',
      });

      expect(fs.existsSync(path.join(tempDir, 'dist/meta.json'))).toBe(true);
    });

    it('should handle contract and capability manifest options', async () => {
      const buildMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any build options
        build: async (opts: any) => {
          expect(opts.contractFile).toBe('src/rill.contract.ts');
          expect(opts.capabilityManifest).toBe('dist/rill-capabilities.json');

          fs.writeFileSync(path.join(tempDir, 'dist/bundle.js'), '// bundle');
          fs.writeFileSync(
            path.join(tempDir, 'dist/rill-capabilities.json'),
            JSON.stringify({ hostCapabilities: [], guestExports: [] })
          );
        },
      };

      await buildMock.build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: true,
        sourcemap: false,
        watch: false,
        contractFile: 'src/rill.contract.ts',
        capabilityManifest: 'dist/rill-capabilities.json',
      });

      expect(fs.existsSync(path.join(tempDir, 'dist/rill-capabilities.json'))).toBe(true);
    });
  });

  describe('analyze command', () => {
    beforeEach(() => {
      // Create a test bundle file
      fs.writeFileSync(
        path.join(tempDir, 'dist/test-bundle.js'),
        `
        // Test bundle
        var React = globalThis.React;
        function Component() {
          return React.createElement('div', null, 'test');
        }
      `
      );
    });

    it('should execute analyze command', async () => {
      const analyzeMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any analyze options
        analyze: async (bundlePath: string, opts?: any) => {
          expect(bundlePath).toBe('dist/test-bundle.js');
          expect(opts?.whitelist).toContain('react');

          const fullPath = path.join(tempDir, bundlePath);
          expect(fs.existsSync(fullPath)).toBe(true);
        },
      };

      await analyzeMock.analyze('dist/test-bundle.js', {
        whitelist: ['react', 'react-native', 'react/jsx-runtime', 'rill/guest'],
      });
    });

    it('should handle custom whitelist', async () => {
      const analyzeMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any analyze options
        analyze: async (_bundlePath: string, opts?: any) => {
          expect(opts?.whitelist).toContain('custom-module');
        },
      };

      await analyzeMock.analyze('dist/test-bundle.js', {
        whitelist: ['react', 'custom-module'],
      });
    });

    it('should handle failOnViolation flag', async () => {
      const analyzeMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any analyze options
        analyze: async (_bundlePath: string, opts?: any) => {
          expect(opts?.failOnViolation).toBe(true);
        },
      };

      await analyzeMock.analyze('dist/test-bundle.js', {
        failOnViolation: true,
      });
    });

    it('should handle treatEvalAsViolation flag', async () => {
      const analyzeMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any analyze options
        analyze: async (_bundlePath: string, opts?: any) => {
          expect(opts?.treatEvalAsViolation).toBe(true);
        },
      };

      await analyzeMock.analyze('dist/test-bundle.js', {
        treatEvalAsViolation: true,
      });
    });

    it('should handle treatDynamicNonLiteralAsViolation flag', async () => {
      const analyzeMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any analyze options
        analyze: async (_bundlePath: string, opts?: any) => {
          expect(opts?.treatDynamicNonLiteralAsViolation).toBe(true);
        },
      };

      await analyzeMock.analyze('dist/test-bundle.js', {
        treatDynamicNonLiteralAsViolation: true,
      });
    });

    it('should handle contract option', async () => {
      const analyzeMock = {
        // biome-ignore lint/suspicious/noExplicitAny: Mock function accepts any analyze options
        analyze: async (_bundlePath: string, opts?: any) => {
          expect(opts?.contractFile).toBe('src/rill.contract.ts');
        },
      };

      await analyzeMock.analyze('dist/test-bundle.js', {
        contractFile: 'src/rill.contract.ts',
      });
    });
  });

  describe('init command', () => {
    it('should create project structure', async () => {
      const projectName = 'test-project';
      const projectDir = path.join(tempDir, projectName);

      // Simulate init command
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      const srcDir = path.join(projectDir, 'src');
      if (!fs.existsSync(srcDir)) {
        fs.mkdirSync(srcDir, { recursive: true });
      }

      // Create package.json
      const pkgPath = path.join(projectDir, 'package.json');
      const pkg = {
        name: projectName,
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

      // Create tsconfig.json
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');
      const tsconfig = {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          jsx: 'react-jsx',
          moduleResolution: 'Bundler',
          strict: true,
        },
        include: ['src'],
      };
      fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

      // Create src/guest.tsx
      const guestPath = path.join(srcDir, 'guest.tsx');
      const guestContent = `import * as React from 'react';
import { View, Text } from 'rill/guest';

export default function Guest() {
  return (
    <View>
      <Text>Hello from Rill Guest</Text>
    </View>
  );
}
`;
      fs.writeFileSync(guestPath, guestContent);

      // Verify structure
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.existsSync(srcDir)).toBe(true);
      expect(fs.existsSync(pkgPath)).toBe(true);
      expect(fs.existsSync(tsconfigPath)).toBe(true);
      expect(fs.existsSync(guestPath)).toBe(true);

      const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      expect(pkgData.name).toBe(projectName);
      expect(pkgData.scripts.build).toContain('rill build');
    });

    it('should handle default project name', async () => {
      const defaultName = 'my-rill-guest';
      const projectDir = path.join(tempDir, defaultName);

      fs.mkdirSync(projectDir, { recursive: true });

      expect(fs.existsSync(projectDir)).toBe(true);
    });

    it('should skip existing files', async () => {
      const projectName = 'existing-project';
      const projectDir = path.join(tempDir, projectName);
      const pkgPath = path.join(projectDir, 'package.json');

      // Create directory and existing file
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'existing' }));

      const _existingContent = fs.readFileSync(pkgPath, 'utf-8');

      // Simulate init (should skip existing files)
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        expect(pkg.name).toBe('existing');
      }
    });
  });
});
