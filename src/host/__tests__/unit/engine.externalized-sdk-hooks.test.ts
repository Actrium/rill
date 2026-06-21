import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

/**
 * Verifies IIFE/externalized bundle path: Guest reads hooks from globalThis.RillGuest.
 * Previously these were broken because SDK globals were resolved from the wrong realm.
 */
describe('Engine - externalized rill/guest hooks', () => {
  it('should expose hooks on global RillGuest (externalized bundles)', async () => {
    const engine = new Engine({ sandbox: 'node-vm', debug: false });

    // This code simulates an externalized guest bundle that reads from global RillGuest directly.
    await engine.loadBundle(`
      globalThis.__HOOK_TYPES = {
        useHostEvent: typeof RillGuest.useHostEvent,
        useConfig: typeof RillGuest.useConfig,
        useSendToHost: typeof RillGuest.useSendToHost
      };
    `);

    const types = engine.context?.extract('__HOOK_TYPES') as Record<string, unknown>;
    expect(types).toEqual({
      useHostEvent: 'function',
      useConfig: 'function',
      useSendToHost: 'function',
    });

    engine.destroy();
  });
});
