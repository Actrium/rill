/**
 * @rill/runtime/bridge - Bridge Tests
 *
 * Tests for the unified communication layer with automatic serialization.
 *
 * Key principles:
 * - Bridge exposes sendRawBatch/sendSerializedBatch/sendBinaryBatch/sendJsonBatch and sendToGuest()
 * - All serialization/deserialization happens internally
 * - JSI-safe types pass through with zero overhead
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry, HostMsg } from '..';
import type { HostMessage, OperationBatch } from '..';
import { Bridge } from './bridge';

describe('Bridge - Unified Communication Layer', () => {
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
      onHostMessage: (message) => {
        guestReceived.push(message);
      },
      debug: false,
    });
  });

  describe('Public API', () => {
    test('should have send methods', () => {
      expect(typeof bridge.sendRawBatch).toBe('function');
      expect(typeof bridge.sendSerializedBatch).toBe('function');
      expect(typeof bridge.sendBinaryBatch).toBe('function');
      expect(typeof bridge.sendJsonBatch).toBe('function');
      expect(typeof bridge.sendToGuest).toBe('function');
    });
  });

  describe('sendRawBatch - Guest → Host', () => {
    test('should send batch with primitive props', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { style: { flex: 1 }, testID: 'test' },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0]!.version).toBe(1);
      expect(hostReceived[0]!.batchId).toBe(1);
      expect(hostReceived[0]!.operations[0]!.props!.style).toEqual({ flex: 1 });
      expect(hostReceived[0]!.operations[0]!.props!.testID).toBe('test');
    });

    test('should automatically encode functions in props', () => {
      let called = false;
      const onPress = () => {
        called = true;
        return 'clicked';
      };

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'TouchableOpacity',
            props: { onPress },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      // Host receives decoded data - onPress is a callable proxy
      const received = hostReceived[0]!;
      const receivedOnPress = received.operations[0]!.props!.onPress;

      expect(typeof receivedOnPress).toBe('function');
      expect(called).toBe(false);

      // Calling the proxy should invoke the original function
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies function callback
      const result = (receivedOnPress as Function)();
      expect(called).toBe(true);
      expect(result).toBe('clicked');
    });

    test('should encode Date objects', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'DatePicker',
            props: { value: date },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const receivedDate = hostReceived[0]!.operations[0]!.props!.value;
      expect(receivedDate instanceof Date).toBe(true);
      expect((receivedDate as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    test('should handle nested props with functions', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'Form',
            props: {
              handlers: {
                onSubmit: () => 'submitted',
                onReset: () => 'reset',
              },
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies function callbacks
      const handlers = hostReceived[0]!.operations[0]!.props!.handlers as Record<string, Function>;
      expect(typeof handlers.onSubmit).toBe('function');
      expect(typeof handlers.onReset).toBe('function');
      expect(handlers.onSubmit()).toBe('submitted');
      expect(handlers.onReset()).toBe('reset');
    });
  });

  describe('sendToGuest - Host → Guest', () => {
    test('should send CALL_FUNCTION message', async () => {
      const fnId = registry.register(() => 'result');

      const message: HostMessage = {
        type: HostMsg.CALL_FUNCTION,
        fnId,
        args: [1, 2, 'three'],
      };

      await bridge.sendToGuest(message);

      expect(guestReceived.length).toBe(1);
      expect(guestReceived[0]!.type).toBe('CALL_FUNCTION');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).fnId).toBe(fnId);
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).args).toEqual([1, 2, 'three']);
    });

    test('should send HOST_EVENT message', async () => {
      const message: HostMessage = {
        type: HostMsg.HOST_EVENT,
        eventName: 'onVisibilityChange',
        payload: { visible: true },
      };

      await bridge.sendToGuest(message);

      expect(guestReceived.length).toBe(1);
      expect(guestReceived[0]!.type).toBe('HOST_EVENT');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).eventName).toBe('onVisibilityChange');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).payload).toEqual({ visible: true });
    });

    test('should send CONFIG_UPDATE message', async () => {
      const message: HostMessage = {
        type: HostMsg.CONFIG_UPDATE,
        config: { theme: 'dark', locale: 'en-US' },
      };

      await bridge.sendToGuest(message);

      expect(guestReceived.length).toBe(1);
      expect(guestReceived[0]!.type).toBe('CONFIG_UPDATE');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).config).toEqual({ theme: 'dark', locale: 'en-US' });
    });

    test('should send DESTROY message', async () => {
      const message: HostMessage = { type: HostMsg.DESTROY };

      await bridge.sendToGuest(message);

      expect(guestReceived.length).toBe(1);
      expect(guestReceived[0]!.type).toBe('DESTROY');
    });

    test('should decode serialized functions in args', async () => {
      let originalCalled = false;
      const fnId = registry.register(() => {
        originalCalled = true;
        return 'original-result';
      });

      const message: HostMessage = {
        type: HostMsg.CALL_FUNCTION,
        fnId: 'some-id',
        args: [{ __type: 'function' as const, __fnId: fnId }],
      };

      await bridge.sendToGuest(message);

      // The first arg should be decoded to a callable proxy
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      const args = (guestReceived[0] as any).args;
      expect(typeof args[0]).toBe('function');

      const result = args[0]();
      expect(originalCalled).toBe(true);
      expect(result).toBe('original-result');
    });
  });

  describe('Special Types - RegExp', () => {
    test('should encode and decode RegExp', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'Input',
            props: { pattern: /^[a-z]+$/gi },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const pattern = hostReceived[0]!.operations[0]!.props!.pattern;
      expect(pattern instanceof RegExp).toBe(true);
      expect((pattern as RegExp).source).toBe('^[a-z]+$');
      expect((pattern as RegExp).flags).toBe('gi');
    });
  });

  describe('Special Types - Error', () => {
    test('should encode and decode Error', () => {
      const error = new Error('Test error');
      error.name = 'CustomError';

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'UPDATE',
            id: 1,
            props: { lastError: error },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const lastError = hostReceived[0]!.operations[0]!.props!.lastError;
      expect(lastError instanceof Error).toBe(true);
      expect((lastError as Error).message).toBe('Test error');
      expect((lastError as Error).name).toBe('CustomError');
    });
  });

  describe('Special Types - Map', () => {
    test('should encode and decode Map', () => {
      const map = new Map<string, number>();
      map.set('a', 1);
      map.set('b', 2);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'MapView',
            props: { data: map },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const data = hostReceived[0]!.operations[0]!.props!.data;
      expect(data instanceof Map).toBe(true);
      expect((data as Map<string, number>).get('a')).toBe(1);
      expect((data as Map<string, number>).get('b')).toBe(2);
    });
  });

  describe('Special Types - Set', () => {
    test('should encode and decode Set', () => {
      const set = new Set<string>();
      set.add('x');
      set.add('y');

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'SetView',
            props: { items: set },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const items = hostReceived[0]!.operations[0]!.props!.items;
      expect(items instanceof Set).toBe(true);
      expect((items as Set<string>).has('x')).toBe(true);
      expect((items as Set<string>).has('y')).toBe(true);
    });
  });

  describe('Complete Flow - Roundtrip', () => {
    test('should handle a complete Guest → Host flow', () => {
      // Simulate reconciler creating elements
      let pressCount = 0;
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { style: { flex: 1 } },
          },
          {
            op: 'CREATE',
            id: 2,
            type: 'TouchableOpacity',
            props: {
              onPress: () => {
                pressCount++;
                return pressCount;
              },
            },
          },
          { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
          { op: 'APPEND', id: 2, parentId: 1, childId: 2 },
        ],
      };

      bridge.sendRawBatch(batch);

      // Verify batch structure
      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0]!.operations.length).toBe(4);

      // Verify function was decoded
      const touchableOp = hostReceived[0]!.operations[1]!;
      // biome-ignore lint/complexity/noBannedTypes: Test helper verifies function callback
      const onPress = touchableOp.props!.onPress as Function;
      expect(typeof onPress).toBe('function');

      // Simulate host calling the function
      expect(onPress()).toBe(1);
      expect(onPress()).toBe(2);
      expect(pressCount).toBe(2);
    });
  });

  describe('ArrayBuffer Support', () => {
    test('should pass ArrayBuffer from Guest to Host', () => {
      const buffer = new ArrayBuffer(8);
      const view = new Uint8Array(buffer);
      view[0] = 10;
      view[1] = 20;
      view[2] = 30;
      view[7] = 255;

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'ImageView',
            props: { imageData: buffer },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const receivedBuffer = received.operations[0]!.props!.imageData as ArrayBuffer;

      expect(receivedBuffer).toBeInstanceOf(ArrayBuffer);
      expect(receivedBuffer.byteLength).toBe(8);

      const receivedView = new Uint8Array(receivedBuffer);
      expect(receivedView[0]).toBe(10);
      expect(receivedView[1]).toBe(20);
      expect(receivedView[2]).toBe(30);
      expect(receivedView[7]).toBe(255);
    });

    test('should pass ArrayBuffer from Host to Guest', () => {
      const buffer = new ArrayBuffer(4);
      const view = new Uint8Array(buffer);
      view[0] = 100;
      view[1] = 101;
      view[2] = 102;
      view[3] = 103;

      bridge.sendToGuest({
        type: HostMsg.CONFIG_UPDATE,
        config: {
          binaryData: buffer,
          metadata: { type: 'binary' },
        },
      });

      const received = guestReceived[0]!;
      expect(received.type).toBe('CONFIG_UPDATE');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      const config = (received as any).config;
      const receivedBuffer = config.binaryData as ArrayBuffer;

      expect(receivedBuffer).toBeInstanceOf(ArrayBuffer);
      expect(receivedBuffer.byteLength).toBe(4);

      const receivedView = new Uint8Array(receivedBuffer);
      expect(Array.from(receivedView)).toEqual([100, 101, 102, 103]);
    });

    test('should handle nested ArrayBuffers in complex props', () => {
      const buffer1 = new ArrayBuffer(2);
      const buffer2 = new ArrayBuffer(3);
      new Uint8Array(buffer1)[0] = 50;
      new Uint8Array(buffer2)[0] = 75;

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'MediaView',
            props: {
              title: 'Test',
              media: {
                thumbnail: buffer1,
                fullImage: buffer2,
              },
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const receivedProps = received.operations[0]!.props!;

      expect(receivedProps.title).toBe('Test');
      expect(receivedProps.media.thumbnail).toBeInstanceOf(ArrayBuffer);
      expect(receivedProps.media.fullImage).toBeInstanceOf(ArrayBuffer);

      expect(new Uint8Array(receivedProps.media.thumbnail)[0]).toBe(50);
      expect(new Uint8Array(receivedProps.media.fullImage)[0]).toBe(75);
    });

    test('should handle ArrayBuffer in arrays', () => {
      const buffers = [
        (() => {
          const b = new ArrayBuffer(1);
          new Uint8Array(b)[0] = 1;
          return b;
        })(),
        (() => {
          const b = new ArrayBuffer(1);
          new Uint8Array(b)[0] = 2;
          return b;
        })(),
        (() => {
          const b = new ArrayBuffer(1);
          new Uint8Array(b)[0] = 3;
          return b;
        })(),
      ];

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'DataView',
            props: { buffers },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const receivedBuffers = received.operations[0]!.props!.buffers as ArrayBuffer[];

      expect(Array.isArray(receivedBuffers)).toBe(true);
      expect(receivedBuffers.length).toBe(3);

      receivedBuffers.forEach((buf, i) => {
        expect(buf).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(buf)[0]).toBe(i + 1);
      });
    });

    test('should handle empty ArrayBuffer', () => {
      const emptyBuffer = new ArrayBuffer(0);

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { data: emptyBuffer },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const receivedBuffer = received.operations[0]!.props!.data as ArrayBuffer;

      expect(receivedBuffer).toBeInstanceOf(ArrayBuffer);
      expect(receivedBuffer.byteLength).toBe(0);
    });

    test('should handle multiple references to same ArrayBuffer', () => {
      const buffer = new ArrayBuffer(4);
      new Uint8Array(buffer)[0] = 99;

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              buffer1: buffer,
              buffer2: buffer, // Same ArrayBuffer reference
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      const received = hostReceived[0]!;
      const props = received.operations[0]!.props!;

      expect(props.buffer1).toBeInstanceOf(ArrayBuffer);
      expect(props.buffer2).toBeInstanceOf(ArrayBuffer);

      // Both should have the same data
      expect(new Uint8Array(props.buffer1)[0]).toBe(99);
      expect(new Uint8Array(props.buffer2)[0]).toBe(99);
    });
  });

  describe('encodeBatch', () => {
    test('should track function IDs during batch encoding', () => {
      const onPress = () => 'clicked';
      const onLongPress = () => 'long pressed';

      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'TouchableOpacity',
            props: {
              onPress,
              onLongPress,
              style: { flex: 1 },
            },
          },
        ],
      };

      const result = bridge.encodeBatch(batch);

      // Should return serialized batch and fnIds
      expect(result.serialized).toBeDefined();
      expect(result.fnIds).toBeInstanceOf(Set);
      expect(result.fnIds.size).toBe(2);

      // Function IDs should be tracked
      const fnIdArray = Array.from(result.fnIds);
      expect(fnIdArray.every((id) => typeof id === 'string')).toBe(true);
      expect(fnIdArray.every((id) => id.startsWith('fn_'))).toBe(true);
    });

    test('should track nested function IDs', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'Form',
            props: {
              handlers: {
                onSubmit: () => 'submitted',
                onCancel: () => 'cancelled',
              },
              validators: [() => true, () => false],
            },
          },
        ],
      };

      const result = bridge.encodeBatch(batch);

      expect(result.fnIds.size).toBe(4); // 2 in handlers + 2 in validators array
    });

  });

  describe('Promise Support', () => {
    test('should send Promise resolve result', async () => {
      const promise = Promise.resolve('test-value');
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'AsyncComponent',
            props: { asyncData: promise },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      // Wait for promise to settle and result to be sent
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have sent PROMISE_RESOLVE message
      expect(guestReceived.length).toBeGreaterThan(0);
      const resolveMsg = guestReceived.find((msg) => msg.type === 'PROMISE_RESOLVE');
      expect(resolveMsg).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((resolveMsg as any).value).toBe('test-value');
    });

    test('should handle PROMISE_RESOLVE message from Guest', async () => {
      const message: HostMessage = {
        type: HostMsg.PROMISE_RESOLVE,
        promiseId: 'p_123',
        value: { result: 'success' },
      };

      await bridge.sendToGuest(message);

      expect(guestReceived.length).toBe(1);
      expect(guestReceived[0]!.type).toBe('PROMISE_RESOLVE');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).promiseId).toBe('p_123');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).value).toEqual({ result: 'success' });
    });

    test('should handle PROMISE_REJECT message from Guest', async () => {
      const message: HostMessage = {
        type: HostMsg.PROMISE_REJECT,
        promiseId: 'p_456',
        error: {
          __type: 'error',
          __name: 'ValidationError',
          __message: 'Invalid input',
          __stack: 'stack trace',
        },
      };

      await bridge.sendToGuest(message);

      expect(guestReceived.length).toBe(1);
      expect(guestReceived[0]!.type).toBe('PROMISE_REJECT');
      // biome-ignore lint/suspicious/noExplicitAny: Test message has dynamic structure
      expect((guestReceived[0] as any).promiseId).toBe('p_456');
    });
  });

  describe('Callback Lifecycle', () => {
    test('should release callback from registry', () => {
      const fn = () => 'test';
      const fnId = registry.register(fn);

      expect(registry.has(fnId)).toBe(true);

      bridge.releaseCallback(fnId);

      expect(registry.has(fnId)).toBe(false);
    });

    test('should route callback release to guest if not in host registry', () => {
      let guestReleaseCalled = false;
      let releasedFnId = '';

      const bridgeWithGuestRelease = new Bridge({
        callbackRegistry: registry,
        onGuestOperations: () => {},
        onHostMessage: () => {},
        guestReleaseCallback: (fnId) => {
          guestReleaseCalled = true;
          releasedFnId = fnId;
        },
      });

      bridgeWithGuestRelease.releaseCallback('fn_guest_123');

      expect(guestReleaseCalled).toBe(true);
      expect(releasedFnId).toBe('fn_guest_123');
    });
  });

  describe('sendJsonBatch - structural validation at trust boundary', () => {
    test('accepts a well-formed JSON batch', () => {
      const json = JSON.stringify({
        version: 1,
        batchId: 1,
        operations: [{ op: 'CREATE', id: 1, type: 'View', props: {} }],
      });
      bridge.sendJsonBatch(json);
      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0]!.operations[0]!.op).toBe('CREATE');
    });

    test('rejects non-object payloads', () => {
      expect(() => bridge.sendJsonBatch('42')).toThrow(/expected a batch object/);
      expect(() => bridge.sendJsonBatch('null')).toThrow(/expected a batch object/);
      expect(() => bridge.sendJsonBatch('[]')).toThrow(/expected a batch object/);
    });

    test('rejects batches without an operations array', () => {
      expect(() => bridge.sendJsonBatch('{"version":1}')).toThrow(/operations must be an array/);
      expect(() => bridge.sendJsonBatch('{"operations":{}}')).toThrow(
        /operations must be an array/
      );
    });

    test('rejects operations with unknown or missing op discriminant', () => {
      expect(() => bridge.sendJsonBatch('{"operations":[{"id":1}]}')).toThrow(
        /not a known operation type/
      );
      expect(() => bridge.sendJsonBatch('{"operations":[{"op":"EVIL","id":1}]}')).toThrow(
        /not a known operation type/
      );
      expect(() => bridge.sendJsonBatch('{"operations":[null]}')).toThrow(/must be an object/);
    });
  });

  describe('Lifecycle', () => {
    test('should clean up resources on destroy', () => {
      const fn = () => 'test';
      registry.register(fn);

      bridge.destroy();

      expect(registry.size).toBe(0);
    });
  });
});
