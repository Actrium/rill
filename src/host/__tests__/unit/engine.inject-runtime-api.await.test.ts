import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

/**
 * Regression test: injectRuntimeAPI must await evalCode(RUNTIME_HELPERS_CODE)
 * so that async-only providers don't race (helpers not available yet).
 */
describe('Engine - injectRuntimeAPI awaits runtime helpers', () => {
  it('should make __rill_onHostEvent available before executing guest bundle (async provider)', async () => {
    // Use the built-in async provider to avoid exposing provider injection as public API.
    const engine = new Engine({ sandbox: 'wasm-quickjs', debug: false });

    // Guest bundle asserts runtime helpers exist at execution time.
    await engine.loadBundle(`
      if (typeof globalThis.__rill_onHostEvent !== 'function') {
        throw new Error('__rill_onHostEvent missing');
      }
      if (!globalThis.__rill.callbacks || typeof globalThis.__rill.registerCallback !== 'function') {
        throw new Error('__rill.callbacks missing');
      }
      globalThis.__OK = true;
    `);

    expect(engine.context?.extract('__OK')).toBe(true);
    engine.destroy();
  });
});
