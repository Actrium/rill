import { describe, expect, test } from 'bun:test';
import {
  createCapabilitiesManifest,
  createHostModuleDispatch,
  defineRillContract,
  implementHostModules,
  isHostModuleId,
  rpc,
  subscription,
  type GuestExportsClient,
} from './index';

describe('rill/contract', () => {
  test('creates rpc and subscription descriptors', () => {
    const parseInput = (value: unknown) => value as { id: string };
    const parseOutput = (value: unknown) => value as { ok: true };
    const parseEvent = (value: unknown) => value as { theme: 'light' | 'dark' };
    const call = rpc<{ id: string }, { ok: true }>({
      timeoutMs: 500,
      schema: { parseInput, parseOutput },
    });
    const sub = subscription<{ theme: 'light' | 'dark' }>({
      schema: { parseEvent },
    });

    expect(call.kind).toBe('rpc');
    expect(call.timeoutMs).toBe(500);
    expect(call.schema?.parseInput).toBe(parseInput);
    expect(call.schema?.parseOutput).toBe(parseOutput);
    expect(Object.isFrozen(call)).toBe(true);

    expect(sub.kind).toBe('subscription');
    expect(sub.schema?.parseEvent).toBe(parseEvent);
    expect(Object.isFrozen(sub)).toBe(true);
  });

  test('validates host module ids', () => {
    expect(isHostModuleId('host:navigation')).toBe(true);
    expect(isHostModuleId('host:user/profile')).toBe(true);
    expect(isHostModuleId('host:user_profile-2')).toBe(true);

    expect(isHostModuleId('host:')).toBe(false);
    expect(isHostModuleId('host:User')).toBe(false);
    expect(isHostModuleId('host:../secrets')).toBe(false);
    expect(isHostModuleId('https://example.com')).toBe(false);
  });

  test('defines a frozen contract and creates a deterministic manifest', () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:navigation': {
          openProfile: rpc<{ userId: string }, void>(),
        },
        'host:theme': {
          notifyReady: rpc<{ version: string }, void>(),
          onThemeChanged: subscription<{ theme: 'light' | 'dark' }>(),
        },
      },
      guestExports: {
        refresh: rpc<{ reason: string }, void>(),
      },
    });

    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.hostModules)).toBe(true);
    expect(Object.isFrozen(contract.hostModules['host:navigation'])).toBe(true);

    expect(createCapabilitiesManifest(contract)).toEqual({
      contractVersion: '1.0.0',
      hostCapabilities: [
        'host:navigation.openProfile',
        'host:theme.notifyReady',
        'host:theme.onThemeChanged',
      ],
      guestExports: ['refresh'],
    });
  });

  test('validates host module implementations', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:math': {
          add: rpc<{ a: number; b: number }, number>(),
          onTick: subscription<{ value: number }>(),
        },
        'host:clipboard': {
          readText: rpc<void, string>(),
        },
      },
      guestExports: {
        refresh: rpc<{ reason: string }, boolean>(),
      },
    });

    const impl = implementHostModules(contract, {
      'host:math': {
        add: async ({ a, b }) => a + b,
        onTick: (handler) => {
          handler({ value: 1 });
          return () => {};
        },
      },
      'host:clipboard': {
        readText: () => 'copied',
      },
    });

    expect(await impl['host:math'].add({ a: 2, b: 3 })).toBe(5);
    expect(await impl['host:clipboard'].readText()).toBe('copied');

    const guest: GuestExportsClient<typeof contract> = {
      refresh: async ({ reason }) => reason.length > 0,
    };

    expect(await guest.refresh({ reason: 'manual' })).toBe(true);
  });

  test('rejects invalid contracts', () => {
    expect(() =>
      defineRillContract({
        version: '',
        hostModules: {},
        guestExports: {},
      } as never)
    ).toThrow('Contract version must be a non-empty string');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: null,
        guestExports: {},
      } as never)
    ).toThrow('hostModules must be an object');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {},
        guestExports: null,
      } as never)
    ).toThrow('guestExports must be an object');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {
          'host:Bad': {
            open: rpc(),
          },
        },
        guestExports: {},
      } as never)
    ).toThrow('Invalid host module id');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {
          'host:navigation': {
            'open-profile': rpc(),
          },
        },
        guestExports: {},
      } as never)
    ).toThrow('Invalid export name');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {},
        guestExports: {
          refresh: subscription(),
        },
      } as never)
    ).toThrow('must be rpc()');
  });

  test('rejects invalid host module implementations', () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:navigation': {
          openProfile: rpc<{ userId: string }, void>(),
        },
      },
      guestExports: {},
    });

    expect(() => implementHostModules(contract, {} as never)).toThrow(
      'Missing implementation for host module "host:navigation"'
    );

    expect(() =>
      implementHostModules(contract, {
        'host:navigation': {},
      } as never)
    ).toThrow('Missing function implementation for "host:navigation.openProfile"');

    expect(() =>
      implementHostModules(contract, {
        'host:navigation': {
          openProfile: () => {},
          closeProfile: () => {},
        },
      } as never)
    ).toThrow('is not declared');

    expect(() =>
      implementHostModules(contract, {
        'host:navigation': {
          openProfile: () => {},
        },
        'host:extra': {
          ping: () => {},
        },
      } as never)
    ).toThrow('Host module implementation "host:extra" is not declared');
  });
});

describe('createHostModuleDispatch', () => {
  const buildContract = () =>
    defineRillContract({
      version: '2.0.0',
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

  test('runs parseInput then implementation then parseOutput', async () => {
    const calls: Array<{ name: string }> = [];
    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': {
        track: async (input) => {
          calls.push(input);
          return { ok: true };
        },
      },
      'host:theme': {
        onThemeChanged: () => () => {},
      },
    });

    const result = await dispatch['host:analytics']!.track!({ name: 'opened' });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ name: 'opened' }]);
  });

  test('parseInput rejects malformed input fail-closed (impl never runs)', async () => {
    let implCalled = false;
    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': {
        track: async () => {
          implCalled = true;
          return { ok: true };
        },
      },
      'host:theme': { onThemeChanged: () => () => {} },
    });

    expect(() => dispatch['host:analytics']!.track!({ name: '' })).toThrow(
      'Boundary input validation failed for "host:analytics.track": name must be a non-empty string'
    );
    expect(implCalled).toBe(false);
  });

  test('parseOutput rejects malformed output of an async implementation', async () => {
    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': {
        // Implementation returns a value the contract forbids.
        track: async () => ({ ok: false }) as never,
      },
      'host:theme': { onThemeChanged: () => () => {} },
    });

    await expect(dispatch['host:analytics']!.track!({ name: 'x' })).rejects.toThrow(
      'Boundary output validation failed for "host:analytics.track": output.ok must be true'
    );
  });

  test('reports boundary failures through onError without swallowing the throw', () => {
    const errors: string[] = [];
    const dispatch = createHostModuleDispatch(
      buildContract(),
      {
        'host:analytics': { track: async () => ({ ok: true }) },
        'host:theme': { onThemeChanged: () => () => {} },
      },
      {
        onError: (_error, ctx) => {
          errors.push(`${ctx.moduleId}.${ctx.exportName}:${ctx.phase}`);
        },
      }
    );

    expect(() => dispatch['host:analytics']!.track!({ name: 123 })).toThrow();
    expect(errors).toEqual(['host:analytics.track:input']);
  });

  test('subscription runs parseEvent before the guest handler and rejects bad events', () => {
    const seen: Array<{ theme: string }> = [];
    let emit: ((event: unknown) => void) | undefined;

    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': { track: async () => ({ ok: true }) },
      'host:theme': {
        onThemeChanged: (handler) => {
          emit = handler as (event: unknown) => void;
          return () => {};
        },
      },
    });

    const unsubscribe = dispatch['host:theme']!.onThemeChanged!((event: { theme: string }) => {
      seen.push(event);
    });
    expect(typeof unsubscribe).toBe('function');

    emit?.({ theme: 'dark' });
    expect(seen).toEqual([{ theme: 'dark' }]);

    // A malformed event throws on emit and never reaches the guest handler.
    expect(() => emit?.({ theme: 'rainbow' })).toThrow(
      'Boundary event validation failed for "host:theme.onThemeChanged": theme must be light or dark'
    );
    expect(seen).toEqual([{ theme: 'dark' }]);
  });

  test('implementation errors propagate unchanged (not wrapped as boundary errors)', async () => {
    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': {
        track: async () => {
          throw new Error('analytics backend down');
        },
      },
      'host:theme': { onThemeChanged: () => () => {} },
    });

    await expect(dispatch['host:analytics']!.track!({ name: 'x' })).rejects.toThrow(
      'analytics backend down'
    );
  });

  test('rejects an implementation that does not match the contract', () => {
    expect(() =>
      createHostModuleDispatch(buildContract(), {
        'host:analytics': { track: async () => ({ ok: true }) },
      } as never)
    ).toThrow('Missing implementation for host module "host:theme"');
  });

  test('synchronous rpc impl: parseOutput runs inline and the result returns synchronously', () => {
    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': {
        // Synchronous (non-async) implementation — exercises the non-thenable branch.
        track: () => ({ ok: true }) as never,
      },
      'host:theme': { onThemeChanged: () => () => {} },
    });

    const result = dispatch['host:analytics']?.track?.({ name: 'x' });
    // Not a promise: a sync impl returns the parsed value directly.
    expect(result).toEqual({ ok: true });
    expect(typeof (result as { then?: unknown })?.then).not.toBe('function');
  });

  test('synchronous rpc impl: parseOutput rejects malformed output synchronously (throws, not rejects)', () => {
    const dispatch = createHostModuleDispatch(buildContract(), {
      'host:analytics': {
        track: () => ({ ok: false }) as never,
      },
      'host:theme': { onThemeChanged: () => () => {} },
    });
    expect(() => dispatch['host:analytics']?.track?.({ name: 'x' })).toThrow(
      'Boundary output validation failed for "host:analytics.track": output.ok must be true'
    );
  });

  test('no-input (void) rpc runs parseInput with undefined and rejects an unexpected arg', () => {
    const seenInputs: unknown[] = [];
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:lifecycle': {
          ping: rpc<void, void>({
            schema: {
              parseInput: (value) => {
                seenInputs.push(value);
                if (value !== undefined) {
                  throw new Error('expected no input');
                }
                return undefined;
              },
            },
          }),
        },
      },
      guestExports: {},
    });

    let implCalls = 0;
    const dispatch = createHostModuleDispatch(contract, {
      'host:lifecycle': {
        ping: () => {
          implCalls++;
        },
      },
    });

    // Called with no args: parseInput receives undefined and the impl runs.
    dispatch['host:lifecycle']?.ping?.();
    expect(seenInputs).toEqual([undefined]);
    expect(implCalls).toBe(1);

    // Called with an unexpected arg: rejected at the input boundary, impl never re-runs.
    expect(() => dispatch['host:lifecycle']?.ping?.({ unexpected: true } as never)).toThrow(
      'Boundary input validation failed for "host:lifecycle.ping": expected no input'
    );
    expect(implCalls).toBe(1);
  });
});
