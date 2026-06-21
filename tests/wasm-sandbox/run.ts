/**
 * WASM Sandbox E2E Test Runner
 *
 * Copies WASM files, starts server, and runs Playwright tests
 */

import { spawn, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import net from 'net';

const ROOT = join(import.meta.dir, '../..');
const E2E_DIR = import.meta.dir;
const DIST_DIR = join(E2E_DIR, 'dist');
// Served at /wasm/ — the bundled Engine's WASM provider dynamically imports
// ../wasm/quickjs-sandbox.js relative to /dist/engine-harness.js (i.e. /wasm/...).
const WASM_SERVE_DIR = join(E2E_DIR, 'wasm');
const WASM_SRC = join(ROOT, 'src/host/sandbox/wasm');
const ENGINE_HARNESS_ENTRY = join(E2E_DIR, 'engine-harness.ts');
const ENGINE_HARNESS_OUT = join(DIST_DIR, 'engine-harness.js');
const PLAYWRIGHT_CLI = join(ROOT, 'node_modules/playwright/cli.js');

function findNodeCommand(): string | undefined {
  const home = process.env.HOME;
  const candidates = [
    process.env.PLAYWRIGHT_NODE,
    process.env.NODE,
    'node',
    home ? join(home, '.local/n/bin/node') : undefined,
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) {
      return candidate;
    }
  }

  return undefined;
}

async function copyWASMFiles() {
  console.log('Copying WASM files...');

  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  if (!existsSync(WASM_SERVE_DIR)) {
    mkdirSync(WASM_SERVE_DIR, { recursive: true });
  }

  const files = ['quickjs-sandbox.js', 'quickjs-sandbox.wasm'];
  for (const file of files) {
    const src = join(WASM_SRC, file);
    if (!existsSync(src)) {
      console.error(`  Missing: ${src}`);
      console.error('  Run: cd native/quickjs && ./build-wasm.sh release');
      process.exit(1);
    }
    // dist/ for the bare-harness tests (imported as /dist/quickjs-sandbox.js);
    // wasm/ for the engine harness (dynamic import resolves to /wasm/quickjs-sandbox.js).
    copyFileSync(src, join(DIST_DIR, file));
    copyFileSync(src, join(WASM_SERVE_DIR, file));
    console.log(`  ${file} -> dist/, wasm/`);
  }
}

// Bundle the real Engine for the browser (engine-in-browser e2e). The dynamic import of
// the WASM loader inside the provider is left as a runtime import (resolved against the
// served bundle URL), so the .wasm is fetched from /wasm/ — not inlined into the bundle.
function buildEngineHarness() {
  console.log('Building engine harness bundle...');
  const result = spawnSync(
    process.execPath,
    ['build', ENGINE_HARNESS_ENTRY, '--target=browser', '--outfile', ENGINE_HARNESS_OUT],
    { stdio: 'inherit', cwd: ROOT }
  );
  if (result.status !== 0) {
    console.error('  Failed to bundle engine-harness.ts');
    process.exit(result.status ?? 1);
  }
  console.log('  engine-harness.js -> dist/');
}

async function main() {
  // Copy WASM files
  await copyWASMFiles();

  // Bundle the Engine for the engine-in-browser e2e
  buildEngineHarness();

  // Pick a free port (Bun.serve({ port: 0 }) can fail in some environments)
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to acquire a free TCP port')));
        return;
      }
      const selectedPort = address.port;
      server.close((err) => (err ? reject(err) : resolve(selectedPort)));
    });
  });

  // Start Bun server
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',

    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      if (pathname === '/') {
        pathname = '/index.html';
      }

      // Serve from dist or e2e directory
      let filePath: string;
      if (pathname.startsWith('/dist/')) {
        filePath = join(DIST_DIR, pathname.slice(6));
      } else {
        filePath = join(E2E_DIR, pathname);
      }

      const file = Bun.file(filePath);
      if (await file.exists()) {
        const contentType = getContentType(pathname);
        return new Response(file, {
          headers: {
            'Content-Type': contentType,
            // Required for WASM
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`Server started on http://127.0.0.1:${port}`);

  const nodeCommand = findNodeCommand();
  const playwrightCommand = existsSync(PLAYWRIGHT_CLI) && nodeCommand ? nodeCommand : process.execPath;
  const playwrightArgs = existsSync(PLAYWRIGHT_CLI)
    ? [PLAYWRIGHT_CLI, 'test', '--config', 'tests/wasm-sandbox/playwright.config.ts']
    : ['x', 'playwright', 'test', '--config', 'tests/wasm-sandbox/playwright.config.ts'];

  const playwright = spawn(playwrightCommand, playwrightArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    env: {
      ...process.env,
      TEST_PORT: String(port),
    },
  });

  playwright.on('close', async (code) => {
    server.stop();
    process.exit(code ?? 0);
  });
}

function getContentType(pathname: string): string {
  if (pathname.endsWith('.html')) return 'text/html';
  if (pathname.endsWith('.js')) return 'application/javascript';
  if (pathname.endsWith('.wasm')) return 'application/wasm';
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
