import { describe, expect, test } from 'bun:test';
import {
  createCapabilitiesManifest,
  createHostModuleDispatch,
  defineRillContract,
  rpc,
  subscription,
} from './index';

describe('rill/contract binary fields', () => {
  test('rpc() carries the additive binary metadata into the frozen descriptor', () => {
    const call = rpc<{ key: string; value: Uint8Array }, { version: number }>({
      binary: { input: ['value'] },
    });

    expect(call.kind).toBe('rpc');
    expect(call.binary).toEqual({ input: ['value'] });
    expect(Object.isFrozen(call)).toBe(true);
  });

  test('a plain rpc() (no binary) leaves binary undefined — unchanged path', () => {
    const call = rpc<{ id: string }, void>();
    expect(call.binary).toBeUndefined();
  });

  test('manifest lists binaryCapabilities only for capabilities that declare bytes', () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:store': {
          putBytes: rpc<{ key: string; value: Uint8Array }, { version: number }>({
            binary: { input: ['value'] },
          }),
          getBytes: rpc<{ key: string }, { value: Uint8Array } | null>({
            binary: { output: ['value'] },
          }),
          putText: rpc<{ key: string; value: string }, void>(),
        },
      },
      guestExports: {},
    });

    const manifest = createCapabilitiesManifest(contract);
    expect(manifest.binaryCapabilities).toEqual(['host:store.getBytes', 'host:store.putBytes']);
  });

  test('manifest of a purely-JSON contract has NO binaryCapabilities key (byte-identical)', () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:store': {
          putText: rpc<{ key: string; value: string }, void>(),
        },
        'host:theme': {
          onThemeChanged: subscription<{ theme: 'light' | 'dark' }>(),
        },
      },
      guestExports: {
        refresh: rpc<{ reason: string }, void>(),
      },
    });

    const manifest = createCapabilitiesManifest(contract);
    expect('binaryCapabilities' in manifest).toBe(false);
    // Whole-object shape is exactly the pre-change manifest.
    expect(manifest).toEqual({
      contractVersion: '1.0.0',
      hostCapabilities: ['host:store.putText', 'host:theme.onThemeChanged'],
      guestExports: ['refresh'],
      unschemed: ['host:store.putText', 'host:theme.onThemeChanged'],
    });
  });

  test('validation rejects a malformed binary field-name map', () => {
    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {
          'host:store': {
            putBytes: rpc({ binary: { input: 'value' } } as never),
          },
        },
        guestExports: {},
      })
    ).toThrow('binary.input must be an array of field names');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {
          'host:store': {
            putBytes: rpc({ binary: { input: [''] } } as never),
          },
        },
        guestExports: {},
      })
    ).toThrow('binary.input must contain non-empty field-name strings');

    expect(() =>
      defineRillContract({
        version: '1.0.0',
        hostModules: {
          'host:store': {
            putBytes: rpc({ binary: 123 } as never),
          },
        },
        guestExports: {},
      })
    ).toThrow('binary must be an object');
  });

  const buildStoreContract = () =>
    defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:store': {
          putBytes: rpc<{ key: string; value: Uint8Array }, { version: number }>({
            binary: { input: ['value'] },
          }),
          getBytes: rpc<{ key: string }, { value: Uint8Array }>({
            binary: { output: ['value'] },
          }),
        },
      },
      guestExports: {},
    });

  test('dispatch accepts a Uint8Array for a declared binary input field', () => {
    let received: Uint8Array | undefined;
    const dispatch = createHostModuleDispatch(buildStoreContract(), {
      'host:store': {
        putBytes: (input: { key: string; value: Uint8Array }) => {
          received = input.value;
          return { version: 1 };
        },
        getBytes: () => ({ value: new Uint8Array([1]) }),
      },
    });

    const result = dispatch['host:store']!.putBytes!({
      key: 'k',
      value: new Uint8Array([0x00, 0xff]),
    });
    expect(result).toEqual({ version: 1 });
    expect(received).toEqual(new Uint8Array([0x00, 0xff]));
  });

  test('dispatch REJECTS a number-array for a declared binary input field (fail-closed)', () => {
    let implCalled = false;
    const dispatch = createHostModuleDispatch(buildStoreContract(), {
      'host:store': {
        putBytes: () => {
          implCalled = true;
          return { version: 1 };
        },
        getBytes: () => ({ value: new Uint8Array([1]) }),
      },
    });

    expect(() =>
      // A JSON number-array is exactly the wrong shape the byte-stream type replaces.
      dispatch['host:store']!.putBytes!({ key: 'k', value: [0, 255] } as never)
    ).toThrow('binary input field "value" must be a Uint8Array');
    expect(implCalled).toBe(false);
  });

  test('dispatch rejects a missing / wrong-type binary input field', () => {
    const dispatch = createHostModuleDispatch(buildStoreContract(), {
      'host:store': {
        putBytes: () => ({ version: 1 }),
        getBytes: () => ({ value: new Uint8Array([1]) }),
      },
    });

    expect(() =>
      dispatch['host:store']!.putBytes!({ key: 'k', value: 'not-bytes' } as never)
    ).toThrow('binary input field "value" must be a Uint8Array');
  });

  test('dispatch rejects an impl returning a non-Uint8Array for a declared binary output field', () => {
    const dispatch = createHostModuleDispatch(buildStoreContract(), {
      'host:store': {
        putBytes: () => ({ version: 1 }),
        // Returns a number-array where the contract declares bytes.
        getBytes: () => ({ value: [1, 2, 3] }) as never,
      },
    });

    expect(() => dispatch['host:store']!.getBytes!({ key: 'k' })).toThrow(
      'binary output field "value" must be a Uint8Array'
    );
  });

  test('binary backstop composes with a user parseInput (parse runs, then bytes are checked)', () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:store': {
          putBytes: rpc<{ key: string; value: Uint8Array }, void>({
            binary: { input: ['value'] },
            schema: {
              parseInput: (v) => {
                const input = v as { key?: unknown; value?: unknown };
                if (typeof input?.key !== 'string') {
                  throw new Error('key must be a string');
                }
                return input as { key: string; value: Uint8Array };
              },
            },
          }),
        },
      },
      guestExports: {},
    });

    const seen: string[] = [];
    const dispatch = createHostModuleDispatch(contract, {
      'host:store': {
        putBytes: (input: { key: string; value: Uint8Array }) => {
          seen.push(input.key);
        },
      },
    });

    dispatch['host:store']!.putBytes!({ key: 'k', value: new Uint8Array([1]) });
    expect(seen).toEqual(['k']);

    // parseInput failure still fires first.
    expect(() =>
      dispatch['host:store']!.putBytes!({ key: 123, value: new Uint8Array([1]) } as never)
    ).toThrow('key must be a string');

    // parse passes, but the binary backstop rejects a non-Uint8Array value.
    expect(() =>
      dispatch['host:store']!.putBytes!({ key: 'k', value: [1, 2] } as never)
    ).toThrow('binary input field "value" must be a Uint8Array');
  });

  test('async impl: binary output backstop rejects after resolution', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:store': {
          getBytes: rpc<{ key: string }, { value: Uint8Array }>({
            binary: { output: ['value'] },
          }),
        },
      },
      guestExports: {},
    });

    const dispatch = createHostModuleDispatch(contract, {
      'host:store': {
        getBytes: async () => ({ value: [1, 2, 3] }) as never,
      },
    });

    await expect(dispatch['host:store']!.getBytes!({ key: 'k' })).rejects.toThrow(
      'binary output field "value" must be a Uint8Array'
    );
  });
});

describe('rill/contract binary field-name types (compile-time)', () => {
  test('binary field names are constrained to Uint8Array-typed keys of Input/Output', () => {
    // Valid: 'value' is the Uint8Array field.
    rpc<{ key: string; value: Uint8Array }, void>({ binary: { input: ['value'] } });
    // Valid on the output side.
    rpc<void, { value: Uint8Array; version: number }>({ binary: { output: ['value'] } });

    // @ts-expect-error 'key' is a string field, not a byte stream.
    rpc<{ key: string; value: Uint8Array }, void>({ binary: { input: ['key'] } });

    // @ts-expect-error 'missing' is not a field of Input at all.
    rpc<{ value: Uint8Array }, void>({ binary: { input: ['missing'] } });

    // @ts-expect-error 'version' is a number field, not a byte stream.
    rpc<void, { value: Uint8Array; version: number }>({ binary: { output: ['version'] } });

    expect(true).toBe(true);
  });
});
