import { describe, expect, test } from 'bun:test';
import {
  createCapabilitiesManifest,
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
