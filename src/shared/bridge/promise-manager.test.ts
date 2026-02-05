/**
 * @rill/runtime/bridge - Promise Manager Tests
 *
 * Tests for cross-boundary Promise management:
 * - Registration and result sending
 * - Pending promise creation and settlement
 * - Timeout handling
 * - Cleanup and memory management
 */

import { describe, expect, test } from 'bun:test';
import { PromiseManager, type PromiseSettleResult } from './promise-manager';

describe('PromiseManager', () => {
  describe('register() - outgoing promises', () => {
    test('should generate unique promise IDs', () => {
      const manager = new PromiseManager();
      const p1 = Promise.resolve(1);
      const p2 = Promise.resolve(2);

      const id1 = manager.register(p1);
      const id2 = manager.register(p2);

      expect(id1).toMatch(/^p_\d+$/);
      expect(id2).toMatch(/^p_\d+$/);
      expect(id1).not.toBe(id2);
    });

    test('should call onSendResult when promise resolves', async () => {
      const results: Array<{ id: string; result: PromiseSettleResult }> = [];
      const manager = new PromiseManager({
        onSendResult: (id, result) => results.push({ id, result }),
      });

      const promise = Promise.resolve(42);
      const id = manager.register(promise);

      await promise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id,
        result: { status: 'fulfilled', value: 42 },
      });
    });

    test('should call onSendResult when promise rejects', async () => {
      const results: Array<{ id: string; result: PromiseSettleResult }> = [];
      const manager = new PromiseManager({
        onSendResult: (id, result) => results.push({ id, result }),
      });

      const error = new Error('test error');
      const promise = Promise.reject(error);
      const id = manager.register(promise);

      await promise.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id,
        result: { status: 'rejected', reason: error },
      });
    });

    test('should log in debug mode', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(' '));

      try {
        const manager = new PromiseManager({ debug: true });
        const promise = Promise.resolve('data');
        manager.register(promise);

        await promise;
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(logs.some((log) => log.includes('Promise') && log.includes('resolved'))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('createPending() - incoming promises', () => {
    test('should create a pending promise', () => {
      const manager = new PromiseManager();
      const promise = manager.createPending('p_123');

      expect(promise).toBeInstanceOf(Promise);
      expect(manager.hasPending('p_123')).toBe(true);
      expect(manager.pendingCount).toBe(1);

      // Clean up to prevent timeout timer from firing after test
      manager.clear();
    });

    test('should timeout if not settled within timeout period', async () => {
      const manager = new PromiseManager({ timeout: 50 });
      const promise = manager.createPending('p_timeout');

      await expect(promise).rejects.toThrow('Promise p_timeout timed out after 50ms');
      expect(manager.hasPending('p_timeout')).toBe(false);
    });

    test('should not timeout if timeout is 0', async () => {
      const manager = new PromiseManager({ timeout: 0 });
      const promise = manager.createPending('p_no_timeout');

      // Wait a bit to ensure no timeout occurs
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(manager.hasPending('p_no_timeout')).toBe(true);

      // Settle manually
      manager.settle('p_no_timeout', { status: 'fulfilled', value: 'ok' });
      await expect(promise).resolves.toBe('ok');
    });

    test('should log timeout warning in debug mode', async () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

      try {
        const manager = new PromiseManager({ timeout: 50, debug: true });
        const promise = manager.createPending('p_debug_timeout');

        await promise.catch(() => {});

        expect(warnings.some((w) => w.includes('p_debug_timeout') && w.includes('timed out'))).toBe(
          true
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('settle() - resolve pending promises', () => {
    test('should resolve pending promise with fulfilled result', async () => {
      const manager = new PromiseManager();
      const promise = manager.createPending('p_resolve');

      manager.settle('p_resolve', { status: 'fulfilled', value: 123 });

      await expect(promise).resolves.toBe(123);
      expect(manager.hasPending('p_resolve')).toBe(false);
    });

    test('should reject pending promise with rejected result', async () => {
      const manager = new PromiseManager();
      const promise = manager.createPending('p_reject');

      const error = new Error('settlement error');
      manager.settle('p_reject', { status: 'rejected', reason: error });

      await expect(promise).rejects.toThrow('settlement error');
      expect(manager.hasPending('p_reject')).toBe(false);
    });

    test('should clear timeout when settled', async () => {
      const manager = new PromiseManager({ timeout: 5000 });
      const promise = manager.createPending('p_settled');

      // Settle immediately
      manager.settle('p_settled', { status: 'fulfilled', value: 'done' });

      await expect(promise).resolves.toBe('done');

      // Wait a bit to ensure timeout doesn't fire
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.hasPending('p_settled')).toBe(false);
    });

    test('should handle settlement of non-existent promise gracefully', () => {
      const manager = new PromiseManager();

      expect(() => {
        manager.settle('p_nonexistent', { status: 'fulfilled', value: null });
      }).not.toThrow();
    });

    test('should log warning when settling non-existent promise in debug mode', () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

      try {
        const manager = new PromiseManager({ debug: true });
        manager.settle('p_missing', { status: 'fulfilled', value: null });

        expect(warnings.some((w) => w.includes('No pending promise found'))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    test('should log settlement in debug mode', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(' '));

      try {
        const manager = new PromiseManager({ debug: true });
        const promise = manager.createPending('p_debug');

        manager.settle('p_debug', { status: 'fulfilled', value: 'test' });
        await promise;

        expect(logs.some((l) => l.includes('p_debug') && l.includes('settled'))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('hasPending() and pendingCount', () => {
    test('should track pending promises correctly', () => {
      const manager = new PromiseManager();

      expect(manager.pendingCount).toBe(0);
      expect(manager.hasPending('p_1')).toBe(false);

      manager.createPending('p_1');
      expect(manager.pendingCount).toBe(1);
      expect(manager.hasPending('p_1')).toBe(true);

      manager.createPending('p_2');
      expect(manager.pendingCount).toBe(2);
      expect(manager.hasPending('p_2')).toBe(true);

      manager.settle('p_1', { status: 'fulfilled', value: null });
      expect(manager.pendingCount).toBe(1);
      expect(manager.hasPending('p_1')).toBe(false);
      expect(manager.hasPending('p_2')).toBe(true);

      // Clean up remaining pending promise
      manager.clear();
    });
  });

  describe('clear() - cleanup', () => {
    test('should silently resolve all pending promises with undefined', async () => {
      // Note: clear() resolves with undefined to avoid unhandled rejection errors during destroy
      const manager = new PromiseManager();

      const p1 = manager.createPending('p_1');
      const p2 = manager.createPending('p_2');
      const p3 = manager.createPending('p_3');

      manager.clear();

      // All promises should resolve to undefined (silent cleanup)
      await expect(p1).resolves.toBeUndefined();
      await expect(p2).resolves.toBeUndefined();
      await expect(p3).resolves.toBeUndefined();
    });

    test('should clear all pending promises', async () => {
      const manager = new PromiseManager();

      const p1 = manager.createPending('p_1');
      const p2 = manager.createPending('p_2');
      expect(manager.pendingCount).toBe(2);

      manager.clear();
      expect(manager.pendingCount).toBe(0);
      expect(manager.hasPending('p_1')).toBe(false);
      expect(manager.hasPending('p_2')).toBe(false);

      // Wait for promises to complete
      await p1;
      await p2;
    });

    test('should clear all timeouts', async () => {
      const manager = new PromiseManager({ timeout: 100 });

      manager.createPending('p_1').catch(() => {});
      manager.createPending('p_2').catch(() => {});

      manager.clear();

      // Wait to ensure no timeout fires
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(manager.pendingCount).toBe(0);
    });

    test('should reset promise ID counter', () => {
      const manager = new PromiseManager();

      manager.register(Promise.resolve(1));
      manager.register(Promise.resolve(2));

      manager.clear();

      // After clear, counter is reset, next ID should be p_1 again
      const nextId = manager.register(Promise.resolve(3));
      expect(nextId).toBe('p_1');
    });

    test('should be safe to call clear() multiple times', () => {
      const manager = new PromiseManager();
      manager.createPending('p_1').catch(() => {});

      expect(() => {
        manager.clear();
        manager.clear();
        manager.clear();
      }).not.toThrow();

      expect(manager.pendingCount).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    test('should handle rapid register/settle cycles', async () => {
      const results: PromiseSettleResult[] = [];
      const manager = new PromiseManager({
        onSendResult: (_, result) => results.push(result),
      });

      // Register many promises
      const promises = Array.from({ length: 100 }, (_, i) => Promise.resolve(i));
      promises.forEach((p) => manager.register(p));

      await Promise.all(promises);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(results).toHaveLength(100);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    test('should handle concurrent pending promises', async () => {
      const manager = new PromiseManager({ timeout: 1000 });

      const pending = Array.from({ length: 50 }, (_, i) => manager.createPending(`p_${i}`));

      expect(manager.pendingCount).toBe(50);

      // Settle half
      for (let i = 0; i < 25; i++) {
        manager.settle(`p_${i}`, { status: 'fulfilled', value: i });
      }

      const settled = await Promise.allSettled(pending.slice(0, 25));
      expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(manager.pendingCount).toBe(25);

      // Clean up remaining pending promises to avoid timeout errors
      manager.clear();
      await Promise.allSettled(pending.slice(25));
    });

    test('should handle mixed success and error cases', async () => {
      const results: Array<{ id: string; result: PromiseSettleResult }> = [];
      const manager = new PromiseManager({
        onSendResult: (id, result) => results.push({ id, result }),
      });

      manager.register(Promise.resolve('ok'));
      manager.register(Promise.reject(new Error('err')).catch((e) => Promise.reject(e)));

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(results).toHaveLength(2);
      expect(results[0].result.status).toBe('fulfilled');
      expect(results[1].result.status).toBe('rejected');
    });
  });
});
