/**
 * Engine host:* module runtime wiring (issue #3)
 *
 * Exercises the runtime backend for the `rill/contract` host-module capability
 * layer: the Engine pairs the contract's boundary schemas with the host
 * implementations and injects them into the sandbox as `globalThis.__rill.hostModules`,
 * where the Guest's rewritten `host:*` imports resolve.
 *
 * These tests run a Guest bundle through a real (vm) sandbox and call `host:*`
 * capabilities the way the CLI-rewritten guest code does, asserting:
 * - the host implementation is invoked and its return value crosses back to the Guest;
 * - `parseInput` rejects malformed arguments fail-closed (the impl never runs);
 * - `parseOutput` rejects malformed results of async implementations;
 * - subscriptions run `parseEvent` before the Guest handler sees an event;
 * - an unregistered capability fails closed at the resolver.
 */

import { describe, expect, it } from 'bun:test';
import { defineRillContract, implementHostModules, rpc, subscription } from '../../../contract';
import { Engine } from '../../engine';

// Mirror of the host-module resolver the CLI injects into every bundle
// (src/cli/build.ts RUNTIME_INJECT). The CLI rewrites `import { x } from 'host:foo'`
// into `globalThis.__rill_importHostModule('host:foo')`; this bundle stands in for
// that rewritten guest code so the test exercises the same resolution path.
const GUEST_BUNDLE = `
  if (typeof globalThis.__rill_importHostModule !== 'function') {
    globalThis.__rill_importHostModule = function(moduleId) {
      var ns = globalThis.__rill;
      if (ns && ns.hostModules && ns.hostModules[moduleId]) {
        return ns.hostModules[moduleId];
      }
      throw new Error('[rill] Host module not registered: ' + moduleId);
    };
  }

  globalThis.__guest = {
    track: function(input) {
      return globalThis.__rill_importHostModule('host:analytics').track(input);
    },
    openProfile: function(input) {
      return globalThis.__rill_importHostModule('host:navigation').openProfile(input);
    },
    subscribeTheme: function() {
      var theme = globalThis.__rill_importHostModule('host:theme');
      globalThis.__themeEvents = [];
      return theme.onThemeChanged(function(event) {
        globalThis.__themeEvents.push(event);
      });
    },
    useUnregistered: function() {
      return globalThis.__rill_importHostModule('host:secret');
    },
  };
`;

interface HostCalls {
  track: Array<{ name: string }>;
  openProfile: Array<{ userId: string }>;
  themeHandlers: Array<(event: unknown) => void>;
}

function createEngine() {
  const contract = defineRillContract({
    version: '1.0.0',
    hostModules: {
      'host:analytics': {
        track: rpc<{ name: string }, { ok: true }>({
          schema: {
            parseInput: (value) => {
              const input = value as { name?: unknown };
              if (typeof input?.name !== 'string' || input.name.length === 0) {
                throw new Error('name must be a non-empty string');
              }
              return { name: input.name };
            },
            parseOutput: (value) => {
              const output = value as { ok?: unknown };
              if (output?.ok !== true) {
                throw new Error('output.ok must be true');
              }
              return { ok: true };
            },
          },
        }),
      },
      'host:navigation': {
        openProfile: rpc<{ userId: string }, void>(),
      },
      'host:theme': {
        onThemeChanged: subscription<{ theme: 'light' | 'dark' }>({
          schema: {
            parseEvent: (value) => {
              const event = value as { theme?: unknown };
              if (event?.theme !== 'light' && event?.theme !== 'dark') {
                throw new Error('theme must be light or dark');
              }
              return { theme: event.theme };
            },
          },
        }),
      },
    },
    guestExports: {},
  });

  const calls: HostCalls = { track: [], openProfile: [], themeHandlers: [] };

  const engine = new Engine({
    sandbox: 'vm',
    contract,
    hostModules: implementHostModules(contract, {
      'host:analytics': {
        track: async (input) => {
          calls.track.push(input);
          return { ok: true };
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

  return { engine, calls };
}

// Reason: tests reach into the private sandbox scope to drive guest-side calls,
// matching the existing engine.hostevent.test.ts pattern.
// biome-ignore lint/suspicious/noExplicitAny: test accesses the private sandbox scope
function scope(engine: Engine): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return (engine as any).context;
}

describe('Engine host:* module runtime wiring', () => {
  it('invokes the host implementation and returns its value to the guest', async () => {
    const { engine, calls } = createEngine();
    await engine.loadBundle(GUEST_BUNDLE);

    const result = await scope(engine).eval('globalThis.__guest.track({ name: "opened" })');

    expect(result).toEqual({ ok: true });
    expect(calls.track).toEqual([{ name: 'opened' }]);

    engine.destroy();
  });

  it('rejects malformed input fail-closed before the implementation runs', async () => {
    const { engine, calls } = createEngine();
    await engine.loadBundle(GUEST_BUNDLE);

    expect(() => scope(engine).eval('globalThis.__guest.track({ name: "" })')).toThrow(
      'Boundary input validation failed for "host:analytics.track": name must be a non-empty string'
    );
    expect(calls.track).toEqual([]);

    engine.destroy();
  });

  it('rejects malformed output of an async implementation', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:analytics': {
          track: rpc<{ name: string }, { ok: true }>({
            schema: {
              parseOutput: (value) => {
                if ((value as { ok?: unknown })?.ok !== true) {
                  throw new Error('output.ok must be true');
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
      contract,
      hostModules: implementHostModules(contract, {
        'host:analytics': {
          // Returns a value the contract forbids.
          track: async () => ({ ok: false }) as never,
        },
      }),
    });

    await engine.loadBundle(`
      globalThis.__rill_importHostModule = globalThis.__rill_importHostModule || function(id) {
        return globalThis.__rill.hostModules[id];
      };
      globalThis.__track = function(input) {
        return globalThis.__rill_importHostModule('host:analytics').track(input);
      };
    `);

    await expect(scope(engine).eval('globalThis.__track({ name: "x" })')).rejects.toThrow(
      'Boundary output validation failed for "host:analytics.track": output.ok must be true'
    );

    engine.destroy();
  });

  it('runs parseEvent before the guest handler and rejects malformed events', async () => {
    const { engine, calls } = createEngine();
    await engine.loadBundle(GUEST_BUNDLE);

    const unsubscribe = scope(engine).eval('globalThis.__guest.subscribeTheme()');
    expect(typeof unsubscribe).toBe('function');
    expect(calls.themeHandlers).toHaveLength(1);

    // Host emits a valid event -> reaches the guest handler.
    const emit = calls.themeHandlers[0]!;
    emit({ theme: 'dark' });
    expect(scope(engine).extract('__themeEvents')).toEqual([{ theme: 'dark' }]);

    // Host emits a malformed event -> rejected at the boundary, never reaches the guest.
    expect(() => emit({ theme: 'rainbow' })).toThrow(
      'Boundary event validation failed for "host:theme.onThemeChanged": theme must be light or dark'
    );
    expect(scope(engine).extract('__themeEvents')).toEqual([{ theme: 'dark' }]);

    engine.destroy();
  });

  it('passes a void-returning capability through and records the call', async () => {
    const { engine, calls } = createEngine();
    await engine.loadBundle(GUEST_BUNDLE);

    await scope(engine).eval('globalThis.__guest.openProfile({ userId: "42" })');
    expect(calls.openProfile).toEqual([{ userId: '42' }]);

    engine.destroy();
  });

  it('fails closed when the guest imports an unregistered host module', async () => {
    const { engine } = createEngine();
    await engine.loadBundle(GUEST_BUNDLE);

    expect(() => scope(engine).eval('globalThis.__guest.useUnregistered()')).toThrow(
      'Host module not registered: host:secret'
    );

    engine.destroy();
  });

  it('does not define __rill.hostModules when no host modules are configured', async () => {
    const engine = new Engine({ sandbox: 'vm' });
    await engine.loadBundle('globalThis.__hasHostModules = !!(globalThis.__rill && globalThis.__rill.hostModules);');

    expect(scope(engine).extract('__hasHostModules')).toBe(false);

    engine.destroy();
  });

  it('throws when hostModules is provided without a contract', () => {
    expect(
      () =>
        new Engine({
          sandbox: 'vm',
          // biome-ignore lint/suspicious/noExplicitAny: intentionally bypassing the typed requirement
          hostModules: { 'host:analytics': { track: async () => {} } } as any,
        })
    ).toThrow('EngineOptions.hostModules requires EngineOptions.contract');
  });
});
