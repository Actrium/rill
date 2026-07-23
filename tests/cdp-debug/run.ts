/**
 * In-browser CDP debug E2E runner (design P4).
 *
 * Wires up the whole reverse-tunnel debugging chain and hands it to Playwright:
 *
 *   [Playwright spec: raw WS CDP client]
 *          | ws  /devtools/<id>
 *   [reverse-tunnel relay]  (src/host/web/tools/cdp-relay.mjs, started in-process here)
 *          | ws  /agent  (OUTBOUND from the page)
 *   [browser page harness]  --postMessage-->  [Web Worker: CdpDebugSession + fat CDP wasm]
 *
 * Steps:
 *   1. Verify the fat debug wasm exists (built by native/quickjs/build-wasm-cdp.sh).
 *   2. Copy it to serve/cdp-wasm/ (the worker imports /cdp-wasm/quickjs-cdp-debug.mjs).
 *   3. Bundle the page + worker TS entries to serve/dist/ (module worker needs JS).
 *   4. Start the relay in-process on an ephemeral port.
 *   5. Serve the page + bundles + wasm (COOP/COEP on, required for wasm) on an ephemeral port.
 *   6. Run Playwright with TEST_PORT + RELAY_PORT in the env; the spec learns both.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { startRelay } from '../../src/host/web/tools/cdp-relay.mjs';

const ROOT = join(import.meta.dir, '../..');
const E2E_DIR = import.meta.dir;
const SERVE_DIR = join(E2E_DIR, 'serve');
const DIST_DIR = join(SERVE_DIR, 'dist');
const WASM_SERVE_DIR = join(SERVE_DIR, 'cdp-wasm');
const WASM_SRC = join(ROOT, 'native/quickjs/build-debug');
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
    if (result.status === 0) return candidate;
  }
  return undefined;
}

function copyWasm() {
  console.log('Copying fat CDP debug wasm...');
  mkdirSync(WASM_SERVE_DIR, { recursive: true });
  const files = ['quickjs-cdp-debug.mjs', 'quickjs-cdp-debug.wasm'];
  for (const file of files) {
    const src = join(WASM_SRC, file);
    if (!existsSync(src)) {
      console.error(`  Missing: ${src}`);
      console.error('  Build it first:');
      console.error('    source /ext/emsdk/emsdk_env.sh && bash native/quickjs/build-wasm-cdp.sh');
      process.exit(1);
    }
    copyFileSync(src, join(WASM_SERVE_DIR, file));
    console.log(`  ${file} -> serve/cdp-wasm/`);
  }
}

function bundle(entry: string, outfile: string) {
  const result = spawnSync(
    process.execPath,
    ['build', join(E2E_DIR, entry), '--target=browser', '--outfile', join(DIST_DIR, outfile)],
    { stdio: 'inherit', cwd: ROOT }
  );
  if (result.status !== 0) {
    console.error(`  Failed to bundle ${entry}`);
    process.exit(result.status ?? 1);
  }
  console.log(`  ${entry} -> serve/dist/${outfile}`);
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
}

function getContentType(pathname: string): string {
  if (pathname.endsWith('.html')) return 'text/html';
  if (pathname.endsWith('.mjs') || pathname.endsWith('.js')) return 'application/javascript';
  if (pathname.endsWith('.wasm')) return 'application/wasm';
  if (pathname.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

async function main() {
  mkdirSync(DIST_DIR, { recursive: true });
  copyWasm();

  console.log('Bundling page + worker harnesses...');
  bundle('cdp-debug-page.ts', 'cdp-debug-page.js');
  bundle('cdp-debug-worker.ts', 'cdp-debug-worker.js');

  // Reverse-tunnel relay, in-process on an ephemeral port.
  const relayPort = await freePort();
  const relay = await startRelay({ port: relayPort, host: '127.0.0.1', log: () => {} });
  console.log(`Relay listening on http://127.0.0.1:${relay.port}`);

  // Static server for the page + bundles + wasm.
  const httpPort = await freePort();
  const server = Bun.serve({
    port: httpPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname === '/') pathname = '/cdp-debug-page.html';
      // /dist/ and /cdp-wasm/ come from serve/; everything else from the e2e dir.
      const filePath =
        pathname.startsWith('/dist/') || pathname.startsWith('/cdp-wasm/')
          ? join(SERVE_DIR, pathname.slice(1))
          : join(E2E_DIR, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            'Content-Type': getContentType(pathname),
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  console.log(`Static server on http://127.0.0.1:${httpPort}`);

  const nodeCommand = findNodeCommand();
  const playwrightCommand = existsSync(PLAYWRIGHT_CLI) && nodeCommand ? nodeCommand : process.execPath;
  const playwrightArgs = existsSync(PLAYWRIGHT_CLI)
    ? [PLAYWRIGHT_CLI, 'test', '--config', 'tests/cdp-debug/playwright.config.ts']
    : ['x', 'playwright', 'test', '--config', 'tests/cdp-debug/playwright.config.ts'];

  const playwright = spawn(playwrightCommand, playwrightArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, TEST_PORT: String(httpPort), RELAY_PORT: String(relay.port) },
  });

  playwright.on('close', async (code) => {
    await relay.close();
    server.stop();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
