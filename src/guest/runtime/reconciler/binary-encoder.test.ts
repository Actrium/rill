/**
 * binary-encoder.test.ts
 *
 * P3-X.T: Binary Encoder Tests (TypeScript side)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { BinaryEncoder, createBinaryEncoder, encodeBatchToBinary } from './binary-encoder';
import type { SerializedOperationBatch, SerializedOperation } from '../../../shared/types';

// ============================================
// Constants (must match InstructionFormat.h)
// ============================================

const RILL_MAGIC = 0x4c4c4952;
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 16;

// ============================================
// Helper Functions
// ============================================

function readU32LE(buffer: ArrayBuffer, offset: number): number {
  return new DataView(buffer).getUint32(offset, true);
}

function readU16LE(buffer: ArrayBuffer, offset: number): number {
  return new DataView(buffer).getUint16(offset, true);
}

function createTestBatch(operations: SerializedOperation[]): SerializedOperationBatch {
  return {
    version: 1,
    batchId: 1,
    operations,
  };
}

// ============================================
// Basic Encoding Tests
// ============================================

describe('BinaryEncoder', () => {
  let encoder: BinaryEncoder;

  beforeEach(() => {
    encoder = new BinaryEncoder();
  });

  describe('header encoding', () => {
    it('should encode magic number correctly', () => {
      const batch = createTestBatch([]);
      const binary = encoder.encodeBatch(batch);

      expect(binary.byteLength).toBeGreaterThanOrEqual(HEADER_SIZE);
      expect(readU32LE(binary, 0)).toBe(RILL_MAGIC);
    });

    it('should encode version correctly', () => {
      const batch = createTestBatch([]);
      const binary = encoder.encodeBatch(batch);

      expect(readU16LE(binary, 4)).toBe(PROTOCOL_VERSION);
    });

    it('should encode batchId correctly', () => {
      const batch: SerializedOperationBatch = {
        version: 1,
        batchId: 12345,
        operations: [],
      };
      const binary = encoder.encodeBatch(batch);

      expect(readU32LE(binary, 6)).toBe(12345);
    });

    it('should encode opCount correctly', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: {} },
        { op: 'CREATE', id: 2, type: 'Text', props: {} },
      ]);
      const binary = encoder.encodeBatch(batch);

      expect(readU16LE(binary, 10)).toBe(2);
    });
  });

  describe('CREATE operation', () => {
    it('should encode CREATE with empty props', () => {
      const batch = createTestBatch([{ op: 'CREATE', id: 1, type: 'View', props: {} }]);

      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode CREATE with string props', () => {
      const batch = createTestBatch([
        {
          op: 'CREATE',
          id: 1,
          type: 'View',
          props: {
            testID: 'my-view',
            accessibilityLabel: 'My View',
          },
        },
      ]);

      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode CREATE with nested object props', () => {
      const batch = createTestBatch([
        {
          op: 'CREATE',
          id: 1,
          type: 'View',
          props: {
            style: {
              flex: 1,
              backgroundColor: '#ffffff',
            },
          },
        },
      ]);

      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode CREATE with function props', () => {
      const batch = createTestBatch([
        {
          op: 'CREATE',
          id: 1,
          type: 'View',
          props: {
            onPress: { __type: 'function', __fnId: 'fn-123' },
          },
        },
      ]);

      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });
  });

  describe('UPDATE operation', () => {
    it('should encode UPDATE with props', () => {
      const batch = createTestBatch([
        {
          op: 'UPDATE',
          id: 1,
          props: { newProp: 'value' },
        },
      ]);

      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode UPDATE with removedProps', () => {
      const batch = createTestBatch([
        {
          op: 'UPDATE',
          id: 1,
          props: { newProp: 'value' },
          removedProps: ['oldProp1', 'oldProp2'],
        },
      ]);

      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });
  });

  describe('structural operations', () => {
    it('should encode DELETE', () => {
      const batch = createTestBatch([{ op: 'DELETE', id: 5 }]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });

    it('should encode APPEND', () => {
      const batch = createTestBatch([{ op: 'APPEND', id: 2, parentId: 1, childId: 2 }]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });

    it('should encode INSERT', () => {
      const batch = createTestBatch([{ op: 'INSERT', id: 3, parentId: 1, childId: 3, index: 0 }]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });

    it('should encode REMOVE', () => {
      const batch = createTestBatch([{ op: 'REMOVE', id: 2, parentId: 1, childId: 2 }]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });

    it('should encode REORDER', () => {
      const batch = createTestBatch([{ op: 'REORDER', id: 1, parentId: 0, childIds: [3, 1, 2] }]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });

    it('should encode TEXT', () => {
      const batch = createTestBatch([{ op: 'TEXT', id: 5, text: 'Hello World' }]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });

    it('should encode REF_CALL', () => {
      const batch = createTestBatch([
        {
          op: 'REF_CALL',
          id: 1,
          refId: 1,
          method: 'focus',
          callId: 'call-123',
          args: [],
        },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(readU16LE(binary, 10)).toBe(1);
    });
  });

  describe('string interning', () => {
    it('should intern repeated strings', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: { style: 'flex:1' } },
        { op: 'CREATE', id: 2, type: 'View', props: { style: 'flex:2' } },
        { op: 'CREATE', id: 3, type: 'View', props: { style: 'flex:3' } },
      ]);

      const binary = encoder.encodeBatch(batch);
      const stats = encoder.getStats();

      // "View" and "style" should be interned once, reused 3 times
      expect(stats.internHitRate).toBeGreaterThan(0);
    });

    it('should persist intern table across batches when configured', () => {
      const encoder = new BinaryEncoder({ persistentIntern: true });

      // First batch
      const batch1 = createTestBatch([{ op: 'CREATE', id: 1, type: 'View', props: {} }]);
      encoder.encodeBatch(batch1);
      const size1 = encoder.getInternTableSize();

      // Second batch with same string
      const batch2 = createTestBatch([{ op: 'CREATE', id: 2, type: 'View', props: {} }]);
      encoder.encodeBatch(batch2);
      const size2 = encoder.getInternTableSize();

      // Intern table should not grow
      expect(size2).toBe(size1);
    });

    it('should clear intern table when not persistent', () => {
      const encoder = new BinaryEncoder({ persistentIntern: false });

      const batch1 = createTestBatch([{ op: 'CREATE', id: 1, type: 'View', props: {} }]);
      encoder.encodeBatch(batch1);

      const batch2 = createTestBatch([{ op: 'CREATE', id: 2, type: 'Text', props: {} }]);
      encoder.encodeBatch(batch2);

      // Each batch starts fresh
      const stats = encoder.getStats();
      expect(stats.internedStrings).toBeGreaterThan(0);
    });
  });

  describe('value types', () => {
    it('should encode null', () => {
      const batch = createTestBatch([{ op: 'CREATE', id: 1, type: 'View', props: { value: null } }]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode boolean', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: { enabled: true, disabled: false } },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode integers', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: { count: 42, negative: -100 } },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode floats', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: { ratio: 3.14159, small: 0.001 } },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode arrays', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: { items: [1, 2, 3], names: ['a', 'b'] } },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode dates', () => {
      const batch = createTestBatch([
        {
          op: 'CREATE',
          id: 1,
          type: 'View',
          props: {
            timestamp: { __type: 'date', __value: '2024-01-29T00:00:00.000Z' },
          },
        },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });

    it('should encode errors', () => {
      const batch = createTestBatch([
        {
          op: 'CREATE',
          id: 1,
          type: 'View',
          props: {
            error: { __type: 'error', __name: 'Error', __message: 'Something went wrong' },
          },
        },
      ]);
      const binary = encoder.encodeBatch(batch);
      expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
    });
  });

  describe('statistics', () => {
    it('should track encoding stats', () => {
      const batch = createTestBatch([
        { op: 'CREATE', id: 1, type: 'View', props: { style: 'flex:1' } },
        { op: 'CREATE', id: 2, type: 'Text', props: { children: 'Hello' } },
      ]);

      const binary = encoder.encodeBatch(batch);
      const stats = encoder.getStats();

      expect(stats.operationCount).toBe(2);
      expect(stats.outputBytes).toBe(binary.byteLength);
      expect(stats.encodingMs).toBeGreaterThanOrEqual(0);
      expect(stats.internedStrings).toBeGreaterThan(0);
      expect(stats.compressionRatio).toBeLessThanOrEqual(1);
    });
  });
});

// ============================================
// Performance Benchmark Tests
// ============================================

describe('BinaryEncoder Performance', () => {
  it('should encode 100 CREATE operations efficiently', () => {
    const operations: SerializedOperation[] = [];
    for (let i = 0; i < 100; i++) {
      operations.push({
        op: 'CREATE',
        id: i,
        type: 'View',
        props: {
          style: { flex: 1, backgroundColor: '#ffffff' },
          testID: `view-${i}`,
          onPress: { __type: 'function', __fnId: `fn-${i}` },
        },
      });
    }

    const batch = createTestBatch(operations);
    const encoder = new BinaryEncoder();

    // Warm up
    encoder.encodeBatch(batch);
    encoder.clearInternTable();

    // Benchmark
    const start = performance.now();
    const binary = encoder.encodeBatch(batch);
    const elapsed = performance.now() - start;

    const stats = encoder.getStats();

    console.log('\n=== TS Binary Encoder Benchmark ===');
    console.log(`Operations: 100 CREATE`);
    console.log(`Encoding time: ${elapsed.toFixed(3)} ms`);
    console.log(`Output size: ${binary.byteLength} bytes`);
    console.log(`Estimated JSON size: ${stats.inputEstimatedBytes} bytes`);
    console.log(`Compression ratio: ${(stats.compressionRatio * 100).toFixed(1)}%`);
    console.log(`Interned strings: ${stats.internedStrings}`);
    console.log(`Intern hit rate: ${(stats.internHitRate * 100).toFixed(1)}%`);
    console.log('===================================\n');

    // KPI targets (relaxed for test environment)
    expect(elapsed).toBeLessThan(50); // Should be well under 50ms
    expect(binary.byteLength).toBeLessThan(15000); // Should be under 15KB
  });

  it('should compare binary vs JSON size', () => {
    const operations: SerializedOperation[] = [];
    for (let i = 0; i < 100; i++) {
      operations.push({
        op: 'CREATE',
        id: i,
        type: 'View',
        props: {
          style: { flex: 1 },
          onPress: { __type: 'function', __fnId: `fn-${i}` },
        },
      });
    }

    const batch = createTestBatch(operations);

    // JSON size
    const jsonSize = JSON.stringify(batch).length;

    // Binary size
    const encoder = new BinaryEncoder();
    const binary = encoder.encodeBatch(batch);

    const savings = ((1 - binary.byteLength / jsonSize) * 100).toFixed(1);

    console.log('\n=== Size Comparison ===');
    console.log(`JSON size: ${jsonSize} bytes`);
    console.log(`Binary size: ${binary.byteLength} bytes`);
    console.log(`Savings: ${savings}%`);
    console.log('=======================\n');

    // Binary should be smaller
    expect(binary.byteLength).toBeLessThan(jsonSize);
  });
});

// ============================================
// Factory Function Tests
// ============================================

describe('Factory functions', () => {
  it('createBinaryEncoder should create encoder', () => {
    const encoder = createBinaryEncoder();
    expect(encoder).toBeInstanceOf(BinaryEncoder);
  });

  it('encodeBatchToBinary should encode batch', () => {
    const batch = createTestBatch([{ op: 'CREATE', id: 1, type: 'View', props: {} }]);
    const binary = encodeBatchToBinary(batch);

    expect(binary).toBeInstanceOf(ArrayBuffer);
    expect(binary.byteLength).toBeGreaterThan(HEADER_SIZE);
  });
});
