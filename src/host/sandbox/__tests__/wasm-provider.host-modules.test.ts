/**
 * WASM provider host:* module bridge (issue #5)
 *
 * The isolated QuickJS-WASM realm can't hold host function references, so host:*
 * capabilities are bridged as a JSON request/response over __sendToHost. This test
 * drives the real WASM provider + the real contract dispatch table and asserts the
 * same guarantees the vm/native providers give:
 * - rpc results round-trip back to the guest;
 * - parseInput / parseOutput reject malformed values fail-closed;
 * - subscriptions run parseEvent before the guest handler sees an event;
 * - an unregistered capability fails closed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  createHostModuleDispatch,
  defineRillContract,
  type HostModuleDispatchTable,
  rpc,
  type RillContractShape,
  subscription,
} from '../../../contract';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';
import type { JSEngineRuntime, SandboxScope } from '../types/provider';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

interface RecordedCalls {
  track: Array<{ name: string }>;
  openProfile: Array<{ userId: string }>;
  // biome-ignore lint/suspicious/noExplicitAny: recorded subscription handler
  themeHandler: ((event: any) => void) | null;
}

function buildContract(): RillContractShape {
  return defineRillContract({
    version: '1.0.0',
    hostModules: {
      'host:analytics': {
        track: rpc<{ name: string }, { ackId: string }>({
          schema: {
            parseInput: (value) => {
              const input = value as { name?: unknown };
              if (typeof input?.name !== 'string' || input.name.length === 0) {
                throw new Error('name must be a non-empty string');
              }
              return { name: input.name };
            },
            parseOutput: (value) => {
              const output = value as { ackId?: unknown };
              if (typeof output?.ackId !== 'string') {
                throw new Error('ackId must be a string');
              }
              return { ackId: output.ackId };
            },
          },
        }),
        broken: rpc<void, { ok: true }>({
          schema: {
            parseOutput: (value) => {
              if ((value as { ok?: unknown })?.ok !== true) {
                throw new Error('ok must be true');
              }
              return { ok: true };
            },
          },
        }),
        // No boundary schema: a plain (non-boundary) error thrown by the impl must
        // still cross the JSON bridge back to the guest as a promise rejection.
        failHard: rpc<void, void>(),
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
}

describeIfWASM('QuickJSNativeWASMProvider host:* modules', () => {
  let provider: QuickJSNativeWASMProvider;
  let runtime: JSEngineRuntime;
  let context: SandboxScope;
  let calls: RecordedCalls;
  let table: HostModuleDispatchTable;

  beforeAll(async () => {
    provider = new QuickJSNativeWASMProvider({ debug: false });
    runtime = await provider.createRuntime();
    context = runtime.createContext();

    const contract = buildContract();
    calls = { track: [], openProfile: [], themeHandler: null };
    table = createHostModuleDispatch(contract, {
      'host:analytics': {
        track: async (input) => {
          calls.track.push(input);
          return { ackId: `ack:${input.name}` };
        },
        // Returns a value the contract forbids -> parseOutput must reject.
        broken: async () => ({ ok: false }) as never,
        failHard: async () => {
          throw new Error('backend exploded');
        },
      },
      'host:navigation': {
        openProfile: (input) => {
          calls.openProfile.push(input);
        },
      },
      'host:theme': {
        onThemeChanged: (handler) => {
          calls.themeHandler = handler;
          return () => {
            calls.themeHandler = null;
          };
        },
      },
    });

    context.installHostModules?.(table, contract);
  });

  afterAll(() => {
    context?.dispose();
    runtime?.dispose();
  });

  // Drive a guest rpc call to settlement and return { ok, value } | { ok:false, reason }.
  // Note: the field is `reason`, not `error` — the provider's result parser treats any
  // extracted object carrying an `error` property as a thrown error.
  async function callRpc(expr: string): Promise<{ ok: boolean; value?: unknown; reason?: string }> {
    context.eval(`
      globalThis.__out = undefined;
      (${expr}).then(
        function(v){ globalThis.__out = { ok: true, value: v === undefined ? null : v }; },
        function(e){ globalThis.__out = { ok: false, reason: String(e && e.message ? e.message : e) }; }
      );
    `);
    await context.flushHostModuleCalls?.();
    return context.extract('__out') as { ok: boolean; value?: unknown; reason?: string };
  }

  it('round-trips an rpc result back to the guest and invokes the implementation', async () => {
    const out = await callRpc(`globalThis.__rill.hostModules['host:analytics'].track({ name: 'opened' })`);
    expect(out).toEqual({ ok: true, value: { ackId: 'ack:opened' } });
    expect(calls.track).toEqual([{ name: 'opened' }]);
  });

  it('rejects malformed input fail-closed before the implementation runs', async () => {
    const before = calls.track.length;
    const out = await callRpc(`globalThis.__rill.hostModules['host:analytics'].track({ name: '' })`);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('name must be a non-empty string');
    expect(calls.track.length).toBe(before);
  });

  it('rejects malformed output of an async implementation', async () => {
    const out = await callRpc(`globalThis.__rill.hostModules['host:analytics'].broken()`);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('ok must be true');
  });

  it('passes a void-returning capability through and records the call', async () => {
    const out = await callRpc(
      `globalThis.__rill.hostModules['host:navigation'].openProfile({ userId: '42' })`
    );
    expect(out.ok).toBe(true);
    expect(calls.openProfile).toEqual([{ userId: '42' }]);
  });

  it('fails closed when the guest invokes an unregistered host module', async () => {
    const out = await callRpc(`globalThis.__rill.__invokeHostRpc('host:secret', 'doThing', {})`);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('Host module not registered: host:secret');
  });

  it('runs parseEvent before the guest handler and rejects malformed events', () => {
    context.eval(`
      globalThis.__events = [];
      globalThis.__unsub = globalThis.__rill.hostModules['host:theme'].onThemeChanged(function(e){
        globalThis.__events.push(e);
      });
    `);
    expect(typeof calls.themeHandler).toBe('function');

    // Host emits a valid event -> delivered to the guest handler synchronously.
    calls.themeHandler?.({ theme: 'dark' });
    expect(context.extract('__events')).toEqual([{ theme: 'dark' }]);

    // Host emits a malformed event -> rejected at the boundary, never delivered.
    expect(() => calls.themeHandler?.({ theme: 'rainbow' })).toThrow('theme must be light or dark');
    expect(context.extract('__events')).toEqual([{ theme: 'dark' }]);
  });

  it('unsubscribe stops event delivery to the guest', () => {
    context.eval(`
      globalThis.__ev2 = [];
      globalThis.__unsub2 = globalThis.__rill.hostModules['host:theme'].onThemeChanged(function(e){
        globalThis.__ev2.push(e);
      });
    `);
    expect(typeof calls.themeHandler).toBe('function');
    const handler = calls.themeHandler;

    handler?.({ theme: 'light' });
    expect(context.extract('__ev2')).toEqual([{ theme: 'light' }]);

    // Guest unsubscribes: the host impl's unsubscribe fires AND the guest-side
    // subscription is removed, so further host emits do not reach the guest.
    context.eval('globalThis.__unsub2()');
    expect(calls.themeHandler).toBeNull();

    handler?.({ theme: 'dark' });
    expect(context.extract('__ev2')).toEqual([{ theme: 'light' }]);
  });

  it('propagates a non-boundary impl error to the guest as a rejection', async () => {
    // failHard has no boundary schema: the impl throws a plain Error, which must
    // round-trip across the JSON bridge as a guest promise rejection (reason carries
    // the message), not be swallowed or surface as a resolved value.
    const out = await callRpc(`globalThis.__rill.hostModules['host:analytics'].failHard()`);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('backend exploded');
  });

  it('correlates multiple concurrent rpc calls by id', async () => {
    // Two distinct invokes started in one eval (no await between them), then a single
    // flush. Each result must round-trip to its OWN guest global with the ackId derived
    // from its OWN input — proving id correlation holds with calls in flight together.
    context.eval(`
      globalThis.__outA = undefined;
      globalThis.__outB = undefined;
      globalThis.__rill.hostModules['host:analytics'].track({ name: 'a' }).then(function(v){ globalThis.__outA = v; });
      globalThis.__rill.hostModules['host:analytics'].track({ name: 'b' }).then(function(v){ globalThis.__outB = v; });
    `);
    await context.flushHostModuleCalls?.();
    expect(context.extract('__outA')).toEqual({ ackId: 'ack:a' });
    expect(context.extract('__outB')).toEqual({ ackId: 'ack:b' });
  });
});

describeIfWASM('QuickJSNativeWASMProvider host:* module lifecycle', () => {
  it('dispose() runs the host-side unsubscribe for active subscriptions', async () => {
    const provider = new QuickJSNativeWASMProvider({ debug: false });
    const runtime = await provider.createRuntime();
    const context = runtime.createContext();

    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:theme': {
          onThemeChanged: subscription<{ theme: 'light' | 'dark' }>(),
        },
      },
      guestExports: {},
    });

    let unsubscribed = false;
    const table = createHostModuleDispatch(contract, {
      'host:theme': {
        onThemeChanged: () => () => {
          unsubscribed = true;
        },
      },
    });
    context.installHostModules?.(table, contract);

    context.eval(
      `globalThis.__unsub = globalThis.__rill.hostModules['host:theme'].onThemeChanged(function(){});`
    );
    expect(unsubscribed).toBe(false);

    // Disposing the context with a live subscription must release it host-side, so the
    // host stops holding the guest handler (no leak across context teardown).
    context.dispose();
    expect(unsubscribed).toBe(true);

    runtime.dispose();
  });

  it('a single flush drains transitively-enqueued (chained) host calls', async () => {
    const provider = new QuickJSNativeWASMProvider({ debug: false });
    const runtime = await provider.createRuntime();
    const context = runtime.createContext();

    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:analytics': {
          track: rpc<{ name: string }, { ackId: string }>(),
        },
      },
      guestExports: {},
    });

    const recorded: string[] = [];
    const table = createHostModuleDispatch(contract, {
      'host:analytics': {
        track: async (input) => {
          recorded.push(input.name);
          if (input.name === 'first') {
            // Re-entrant: from inside the first impl, issue a SECOND rpc into the guest.
            // This enqueues another host call while flush is still draining the first.
            context.eval(
              `globalThis.__rill.hostModules['host:analytics'].track({ name: 'second' }).then(function(v){ globalThis.__secondOut = v; });`
            );
          }
          return { ackId: `ack:${input.name}` };
        },
      },
    });
    context.installHostModules?.(table, contract);

    context.eval(
      `globalThis.__rill.hostModules['host:analytics'].track({ name: 'first' }).then(function(v){ globalThis.__firstOut = v; });`
    );

    // A SINGLE flush must drain both the original and the transitively-enqueued call.
    await context.flushHostModuleCalls?.();

    expect(recorded).toEqual(['first', 'second']);
    expect(context.extract('__firstOut')).toEqual({ ackId: 'ack:first' });
    expect(context.extract('__secondOut')).toEqual({ ackId: 'ack:second' });

    context.dispose();
    runtime.dispose();
  });
});
