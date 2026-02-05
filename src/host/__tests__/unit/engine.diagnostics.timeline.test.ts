import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

function makeBatch(batchId: number, ops: number) {
  return {
    version: 1,
    batchId,
    operations: Array.from({ length: ops }, (_, i) => ({
      op: 'CREATE' as const,
      id: batchId * 1000 + i + 1,
      type: 'View',
      props: {},
    })),
  };
}

describe('Engine diagnostics timeline', () => {
  it('aggregates ops/skip/apply into activity.timeline buckets', async () => {
    const engine = new Engine({
      sandbox: 'vm',
      receiverMaxBatchSize: 2,
      diagnostics: { activityHistoryMs: 10_000, activityBucketMs: 1000 },
    });
    await engine.loadBundle('globalThis.__noop = 1;');
    engine.createReceiver();

    // Feed batches directly through Bridge (simulates Guest → Host traffic)
    // biome-ignore lint/suspicious/noExplicitAny: access private field in unit test
    const bridge = (engine as any).bridge as { sendRawBatch?: (b: unknown) => void } | null;
    expect(typeof bridge?.sendRawBatch).toBe('function');

    bridge!.sendRawBatch!(makeBatch(1, 5));
    bridge!.sendRawBatch!(makeBatch(2, 3));

    const d = engine.getDiagnostics();
    const timeline = d.activity.timeline;
    expect(timeline).toBeTruthy();
    expect(timeline!.bucketMs).toBe(1000);
    expect(timeline!.points.length).toBeGreaterThan(0);

    const totalOps = timeline!.points.reduce((sum, p) => sum + p.ops, 0);
    const totalSkipped = timeline!.points.reduce((sum, p) => sum + p.skippedOps, 0);
    expect(totalOps).toBe(8);
    // First batch 5 ops, receiverMaxBatchSize=2 => skipped 3; second batch 3 ops => skipped 1
    expect(totalSkipped).toBe(4);
    expect(timeline!.points.some((p) => p.applyDurationMsAvg != null)).toBe(true);
  });
});
