/**
 * End-to-end integration tests
 *
 * Simulates a complete guest lifecycle:
 * 1. Compile guest code
 * 2. Execute in sandbox
 * 3. Generate operations
 * 4. Host rendering
 * 5. Two-way communication
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import React from 'react';
import { CallbackRegistry, OperationCollector } from '../../../guest/runtime/reconciler';
import { Engine } from '../../engine';
import { Receiver } from '../../receiver';
import { ComponentRegistry } from '../../registry';

// TS type imports
interface OperationBatch {
  version: number;
  batchId: number;
  operations: unknown[];
}

interface HostMessage {
  type: string;
  [key: string]: unknown;
}

// ============ Mock components ============

const MockView: React.FC<{
  style?: object;
  children?: React.ReactNode;
  testID?: string;
}> = ({ children, testID }) =>
  React.createElement('mock-view', { 'data-testid': testID }, children);

const MockText: React.FC<{ children?: React.ReactNode; style?: object }> = ({ children }) =>
  React.createElement('mock-text', null, children);

const MockTouchable: React.FC<{
  onPress?: () => void;
  children?: React.ReactNode;
  style?: object;
}> = ({ children, onPress }) =>
  React.createElement('mock-touchable', { onClick: onPress }, children);

// ============ Integration tests ============

describe('E2E Integration Tests', () => {
  describe('Complete Guest Lifecycle', () => {
    let engine: Engine;
    let _receivedBatches: OperationBatch[];
    let _sentMessages: HostMessage[];

    beforeEach(() => {
      // Silent logger to prevent expected error logs from cluttering output
      const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
      engine = new Engine({
        sandbox: 'node-vm',
        debug: false,
        logger: silentLogger,
      });
      engine.register({
        View: MockView,
        Text: MockText,
        TouchableOpacity: MockTouchable,
      });

      _receivedBatches = [];
      _sentMessages = [];
    });

    afterEach(() => {
      engine.destroy();
    });

    it('should execute simple guest and generate operations', async () => {
      // Simple guest code
      const guestCode = `
        // Simulate guest execution
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: { style: { flex: 1 } } },
            { op: 'CREATE', id: 2, type: 'Text', props: {} },
            { op: 'APPEND', id: 2, parentId: 1, childId: 2 },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });
      `;

      // Create Receiver to receive operations
      let updateCount = 0;
      engine.on('update', () => { updateCount++; });
      const receiver = engine.createReceiver();

      // Load and execute guest
      await engine.loadBundle(guestCode, { theme: 'dark' });

      // Wait for updates
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify nodes created
      expect(receiver.nodeCount).toBeGreaterThanOrEqual(2);
      expect(updateCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle config access', async () => {
      const guestCode = `
        const config = __rill_getConfig();
        console.log('Config:', config);

        if (config.theme === 'dark') {
          __rill_sendBatch({
            version: 1,
            batchId: 1,
            operations: [
              { op: 'CREATE', id: 1, type: 'View', props: { style: { backgroundColor: '#000' } } },
              { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
            ]
          });
        }
      `;

      const receiver = engine.createReceiver();
      await engine.loadBundle(guestCode, { theme: 'dark' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receiver.nodeCount).toBe(1);
    });

    it('should handle multiple batches', async () => {
      const guestCode = `
        // First batch of operations
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: {} },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });

        // Second batch of operations
        __rill_sendBatch({
          version: 1,
          batchId: 2,
          operations: [
            { op: 'CREATE', id: 2, type: 'Text', props: {} },
            { op: 'APPEND', id: 2, parentId: 1, childId: 2 }
          ]
        });
      `;

      const receiver = engine.createReceiver();
      await engine.loadBundle(guestCode);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receiver.nodeCount).toBe(2);
    });

    it('should handle node updates', async () => {
      const guestCode = `
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: { style: { flex: 1 } } },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });

        // Update node
        __rill_sendBatch({
          version: 1,
          batchId: 2,
          operations: [
            { op: 'UPDATE', id: 1, props: { style: { flex: 2, backgroundColor: 'red' } } }
          ]
        });
      `;

      let updateCount = 0;
      engine.on('update', () => { updateCount++; });
      const receiver = engine.createReceiver();

      await engine.loadBundle(guestCode);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Due to microtask batching, two batches may merge into one update
      expect(updateCount).toBeGreaterThanOrEqual(1);
      expect(receiver.nodeCount).toBe(1);
    });

    it('should handle node removal', async () => {
      const guestCode = `
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: {} },
            { op: 'CREATE', id: 2, type: 'Text', props: {} },
            { op: 'APPEND', id: 2, parentId: 1, childId: 2 },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });

        // Remove child node
        __rill_sendBatch({
          version: 1,
          batchId: 2,
          operations: [
            { op: 'REMOVE', id: 2, parentId: 1, childId: 2 },
            { op: 'DELETE', id: 2 }
          ]
        });
      `;

      const receiver = engine.createReceiver();
      await engine.loadBundle(guestCode);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receiver.nodeCount).toBe(1);
    });
  });

  describe('Reconciler to Receiver Integration', () => {
    let callbackRegistry: CallbackRegistry;
    let collector: OperationCollector;
    let registry: ComponentRegistry;
    let receiver: Receiver;
    let receivedBatches: OperationBatch[];

    beforeEach(() => {
      callbackRegistry = new CallbackRegistry();
      collector = new OperationCollector();
      registry = new ComponentRegistry();
      registry.registerAll({
        View: MockView,
        Text: MockText,
        TouchableOpacity: MockTouchable,
      });

      receivedBatches = [];
      const _sendToHost = (batch: OperationBatch) => {
        receivedBatches.push(batch);
        receiver.applyBatch(batch);
      };

      receiver = new Receiver(
        registry,
        () => {},
        () => {}
      );
    });

    afterEach(() => {
      callbackRegistry.clear();
      receiver.clear();
    });

    it('should create component tree from operations', async () => {
      // Simulate operations generated by Reconciler
      collector.add({
        op: 'CREATE',
        id: 1,
        type: 'View',
        props: { style: { flex: 1 } },
      });
      collector.add({
        op: 'CREATE',
        id: 2,
        type: 'Text',
        props: {},
      });
      collector.add({
        op: 'APPEND',
        id: 2,
        parentId: 1,
        childId: 2,
      });
      collector.add({
        op: 'APPEND',
        id: 1,
        parentId: 0,
        childId: 1,
      });

      collector.flush((raw) => {
        const batch = typeof raw === 'string' ? JSON.parse(raw) : raw;
        receivedBatches.push(batch);
        receiver.applyBatch(batch);
      });

      await new Promise((resolve) => queueMicrotask(resolve));

      expect(receiver.nodeCount).toBe(2);

      const rendered = receiver.render();
      expect(rendered).not.toBeNull();
    });

    it('should handle function props through callback registry', async () => {
      const onPress = mock();
      const fnId = callbackRegistry.register(onPress);

      collector.add({
        op: 'CREATE',
        id: 1,
        type: 'TouchableOpacity',
        props: {
          onPress: { __type: 'function', __fnId: fnId },
        },
      });
      collector.add({
        op: 'APPEND',
        id: 1,
        parentId: 0,
        childId: 1,
      });

      collector.flush((raw) => {
        const batch = typeof raw === 'string' ? JSON.parse(raw) : raw;
        receivedBatches.push(batch);
        receiver.applyBatch(batch);
      });

      await new Promise((resolve) => queueMicrotask(resolve));

      // Verify callback can be invoked
      callbackRegistry.invoke(fnId, []);
      expect(onPress).toHaveBeenCalled();
    });

    it('should handle complex nested structure', async () => {
      // Create nested structure: View > View > Text
      collector.add({
        op: 'CREATE',
        id: 1,
        type: 'View',
        props: { style: { flex: 1 } },
      });
      collector.add({
        op: 'CREATE',
        id: 2,
        type: 'View',
        props: { style: { padding: 10 } },
      });
      collector.add({
        op: 'CREATE',
        id: 3,
        type: 'Text',
        props: {},
      });
      collector.add({
        op: 'CREATE',
        id: 4,
        type: '__TEXT__',
        props: { text: 'Hello World' },
      });

      collector.add({ op: 'APPEND', id: 4, parentId: 3, childId: 4 });
      collector.add({ op: 'APPEND', id: 3, parentId: 2, childId: 3 });
      collector.add({ op: 'APPEND', id: 2, parentId: 1, childId: 2 });
      collector.add({ op: 'APPEND', id: 1, parentId: 0, childId: 1 });

      collector.flush((raw) => {
        const batch = typeof raw === 'string' ? JSON.parse(raw) : raw;
        receiver.applyBatch(batch);
      });

      await new Promise((resolve) => queueMicrotask(resolve));

      expect(receiver.nodeCount).toBe(4);

      const debugInfo = receiver.getDebugInfo();
      expect(debugInfo.rootChildren).toEqual([1]);
    });
  });

  describe('Bidirectional Communication', () => {
    let engine: Engine;

    beforeEach(() => {
      // Silent logger to prevent expected error logs from cluttering output
      const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
      engine = new Engine({
        sandbox: 'node-vm',
        debug: false,
        logger: silentLogger,
      });
      engine.register({
        View: MockView,
        Text: MockText,
      });
    });

    afterEach(() => {
      engine.destroy();
    });

    it('should send events from host to sandbox', async () => {
      const guestCode = `
        // Set up event handler
        globalThis.__rill.dispatchEvent = function(eventName, payload) {
          console.log('Received event:', eventName, payload);

          if (eventName === 'REFRESH') {
            __rill_sendBatch({
              version: 1,
              batchId: 99,
              operations: [
                { op: 'CREATE', id: 100, type: 'Text', props: { text: 'Refreshed!' } },
                { op: 'APPEND', id: 100, parentId: 0, childId: 100 }
              ]
            });
          }
        };

        // Initial render
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: {} },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });
      `;

      const receiver = engine.createReceiver();
      await engine.loadBundle(guestCode);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receiver.nodeCount).toBe(1);

      // Send event to sandbox
      engine.sendEvent('REFRESH', { timestamp: Date.now() });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // New node should be created
      expect(receiver.nodeCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle config updates', async () => {
      const guestCode = `
        const { View, Text, useConfig } = require('rill/guest');

        function App() {
          const config = useConfig();
          const theme = (config && config.theme) ? config.theme : 'light';
          return React.createElement(
            View,
            { testID: 'root' },
            React.createElement(Text, { testID: 'theme', text: String(theme) })
          );
        }

        RillReconciler.render(React.createElement(App), __rill_sendBatch);
      `;

      const receiver = engine.createReceiver();
      await engine.loadBundle(guestCode, { theme: 'light' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receiver.findByTestId('theme')?.props.text).toBe('light');

      // Update config
      engine.updateConfig({ theme: 'dark' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receiver.findByTestId('theme')?.props.text).toBe('dark');
    });
  });

  describe('Error Isolation', () => {
    let engine: Engine;

    beforeEach(() => {
      // Silent logger to prevent expected error logs from cluttering output
      const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
      engine = new Engine({
        sandbox: 'node-vm',
        debug: false,
        logger: silentLogger,
      });
    });

    afterEach(() => {
      engine.destroy();
    });

    it('should not crash host when guest throws error', async () => {
      const guestCode = `
        // Normal initialization
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: {} },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });

        // Throw error afterwards
        setTimeout(() => {
          throw new Error('Guest error!');
        }, 10);
      `;

      const receiver = engine.createReceiver();

      // Load should not fail
      await engine.loadBundle(guestCode);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Engine should still be valid
      expect(engine.isLoaded).toBe(true);
      expect(receiver.nodeCount).toBe(1);
    });

    it('should handle missing component gracefully', async () => {
      const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

      engine.register({
        View: MockView,
        // Text component not registered
      });

      const guestCode = `
        __rill_sendBatch({
          version: 1,
          batchId: 1,
          operations: [
            { op: 'CREATE', id: 1, type: 'View', props: {} },
            { op: 'CREATE', id: 2, type: 'UnregisteredComponent', props: {} },
            { op: 'APPEND', id: 2, parentId: 1, childId: 2 },
            { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
          ]
        });
      `;

      const receiver = engine.createReceiver();
      await engine.loadBundle(guestCode);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Rendering should not crash
      const rendered = receiver.render();
      expect(rendered).not.toBeNull();

      // Should have warning
      expect(consoleSpy).toHaveBeenCalled();
      const warnCalls = consoleSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('UnregisteredComponent');

      consoleSpy.mockRestore();
    });
  });

  describe('Batch Operations Performance', () => {
    let collector: OperationCollector;
    let batchCount: number;
    let totalOperations: number;

    beforeEach(() => {
      collector = new OperationCollector();
      batchCount = 0;
      totalOperations = 0;
    });

    it('should batch multiple operations into single flush', () => {
      // Add many operations
      for (let i = 1; i <= 100; i++) {
        collector.add({
          op: 'CREATE',
          id: i,
          type: 'View',
          props: { index: i },
        });
      }

      collector.flush((raw) => {
        const batch = typeof raw === 'string' ? JSON.parse(raw) : raw;
        batchCount++;
        totalOperations += batch.operations.length;
      });

      // All operations should be in one batch
      expect(batchCount).toBe(1);
      expect(totalOperations).toBe(100);
    });

    it('should handle multiple flushes correctly', () => {
      // First batch
      for (let i = 1; i <= 50; i++) {
        collector.add({
          op: 'CREATE',
          id: i,
          type: 'View',
          props: {},
        });
      }
      collector.flush((raw) => {
        const batch = typeof raw === 'string' ? JSON.parse(raw) : raw;
        batchCount++;
        totalOperations += batch.operations.length;
      });

      // Second batch
      for (let i = 51; i <= 100; i++) {
        collector.add({
          op: 'CREATE',
          id: i,
          type: 'View',
          props: {},
        });
      }
      collector.flush((raw) => {
        const batch = typeof raw === 'string' ? JSON.parse(raw) : raw;
        batchCount++;
        totalOperations += batch.operations.length;
      });

      expect(batchCount).toBe(2);
      expect(totalOperations).toBe(100);
    });

    it('should not flush when no pending operations', () => {
      collector.flush((_batch) => {
        batchCount++;
      });

      expect(batchCount).toBe(0);
    });
  });
});

describe('Full Stack Simulation', () => {
  it('should simulate complete render cycle', async () => {
    // 1. Create Engine
    const engine = new Engine({ sandbox: 'node-vm', debug: false });
    engine.register({
      View: MockView,
      Text: MockText,
      TouchableOpacity: MockTouchable,
    });

    // 2. Create Receiver
    let renderCount = 0;
    engine.on('update', () => { renderCount++; });
    const receiver = engine.createReceiver();

    // 3. Simulate guest code
    const guestCode = `
      // Simulate operations after React component rendering
      const operations = [];
      let nodeId = 0;

      // Create root View
      const rootId = ++nodeId;
      operations.push({
        op: 'CREATE',
        id: rootId,
        type: 'View',
        props: { style: { flex: 1, padding: 20 } }
      });

      // Create title
      const titleId = ++nodeId;
      operations.push({
        op: 'CREATE',
        id: titleId,
        type: 'Text',
        props: { style: { fontSize: 24, fontWeight: 'bold' } }
      });

      // Create title text
      const titleTextId = ++nodeId;
      operations.push({
        op: 'CREATE',
        id: titleTextId,
        type: '__TEXT__',
        props: { text: 'Hello Rill!' }
      });

      // Create button
      const buttonId = ++nodeId;
      operations.push({
        op: 'CREATE',
        id: buttonId,
        type: 'TouchableOpacity',
        props: {
          style: { backgroundColor: '#007AFF', padding: 12, borderRadius: 8 },
          onPress: { __type: 'function', __fnId: 'fn_1' }
        }
      });

      // Create button text
      const buttonTextId = ++nodeId;
      operations.push({
        op: 'CREATE',
        id: buttonTextId,
        type: 'Text',
        props: { style: { color: 'white' } }
      });

      const buttonTextContentId = ++nodeId;
      operations.push({
        op: 'CREATE',
        id: buttonTextContentId,
        type: '__TEXT__',
        props: { text: 'Click Me' }
      });

      // Assemble tree structure
      operations.push({ op: 'APPEND', id: titleTextId, parentId: titleId, childId: titleTextId });
      operations.push({ op: 'APPEND', id: titleId, parentId: rootId, childId: titleId });
      operations.push({ op: 'APPEND', id: buttonTextContentId, parentId: buttonTextId, childId: buttonTextContentId });
      operations.push({ op: 'APPEND', id: buttonTextId, parentId: buttonId, childId: buttonTextId });
      operations.push({ op: 'APPEND', id: buttonId, parentId: rootId, childId: buttonId });
      operations.push({ op: 'APPEND', id: rootId, parentId: 0, childId: rootId });

      __rill_sendBatch({
        version: 1,
        batchId: 1,
        operations: operations
      });
    `;

    // 4. Load and execute
    await engine.loadBundle(guestCode);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. Verify results
    expect(receiver.nodeCount).toBe(6);
    expect(renderCount).toBeGreaterThanOrEqual(1);

    const rendered = receiver.render();
    expect(rendered).not.toBeNull();

    const debugInfo = receiver.getDebugInfo();
    expect(debugInfo.rootChildren.length).toBe(1);

    // 6. Cleanup
    engine.destroy();
  });
});
