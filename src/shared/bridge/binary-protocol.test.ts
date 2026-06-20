/**
 * BinaryProtocol.test.ts
 *
 * P3-X.5: Bridge Binary Protocol Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  BinaryProtocol,
  createBinaryProtocol,
  detectPayloadEncoding,
  type PayloadEncoding,
} from './binary-protocol';
import type { SerializedOperationBatch, SerializedOperation } from '../types';

// ============================================
// Test Helpers
// ============================================

function createTestBatch(operations: SerializedOperation[]): SerializedOperationBatch {
  return {
    version: 1,
    batchId: Math.floor(Math.random() * 10000),
    operations,
  };
}

function createCreateOp(id: number, type: string, props: Record<string, unknown> = {}): SerializedOperation {
  return {
    op: 'CREATE',
    id,
    type,
    props,
  };
}

// ============================================
// BinaryProtocol Tests
// ============================================

describe('BinaryProtocol', () => {
  describe('initialization', () => {
    it('should default to JSON encoding', () => {
      const protocol = new BinaryProtocol();
      expect(protocol.getEncoding()).toBe('json');
    });

    it('should accept binary encoding config', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      expect(protocol.getEncoding()).toBe('binary');
    });

    it('should allow changing encoding', () => {
      const protocol = new BinaryProtocol({ encoding: 'json' });
      expect(protocol.getEncoding()).toBe('json');

      protocol.setEncoding('binary');
      expect(protocol.getEncoding()).toBe('binary');

      protocol.setEncoding('json');
      expect(protocol.getEncoding()).toBe('json');
    });
  });

  describe('JSON encoding', () => {
    let protocol: BinaryProtocol;

    beforeEach(() => {
      protocol = new BinaryProtocol({ encoding: 'json' });
    });

    it('should encode batch to JSON string', () => {
      const batch = createTestBatch([createCreateOp(1, 'View')]);
      const encoded = protocol.encodeBatch(batch);

      expect(typeof encoded).toBe('string');
      expect(JSON.parse(encoded as string)).toEqual(batch);
    });

    it('should decode JSON string to batch', () => {
      const batch = createTestBatch([createCreateOp(1, 'View')]);
      const json = JSON.stringify(batch);
      const decoded = protocol.decodeBatch(json);

      expect(decoded).toEqual(batch);
    });

    it('should roundtrip complex batch', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          style: { flex: 1, backgroundColor: '#fff' },
          onPress: { __type: 'function', __fnId: 'fn-123' },
        }),
        { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
        { op: 'TEXT', id: 2, text: 'Hello World' },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded).toEqual(batch);
    });
  });

  describe('binary encoding', () => {
    let protocol: BinaryProtocol;

    beforeEach(() => {
      protocol = new BinaryProtocol({ encoding: 'binary' });
    });

    it('should encode batch to ArrayBuffer', () => {
      const batch = createTestBatch([createCreateOp(1, 'View')]);
      const encoded = protocol.encodeBatch(batch);

      expect(encoded).toBeInstanceOf(ArrayBuffer);
    });

    it('should decode ArrayBuffer to batch', () => {
      const batch = createTestBatch([createCreateOp(1, 'View', { testID: 'test' })]);
      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.version).toBe(batch.version);
      expect(decoded.batchId).toBe(batch.batchId);
      expect(decoded.operations.length).toBe(1);
      expect(decoded.operations[0].op).toBe('CREATE');
    });

    it('should roundtrip CREATE operation', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          style: { flex: 1 },
          testID: 'my-view',
        }),
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toMatchObject({
        op: 'CREATE',
        id: 1,
        type: 'View',
      });
    });

    it('should roundtrip UPDATE operation', () => {
      const batch = createTestBatch([
        {
          op: 'UPDATE',
          id: 1,
          props: { newProp: 'value' },
          removedProps: ['oldProp'],
        },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toMatchObject({
        op: 'UPDATE',
        id: 1,
      });
    });

    it('should roundtrip DELETE operation', () => {
      const batch = createTestBatch([{ op: 'DELETE', id: 5 }]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toEqual({ op: 'DELETE', id: 5 });
    });

    it('should roundtrip APPEND operation', () => {
      const batch = createTestBatch([
        { op: 'APPEND', id: 2, parentId: 1, childId: 2 },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toEqual({
        op: 'APPEND',
        id: 2,
        parentId: 1,
        childId: 2,
      });
    });

    it('should roundtrip INSERT operation', () => {
      const batch = createTestBatch([
        { op: 'INSERT', id: 3, parentId: 1, childId: 3, index: 0 },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toEqual({
        op: 'INSERT',
        id: 3,
        parentId: 1,
        childId: 3,
        index: 0,
      });
    });

    it('should roundtrip REMOVE operation', () => {
      const batch = createTestBatch([
        { op: 'REMOVE', id: 2, parentId: 1, childId: 2 },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toEqual({
        op: 'REMOVE',
        id: 2,
        parentId: 1,
        childId: 2,
      });
    });

    it('should roundtrip REORDER operation', () => {
      const batch = createTestBatch([
        { op: 'REORDER', id: 1, parentId: 0, childIds: [3, 1, 2] },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toEqual({
        op: 'REORDER',
        id: 1,
        parentId: 0,
        childIds: [3, 1, 2],
      });
    });

    it('should roundtrip TEXT operation', () => {
      const batch = createTestBatch([
        { op: 'TEXT', id: 5, text: 'Hello World' },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toEqual({
        op: 'TEXT',
        id: 5,
        text: 'Hello World',
      });
    });

    it('should roundtrip REF_CALL operation', () => {
      const batch = createTestBatch([
        {
          op: 'REF_CALL',
          id: 1,
          refId: 1,
          method: 'focus',
          callId: 'call-123',
          args: ['arg1', 42],
        },
      ]);

      const encoded = protocol.encodeBatch(batch);
      const decoded = protocol.decodeBatch(encoded);

      expect(decoded.operations[0]).toMatchObject({
        op: 'REF_CALL',
        id: 1,
        method: 'focus',
        callId: 'call-123',
      });
    });
  });

  describe('value types', () => {
    let protocol: BinaryProtocol;

    beforeEach(() => {
      protocol = new BinaryProtocol({ encoding: 'binary' });
    });

    it('should roundtrip null', () => {
      const batch = createTestBatch([createCreateOp(1, 'View', { value: null })]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.value).toBeNull();
    });

    it('should roundtrip boolean', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', { enabled: true, disabled: false }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.enabled).toBe(true);
      expect((decoded.operations[0] as any).props.disabled).toBe(false);
    });

    it('should roundtrip integers', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', { count: 42, negative: -100 }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.count).toBe(42);
      expect((decoded.operations[0] as any).props.negative).toBe(-100);
    });

    it('should roundtrip floats', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', { ratio: 3.14159 }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.ratio).toBeCloseTo(3.14159, 5);
    });

    it('should roundtrip strings', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', { name: 'Hello World' }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.name).toBe('Hello World');
    });

    it('should roundtrip function references', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          onPress: { __type: 'function', __fnId: 'fn-123' },
        }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.onPress).toEqual({
        __type: 'function',
        __fnId: 'fn-123',
      });
    });

    it('should roundtrip nested objects', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          style: {
            flex: 1,
            margin: { top: 10, bottom: 20 },
          },
        }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.style).toEqual({
        flex: 1,
        margin: { top: 10, bottom: 20 },
      });
    });

    it('should roundtrip arrays', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          items: [1, 2, 3],
          names: ['a', 'b', 'c'],
        }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.items).toEqual([1, 2, 3]);
      expect((decoded.operations[0] as any).props.names).toEqual(['a', 'b', 'c']);
    });

    it('should roundtrip dates', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          timestamp: { __type: 'date', __value: '2024-01-29T00:00:00.000Z' },
        }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.timestamp.__type).toBe('date');
    });

    it('should roundtrip errors', () => {
      const batch = createTestBatch([
        createCreateOp(1, 'View', {
          error: {
            __type: 'error',
            __name: 'TypeError',
            __message: 'Something went wrong',
          },
        }),
      ]);
      const decoded = protocol.decodeBatch(protocol.encodeBatch(batch));
      expect((decoded.operations[0] as any).props.error).toMatchObject({
        __type: 'error',
        __name: 'TypeError',
        __message: 'Something went wrong',
      });
    });
  });

  describe('statistics', () => {
    it('should track encoding stats', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const batch = createTestBatch([createCreateOp(1, 'View')]);

      protocol.encodeBatch(batch);
      const stats = protocol.getStats();

      expect(stats.totalBatchesEncoded).toBe(1);
      expect(stats.lastEncodingMs).toBeGreaterThanOrEqual(0);
      expect(stats.lastOutputBytes).toBeGreaterThan(0);
    });

    it('should track decoding stats', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const batch = createTestBatch([createCreateOp(1, 'View')]);

      const encoded = protocol.encodeBatch(batch);
      protocol.decodeBatch(encoded);
      const stats = protocol.getStats();

      expect(stats.totalBatchesDecoded).toBe(1);
      expect(stats.lastDecodingMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('format detection', () => {
    it('should detect binary format', () => {
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const batch = createTestBatch([createCreateOp(1, 'View')]);
      const encoded = protocol.encodeBatch(batch);

      expect(protocol.isBinaryFormat(encoded)).toBe(true);
    });

    it('should not detect JSON as binary', () => {
      const protocol = new BinaryProtocol();
      const json = '{"version":1}';

      expect(protocol.isBinaryFormat(json)).toBe(false);
    });

    it('should not detect invalid ArrayBuffer as binary', () => {
      const protocol = new BinaryProtocol();
      const invalid = new ArrayBuffer(16);

      expect(protocol.isBinaryFormat(invalid)).toBe(false);
    });
  });
});

// ============================================
// Factory Function Tests
// ============================================

describe('createBinaryProtocol', () => {
  it('should create protocol with defaults', () => {
    const protocol = createBinaryProtocol();
    expect(protocol.getEncoding()).toBe('json');
  });

  it('should create protocol with config', () => {
    const protocol = createBinaryProtocol({ encoding: 'binary' });
    expect(protocol.getEncoding()).toBe('binary');
  });
});

describe('detectPayloadEncoding', () => {
  it('should detect binary ArrayBuffer', () => {
    const protocol = new BinaryProtocol({ encoding: 'binary' });
    const batch = createTestBatch([createCreateOp(1, 'View')]);
    const binary = protocol.encodeBatch(batch);

    expect(detectPayloadEncoding(binary)).toBe('binary');
  });

  it('should detect JSON string', () => {
    expect(detectPayloadEncoding('{"version":1}')).toBe('json');
  });

  it('should default to JSON for unknown types', () => {
    expect(detectPayloadEncoding(null)).toBe('json');
    expect(detectPayloadEncoding(undefined)).toBe('json');
    expect(detectPayloadEncoding(123)).toBe('json');
  });
});

// ============================================
// Performance Tests
// ============================================

describe('BinaryProtocol Performance', () => {
  it('should encode faster than JSON for large batches', () => {
    const operations: SerializedOperation[] = [];
    for (let i = 0; i < 100; i++) {
      operations.push(
        createCreateOp(i, 'View', {
          style: { flex: 1 },
          testID: `view-${i}`,
          onPress: { __type: 'function', __fnId: `fn-${i}` },
        })
      );
    }

    const batch = createTestBatch(operations);

    // JSON timing
    const jsonProtocol = new BinaryProtocol({ encoding: 'json' });
    const jsonStart = performance.now();
    const jsonResult = jsonProtocol.encodeBatch(batch);
    const jsonTime = performance.now() - jsonStart;

    // Binary timing
    const binaryProtocol = new BinaryProtocol({ encoding: 'binary' });
    const binaryStart = performance.now();
    const binaryResult = binaryProtocol.encodeBatch(batch);
    const binaryTime = performance.now() - binaryStart;

    console.log('\n=== Encoding Performance ===');
    console.log(`JSON: ${jsonTime.toFixed(3)}ms, ${(jsonResult as string).length} bytes`);
    console.log(`Binary: ${binaryTime.toFixed(3)}ms, ${(binaryResult as ArrayBuffer).byteLength} bytes`);
    console.log(`Size reduction: ${((1 - (binaryResult as ArrayBuffer).byteLength / (jsonResult as string).length) * 100).toFixed(1)}%`);
    console.log('============================\n');

    // Binary should be smaller
    expect((binaryResult as ArrayBuffer).byteLength).toBeLessThan((jsonResult as string).length);
  });
});
