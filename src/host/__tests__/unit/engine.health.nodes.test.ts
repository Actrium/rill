import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

function makeBatch(n: number) {
  return {
    operations: Array.from({ length: n }, (_, i) => ({
      op: 'CREATE',
      id: i + 1,
      type: 'View',
      // biome-ignore lint/suspicious/noExplicitAny: Test node with dynamic structure
      props: {} as any,
    })),
    // biome-ignore lint/suspicious/noExplicitAny: Test data has dynamic structure
  } as any;
}

describe('Engine health receiverNodes', () => {
  it('reflects receiver node count after applyBatch', async () => {
    const engine = new Engine({ sandbox: 'vm', debug: false });
    await Promise.resolve().then(() => engine.loadBundle('console.log("ok")'));
    const receiver = engine.createReceiver();
    receiver.applyBatch(makeBatch(7));
    const health = engine.getDiagnostics().health;
    expect(health.receiverNodes).toBe(7);
  });
});
