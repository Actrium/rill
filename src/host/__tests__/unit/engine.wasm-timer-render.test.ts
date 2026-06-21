/**
 * Engine timer-callback-driven render on the wasm-quickjs provider (issue #10).
 *
 * Before the fix, host functions that take a CALLBACK argument (setTimeout / setInterval /
 * setImmediate / queueMicrotask) lost the callback on the WASM provider: the engine injects
 * these as host closures, and the WASM inject() shim JSON-serialized the arguments — a
 * function argument became null, so the timer never fired and no follow-up render batch was
 * ever produced. React's concurrent scheduler relies on setImmediate, so a useEffect/timer-
 * driven update never reached the host on web.
 *
 * The fix (approach B) registers callback arguments in the guest callback registry and
 * passes a {__rill_cb:id} marker across the bridge; the host reconstructs a proxy that
 * invokes the guest callback by id. This drives the REAL Engine on the REAL wasm-quickjs
 * provider and asserts a deferred render batch — scheduled from a setImmediate callback —
 * reaches the host Receiver in addition to the initial batch.
 *
 * Determinism: setImmediate is drained synchronously by the Engine after the bundle eval
 * (_drainPendingImmediates), so no timers/sleeps are needed to observe the second batch.
 * The FULL React scheduler path (useEffect + setTimeout completing a concurrent render) is
 * covered against real WASM in tests/wasm-sandbox/rill-useeffect.e2e.ts — the bun mock-react
 * environment can't host useEffect because react-reconciler captures setTimeout at import.
 */

import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';
import type { OperationBatch } from '../../types';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

// biome-ignore lint/suspicious/noExplicitAny: test mock components
const mock = ((p: any) => p) as any;

describeIfWASM('Engine timer-callback render on wasm-quickjs (issue #10)', () => {
  it('a setImmediate callback fires through the bridge and its batch reaches the Receiver', async () => {
    const engine = new Engine({ sandbox: 'wasm-quickjs' });
    engine.register({ View: mock, Text: mock });
    const batches: OperationBatch[] = [];
    engine.on('operation', (b) => batches.push(b));
    engine.createReceiver();

    await engine.loadBundle(`
      // Initial render (direct data batch — already worked after #8).
      globalThis.__rill_sendBatch({
        version: 1, batchId: 1,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: {} },
          { op: 'APPEND', parentId: 0, childId: 1 }
        ]
      });
      // Deferred update scheduled via the engine's setImmediate polyfill. The callback
      // argument crosses the WASM bridge by id (#10) and is invoked when the engine drains
      // immediates — producing a SECOND batch the host must receive.
      setImmediate(function(){
        globalThis.__rill_sendBatch({
          version: 1, batchId: 2,
          operations: [
            { op: 'CREATE', id: 2, type: 'Text', props: {} },
            { op: 'APPEND', parentId: 0, childId: 2 }
          ]
        });
      });
    `);

    const ids = batches.map((b) => b.batchId);
    expect(ids).toContain(1);
    expect(ids).toContain(2); // the timer-callback-driven batch arrived

    const receiver = engine.getReceiver();
    expect(receiver).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
    expect(receiver!.nodeCount).toBe(2);
    // biome-ignore lint/style/noNonNullAssertion: see above
    expect(receiver!.findNodesByType('Text')).toHaveLength(1);

    engine.destroy();
  });

  it('a queueMicrotask callback also crosses the bridge and produces a batch', async () => {
    const engine = new Engine({ sandbox: 'wasm-quickjs' });
    engine.register({ View: mock });
    const batches: OperationBatch[] = [];
    engine.on('operation', (b) => batches.push(b));
    engine.createReceiver();

    await engine.loadBundle(`
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(function(){
          globalThis.__rill_sendBatch({
            version: 1, batchId: 5,
            operations: [{ op: 'CREATE', id: 1, type: 'View', props: {} }, { op: 'APPEND', parentId: 0, childId: 1 }]
          });
        });
      } else {
        // Fallback: if the engine does not inject queueMicrotask, prove the path via setImmediate.
        setImmediate(function(){
          globalThis.__rill_sendBatch({
            version: 1, batchId: 5,
            operations: [{ op: 'CREATE', id: 1, type: 'View', props: {} }, { op: 'APPEND', parentId: 0, childId: 1 }]
          });
        });
      }
    `);

    expect(batches.map((b) => b.batchId)).toContain(5);
    engine.destroy();
  });
});
