import fs from 'fs';
import React from 'react';
import { implementHostModules } from '../../src/contract';
import { Engine } from '../../src/host';
import { contract } from './src/rill.contract';

const bundlePath = './dist/host-modules.bundle.js';
const manifestPath = './dist/rill-capabilities.json';

function readRequiredFile(path: string): string {
  if (!fs.existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }

  return fs.readFileSync(path, 'utf-8');
}

function expectContains(label: string, value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} does not contain ${expected}`);
  }
}

function expectNotContains(label: string, value: string, expected: string): void {
  if (value.includes(expected)) {
    throw new Error(`${label} unexpectedly contains ${expected}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Runtime check failed: ${message}`);
  }
}

function assertThrows(fn: () => unknown, expected: string, message: string): void {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(expected)) {
      throw new Error(`${message}: expected error to include "${expected}", got "${text}"`);
    }
  }
  if (!threw) {
    throw new Error(`${message}: expected a throw but none happened`);
  }
}

async function assertRejects(promise: Promise<unknown>, expected: string, message: string): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(expected)) {
      throw new Error(`${message}: expected rejection to include "${expected}", got "${text}"`);
    }
  }
  if (!rejected) {
    throw new Error(`${message}: expected a rejection but none happened`);
  }
}

const bundle = readRequiredFile(bundlePath);
const manifest = JSON.parse(readRequiredFile(manifestPath));

expectContains('bundle', bundle, 'globalThis.__rill_importHostModule("host:analytics")');
expectContains('bundle', bundle, 'globalThis.__rill_importHostModule("host:navigation")');
expectContains('bundle', bundle, 'globalThis.__rill_importHostModule("host:theme")');
expectContains('bundle', bundle, 'Host module resolver');

expectNotContains('bundle', bundle, 'require("host:analytics")');
expectNotContains('bundle', bundle, 'require("host:navigation")');
expectNotContains('bundle', bundle, 'require("host:theme")');
expectNotContains('bundle', bundle, "require('host:analytics')");
expectNotContains('bundle', bundle, "require('host:navigation')");
expectNotContains('bundle', bundle, "require('host:theme')");

const expectedManifest = {
  contractVersion: '1.0.0',
  hostCapabilities: [
    'host:analytics.track',
    'host:navigation.openProfile',
    'host:theme.onThemeChanged',
  ],
  guestExports: ['refresh'],
};

if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
  throw new Error(
    `Unexpected capability manifest.\nExpected: ${JSON.stringify(
      expectedManifest,
      null,
      2
    )}\nActual: ${JSON.stringify(manifest, null, 2)}`
  );
}

console.log('Host module bundle verified (build-time).');

// ============================================================================
// Runtime verification
//
// Loads the REAL built bundle into the Engine (vm sandbox — the headless sandbox
// the guest-bundle suite already uses; the standalone WASM provider cannot return
// host-function values), registers host module implementations, and drives the
// bundle's own `__rill_importHostModule` resolver. This is the end-to-end path the
// build-time string/manifest checks above cannot cover: contract -> Engine
// injection -> guest resolver -> boundary dispatch -> host implementation.
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: mock host components for headless render
function mockComponent(name: string): any {
  // biome-ignore lint/suspicious/noExplicitAny: mock accepts any props
  const component = (props: any) => React.createElement(name, props);
  return component;
}

interface RecordedCalls {
  track: Array<{ name: string; props?: Record<string, unknown> }>;
  openProfile: Array<{ userId: string }>;
  // biome-ignore lint/suspicious/noExplicitAny: handler shape is provider-dependent
  themeHandlers: Array<(event: any) => void>;
}

// Boundary rejections below are intentional; the engine logs them at error level
// (a contract violation at a security boundary). Collapse them to one concise line
// each so the expected rejections do not bury the verification output in stacks.
const quietLogger = {
  log: () => {},
  warn: () => {},
  error: (...args: unknown[]) => {
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    console.error('[verify]', text);
  },
};

async function runtimeVerify(): Promise<void> {
  const calls: RecordedCalls = { track: [], openProfile: [], themeHandlers: [] };

  const engine = new Engine({
    sandbox: 'vm',
    timeout: 3000,
    logger: quietLogger,
    contract,
    hostModules: implementHostModules(contract, {
      'host:analytics': {
        track: async (input) => {
          calls.track.push(input);
        },
      },
      'host:navigation': {
        openProfile: (input) => {
          calls.openProfile.push(input);
        },
      },
      'host:theme': {
        onThemeChanged: (handler) => {
          calls.themeHandlers.push(handler);
          return () => {
            const index = calls.themeHandlers.indexOf(handler);
            if (index >= 0) calls.themeHandlers.splice(index, 1);
          };
        },
      },
    }),
  });

  engine.register({
    View: mockComponent('View'),
    Text: mockComponent('Text'),
    TouchableOpacity: mockComponent('TouchableOpacity'),
  });
  engine.createReceiver();

  await engine.loadBundle(bundle, { reason: 'verify' });

  // biome-ignore lint/suspicious/noExplicitAny: reach into the private sandbox scope for verification
  const ctx = (engine as any).context;

  // 1. Valid rpc call: the host implementation runs and the call resolves.
  await ctx.eval(
    'globalThis.__rill_importHostModule("host:analytics").track({ name: "opened", props: { from: "verify" } })'
  );
  assert(
    calls.track.length === 1 && calls.track[0]?.name === 'opened',
    'track implementation should be invoked with the parsed input'
  );

  // 2. parseInput fail-closed: malformed input throws and never reaches the impl.
  assertThrows(
    () => ctx.eval('globalThis.__rill_importHostModule("host:analytics").track({ name: "" })'),
    'track input.name must be a non-empty string',
    'malformed track input must be rejected at the boundary'
  );
  assert(calls.track.length === 1, 'rejected track call must not reach the implementation');

  // 3. A second declared capability dispatches independently.
  await ctx.eval(
    'globalThis.__rill_importHostModule("host:navigation").openProfile({ userId: "42" })'
  );
  assert(
    calls.openProfile.length === 1 && calls.openProfile[0]?.userId === '42',
    'openProfile implementation should be invoked'
  );
  assertThrows(
    () =>
      ctx.eval('globalThis.__rill_importHostModule("host:navigation").openProfile({ userId: "" })'),
    'openProfile input.userId must be a non-empty string',
    'malformed openProfile input must be rejected at the boundary'
  );

  // 4. Subscription: parseEvent runs on every event before it reaches the guest handler.
  const handlerIndex = calls.themeHandlers.length;
  ctx.eval(
    'globalThis.__themeEvents = []; globalThis.__rill_importHostModule("host:theme").onThemeChanged(function(event){ globalThis.__themeEvents.push(event); });'
  );
  const themeHandler = calls.themeHandlers[handlerIndex];
  assert(typeof themeHandler === 'function', 'theme subscription handler should be registered');

  themeHandler?.({ theme: 'dark' });
  assert(
    JSON.stringify(ctx.extract('__themeEvents')) === JSON.stringify([{ theme: 'dark' }]),
    'a valid theme event should reach the guest handler'
  );

  assertThrows(
    () => themeHandler?.({ theme: 'rainbow' }),
    'theme event.theme must be',
    'a malformed theme event must be rejected at the boundary'
  );
  assert(
    JSON.stringify(ctx.extract('__themeEvents')) === JSON.stringify([{ theme: 'dark' }]),
    'a rejected theme event must not reach the guest handler'
  );

  // 5. Fail-closed: an unregistered host module throws at the resolver.
  assertThrows(
    () => ctx.eval('globalThis.__rill_importHostModule("host:secret")'),
    'Host module not registered: host:secret',
    'an unregistered host module must fail closed'
  );

  // 6. parseOutput fail-closed on an async implementation, using a throwaway engine
  //    whose implementation returns a contract-violating value.
  await assertRejects(
    verifyParseOutput(),
    'Boundary output validation failed',
    'a malformed implementation output must be rejected at the boundary'
  );

  engine.destroy();
  console.log('Host module bundle verified (runtime).');
}

async function verifyParseOutput(): Promise<void> {
  const localContract = (await import('rill/contract')).defineRillContract({
    version: '1.0.0',
    hostModules: {
      'host:analytics': {
        track: (await import('rill/contract')).rpc<{ name: string }, { ok: true }>({
          schema: {
            parseOutput: (value) => {
              if ((value as { ok?: unknown })?.ok !== true) {
                throw new Error('track output.ok must be true');
              }
              return { ok: true };
            },
          },
        }),
      },
    },
    guestExports: {},
  });

  const engine = new Engine({
    sandbox: 'vm',
    timeout: 3000,
    logger: quietLogger,
    contract: localContract,
    hostModules: implementHostModules(localContract, {
      'host:analytics': {
        track: async () => ({ ok: false }) as never,
      },
    }),
  });

  try {
    await engine.loadBundle(
      'globalThis.__call = function(){ return globalThis.__rill.hostModules["host:analytics"].track({ name: "x" }); };'
    );
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private sandbox scope for verification
    const ctx = (engine as any).context;
    await ctx.eval('globalThis.__call()');
  } finally {
    engine.destroy();
  }
}

await runtimeVerify();
