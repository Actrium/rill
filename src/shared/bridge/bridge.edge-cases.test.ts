/**
 * @rill/runtime/bridge - Edge Case Tests
 *
 * Tests for edge cases and complex scenarios:
 * - Circular references
 * - TypedArrays
 * - Complex nested structures
 * - toJSON support
 * - Mixed type combinations
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry } from '..';
import type { HostMessage, OperationBatch } from '..';
import { Bridge } from './bridge';

describe('Bridge - Edge Cases', () => {
  let registry: CallbackRegistry;
  let bridge: Bridge;
  let hostReceived: OperationBatch[];
  let guestReceived: HostMessage[];

  beforeEach(() => {
    registry = new CallbackRegistry();
    hostReceived = [];
    guestReceived = [];

    bridge = new Bridge({
      callbackRegistry: registry,
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: (message) => guestReceived.push(message),
      debug: false,
    });
  });

  describe('Circular References', () => {
    // Circular reference detection is implemented in:
    // 1. serialization.ts - createEncoder() tracks seen objects
    // 2. bridge.ts - hasSerializedValues() tracks seen objects

    test('should handle circular references in objects', () => {
      const obj: Record<string, unknown> = { name: 'root' };
      obj.self = obj; // Circular reference

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: obj },
          },
        ],
      };

      // Should not throw
      expect(() => bridge.sendRawBatch(batch)).not.toThrow();

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as Record<string, unknown>;
      expect(data.name).toBe('root');
      // Circular reference should be replaced with undefined
      expect(data.self).toBe(undefined);
    });

    test('should handle circular references in arrays', () => {
      const arr: unknown[] = [1, 2, 3];
      arr.push(arr); // Circular reference

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { items: arr },
          },
        ],
      };

      expect(() => bridge.sendRawBatch(batch)).not.toThrow();

      const received = hostReceived[0]!;
      const items = received.operations[0]!.props!.items as unknown[];
      expect(items[0]).toBe(1);
      expect(items[1]).toBe(2);
      expect(items[2]).toBe(3);
      // Circular reference should be replaced with undefined
      expect(items[3]).toBe(undefined);
    });

    test('should handle deeply nested circular references', () => {
      const root = { level: 0, child: null as unknown };
      const level1 = { level: 1, child: null as unknown, parent: root };
      const level2 = { level: 2, child: null as unknown, parent: level1 };
      root.child = level1;
      level1.child = level2;
      level2.child = root; // Circular back to root

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: root },
          },
        ],
      };

      expect(() => bridge.sendRawBatch(batch)).not.toThrow();

      const received = hostReceived[0]!;
      // biome-ignore lint/suspicious/noExplicitAny: Test/internal structure with dynamic types
      const data = received.operations[0]!.props!.data as any;
      expect(data.level).toBe(0);
      expect(data.child.level).toBe(1);
      expect(data.child.child.level).toBe(2);
      // Circular reference should be handled
      expect(data.child.child.child).toBe(undefined);
    });
  });

  describe('TypedArrays', () => {
    test('should encode and decode Uint8Array', () => {
      const arr = new Uint8Array([10, 20, 30, 40, 50]);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: arr },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data;
      expect(data).toBeInstanceOf(Uint8Array);
      expect(Array.from(data as Uint8Array)).toEqual([10, 20, 30, 40, 50]);
    });

    test('should encode and decode Int32Array', () => {
      const arr = new Int32Array([-100, 0, 100, 1000000]);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: arr },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data;
      expect(data).toBeInstanceOf(Int32Array);
      expect(Array.from(data as Int32Array)).toEqual([-100, 0, 100, 1000000]);
    });

    test('should encode and decode Float32Array', () => {
      const arr = new Float32Array([1.5, 2.5, 3.5, Math.PI]);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: arr },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as Float32Array;
      expect(data).toBeInstanceOf(Float32Array);
      expect(data[0]).toBeCloseTo(1.5, 5);
      expect(data[1]).toBeCloseTo(2.5, 5);
      expect(data[2]).toBeCloseTo(3.5, 5);
    });

    test('should encode and decode Float64Array', () => {
      const arr = new Float64Array([Math.PI, Math.E, Number.MAX_VALUE]);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: arr },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as Float64Array;
      expect(data).toBeInstanceOf(Float64Array);
      expect(data[0]).toBeCloseTo(Math.PI, 10);
      expect(data[1]).toBeCloseTo(Math.E, 10);
    });

    test('should encode and decode Uint8ClampedArray', () => {
      const arr = new Uint8ClampedArray([0, 128, 255, 300, -50]);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: arr },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data;
      expect(data).toBeInstanceOf(Uint8ClampedArray);
      // Uint8ClampedArray clamps values: 300 -> 255, -50 -> 0
      expect(Array.from(data as Uint8ClampedArray)).toEqual([0, 128, 255, 255, 0]);
    });
  });

  describe('Complex Nested Structures', () => {
    test('should handle Map with nested Map values', () => {
      const innerMap = new Map([
        ['x', 1],
        ['y', 2],
      ]);
      const outerMap = new Map<string, Map<string, number>>([['inner', innerMap]]);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: outerMap },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as Map<string, Map<string, number>>;
      expect(data).toBeInstanceOf(Map);
      expect(data.get('inner')).toBeInstanceOf(Map);
      expect(data.get('inner')?.get('x')).toBe(1);
      expect(data.get('inner')?.get('y')).toBe(2);
    });

    test('should handle Set with nested Set values', () => {
      const innerSet = new Set([1, 2, 3]);
      const middleSet = new Set([innerSet]);
      const data = { sets: middleSet };

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const receivedData = received.operations[0]!.props!.data as { sets: Set<Set<number>> };
      expect(receivedData.sets).toBeInstanceOf(Set);
      const setArray = Array.from(receivedData.sets);
      expect(setArray[0]).toBeInstanceOf(Set);
      expect(Array.from(setArray[0]!)).toEqual([1, 2, 3]);
    });

    test('should handle mixed nested structures', () => {
      const mixedData = {
        map: new Map([['key', { nested: true }]]),
        set: new Set([new Date('2024-01-01'), new Date('2024-12-31')]),
        array: [{ fn: () => 'hello' }, new Uint8Array([1, 2, 3]), /pattern/gi],
      };

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: mixedData },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as typeof mixedData;

      // Map
      expect(data.map).toBeInstanceOf(Map);
      expect(data.map.get('key')).toEqual({ nested: true });

      // Set with Dates
      expect(data.set).toBeInstanceOf(Set);
      const dates = Array.from(data.set);
      expect(dates[0]).toBeInstanceOf(Date);
      expect(dates[1]).toBeInstanceOf(Date);

      // Array with function, TypedArray, RegExp
      expect(typeof data.array[0].fn).toBe('function');
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies function callback
      expect((data.array[0].fn as Function)()).toBe('hello');
      expect(data.array[1]).toBeInstanceOf(Uint8Array);
      expect(data.array[2]).toBeInstanceOf(RegExp);
    });
  });

  describe('toJSON Support', () => {
    test('should call toJSON on objects that define it', () => {
      const customObj = {
        privateData: 'secret',
        publicData: 'visible',
        toJSON() {
          return { public: this.publicData };
        },
      };

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: customObj },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as Record<string, unknown>;

      // Should only have the serialized data from toJSON
      expect(data.public).toBe('visible');
      expect(data.privateData).toBeUndefined();
    });

    test('should handle nested objects with toJSON', () => {
      const child = {
        value: 42,
        toJSON() {
          return { serialized: true, v: this.value };
        },
      };

      const parent = {
        name: 'parent',
        child,
      };

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: parent },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      // biome-ignore lint/suspicious/noExplicitAny: Test/internal structure with dynamic types
      const data = received.operations[0]!.props!.data as any;

      expect(data.name).toBe('parent');
      expect(data.child.serialized).toBe(true);
      expect(data.child.v).toBe(42);
    });
  });

  describe('Edge Case Values', () => {
    test('should handle undefined values in objects', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              defined: 'value',
              notDefined: undefined,
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const props = received.operations[0]!.props!;
      expect(props.defined).toBe('value');
      expect(props.notDefined).toBe(undefined);
    });

    test('should handle NaN and Infinity', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              nan: NaN,
              posInf: Infinity,
              negInf: -Infinity,
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const props = received.operations[0]!.props!;
      expect(Number.isNaN(props.nan)).toBe(true);
      expect(props.posInf).toBe(Infinity);
      expect(props.negInf).toBe(-Infinity);
    });

    test('should handle empty objects and arrays', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              emptyObj: {},
              emptyArr: [],
              emptyMap: new Map(),
              emptySet: new Set(),
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const props = received.operations[0]!.props!;

      expect(props.emptyObj).toEqual({});
      expect(props.emptyArr).toEqual([]);
      expect(props.emptyMap).toBeInstanceOf(Map);
      expect((props.emptyMap as Map<unknown, unknown>).size).toBe(0);
      expect(props.emptySet).toBeInstanceOf(Set);
      expect((props.emptySet as Set<unknown>).size).toBe(0);
    });

    test('should handle objects with null prototype', () => {
      const nullProtoObj = Object.create(null);
      nullProtoObj.key = 'value';
      nullProtoObj.number = 42;

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: nullProtoObj },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const data = received.operations[0]!.props!.data as Record<string, unknown>;
      expect(data.key).toBe('value');
      expect(data.number).toBe(42);
    });
  });

  describe('Function Edge Cases', () => {
    test('should handle function with arguments and return value', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              calculate: (a: number, b: number) => a + b,
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies function callback
      const calculate = received.operations[0]!.props!.calculate as Function;
      expect(calculate(2, 3)).toBe(5);
      expect(calculate(10, 20)).toBe(30);
    });

    test('should handle async functions', async () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              asyncFn: async (x: number) => {
                await new Promise((r) => setTimeout(r, 10));
                return x * 2;
              },
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies async function callback
      const asyncFn = received.operations[0]!.props!.asyncFn as Function;
      const result = await asyncFn(5);
      expect(result).toBe(10);
    });

    test('should handle function that throws', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              throwFn: () => {
                throw new Error('Intentional error');
              },
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies error-throwing function
      const throwFn = received.operations[0]!.props!.throwFn as Function;
      // Sync errors are caught to prevent Host crashes, returning undefined
      expect(throwFn()).toBeUndefined();
    });
  });

  describe('UPDATE Operation', () => {
    test('should handle UPDATE with removedProps', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'UPDATE',
            id: 1,
            props: { newProp: 'value' },
            removedProps: ['oldProp1', 'oldProp2'],
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const op = received.operations[0]!;
      expect(op.op).toBe('UPDATE');
      expect(op.props?.newProp).toBe('value');
      expect(op.removedProps).toEqual(['oldProp1', 'oldProp2']);
    });
  });

  describe('Multiple Operations', () => {
    test('should handle batch with multiple operations', () => {
      let count = 0;
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: { style: { flex: 1 } } },
          {
            op: 'CREATE',
            id: 2,
            type: 'Button',
            props: {
              onPress: () => ++count,
            },
          },
          { op: 'APPEND', id: 3, parentId: 1, childId: 2 },
          { op: 'UPDATE', id: 1, props: { style: { flex: 2 } } },
          { op: 'DELETE', id: 99 },
        ],
      };

      bridge.sendRawBatch(batch);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0]!.operations.length).toBe(5);

      // Verify function in CREATE was decoded
      const buttonOp = hostReceived[0]!.operations[1]!;
      expect(typeof buttonOp.props?.onPress).toBe('function');
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies function callback
      (buttonOp.props!.onPress as Function)();
      expect(count).toBe(1);
    });
  });
});
