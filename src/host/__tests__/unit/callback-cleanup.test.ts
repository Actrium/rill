/**
 * Callback Memory Leak Fix Verification
 *
 * This test verifies that function callbacks are properly cleaned up
 * when components update or are deleted, preventing memory leaks.
 */

import { describe, expect, it } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry } from '../../../shared';
import { Bridge } from '../../../shared/bridge/bridge';
import type { OperationBatch } from '../../../shared/types';
import { Receiver } from '../../receiver';
import { ComponentRegistry } from '../../registry';

describe('Callback Cleanup - Memory Leak Fix', () => {
  it('should release old callbacks when node updates', () => {
    const callbackRegistry = new CallbackRegistry();
    const componentRegistry = new ComponentRegistry();

    // Register mock components
    componentRegistry.registerAll({
      Button: () => null,
    });

    const receiver = new Receiver(
      componentRegistry,
      () => {},
      () => {},
      { callbackRegistry }
    );

    const bridge = new Bridge({
      debug: false,
      callbackRegistry,
      onGuestOperations: (batch) => {
        receiver.applyBatch(batch);
      },
      onHostMessage: async () => {},
    });

    // Initial callback count
    const initialCount = callbackRegistry.size;

    // Create a node with a function prop
    const batch1: OperationBatch = {
      version: 1,
      batchId: 1,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Button',
          props: {
            onPress: () => console.log('click 1'),
          },
        },
      ],
    };

    bridge.sendRawBatch(batch1);

    // Should have registered 1 callback
    console.log(
      `[TEST] After CREATE: callbackRegistry.size = ${callbackRegistry.size}, expected = ${initialCount + 1}`
    );
    expect(callbackRegistry.size).toBe(initialCount + 1);
    const afterCreateCount = callbackRegistry.size;

    // Update with a new function prop
    const batch2: OperationBatch = {
      version: 1,
      batchId: 2,
      operations: [
        {
          op: 'UPDATE',
          id: 1,
          props: {
            onPress: () => console.log('click 2'),
          },
        },
      ],
    };

    bridge.sendRawBatch(batch2);

    // Should still have only 1 callback (old one released, new one added)
    console.log(
      `[TEST] After UPDATE: callbackRegistry.size = ${callbackRegistry.size}, expected = ${afterCreateCount}`
    );
    expect(callbackRegistry.size).toBe(afterCreateCount);
  });

  it('should release callbacks when node is deleted', () => {
    const callbackRegistry = new CallbackRegistry();
    const componentRegistry = new ComponentRegistry();

    // Register mock components
    componentRegistry.registerAll({
      Button: () => null,
    });

    const receiver = new Receiver(
      componentRegistry,
      () => {},
      () => {},
      { callbackRegistry }
    );

    const bridge = new Bridge({
      debug: false,
      callbackRegistry,
      onGuestOperations: (batch) => {
        receiver.applyBatch(batch);
      },
      onHostMessage: async () => {},
    });

    const initialCount = callbackRegistry.size;

    // Create multiple nodes with callbacks
    const batch1: OperationBatch = {
      version: 1,
      batchId: 1,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Button',
          props: {
            onPress: () => console.log('button 1'),
          },
        },
        {
          op: 'CREATE',
          id: 2,
          type: 'Button',
          props: {
            onPress: () => console.log('button 2'),
          },
        },
      ],
    };

    bridge.sendRawBatch(batch1);

    // Should have 2 callbacks registered
    expect(callbackRegistry.size).toBe(initialCount + 2);

    // Delete one node
    const batch2: OperationBatch = {
      version: 1,
      batchId: 2,
      operations: [
        {
          op: 'DELETE',
          id: 1,
        },
      ],
    };

    bridge.sendRawBatch(batch2);

    // Should have only 1 callback remaining
    expect(callbackRegistry.size).toBe(initialCount + 1);

    // Delete the other node
    const batch3: OperationBatch = {
      version: 1,
      batchId: 3,
      operations: [
        {
          op: 'DELETE',
          id: 2,
        },
      ],
    };

    bridge.sendRawBatch(batch3);

    // Should be back to initial count
    expect(callbackRegistry.size).toBe(initialCount);
  });

  it('should handle multiple updates without leaking callbacks', () => {
    const callbackRegistry = new CallbackRegistry();
    const componentRegistry = new ComponentRegistry();

    // Register mock components
    componentRegistry.registerAll({
      Button: () => null,
    });

    const receiver = new Receiver(
      componentRegistry,
      () => {},
      () => {},
      { callbackRegistry }
    );

    const bridge = new Bridge({
      debug: false,
      callbackRegistry,
      onGuestOperations: (batch) => {
        receiver.applyBatch(batch);
      },
      onHostMessage: async () => {},
    });

    const _initialCount = callbackRegistry.size;

    // Create a node
    const batch1: OperationBatch = {
      version: 1,
      batchId: 1,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'Button',
          props: {
            onPress: () => console.log('initial'),
          },
        },
      ],
    };

    bridge.sendRawBatch(batch1);
    const afterCreateCount = callbackRegistry.size;

    // Perform 100 updates (simulating component re-renders)
    for (let i = 0; i < 100; i++) {
      const batch: OperationBatch = {
        version: 1,
        batchId: i + 2,
        operations: [
          {
            op: 'UPDATE',
            id: 1,
            props: {
              onPress: () => console.log(`update ${i}`),
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);
    }

    // Should still have only 1 callback (not 101!)
    expect(callbackRegistry.size).toBe(afterCreateCount);
  });

  it('should use reference counting correctly', () => {
    const callbackRegistry = new CallbackRegistry();

    // Register a callback
    const fn = () => console.log('test');
    const fnId = callbackRegistry.register(fn);

    // Initial ref count should be 1
    expect(callbackRegistry.getRefCount(fnId)).toBe(1);

    // Retain it
    callbackRegistry.retain(fnId);
    expect(callbackRegistry.getRefCount(fnId)).toBe(2);

    // Release once - should still exist
    callbackRegistry.release(fnId);
    expect(callbackRegistry.getRefCount(fnId)).toBe(1);
    expect(callbackRegistry.has(fnId)).toBe(true);

    // Release again - should be deleted
    callbackRegistry.release(fnId);
    expect(callbackRegistry.getRefCount(fnId)).toBe(0);
    expect(callbackRegistry.has(fnId)).toBe(false);
  });
});
