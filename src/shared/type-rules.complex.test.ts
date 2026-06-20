/**
 * TypeRules Complex Type Serialization Tests
 *
 * Comprehensive tests for complex types: ArrayBuffer, TypedArray, BigInt, etc.
 * Targets uncovered lines in type-rules.ts
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CallbackRegistry } from '../guest/runtime/reconciler';
import { createDecoder, createEncoder, DEFAULT_TYPE_RULES } from './type-rules';

describe('TypeRules - Complex Types', () => {
  let registry: CallbackRegistry;
  // biome-ignore lint/suspicious/noExplicitAny: Test context with dynamic encoder/decoder assignment
  let context: any;
  let encoder: (value: unknown) => unknown;
  let decoder: (value: unknown) => unknown;

  beforeEach(() => {
    registry = new CallbackRegistry();

    // TypeRules expect ctx.encode/ctx.decode for nested structures (Map/Set/Object/Array rules).
    // In production Bridge sets these after creating the encoder/decoder.
    context = {
      // biome-ignore lint/suspicious/noExplicitAny: Test callback registry expects any function type
      // biome-ignore lint/complexity/noBannedTypes: Function type required for test registry
      registerFunction: (fn: Function) => registry.register(fn as any),
      invokeFunction: (fnId: string, args: unknown[]) => registry.invoke(fnId, args),
      registerPromise: () => 'p_test',
      createPendingPromise: () => Promise.resolve(),
      encode: undefined,
      decode: undefined,
    };

    encoder = createEncoder(DEFAULT_TYPE_RULES, context);
    decoder = createDecoder(DEFAULT_TYPE_RULES, context);
    context.encode = encoder;
    context.decode = decoder;
  });

  describe('ArrayBuffer', () => {
    it('should serialize ArrayBuffer', () => {
      const buffer = new ArrayBuffer(16);
      const view = new Uint8Array(buffer);
      view[0] = 255;
      view[1] = 128;

      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(buffer) as any;

      expect(encoded.__type).toBe('arraybuffer');
      expect(encoded.__data).toBeDefined();
      expect(Array.isArray(encoded.__data)).toBe(true);
    });

    it('should deserialize ArrayBuffer', () => {
      const serialized = {
        __type: 'arraybuffer',
        __data: [255, 128, 64, 32],
      };

      const decoded = decoder(serialized) as ArrayBuffer;

      expect(decoded instanceof ArrayBuffer).toBe(true);
      expect(decoded.byteLength).toBe(4);

      const view = new Uint8Array(decoded);
      expect(view[0]).toBe(255);
      expect(view[1]).toBe(128);
      expect(view[2]).toBe(64);
      expect(view[3]).toBe(32);
    });

    it('should round-trip ArrayBuffer', () => {
      const original = new ArrayBuffer(8);
      const view = new Uint8Array(original);
      for (let i = 0; i < 8; i++) {
        view[i] = i * 10;
      }

      const encoded = encoder(original);
      const decoded = decoder(encoded) as ArrayBuffer;

      expect(decoded.byteLength).toBe(original.byteLength);
      const decodedView = new Uint8Array(decoded);
      for (let i = 0; i < 8; i++) {
        expect(decodedView[i]).toBe(view[i]);
      }
    });
  });

  describe('TypedArrays', () => {
    it('should serialize Uint8Array', () => {
      const arr = new Uint8Array([1, 2, 3, 4, 5]);
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(arr) as any;

      expect(encoded.__type).toBe('typedarray');
      expect(encoded.__ctor).toBe('Uint8Array');
      expect(encoded.__data).toEqual([1, 2, 3, 4, 5]);
    });

    it('should serialize Int16Array', () => {
      const arr = new Int16Array([-1000, 0, 1000]);
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(arr) as any;

      expect(encoded.__type).toBe('typedarray');
      expect(encoded.__ctor).toBe('Int16Array');
      expect(encoded.__data).toEqual([-1000, 0, 1000]);
    });

    it('should serialize Float32Array', () => {
      const arr = new Float32Array([1.5, 2.75, 3.125]);
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(arr) as any;

      expect(encoded.__type).toBe('typedarray');
      expect(encoded.__ctor).toBe('Float32Array');
      expect(Array.isArray(encoded.__data)).toBe(true);
      expect(encoded.__data.length).toBe(3);
    });

    it('should deserialize Uint8Array', () => {
      const serialized = {
        __type: 'typedarray',
        __ctor: 'Uint8Array',
        __data: [10, 20, 30],
      };

      const decoded = decoder(serialized) as Uint8Array;

      expect(decoded instanceof Uint8Array).toBe(true);
      expect(decoded.length).toBe(3);
      expect(decoded[0]).toBe(10);
      expect(decoded[1]).toBe(20);
      expect(decoded[2]).toBe(30);
    });

    it('should round-trip Int32Array', () => {
      const original = new Int32Array([1000000, -500000, 0, 999999]);
      const encoded = encoder(original);
      const decoded = decoder(encoded) as Int32Array;

      expect(decoded instanceof Int32Array).toBe(true);
      expect(decoded.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(decoded[i]).toBe(original[i]);
      }
    });

    it('should handle all TypedArray types', () => {
      const arrays = [
        new Uint8Array([1, 2]),
        new Uint8ClampedArray([100, 255]),
        new Int8Array([-128, 127]),
        new Uint16Array([1000, 2000]),
        new Int16Array([-1000, 1000]),
        new Uint32Array([100000, 200000]),
        new Int32Array([-100000, 100000]),
        new Float32Array([1.5, 2.5]),
        new Float64Array([1.123456789, 2.987654321]),
      ];

      for (const arr of arrays) {
        const encoded = encoder(arr);
        const decoded = decoder(encoded);

        expect(decoded.constructor.name).toBe(arr.constructor.name);
        // biome-ignore lint/suspicious/noExplicitAny: Test needs to access length property dynamically
        expect((decoded as any).length).toBe(arr.length);
      }
    });
  });

  describe('BigInt', () => {
    it('should serialize BigInt', () => {
      const big = BigInt('9007199254740991');
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(big) as any;

      // BigInt is currently treated as passthrough (no special serialization rule).
      expect(typeof encoded).toBe('bigint');
    });

    it('should deserialize BigInt', () => {
      // BigInt deserialization is not supported (no bigint type rule).
      // Unknown __type objects are returned as-is.
      const serialized = {
        __type: 'bigint',
        __value: '123456789012345678901234567890',
      };

      const decoded = decoder(serialized);
      expect(decoded).toEqual(serialized);
    });

    it('should round-trip BigInt', () => {
      const values = [
        BigInt(0),
        BigInt(1),
        BigInt(-1),
        BigInt('999999999999999999'),
        BigInt('-999999999999999999'),
      ];

      for (const original of values) {
        const encoded = encoder(original);
        const decoded = decoder(encoded);

        expect(decoded).toBe(original);
      }
    });

    it('should handle very large BigInt', () => {
      const huge = BigInt('12345678901234567890123456789012345678901234567890');
      const encoded = encoder(huge);
      const decoded = decoder(encoded);

      expect(decoded).toBe(huge);
    });
  });

  describe('Complex Nested Structures', () => {
    it('should serialize nested objects with TypedArrays', () => {
      const obj = {
        data: new Uint8Array([1, 2, 3]),
        meta: {
          buffer: new ArrayBuffer(4),
          count: 3,
        },
      };

      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(obj) as any;

      expect(encoded.data.__type).toBe('typedarray');
      expect(encoded.data.__ctor).toBe('Uint8Array');
      expect(encoded.meta.buffer.__type).toBe('arraybuffer');
      expect(encoded.meta.count).toBe(3);
    });

    it('should handle arrays containing TypedArrays', () => {
      const arr = [
        new Uint8Array([1, 2]),
        new Int16Array([100, 200]),
        { nested: new Float32Array([1.5, 2.5]) },
      ];

      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded array structure
      const encoded = encoder(arr) as any[];

      expect(encoded[0].__type).toBe('typedarray');
      expect(encoded[0].__ctor).toBe('Uint8Array');
      expect(encoded[1].__type).toBe('typedarray');
      expect(encoded[1].__ctor).toBe('Int16Array');
      expect(encoded[2].nested.__type).toBe('typedarray');
      expect(encoded[2].nested.__ctor).toBe('Float32Array');
    });

    it('should serialize Map with complex values', () => {
      const map = new Map([
        ['buffer', new ArrayBuffer(8)],
        ['array', new Uint16Array([1, 2, 3])],
        ['bigint', BigInt(12345)],
      ]);

      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(map) as any;

      expect(encoded.__type).toBe('map');
      expect(encoded.__entries).toBeDefined();
      expect(Array.isArray(encoded.__entries)).toBe(true);
    });

    it('should serialize Set with TypedArrays', () => {
      const set = new Set([new Uint8Array([1, 2]), new Int16Array([10, 20])]);

      // biome-ignore lint/suspicious/noExplicitAny: Test needs to inspect encoded object structure
      const encoded = encoder(set) as any;

      expect(encoded.__type).toBe('set');
      expect(encoded.__values).toBeDefined();
      expect(Array.isArray(encoded.__values)).toBe(true);
      expect(encoded.__values[0].__type).toBe('typedarray');
      expect(encoded.__values[0].__ctor).toBe('Uint8Array');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty ArrayBuffer', () => {
      const buffer = new ArrayBuffer(0);
      const encoded = encoder(buffer);
      const decoded = decoder(encoded) as ArrayBuffer;

      expect(decoded.byteLength).toBe(0);
    });

    it('should handle empty TypedArray', () => {
      const arr = new Uint8Array(0);
      const encoded = encoder(arr);
      const decoded = decoder(encoded) as Uint8Array;

      expect(decoded.length).toBe(0);
    });

    it('should handle BigInt zero', () => {
      const zero = BigInt(0);
      const encoded = encoder(zero);
      const decoded = decoder(encoded);

      expect(decoded).toBe(zero);
    });

    it('should handle negative BigInt', () => {
      const negative = BigInt(-999);
      const encoded = encoder(negative);
      const decoded = decoder(encoded);

      expect(decoded).toBe(negative);
    });

    it('should handle TypedArray with special values', () => {
      const arr = new Float64Array([Infinity, -Infinity, NaN, 0, -0]);
      const encoded = encoder(arr);
      const decoded = decoder(encoded) as Float64Array;

      expect(decoded[0]).toBe(Infinity);
      expect(decoded[1]).toBe(-Infinity);
      expect(Number.isNaN(decoded[2])).toBe(true);
      expect(decoded[3]).toBe(0);
      expect(Object.is(decoded[4], -0)).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should handle large ArrayBuffer', () => {
      const size = 1024 * 1024; // 1MB
      const buffer = new ArrayBuffer(size);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < 1000; i++) {
        view[i] = i % 256;
      }

      const encoded = encoder(buffer);
      const decoded = decoder(encoded) as ArrayBuffer;

      expect(decoded.byteLength).toBe(size);
    });

    it('should handle large TypedArray', () => {
      const size = 100000;
      const arr = new Uint16Array(size);
      for (let i = 0; i < size; i++) {
        arr[i] = i % 65536;
      }

      const encoded = encoder(arr);
      const decoded = decoder(encoded) as Uint16Array;

      expect(decoded.length).toBe(size);
      expect(decoded[0]).toBe(arr[0]);
      expect(decoded[size - 1]).toBe(arr[size - 1]);
    });
  });
});
