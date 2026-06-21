/**
 * Browser harness entry: bundles the real Rill Engine for the engine-in-browser e2e.
 *
 * Built with `bun build --target=browser` to dist/engine-harness.js and loaded by
 * engine-test.html. Exposes the Engine constructor on window so the Playwright spec can
 * drive a real Engine on the real WASM provider (sandbox:'wasm-quickjs') — the only setup
 * that exercises the full react-reconciler scheduler + timers through the host bridge
 * (issue #10), which the bun unit suite (mock react) and the bare-harness Playwright tests
 * (hand-rolled React shim + native timers) cannot.
 */

import { Engine } from '../../src/host/engine';

// biome-ignore lint/suspicious/noExplicitAny: expose for the e2e page
(globalThis as any).RillEngine = Engine;
// biome-ignore lint/suspicious/noExplicitAny: signal readiness to the spec
(globalThis as any).RillEngineReady = true;
