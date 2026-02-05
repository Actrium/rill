/**
 * operation-collector.test.ts
 *
 * M5-A: OperationCollector tests including binary encoding path
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { OperationCollector } from './operation-collector';
import { BinaryProtocol } from '../../../shared/bridge/binary-protocol';
import type { SerializedOperationBatch } from '../../../shared/types';

/** Parse flush output (JSON string in non-binary mode, ArrayBuffer in binary mode) */
function parseBatch(raw: unknown): SerializedOperationBatch {
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw as SerializedOperationBatch;
}

describe('OperationCollector', () => {
  describe('JSON mode (default)', () => {
    let collector: OperationCollector;

    beforeEach(() => {
      collector = new OperationCollector();
    });

    it('should collect and flush operations', () => {
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });
      collector.add({ op: 'APPEND', id: 1, parentId: 0, childId: 1, timestamp: Date.now() });

      let received: unknown = null;
      collector.flush((raw) => { received = raw; });

      expect(received).not.toBeNull();
      const batch = parseBatch(received);
      expect(batch.operations.length).toBe(2);
      expect(batch.batchId).toBe(1);
    });

    it('should not flush empty operations', () => {
      let called = false;
      collector.flush(() => { called = true; });
      expect(called).toBe(false);
    });

    it('should send JSON string (not ArrayBuffer) in default mode', () => {
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });

      let received: unknown = null;
      collector.flush((raw) => { received = raw; });

      // Non-binary mode sends JSON string for JSI stack safety
      expect(received).not.toBeInstanceOf(ArrayBuffer);
      expect(typeof received).toBe('string');
      const batch = parseBatch(received);
      expect(batch.operations).toHaveLength(1);
    });

    it('should increment batchId', () => {
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });
      let batch1: SerializedOperationBatch | null = null;
      collector.flush((b) => { batch1 = parseBatch(b); });

      collector.add({ op: 'DELETE', id: 1, timestamp: Date.now() });
      let batch2: SerializedOperationBatch | null = null;
      collector.flush((b) => { batch2 = parseBatch(b); });

      expect(batch1!.batchId).toBe(1);
      expect(batch2!.batchId).toBe(2);
    });

    it('should report pendingCount', () => {
      expect(collector.pendingCount).toBe(0);
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });
      expect(collector.pendingCount).toBe(1);
      collector.add({ op: 'DELETE', id: 1, timestamp: Date.now() });
      expect(collector.pendingCount).toBe(2);
    });
  });

  describe('binary mode', () => {
    let collector: OperationCollector;

    beforeEach(() => {
      collector = new OperationCollector({ binaryEncoding: true });
    });

    it('should send ArrayBuffer when binary encoding enabled', () => {
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });

      let received: unknown = null;
      collector.flush((batch) => { received = batch; });

      expect(received).toBeInstanceOf(ArrayBuffer);
    });

    it('should produce valid binary that can be decoded', () => {
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: { style: 'flex:1' }, timestamp: Date.now() });
      collector.add({ op: 'TEXT', id: 2, text: 'Hello', timestamp: Date.now() });

      let binary: ArrayBuffer | null = null;
      collector.flush((batch) => { binary = batch as ArrayBuffer; });

      // Decode with BinaryProtocol
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const decoded = protocol.decodeBatch(binary!);

      expect(decoded.operations.length).toBe(2);
      expect(decoded.operations[0].op).toBe('CREATE');
      expect(decoded.operations[1].op).toBe('TEXT');
    });

    it('should handle multiple flushes with persistent intern', () => {
      // First flush
      collector.add({ op: 'CREATE', id: 1, type: 'View', props: {}, timestamp: Date.now() });
      let binary1: ArrayBuffer | null = null;
      collector.flush((batch) => { binary1 = batch as ArrayBuffer; });

      // Second flush — same string "View" should benefit from intern
      collector.add({ op: 'CREATE', id: 2, type: 'View', props: {}, timestamp: Date.now() });
      let binary2: ArrayBuffer | null = null;
      collector.flush((batch) => { binary2 = batch as ArrayBuffer; });

      expect(binary1).toBeInstanceOf(ArrayBuffer);
      expect(binary2).toBeInstanceOf(ArrayBuffer);

      // Both should be decodable
      const protocol = new BinaryProtocol({ encoding: 'binary' });
      const decoded1 = protocol.decodeBatch(binary1!);
      const decoded2 = protocol.decodeBatch(binary2!);

      expect(decoded1.batchId).toBe(1);
      expect(decoded2.batchId).toBe(2);
    });
  });
});
