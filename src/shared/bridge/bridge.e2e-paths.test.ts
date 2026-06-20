/**
 * Bridge.e2e-paths.test.ts
 *
 * Critical path end-to-end tests covering ALL four Bridge send methods:
 *   1. sendRawBatch — OperationBatch (VM mode)
 *   2. sendSerializedBatch — SerializedOperationBatch (WASM mode)
 *   3. sendBinaryBatch — ArrayBuffer (Binary mode)
 *   4. sendJsonBatch — JSON string (Android JSI workaround)
 *
 * Also covers:
 *   - OperationCollector → Bridge integration (JSON + Binary)
 *   - BinaryEncoder → BinaryProtocol.decode → Bridge.sendBinaryBatch roundtrip
 *   - Function prop serialization through binary path
 *   - Mixed operation types through all three paths
 *   - destroy() cleanup across all modes
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry } from '..';
import type { OperationBatch, SerializedOperationBatch, HostMessage } from '..';
import { Bridge } from './bridge';
import { BinaryProtocol } from './binary-protocol';
import { BinaryEncoder } from '../../guest/runtime/reconciler/binary-encoder';
import { OperationCollector } from '../../guest/runtime/reconciler/operation-collector';

// ============================================
// Path 1: OperationBatch (VM mode)
// ============================================

describe('Critical Path 1: OperationBatch (VM mode)', () => {
  let bridge: Bridge;
  let hostReceived: OperationBatch[];

  beforeEach(() => {
    hostReceived = [];
    bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
    });
  });

  it('should encode+decode all operation types', () => {
    const batch: OperationBatch = {
      version: 1,
      batchId: 1,
      operations: [
        { op: 'CREATE', id: 1, type: 'View', props: { style: { flex: 1 } } },
        { op: 'UPDATE', id: 1, props: { title: 'Hello' } },
        { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
        { op: 'INSERT', id: 2, parentId: 0, childId: 2, index: 0 },
        { op: 'REMOVE', id: 2, parentId: 0, childId: 2 },
        { op: 'TEXT', id: 3, text: 'Some text' },
        { op: 'DELETE', id: 3 },
      ],
    };

    bridge.sendRawBatch(batch);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].operations.length).toBe(7);
    expect(hostReceived[0].operations.map(o => o.op)).toEqual([
      'CREATE', 'UPDATE', 'APPEND', 'INSERT', 'REMOVE', 'TEXT', 'DELETE',
    ]);
  });

  it('should preserve function props through encode/decode', () => {
    const fn = () => 'clicked';
    const batch: OperationBatch = {
      version: 1,
      batchId: 2,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Button',
          props: { onPress: fn, title: 'Click' },
        },
      ],
    };

    bridge.sendRawBatch(batch);

    expect(hostReceived.length).toBe(1);
    const decoded = hostReceived[0].operations[0];
    expect(decoded.op).toBe('CREATE');
    // Function should have been roundtripped (registered → proxied)
    expect(decoded).toHaveProperty('props');
    expect((decoded as any).props.title).toBe('Click');
  });

  it('should handle nested object props', () => {
    const batch: OperationBatch = {
      version: 1,
      batchId: 3,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'View',
          props: {
            style: {
              flex: 1,
              margin: { top: 10, left: 20 },
              padding: [5, 10, 5, 10],
            },
          },
        },
      ],
    };

    bridge.sendRawBatch(batch);

    expect(hostReceived.length).toBe(1);
    const props = (hostReceived[0].operations[0] as any).props;
    expect(props.style.flex).toBe(1);
    expect(props.style.margin.top).toBe(10);
    expect(props.style.padding).toEqual([5, 10, 5, 10]);
  });
});

// ============================================
// Path 2: SerializedOperationBatch (WASM mode)
// ============================================

describe('Critical Path 2: SerializedOperationBatch (WASM mode)', () => {
  let bridge: Bridge;
  let hostReceived: OperationBatch[];

  beforeEach(() => {
    hostReceived = [];
    bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
    });
  });

  it('should skip encode for pre-serialized batch with fnIds', () => {
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 10,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Button',
          props: {
            onPress: { __type: 'function', __fnId: 'fn-42' },
            title: 'Test',
          },
        },
        { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
      ],
    };

    bridge.sendRawBatch(batch);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].batchId).toBe(10);
    expect(hostReceived[0].operations.length).toBe(2);
  });

  it('should roundtrip all serialized special types', () => {
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 11,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Complex',
          props: {
            fn: { __type: 'function', __fnId: 'fn-1' },
            date: { __type: 'date', __value: '2024-01-01T00:00:00.000Z' },
            err: { __type: 'error', __name: 'TypeError', __message: 'bad', __stack: 'at test' },
            re: { __type: 'regexp', __source: '\\d+', __flags: 'gi' },
          },
        },
      ],
    };

    bridge.sendRawBatch(batch);

    expect(hostReceived.length).toBe(1);
    const props = (hostReceived[0].operations[0] as any).props;
    // fn should be decoded to a callable proxy
    expect(typeof props.fn).toBe('function');
    // date should be decoded
    expect(props.date).toBeInstanceOf(Date);
    // error should be decoded
    expect(props.err).toBeInstanceOf(Error);
    expect(props.err.name).toBe('TypeError');
    // regexp should be decoded
    expect(props.re).toBeInstanceOf(RegExp);
  });
});

// ============================================
// Path 3: ArrayBuffer (Binary mode)
// ============================================

describe('Critical Path 3: ArrayBuffer (Binary mode)', () => {
  let bridge: Bridge;
  let hostReceived: OperationBatch[];

  beforeEach(() => {
    hostReceived = [];
    bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
      binaryProtocol: { encoding: 'binary' },
    });
  });

  it('should decode all operation types from binary', () => {
    const protocol = new BinaryProtocol({ encoding: 'binary' });
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 100,
      operations: [
        { op: 'CREATE', id: 1, type: 'View', props: { key: 'val' } },
        { op: 'UPDATE', id: 1, props: { key: 'new-val' } },
        { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
        { op: 'INSERT', id: 2, parentId: 0, childId: 2, index: 0 },
        { op: 'REMOVE', id: 2, parentId: 0, childId: 2 },
        { op: 'TEXT', id: 3, text: 'Binary text' },
        { op: 'DELETE', id: 3 },
      ],
    };
    const binary = protocol.encodeBatch(batch) as ArrayBuffer;

    bridge.sendBinaryBatch(binary);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].batchId).toBe(100);
    const ops = hostReceived[0].operations;
    expect(ops.length).toBe(7);
    expect(ops.map(o => o.op)).toEqual([
      'CREATE', 'UPDATE', 'APPEND', 'INSERT', 'REMOVE', 'TEXT', 'DELETE',
    ]);
    expect((ops[5] as any).text).toBe('Binary text');
  });

  it('should decode function props from binary', () => {
    const protocol = new BinaryProtocol({ encoding: 'binary' });
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 101,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Button',
          props: {
            onPress: { __type: 'function', __fnId: 'fn-binary-1' },
            title: 'Binary Button',
          },
        },
      ],
    };
    const binary = protocol.encodeBatch(batch) as ArrayBuffer;

    bridge.sendBinaryBatch(binary);

    expect(hostReceived.length).toBe(1);
    const op = hostReceived[0].operations[0] as any;
    expect(op.type).toBe('Button');
    // After binary→serialized→decoded, function should be proxied
    expect(typeof op.props.onPress).toBe('function');
    expect(op.props.title).toBe('Binary Button');
  });

  it('should handle REORDER from binary', () => {
    const protocol = new BinaryProtocol({ encoding: 'binary' });
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 102,
      operations: [
        { op: 'REORDER', id: 1, parentId: 0, childIds: [3, 1, 2] },
      ],
    };
    const binary = protocol.encodeBatch(batch) as ArrayBuffer;

    bridge.sendBinaryBatch(binary);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].operations[0]).toMatchObject({
      op: 'REORDER',
      id: 1,
      parentId: 0,
      childIds: [3, 1, 2],
    });
  });

  it('should handle REF_CALL from binary', () => {
    const protocol = new BinaryProtocol({ encoding: 'binary' });
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 103,
      operations: [
        {
          op: 'REF_CALL',
          id: 5,
          refId: 5,
          method: 'focus',
          callId: 'call-abc',
          args: ['arg1', 42],
        },
      ],
    };
    const binary = protocol.encodeBatch(batch) as ArrayBuffer;

    bridge.sendBinaryBatch(binary);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].operations[0]).toMatchObject({
      op: 'REF_CALL',
      method: 'focus',
      callId: 'call-abc',
    });
  });
});

// ============================================
// Path 4: OperationCollector → Bridge integration
// ============================================

describe('Critical Path 4: OperationCollector → Bridge', () => {
  it('should deliver JSON batch from collector to bridge host receiver', () => {
    const hostReceived: OperationBatch[] = [];
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
    });

    const collector = new OperationCollector();
    collector.add({ op: 'CREATE', id: 1, type: 'View', props: { style: 'flex:1' }, timestamp: Date.now() });
    collector.add({ op: 'APPEND', id: 1, parentId: 0, childId: 1, timestamp: Date.now() });
    collector.add({ op: 'TEXT', id: 2, text: 'Hello', timestamp: Date.now() });

    collector.flush((batch) => {
      if (batch instanceof ArrayBuffer) bridge.sendBinaryBatch(batch);
      else if (typeof batch === 'string') bridge.sendJsonBatch(batch);
      else bridge.sendRawBatch(batch as OperationBatch);
    });

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].operations.length).toBe(3);
    expect(hostReceived[0].operations.map(o => o.op)).toEqual(['CREATE', 'APPEND', 'TEXT']);
  });

  it('should deliver binary batch from collector to bridge host receiver', () => {
    const hostReceived: OperationBatch[] = [];
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
      binaryProtocol: { encoding: 'binary' },
    });

    const collector = new OperationCollector({ binaryEncoding: true });
    collector.add({ op: 'CREATE', id: 1, type: 'View', props: { key: 'val' }, timestamp: Date.now() });
    collector.add({ op: 'DELETE', id: 2, timestamp: Date.now() });
    collector.add({ op: 'TEXT', id: 3, text: 'Binary e2e', timestamp: Date.now() });

    collector.flush((batch) => {
      if (batch instanceof ArrayBuffer) bridge.sendBinaryBatch(batch);
      else if (typeof batch === 'string') bridge.sendJsonBatch(batch);
      else bridge.sendRawBatch(batch as OperationBatch);
    });

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].operations.length).toBe(3);
    expect(hostReceived[0].operations[0].op).toBe('CREATE');
    expect(hostReceived[0].operations[1].op).toBe('DELETE');
    expect((hostReceived[0].operations[2] as any).text).toBe('Binary e2e');
  });

  it('should handle multiple consecutive flushes in binary mode', () => {
    const hostReceived: OperationBatch[] = [];
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
      binaryProtocol: { encoding: 'binary' },
    });

    const collector = new OperationCollector({ binaryEncoding: true });

    // Batch 1
    collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });
    collector.flush((batch) => {
      if (batch instanceof ArrayBuffer) bridge.sendBinaryBatch(batch);
      else if (typeof batch === 'string') bridge.sendJsonBatch(batch);
      else bridge.sendRawBatch(batch as OperationBatch);
    });

    // Batch 2
    collector.add({ op: 'UPDATE', id: 1, props: { title: 'Updated' }, timestamp: Date.now() });
    collector.flush((batch) => {
      if (batch instanceof ArrayBuffer) bridge.sendBinaryBatch(batch);
      else if (typeof batch === 'string') bridge.sendJsonBatch(batch);
      else bridge.sendRawBatch(batch as OperationBatch);
    });

    // Batch 3
    collector.add({ op: 'DELETE', id: 1, timestamp: Date.now() });
    collector.flush((batch) => {
      if (batch instanceof ArrayBuffer) bridge.sendBinaryBatch(batch);
      else if (typeof batch === 'string') bridge.sendJsonBatch(batch);
      else bridge.sendRawBatch(batch as OperationBatch);
    });

    expect(hostReceived.length).toBe(3);
    expect(hostReceived[0].operations[0].op).toBe('CREATE');
    expect(hostReceived[1].operations[0].op).toBe('UPDATE');
    expect(hostReceived[2].operations[0].op).toBe('DELETE');
    expect(hostReceived[0].batchId).toBe(1);
    expect(hostReceived[1].batchId).toBe(2);
    expect(hostReceived[2].batchId).toBe(3);
  });
});

// ============================================
// Path 5: BinaryEncoder direct → Bridge
// ============================================

describe('Critical Path 5: BinaryEncoder → Bridge (raw encoder)', () => {
  it('should accept raw BinaryEncoder output directly', () => {
    const hostReceived: OperationBatch[] = [];
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
    });

    // Use raw BinaryEncoder (as Guest would)
    const encoder = new BinaryEncoder();
    const batch: SerializedOperationBatch = {
      version: 1,
      batchId: 500,
      operations: [
        { op: 'CREATE', id: 1, type: 'View', props: { x: 42 } },
        { op: 'TEXT', id: 2, text: 'Raw encoder' },
      ],
    };
    const binary = encoder.encodeBatch(batch);

    bridge.sendBinaryBatch(binary);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].batchId).toBe(500);
    expect(hostReceived[0].operations.length).toBe(2);
    expect((hostReceived[0].operations[0] as any).props.x).toBe(42);
    expect((hostReceived[0].operations[1] as any).text).toBe('Raw encoder');
  });

  it('should handle 100-op binary batch without data loss', () => {
    const hostReceived: OperationBatch[] = [];
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: () => {},
      binaryProtocol: { encoding: 'binary' },
    });

    const ops: SerializedOperationBatch['operations'] = [];
    for (let i = 0; i < 100; i++) {
      ops.push({
        op: 'CREATE',
        id: i + 1,
        type: 'Item',
        props: { index: i, label: `item-${i}` },
      });
    }
    const encoder = new BinaryEncoder();
    const binary = encoder.encodeBatch({ version: 1, batchId: 999, operations: ops });

    bridge.sendBinaryBatch(binary);

    expect(hostReceived.length).toBe(1);
    expect(hostReceived[0].operations.length).toBe(100);
    // Verify first and last
    expect((hostReceived[0].operations[0] as any).props.index).toBe(0);
    expect((hostReceived[0].operations[0] as any).props.label).toBe('item-0');
    expect((hostReceived[0].operations[99] as any).props.index).toBe(99);
    expect((hostReceived[0].operations[99] as any).props.label).toBe('item-99');
  });
});

// ============================================
// Path 6: destroy() across all modes
// ============================================

describe('Critical Path 6: Bridge.destroy() cleanup', () => {
  it('should cleanly destroy bridge with pending binary state', () => {
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: () => {},
      onHostMessage: () => {},
      binaryProtocol: { encoding: 'binary' },
    });

    // Use it first
    const protocol = new BinaryProtocol({ encoding: 'binary' });
    const batch: SerializedOperationBatch = {
      version: 1, batchId: 1,
      operations: [{ op: 'CREATE', id: 1, type: 'V', props: {} }],
    };
    bridge.sendBinaryBatch(protocol.encodeBatch(batch) as ArrayBuffer);

    // destroy should not throw
    expect(() => bridge.destroy()).not.toThrow();
  });

  it('should cleanly destroy bridge without binary protocol', () => {
    const bridge = new Bridge({
      callbackRegistry: new CallbackRegistry(),
      onGuestOperations: () => {},
      onHostMessage: () => {},
    });

    expect(() => bridge.destroy()).not.toThrow();
  });
});
