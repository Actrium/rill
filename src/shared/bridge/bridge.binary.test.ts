/**
 * Bridge.binary.test.ts
 *
 * M5-A: Bridge Binary Protocol Integration Tests
 *
 * Tests that Bridge.sendBinaryBatch() correctly handles ArrayBuffer input
 * from the binary encoding path (Guest binary → Host decoded).
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry } from '..';
import type { HostMessage, OperationBatch, SerializedOperationBatch } from '..';
import { Bridge } from './bridge';
import { BinaryProtocol } from './binary-protocol';

describe('Bridge - Binary Protocol Integration', () => {
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
      binaryProtocol: { encoding: 'binary' },
    });
  });

  describe('sendToHost with ArrayBuffer', () => {
    test('should decode binary ArrayBuffer and deliver OperationBatch', () => {
      // Encode a batch to binary (simulating Guest-side BinaryEncoder)
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 42,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: { style: 'flex:1' } },
          { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
        ],
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      // Send binary to bridge
      bridge.sendBinaryBatch(binary);

      // Verify host received decoded batch
      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0].batchId).toBe(42);
      expect(hostReceived[0].operations.length).toBe(2);
      expect(hostReceived[0].operations[0].op).toBe('CREATE');
      expect(hostReceived[0].operations[1].op).toBe('APPEND');
    });

    test('should decode binary with function props', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 10,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'Button',
            props: {
              onPress: { __type: 'function', __fnId: 'fn-99' },
              title: 'Click me',
            },
          },
        ],
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      bridge.sendBinaryBatch(binary);

      expect(hostReceived.length).toBe(1);
      const op = hostReceived[0].operations[0];
      expect(op.op).toBe('CREATE');
      // After decode, function props should be decoded (fnId → proxy or raw)
      expect(op).toHaveProperty('props');
    });

    test('should decode binary TEXT operation', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 20,
        operations: [
          { op: 'TEXT', id: 5, text: 'Hello World' },
        ],
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      bridge.sendBinaryBatch(binary);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0].operations[0].op).toBe('TEXT');
      expect((hostReceived[0].operations[0] as any).text).toBe('Hello World');
    });

    test('should decode binary DELETE operation', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 30,
        operations: [
          { op: 'DELETE', id: 7 },
        ],
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      bridge.sendBinaryBatch(binary);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0].operations[0]).toMatchObject({ op: 'DELETE', id: 7 });
    });

    test('should auto-create BinaryProtocol when not configured', () => {
      // Bridge without explicit binaryProtocol config
      const plainBridge = new Bridge({
        callbackRegistry: new CallbackRegistry(),
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: () => {},
      });

      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 99,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: {} },
        ],
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      // Should still work — auto-creates BinaryProtocol
      hostReceived = [];
      plainBridge.sendBinaryBatch(binary);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0].batchId).toBe(99);
    });
  });

  describe('sendRawBatch / sendSerializedBatch still work', () => {
    test('should handle OperationBatch (VM mode)', () => {
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { title: 'test' },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0].operations[0].op).toBe('CREATE');
    });

    test('should handle SerializedOperationBatch (WASM mode)', () => {
      const batch: SerializedOperationBatch = {
        version: 1,
        batchId: 2,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: {
              onPress: { __type: 'function', __fnId: 'fn-1' },
            },
          },
        ],
      };

      bridge.sendSerializedBatch(batch);

      expect(hostReceived.length).toBe(1);
    });
  });

  describe('mixed encoding roundtrip', () => {
    test('should handle large binary batch', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const ops = [];
      for (let i = 0; i < 50; i++) {
        ops.push({
          op: 'CREATE' as const,
          id: i + 1,
          type: 'View',
          props: { index: i, label: `item-${i}` },
        });
      }
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 100,
        operations: ops,
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      bridge.sendBinaryBatch(binary);

      expect(hostReceived.length).toBe(1);
      expect(hostReceived[0].operations.length).toBe(50);
      expect(hostReceived[0].batchId).toBe(100);
    });
  });

  describe('destroy cleans up binary protocol', () => {
    test('should clear binary protocol state on destroy', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const serialized: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [{ op: 'CREATE', id: 1, type: 'View', props: {} }],
      };
      const binary = protocol.encodeBatch(serialized) as ArrayBuffer;

      bridge.sendBinaryBatch(binary);
      expect(hostReceived.length).toBe(1);

      // Destroy should not throw
      bridge.destroy();
    });
  });
});
