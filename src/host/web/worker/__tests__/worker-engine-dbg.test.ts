/**
 * WorkerEngine debugger-surface tests (Milestone B web side).
 *
 * Drives the dbg* methods against a MOCK worker (no real worker/wasm), so these
 * are fully headless. They pin:
 *   - requestId correlation: a dbg* call resolves on its matching ack /
 *     breakpointResolved / evalResult and no other;
 *   - the watchdog contract that makes breakpoints safe: `dbg.paused` DISARMS the
 *     offending turn's watchdog (an intentional unbounded pause must never trip
 *     terminate()), and `dbg.resumed` REARMS it;
 *   - paused/resumed/scriptParsed events surface to listeners.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol';
import { WorkerEngine } from '../worker-engine';

/** Let a watchdog window elapse (timer under test — not a sync barrier). */
function elapse(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Yield a few microtask turns so queued posts/promise chains settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class MockWorker {
  onmessage: ((event: { data: WorkerToMainMessage }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: MainToWorkerMessage[] = [];
  terminated = false;

  postMessage(message: MainToWorkerMessage): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate a worker->main message. */
  emit(message: WorkerToMainMessage): void {
    this.onmessage?.({ data: message });
  }

  /** Most recent sent message of a given type. */
  last<T extends MainToWorkerMessage['type']>(
    type: T
  ): Extract<MainToWorkerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i];
      if (m.type === type) return m as Extract<MainToWorkerMessage, { type: T }>;
    }
    return undefined;
  }
}

function setup(opts: { watchdogTimeout?: number } = {}): { engine: WorkerEngine; mock: MockWorker } {
  const mock = new MockWorker();
  const engine = new WorkerEngine({
    sandbox: 'wasm-quickjs',
    createWorker: () => mock as unknown as Worker,
    watchdogTimeout: opts.watchdogTimeout ?? 5000,
  });
  // The proxy queues everything until it sees `ready`; unblock it.
  mock.emit({ type: 'ready' });
  return { engine, mock };
}

describe('WorkerEngine debugger surface', () => {
  let engine: WorkerEngine | null = null;

  afterEach(() => {
    engine?.destroy();
    engine = null;
  });

  it('correlates dbgEnable with dbg.ack by requestId', async () => {
    const s = setup();
    engine = s.engine;
    const p = s.engine.dbgEnable();
    const req = s.mock.last('dbg.enable');
    expect(req).toBeDefined();
    s.mock.emit({ type: 'dbg.ack', requestId: req?.requestId ?? -1 });
    await expect(p).resolves.toBeUndefined();
  });

  it('does not resolve a request on a mismatched requestId', async () => {
    const s = setup();
    engine = s.engine;
    const p = s.engine.dbgPause();
    const req = s.mock.last('dbg.pause');
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    // Ack for a different request must not resolve this one.
    s.mock.emit({ type: 'dbg.ack', requestId: (req?.requestId ?? 0) + 999 });
    await flush();
    expect(settled).toBe(false);
    s.mock.emit({ type: 'dbg.ack', requestId: req?.requestId ?? -1 });
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves dbgSetBreakpoint with the reported location', async () => {
    const s = setup();
    engine = s.engine;
    const p = s.engine.dbgSetBreakpoint({ url: 'app.js', line: 3 });
    const req = s.mock.last('dbg.setBreakpoint');
    expect(req?.url).toBe('app.js');
    s.mock.emit({
      type: 'dbg.breakpointResolved',
      requestId: req?.requestId ?? -1,
      breakpointId: 'bp-1',
      location: { scriptId: 's1', line: 3, column: 0 },
    });
    const result = await p;
    expect(result.breakpointId).toBe('bp-1');
    expect(result.location).toEqual({ scriptId: 's1', line: 3, column: 0 });
  });

  it('resolves dbgEvaluateOnCallFrame with the eval result', async () => {
    const s = setup();
    engine = s.engine;
    const p = s.engine.dbgEvaluateOnCallFrame('0', 'x * 2');
    const req = s.mock.last('dbg.evaluateOnCallFrame');
    expect(req?.expression).toBe('x * 2');
    s.mock.emit({ type: 'dbg.evalResult', requestId: req?.requestId ?? -1, ok: true, value: 84 });
    expect(await p).toEqual({ ok: true, value: 84, error: undefined });
  });

  it('resolves dbgGetProperties with the reported property descriptors', async () => {
    const s = setup();
    engine = s.engine;
    const p = s.engine.dbgGetProperties('0:local');
    const req = s.mock.last('dbg.getProperties');
    expect(req?.objectId).toBe('0:local');
    const properties = [
      { name: 'x', value: 42, writable: true, configurable: true, enumerable: true },
    ];
    s.mock.emit({ type: 'dbg.propertiesResult', requestId: req?.requestId ?? -1, properties });
    expect(await p).toEqual(properties);
  });

  it('control-plane dbg ops round-trip while a turn is paused (never queued behind it)', async () => {
    // The routing invariant, main-thread half: evaluateOnCallFrame / getProperties are
    // plain request/reply that never arm a turn/watchdog, so a paused (suspended) turn
    // does not block them — proven here by resolving both while a load turn is paused.
    const s = setup({ watchdogTimeout: 60 });
    engine = s.engine;

    const loadP = s.engine.loadBundle('noop');
    loadP.catch(() => undefined);
    await flush();
    const turnId = s.mock.last('load')?.turnId ?? -1;
    // Park the load turn at a breakpoint (its watchdog is disarmed by dbg.paused).
    s.mock.emit({ type: 'dbg.paused', turnId, reason: 'breakpoint', callFrames: [], hitBreakpoints: [] });

    const evalP = s.engine.dbgEvaluateOnCallFrame('0', 'x');
    const evalReq = s.mock.last('dbg.evaluateOnCallFrame');
    s.mock.emit({ type: 'dbg.evalResult', requestId: evalReq?.requestId ?? -1, ok: true, value: 7 });
    expect(await evalP).toEqual({ ok: true, value: 7, error: undefined });

    const propsP = s.engine.dbgGetProperties('0:local');
    const propsReq = s.mock.last('dbg.getProperties');
    const properties = [{ name: 'x', value: 7, writable: true, configurable: true, enumerable: true }];
    s.mock.emit({ type: 'dbg.propertiesResult', requestId: propsReq?.requestId ?? -1, properties });
    expect(await propsP).toEqual(properties);

    // The paused turn is still parked (no completion arrived), and the engine is alive.
    expect(s.engine.isDestroyed).toBe(false);
  });

  it('emits paused / resumed / scriptParsed from worker dbg events', () => {
    const s = setup();
    engine = s.engine;
    const paused: Array<{ turnId: number; reason: string; hitBreakpoints: string[] }> = [];
    const resumed: number[] = [];
    const scripts: string[] = [];
    s.engine.on('paused', (info) =>
      paused.push({ turnId: info.turnId, reason: info.reason, hitBreakpoints: info.hitBreakpoints })
    );
    s.engine.on('resumed', (info) => resumed.push(info.turnId));
    s.engine.on('scriptParsed', (script) => scripts.push(script.scriptId));

    s.mock.emit({
      type: 'dbg.scriptParsed',
      script: { scriptId: 's1', url: 'app.js', startLine: 0, endLine: 9, hash: 'h' },
    });
    s.mock.emit({
      type: 'dbg.paused',
      turnId: 5,
      reason: 'breakpoint',
      callFrames: [],
      hitBreakpoints: ['bp-1'],
    });
    s.mock.emit({ type: 'dbg.resumed', turnId: 5 });

    expect(scripts).toEqual(['s1']);
    expect(paused).toEqual([{ turnId: 5, reason: 'breakpoint', hitBreakpoints: ['bp-1'] }]);
    expect(resumed).toEqual([5]);
  });

  it('dbg.paused disarms the turn watchdog so a breakpoint does not terminate', async () => {
    const s = setup({ watchdogTimeout: 60 });
    engine = s.engine;
    let fatal: Error | null = null;
    s.engine.on('fatalError', (e) => {
      fatal = e;
    });

    const loadP = s.engine.loadBundle('noop');
    // loadBundle chains off the ready promise; let the load post land.
    loadP.catch(() => undefined);
    await flush();

    const load = s.mock.last('load');
    expect(load).toBeDefined();
    const turnId = load?.turnId ?? -1;

    // Hit a breakpoint before the 60ms watchdog fires.
    s.mock.emit({ type: 'dbg.paused', turnId, reason: 'breakpoint', callFrames: [], hitBreakpoints: [] });

    // Wait well past the watchdog window: it must NOT fire while paused.
    await elapse(160);
    expect(s.engine.isDestroyed).toBe(false);
    expect(s.mock.terminated).toBe(false);
    expect(fatal).toBeNull();
  });

  it('dbg.resumed rearms the watchdog', async () => {
    const s = setup({ watchdogTimeout: 60 });
    engine = s.engine;
    let fatal: Error | null = null;
    s.engine.on('fatalError', (e) => {
      fatal = e;
    });

    const loadP = s.engine.loadBundle('noop');
    loadP.catch(() => undefined);
    await flush();
    const turnId = s.mock.last('load')?.turnId ?? -1;

    s.mock.emit({ type: 'dbg.paused', turnId, reason: 'breakpoint', callFrames: [], hitBreakpoints: [] });
    await elapse(120);
    // Still alive: the paused turn's watchdog stayed disarmed.
    expect(s.engine.isDestroyed).toBe(false);

    // Resume rearms; with no completion coming, the rearmed watchdog now fires.
    s.mock.emit({ type: 'dbg.resumed', turnId });
    await elapse(160);
    expect(s.engine.isDestroyed).toBe(true);
    expect(fatal).not.toBeNull();
    expect((fatal as unknown as Error).message).toMatch(/watchdog/);
  });
});
