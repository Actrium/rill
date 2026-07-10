/**
 * WorkerDispatch routing-invariant tests (Milestone B web-debug side).
 *
 * These drive the REAL {@link WorkerDispatch} (the in-worker message state machine) with a
 * mock engine and a capturing `post`, fully headless — no Worker, no QuickJS-WASM. They pin
 * the cross-unwind evaluate-on-frame routing invariant on the worker side:
 *
 *   - guest-eval entry (load/event/invoke) is serialized by the TurnGate while a debug
 *     session is live, so a turn parked at a breakpoint blocks LATER eval turns;
 *   - `dbg.evaluateOnCallFrame` and `dbg.getProperties` BYPASS that gate — they round-trip
 *     even while a suspend is outstanding, because they are sub-operations OF the suspended
 *     turn, not new eval turns (queuing them behind it would deadlock the resume);
 *   - with no debug session the gate is transparent (release eval path untouched).
 */

import { describe, expect, it } from 'bun:test';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol';
import { type GuestEngineLike, isControlPlaneDbg, WorkerDispatch } from '../worker-dispatch';

/** Yield a few microtask turns so the gate's per-turn settle chain drains. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Records everything the dispatch drives into the engine, so we can assert gating. */
class MockEngine {
  events: Array<{ name: string; payload: unknown }> = [];
  invokes: string[] = [];
  loads: string[] = [];
  destroyed = false;
  #handlers = new Map<string, (arg?: unknown) => void>();

  on(event: string, cb: (arg?: unknown) => void): void {
    this.#handlers.set(event, cb);
  }
  emit(event: string, arg?: unknown): void {
    this.#handlers.get(event)?.(arg);
  }
  async loadBundle(source: string): Promise<void> {
    this.loads.push(source);
  }
  sendEvent(name: string, payload?: unknown): void {
    this.events.push({ name, payload });
  }
  invokeGuestCallback(fnId: string): unknown {
    this.invokes.push(fnId);
    return undefined;
  }
  updateConfig(): void {}
  pause(): void {}
  resume(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

interface Harness {
  dispatch: WorkerDispatch;
  posted: WorkerToMainMessage[];
  engine: MockEngine;
  send: (m: MainToWorkerMessage) => void;
  last: <T extends WorkerToMainMessage['type']>(
    type: T
  ) => Extract<WorkerToMainMessage, { type: T }> | undefined;
  count: (type: WorkerToMainMessage['type']) => number;
}

function setup(opts: { throwOnInit?: boolean } = {}): Harness {
  const posted: WorkerToMainMessage[] = [];
  const engine = new MockEngine();
  const dispatch = new WorkerDispatch({
    post: (m) => posted.push(m),
    createEngine: () => {
      if (opts.throwOnInit) throw new Error('boom');
      return engine as unknown as GuestEngineLike;
    },
  });
  const send = (m: MainToWorkerMessage) => dispatch.handle(m);
  const last = <T extends WorkerToMainMessage['type']>(type: T) => {
    for (let i = posted.length - 1; i >= 0; i--) {
      if (posted[i].type === type) return posted[i] as Extract<WorkerToMainMessage, { type: T }>;
    }
    return undefined;
  };
  const count = (type: WorkerToMainMessage['type']) => posted.filter((m) => m.type === type).length;
  return { dispatch, posted, engine, send, last, count };
}

function init(h: Harness): void {
  h.send({ type: 'init', sandbox: 'wasm-quickjs' });
}

describe('WorkerDispatch — init and lifecycle', () => {
  it('posts ready after a successful init', () => {
    const h = setup();
    init(h);
    expect(h.last('ready')).toBeDefined();
  });

  it('posts initError when engine construction throws', () => {
    const h = setup({ throwOnInit: true });
    init(h);
    expect(h.last('initError')?.error.message).toBe('boom');
    expect(h.last('ready')).toBeUndefined();
  });

  it('routes a guest event straight to the engine when no debug session is live', () => {
    const h = setup();
    init(h);
    h.send({ type: 'event', turnId: 1, eventName: 'tap', payload: { x: 1 } });
    expect(h.engine.events).toEqual([{ name: 'tap', payload: { x: 1 } }]);
    expect(h.last('turnDone')?.turnId).toBe(1);
    // Release path: the gate never took a slot.
    expect(h.dispatch.pendingTurns).toBe(0);
    expect(h.dispatch.isSuspended).toBe(false);
  });
});

describe('WorkerDispatch — control-plane dbg ops bypass the guest-eval gate', () => {
  it('classifies evaluateOnCallFrame and getProperties as control-plane (and others not)', () => {
    expect(isControlPlaneDbg('dbg.evaluateOnCallFrame')).toBe(true);
    expect(isControlPlaneDbg('dbg.getProperties')).toBe(true);
    expect(isControlPlaneDbg('dbg.pause')).toBe(false);
    expect(isControlPlaneDbg('event')).toBe(false);
  });

  it('a turn parked at a breakpoint does NOT block a dbg.evaluate / dbg.getProperties round-trip', () => {
    const h = setup();
    init(h);
    h.send({ type: 'dbg.enable', requestId: 1 });

    // A breakpoint parks the current turn: the gate is now suspended.
    h.send({ type: 'dbg.pause', requestId: 2 });
    expect(h.dispatch.isSuspended).toBe(true);

    // A NEW guest-eval turn must queue BEHIND the suspend — the engine must not see it.
    h.send({ type: 'event', turnId: 10, eventName: 'queued', payload: null });
    expect(h.engine.events).toEqual([]);
    expect(h.dispatch.pendingTurns).toBe(1);
    expect(h.count('turnDone')).toBe(0);

    // Control-plane ops of the suspended turn still resolve — they bypass the gate.
    h.send({ type: 'dbg.evaluateOnCallFrame', requestId: 3, callFrameId: '0', expression: 'x' });
    expect(h.last('dbg.evalResult')?.requestId).toBe(3);

    h.send({ type: 'dbg.getProperties', requestId: 4, objectId: '0:local' });
    const props = h.last('dbg.propertiesResult');
    expect(props?.requestId).toBe(4);
    expect(props?.properties).toEqual([]);

    // The bypass did not disturb the gate: still suspended, the eval turn still parked.
    expect(h.dispatch.isSuspended).toBe(true);
    expect(h.dispatch.pendingTurns).toBe(1);
    expect(h.engine.events).toEqual([]);
  });

  it('resume drains the queued guest-eval turns in FIFO order', async () => {
    const h = setup();
    init(h);
    h.send({ type: 'dbg.enable', requestId: 1 });
    h.send({ type: 'dbg.pause', requestId: 2 });

    h.send({ type: 'event', turnId: 10, eventName: 'first', payload: null });
    h.send({ type: 'event', turnId: 11, eventName: 'second', payload: null });
    expect(h.engine.events).toEqual([]);
    expect(h.dispatch.pendingTurns).toBe(2);

    h.send({ type: 'dbg.resume', requestId: 5 });
    expect(h.dispatch.isSuspended).toBe(false);
    // The gate settles each turn on a microtask, so it drains one turn per microtask turn.
    await flush();
    expect(h.engine.events.map((e) => e.name)).toEqual(['first', 'second']);
    expect(h.count('turnDone')).toBe(2);
  });

  it('control-plane ops also resolve when nothing is suspended', () => {
    const h = setup();
    init(h);
    h.send({ type: 'dbg.enable', requestId: 1 });
    h.send({ type: 'dbg.evaluateOnCallFrame', requestId: 2, callFrameId: '0', expression: '1' });
    h.send({ type: 'dbg.getProperties', requestId: 3, objectId: 'obj:1' });
    expect(h.last('dbg.evalResult')?.requestId).toBe(2);
    expect(h.last('dbg.propertiesResult')?.requestId).toBe(3);
  });

  it('dbg.disable drains the gate and restores the direct eval path', () => {
    const h = setup();
    init(h);
    h.send({ type: 'dbg.enable', requestId: 1 });
    h.send({ type: 'dbg.pause', requestId: 2 });
    h.send({ type: 'event', turnId: 10, eventName: 'parked', payload: null });
    expect(h.dispatch.pendingTurns).toBe(1);

    h.send({ type: 'dbg.disable', requestId: 3 });
    // Disable resumes the gate (drains the parked turn) and drops back to direct eval.
    expect(h.dispatch.isSuspended).toBe(false);
    expect(h.engine.events.map((e) => e.name)).toEqual(['parked']);

    // A subsequent event runs directly again.
    h.send({ type: 'event', turnId: 11, eventName: 'direct', payload: null });
    expect(h.engine.events.map((e) => e.name)).toEqual(['parked', 'direct']);
    expect(h.dispatch.pendingTurns).toBe(0);
  });
});
