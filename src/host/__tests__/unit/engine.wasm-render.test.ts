/**
 * Engine render round-trip on the wasm-quickjs provider (issue #8)
 *
 * Regression guard for the render channel: a guest `__rill_sendBatch(batch)` call must
 * reach the host Bridge/Receiver. Before the WASM provider's inject(fn) fix, the engine
 * injected `__rill_sendBatch` as a host closure that the provider rewrote into a
 * self-referential `CALL_HOST_FN` stub — so the batch never reached the host (and
 * injecting it caused infinite recursion). This drives the real Engine on the real
 * wasm-quickjs sandbox and asserts the host received the batch.
 *
 * Note: this exercises the render CHANNEL (sendBatch -> Bridge -> Receiver) directly,
 * not the full React scheduler (timer/callback integration on wasm is a separate
 * concern — the engine currently overrides the provider's native timers).
 */

import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';
import type { OperationBatch } from '../../types';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

describeIfWASM('Engine render channel on wasm-quickjs (issue #8)', () => {
  it('delivers a guest render batch to the host Receiver', async () => {
    const engine = new Engine({ sandbox: 'wasm-quickjs' });
    // Reason: mock host components for the receiver registry
    // biome-ignore lint/suspicious/noExplicitAny: test mock components
    engine.register({ View: ((p: any) => p) as any, Text: ((p: any) => p) as any });

    const batches: OperationBatch[] = [];
    engine.on('operation', (batch) => batches.push(batch));
    engine.createReceiver();

    await engine.loadBundle(`
      globalThis.__rill_sendBatch({
        version: 1,
        batchId: 1,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: {} },
          { op: 'APPEND', parentId: 0, childId: 1 }
        ]
      });
    `);

    // The batch crossed the WASM boundary and reached the host bridge/receiver.
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0]?.batchId).toBe(1);
    expect(batches[0]?.operations?.length).toBe(2);

    const receiver = engine.getReceiver();
    expect(receiver).not.toBeNull();

    engine.destroy();
  });
});
