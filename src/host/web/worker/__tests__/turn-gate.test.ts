/**
 * TurnGate unit tests (Milestone B web side).
 *
 * The gate is a pure state machine, so these drive it with fake deferred turns —
 * no worker, no wasm. They pin the two load-bearing guarantees:
 *   - strict FIFO entry, with an in-flight turn blocking the next;
 *   - while a suspend (breakpoint) is outstanding, new turns queue and only drain
 *     in order once resume clears it — even after the parked turn itself settles.
 */

import { describe, expect, it } from 'bun:test';
import { TurnGate } from '../turn-gate';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TurnGate', () => {
  it('runs synchronously-resolving turns in FIFO order', async () => {
    const gate = new TurnGate();
    const order: number[] = [];
    const runs = [1, 2, 3].map((n) => gate.run(() => order.push(n)));
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it('resolves with the turn function result', async () => {
    const gate = new TurnGate();
    await expect(gate.run(() => 42)).resolves.toBe(42);
    await expect(gate.run(async () => 'x')).resolves.toBe('x');
  });

  it('rejects when a turn throws, and still frees the gate for the next', async () => {
    const gate = new TurnGate();
    const order: string[] = [];
    const bad = gate.run(() => {
      order.push('bad');
      throw new Error('boom');
    });
    const good = gate.run(() => order.push('good'));
    await expect(bad).rejects.toThrow('boom');
    await good;
    expect(order).toEqual(['bad', 'good']);
    expect(gate.isBusy).toBe(false);
  });

  it('blocks the next turn while one is in flight', async () => {
    const gate = new TurnGate();
    const order: string[] = [];
    const d = deferred<void>();

    const pA = gate.run(() => {
      order.push('A');
      return d.promise;
    });
    const pB = gate.run(() => {
      order.push('B');
    });

    await Promise.resolve();
    // A started and is still running; B must not have started.
    expect(order).toEqual(['A']);
    expect(gate.isBusy).toBe(true);
    expect(gate.pending).toBe(1);

    d.resolve();
    await pA;
    await pB;
    expect(order).toEqual(['A', 'B']);
    expect(gate.isBusy).toBe(false);
  });

  it('while suspended, new turns queue and drain in order only on resume', async () => {
    const gate = new TurnGate();
    const order: number[] = [];

    gate.onSuspend();
    const runs = [1, 2, 3].map((n) => gate.run(() => order.push(n)));

    await Promise.resolve();
    expect(order).toEqual([]);
    expect(gate.isSuspended).toBe(true);
    expect(gate.pending).toBe(3);

    gate.onResume();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a suspend raised inside a turn holds back queued turns until resume', async () => {
    // Mirrors the breakpoint case: a turn starts, suspends its own Asyncify stack,
    // and its eval Promise settles later — but the NEXT turn must still wait for
    // an explicit resume, not just for the parked turn to settle.
    const gate = new TurnGate();
    const order: string[] = [];
    const evalDone = deferred<void>();

    const pA = gate.run(() => {
      order.push('A');
      gate.onSuspend();
      return evalDone.promise;
    });
    const pB = gate.run(() => {
      order.push('B');
    });

    await Promise.resolve();
    expect(order).toEqual(['A']);

    // The parked turn's eval Promise settles, but suspend is still outstanding.
    evalDone.resolve();
    await pA;
    await Promise.resolve();
    expect(order).toEqual(['A']);
    expect(gate.isSuspended).toBe(true);

    gate.onResume();
    await pB;
    expect(order).toEqual(['A', 'B']);
  });
});
