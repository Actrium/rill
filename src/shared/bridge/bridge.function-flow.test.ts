/**
 * Bridge Function Prop Flow Tests
 *
 * Tests the critical path: function props must survive serialization and
 * arrive as callable functions on the Host (Receiver) side.
 *
 * This tests three scenarios:
 * 1. Pre-serialized batch (Guest already called serializeProps)
 * 2. Raw batch (functions not yet serialized)
 * 3. Full pipeline: serialize → deserialize → re-serialize → Bridge decode
 *    (the production path with sandbox wrapper deserializeProps)
 *
 * All MUST result in callable function props on the Host side.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry } from '..';
import type { HostMessage, OperationBatch, SerializedOperationBatch } from '..';
import { encodeObject, createEncoder, DEFAULT_TYPE_RULES, type CodecCallbacks } from '..';
import { Bridge } from './bridge';

/**
 * Create a Guest-side encoder (mimics guest-encoder.ts)
 * Returns serializeProps function and the callback registry used
 */
function createGuestEncoder() {
  const guestRegistry = new CallbackRegistry();
  const context = {} as CodecCallbacks;
  const encoder = createEncoder(DEFAULT_TYPE_RULES, context);
  context.encode = encoder;
  context.decode = (v) => v;
  context.registerFunction = (fn) =>
    guestRegistry.register(fn as (...args: unknown[]) => unknown);
  context.invokeFunction = (fnId, args) => guestRegistry.invoke(fnId, args);

  const serializeProps = (props: Record<string, unknown>) =>
    encodeObject(props, encoder);

  return { serializeProps, guestRegistry };
}

/**
 * Create a lightweight proxy for deserialized function markers
 * (mimics guest-encoder.ts createLightweightProxy + deserializeProps)
 */
function deserializeProps(
  props: Record<string, unknown>,
  registry: CallbackRegistry
): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>).__type === 'function' &&
      (value as Record<string, unknown>).__fnId
    ) {
      const fnId = (value as Record<string, unknown>).__fnId as string;
      result[key] = (...args: unknown[]) => registry.invoke(fnId, args);
      changed = true;
    } else {
      result[key] = value;
    }
  }
  return changed ? result : props;
}

describe('Bridge - Function Prop Serialization Flow', () => {
  let hostRegistry: CallbackRegistry;
  let bridge: Bridge;
  let hostReceived: OperationBatch[];
  let guestReceived: HostMessage[];

  beforeEach(() => {
    hostRegistry = new CallbackRegistry();
    hostReceived = [];
    guestReceived = [];

    bridge = new Bridge({
      callbackRegistry: hostRegistry,
      onGuestOperations: (batch) => hostReceived.push(batch),
      onHostMessage: (message) => {
        guestReceived.push(message);
      },
      debug: false,
    });
  });

  describe('Pre-serialized batch (production path: Guest serializeProps → Bridge)', () => {
    test('should decode function markers to callable proxies', () => {
      let called = false;
      const { serializeProps, guestRegistry } = createGuestEncoder();

      // Guest-side: serializeProps converts function → marker
      const onPress = () => { called = true; return 'pressed'; };
      const serializedProps = serializeProps({ onPress, label: 'Click me' });

      // Verify serialization produced function markers
      expect(serializedProps.onPress).toBeDefined();
      expect(typeof serializedProps.onPress).toBe('object');
      expect((serializedProps.onPress as Record<string, unknown>).__type).toBe('function');
      expect((serializedProps.onPress as Record<string, unknown>).__fnId).toBeDefined();
      expect(serializedProps.label).toBe('Click me');

      // Create pre-serialized batch (what Guest reconciler produces)
      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'TouchableOpacity',
            props: serializedProps,
          },
        ],
      };

      // Wire Bridge to invoke Guest registry
      const fnId = (serializedProps.onPress as Record<string, unknown>).__fnId as string;
      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      bridge.sendSerializedBatch(serializedBatch);

      // Host should receive decoded batch
      expect(hostReceived.length).toBe(1);
      const receivedOp = hostReceived[0]!.operations[0]!;
      const receivedOnPress = receivedOp.props!.onPress;

      // KEY ASSERTION: onPress must be a callable function
      expect(typeof receivedOnPress).toBe('function');
      expect(receivedOp.props!.label).toBe('Click me');

      // Calling the proxy should invoke the original function
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      const result = (receivedOnPress as Function)();
      expect(called).toBe(true);
      expect(result).toBe('pressed');
    });

    test('should handle multiple function props in pre-serialized batch', () => {
      const calls: string[] = [];
      const { serializeProps, guestRegistry } = createGuestEncoder();

      const serializedProps = serializeProps({
        onPress: () => { calls.push('press'); },
        onLongPress: () => { calls.push('longPress'); },
        onLayout: () => { calls.push('layout'); },
        style: { flex: 1 },
      });

      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          { op: 'CREATE', id: 1, type: 'TouchableOpacity', props: serializedProps },
        ],
      };

      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      bridge.sendSerializedBatch(serializedBatch);

      const received = hostReceived[0]!.operations[0]!.props!;
      expect(typeof received.onPress).toBe('function');
      expect(typeof received.onLongPress).toBe('function');
      expect(typeof received.onLayout).toBe('function');
      expect(received.style).toEqual({ flex: 1 });

      // All callbacks should be invocable
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      (received.onPress as Function)();
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      (received.onLongPress as Function)();
      expect(calls).toEqual(['press', 'longPress']);
    });

    test('should handle batch with mixed serialized and non-function operations', () => {
      const { serializeProps, guestRegistry } = createGuestEncoder();

      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { style: { flex: 1 } }, // No functions
          },
          {
            op: 'CREATE',
            id: 2,
            type: 'TouchableOpacity',
            props: serializeProps({ onPress: () => 'clicked' }),
          },
          {
            op: 'CREATE',
            id: 3,
            type: 'Text',
            props: { text: 'Hello' }, // No functions
          },
        ],
      };

      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      bridge.sendSerializedBatch(serializedBatch);

      expect(hostReceived.length).toBe(1);
      const ops = hostReceived[0]!.operations;

      // View should have style but no functions
      expect(ops[0]!.props!.style).toEqual({ flex: 1 });

      // TouchableOpacity should have callable onPress
      expect(typeof ops[1]!.props!.onPress).toBe('function');

      // Text should have text prop
      expect(ops[2]!.props!.text).toBe('Hello');
    });
  });

  describe('Raw batch (alternative path: Bridge handles encoding)', () => {
    test('should encode and decode function props', () => {
      let called = false;
      const batch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'TouchableOpacity',
            props: {
              onPress: () => { called = true; return 'raw-pressed'; },
              label: 'Raw Button',
            },
          },
        ],
      };

      bridge.sendRawBatch(batch);

      expect(hostReceived.length).toBe(1);
      const received = hostReceived[0]!.operations[0]!.props!;
      expect(typeof received.onPress).toBe('function');
      expect(received.label).toBe('Raw Button');

      // biome-ignore lint/complexity/noBannedTypes: Test verification
      const result = (received.onPress as Function)();
      expect(called).toBe(true);
      expect(result).toBe('raw-pressed');
    });
  });

  describe('isSerializedBatch detection', () => {
    test('should detect pre-serialized batch (first op has function marker)', () => {
      const { serializeProps } = createGuestEncoder();

      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'TouchableOpacity',
            props: serializeProps({ onPress: () => {} }),
          },
        ],
      };

      // sendSerializedBatch skips encoding (no double-encode).
      // The test verifies the decoded result has callable functions.
      bridge.sendSerializedBatch(serializedBatch);

      const received = hostReceived[0]!.operations[0]!.props!;
      // Should be a callable function, not a double-encoded object
      expect(typeof received.onPress).toBe('function');
    });

    test('should detect pre-serialized batch even when first op has no functions', () => {
      // This is the KEY scenario: first op is a View with only style props,
      // second op is a TouchableOpacity with function props.
      // isSerializedBatch only checks the FIRST op's props.
      const { serializeProps, guestRegistry } = createGuestEncoder();

      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: { style: { flex: 1 } }, // First op: no functions
          },
          {
            op: 'CREATE',
            id: 2,
            type: 'TouchableOpacity',
            props: serializeProps({ onPress: () => 'click' }),
          },
        ],
      };

      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      bridge.sendSerializedBatch(serializedBatch);

      const ops = hostReceived[0]!.operations;
      const receivedOnPress = ops[1]!.props!.onPress;

      // KEY QUESTION: Is onPress still callable?
      // If isSerializedBatch returns false (because first op has no functions),
      // Bridge will encodeBatch (double-encode). What happens to the marker?
      // The serialized-function rule in encoder has no encode method,
      // so it should pass through unchanged.
      // Then decodeBatch creates a callable proxy.
      expect(typeof receivedOnPress).toBe('function');
    });
  });

  describe('Double serialization safety', () => {
    test('function marker should survive double encoding', () => {
      // This tests what happens when:
      // 1. Guest serializeProps creates marker {__type: 'function', __fnId}
      // 2. Bridge.encodeBatch re-encodes (if isSerializedBatch returns false)
      // 3. Bridge.decodeBatch decodes
      // The function should still be callable.
      const { serializeProps, guestRegistry } = createGuestEncoder();

      // Step 1: Guest serializes
      const marker = serializeProps({ onPress: () => 'double-safe' });

      // Step 2: Force double encoding by wrapping in a raw batch
      // (simulating isSerializedBatch returning false)
      const rawBatch: OperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'View',
            props: marker, // Already serialized props treated as raw
          },
        ],
      };

      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      // Bridge will encode (double-encode markers) then decode
      bridge.sendRawBatch(rawBatch);

      const received = hostReceived[0]!.operations[0]!.props!;
      // After double encode + decode, onPress should still be callable
      expect(typeof received.onPress).toBe('function');
    });
  });

  describe('Full pipeline: serialize → deserialize → re-serialize → Bridge decode', () => {
    test('function props should survive full sandbox wrapper pipeline', () => {
      // This tests the EXACT production flow:
      // 1. transformGuestElement serializes props (function → marker)
      // 2. Sandbox wrapper deserializes markers (marker → lightweight proxy)
      // 3. Guest component passes proxy through in JSX
      // 4. host-config.ts serializeProps re-serializes (proxy → new marker)
      // 5. Bridge decodes (new marker → callable proxy)
      // 6. Receiver gets callable function → user can click

      const { serializeProps, guestRegistry } = createGuestEncoder();
      let originalCalled = false;

      // Step 1: transformGuestElement serializes props
      const originalOnPress = () => { originalCalled = true; return 'clicked!'; };
      const serializedProps = serializeProps({
        onPress: originalOnPress,
        label: 'Submit',
        style: { backgroundColor: 'blue' },
      });

      // Step 2: Sandbox wrapper deserializes markers to lightweight proxies
      const deserializedProps = deserializeProps(serializedProps, guestRegistry);

      // Verify deserialization restored callable functions
      expect(typeof deserializedProps.onPress).toBe('function');
      expect(deserializedProps.label).toBe('Submit');
      expect(deserializedProps.style).toEqual({ backgroundColor: 'blue' });

      // Step 3: Guest component uses the deserialized proxy in its JSX
      // (simulated: the proxy function becomes a new prop value)
      const guestOnPress = deserializedProps.onPress;

      // Step 4: host-config.ts re-serializes for sendToHost
      // The proxy is a real function → gets a NEW fnId in the same registry
      const reSerializedProps = serializeProps({
        onPress: guestOnPress,
        label: 'Submit',
        style: { backgroundColor: 'blue' },
      });

      // Verify re-serialization produced new function markers
      expect(typeof reSerializedProps.onPress).toBe('object');
      expect((reSerializedProps.onPress as Record<string, unknown>).__type).toBe('function');

      // Step 5: Bridge receives and decodes
      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          {
            op: 'CREATE',
            id: 1,
            type: 'TouchableOpacity',
            props: reSerializedProps,
          },
        ],
      };

      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      bridge.sendSerializedBatch(serializedBatch);

      // Step 6: Verify Host receives callable function
      expect(hostReceived.length).toBe(1);
      const received = hostReceived[0]!.operations[0]!.props!;
      expect(typeof received.onPress).toBe('function');
      expect(received.label).toBe('Submit');
      expect(received.style).toEqual({ backgroundColor: 'blue' });

      // Step 7: Invoking the proxy should reach the original function
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      const result = (received.onPress as Function)();
      expect(originalCalled).toBe(true);
      expect(result).toBe('clicked!');
    });

    test('Guest component calling deserialized prop should work', () => {
      // This tests the scenario where a Guest component CALLS a prop function
      // (not just passes it through), e.g.: onSubmit(formData)
      const { serializeProps, guestRegistry } = createGuestEncoder();
      const submissions: string[] = [];

      // Step 1: Serialize original function
      const originalOnSubmit = (data: unknown) => { submissions.push(String(data)); };
      const serializedProps = serializeProps({ onSubmit: originalOnSubmit });

      // Step 2: Deserialize to proxy
      const deserializedProps = deserializeProps(serializedProps, guestRegistry);
      const onSubmitProxy = deserializedProps.onSubmit;

      // Step 3: Guest component CALLS the proxy directly
      expect(typeof onSubmitProxy).toBe('function');
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      (onSubmitProxy as Function)('hello');
      (onSubmitProxy as Function)('world');

      // The calls should reach the original function
      expect(submissions).toEqual(['hello', 'world']);
    });

    test('multiple function props should all survive the full pipeline', () => {
      const { serializeProps, guestRegistry } = createGuestEncoder();
      const calls: string[] = [];

      // Step 1: Serialize multiple function props
      const serializedProps = serializeProps({
        onPress: () => calls.push('press'),
        onLongPress: () => calls.push('longPress'),
        onSubmit: (data: unknown) => calls.push(`submit:${data}`),
        title: 'Form',
      });

      // Step 2: Deserialize
      const deserializedProps = deserializeProps(serializedProps, guestRegistry);
      expect(typeof deserializedProps.onPress).toBe('function');
      expect(typeof deserializedProps.onLongPress).toBe('function');
      expect(typeof deserializedProps.onSubmit).toBe('function');
      expect(deserializedProps.title).toBe('Form');

      // Step 3: Guest component creates new handlers wrapping the proxies
      const wrappedOnPress = deserializedProps.onPress;
      const wrappedOnSubmit = (...args: unknown[]) => {
        // biome-ignore lint/complexity/noBannedTypes: Test verification
        (deserializedProps.onSubmit as Function)('formData');
      };

      // Step 4: Re-serialize (simulating host-config.ts)
      const reSerializedProps = serializeProps({
        onPress: wrappedOnPress,
        onLongPress: deserializedProps.onLongPress,
        onSubmit: wrappedOnSubmit,
        title: 'Form',
      });

      // Step 5: Bridge decode
      const serializedBatch: SerializedOperationBatch = {
        version: 1,
        batchId: 1,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: reSerializedProps },
        ],
      };

      bridge = new Bridge({
        callbackRegistry: hostRegistry,
        onGuestOperations: (batch) => hostReceived.push(batch),
        onHostMessage: (message) => { guestReceived.push(message); },
        guestInvoker: (id, args) => guestRegistry.invoke(id, args),
        debug: false,
      });

      bridge.sendSerializedBatch(serializedBatch);

      // Step 6: Invoke all functions
      const received = hostReceived[0]!.operations[0]!.props!;
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      (received.onPress as Function)();
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      (received.onLongPress as Function)();
      // biome-ignore lint/complexity/noBannedTypes: Test verification
      (received.onSubmit as Function)();

      expect(calls).toEqual(['press', 'longPress', 'submit:formData']);
    });
  });
});
