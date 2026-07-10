/**
 * CdpDebugSession — glue unit tests against a MOCK module implementing the WASM CONTRACT.
 *
 * These run everywhere (no emsdk / no built artifact) and pin the pure glue the real-wasm
 * suite (cdp-debug-session.test.ts) exercises end-to-end:
 *   - the outbound sink is installed BEFORE qjsd_cdp_init, and every outbound message is
 *     forwarded to it byte-for-byte (no CDP translation in TS);
 *   - the watchdog is disarmed on `Debugger.paused` and rearmed on `Debugger.resumed`;
 *   - runGuest is serialized by the TurnGate (a parked turn blocks a later runGuest) while
 *     sendCdp BYPASSES the gate and round-trips during the pause.
 *
 * The mock is a faithful stand-in for the contract in native/quickjs/src/
 * qjs_cdp_wasm_bindings.cpp: dispatch is synchronous and answers via __rillCdp.onMessage;
 * eval is async, emits scriptParsed+paused when a breakpoint is armed, and its Promise only
 * resolves after a `Debugger.resume` dispatch.
 */

import { describe, expect, it } from 'bun:test';
import { CdpDebugSession, type CdpDebugModule } from '../cdp-debug-session';
import { TurnGate } from '../turn-gate';

interface RillCdpGlobal {
  onMessage(connId: number, json: string): void;
}

/** A controllable mock of the fat CDP debug wasm's ccall surface. */
class MockCdpModule implements CdpDebugModule {
  initCalls = 0;
  connected: number[] = [];
  disconnected: number[] = [];
  dispatched: string[] = [];
  evalCalls = 0;
  /** True after setBreakpoint: the next eval parks until a resume dispatch. */
  #armed = false;
  #connId = 0;
  #resolveEval: ((rc: number) => void) | null = null;
  /** Was the sink already installed at the instant qjsd_cdp_init ran? */
  sinkAtInit = false;

  #emit(obj: Record<string, unknown>): void {
    const cdp = (globalThis as { __rillCdp?: RillCdpGlobal }).__rillCdp;
    cdp?.onMessage(this.#connId || 1, JSON.stringify(obj));
  }

  ccall(name: string, _ret: string | null, _argT: string[], args: unknown[]): unknown {
    switch (name) {
      case 'qjsd_cdp_init':
        this.initCalls += 1;
        this.sinkAtInit = !!(globalThis as { __rillCdp?: RillCdpGlobal }).__rillCdp;
        return 0;
      case 'qjsd_cdp_connect':
        this.#connId = args[0] as number;
        this.connected.push(args[0] as number);
        return undefined;
      case 'qjsd_cdp_disconnect':
        this.disconnected.push(args[0] as number);
        return undefined;
      case 'qjsd_cdp_dispatch': {
        const json = args[1] as string;
        this.dispatched.push(json);
        const msg = JSON.parse(json) as { id?: number; method?: string };
        this.#answer(msg);
        return undefined;
      }
      case 'qjsd_cdp_eval': {
        this.evalCalls += 1;
        if (this.#armed) {
          // Breakpoint: announce the script + a pause, then park the Promise.
          this.#emit({ method: 'Debugger.scriptParsed', params: { url: 'guest.js' } });
          this.#emit({ method: 'Debugger.paused', params: { callFrames: [] } });
          return new Promise<number>((resolve) => {
            this.#resolveEval = resolve;
          });
        }
        // No breakpoint: runs straight to completion.
        return Promise.resolve(0);
      }
      default:
        return undefined;
    }
  }

  #answer(msg: { id?: number; method?: string }): void {
    switch (msg.method) {
      case 'Debugger.setBreakpoint':
        this.#armed = true;
        this.#emit({ id: msg.id, result: { breakpointId: 'bp:1' } });
        break;
      case 'Debugger.evaluateOnCallFrame':
        this.#emit({ id: msg.id, result: { result: { type: 'string', value: 'world' } } });
        break;
      case 'Debugger.resume': {
        this.#armed = false;
        this.#emit({ id: msg.id, result: {} });
        this.#emit({ method: 'Debugger.resumed', params: {} });
        const resolve = this.#resolveEval;
        this.#resolveEval = null;
        resolve?.(0);
        break;
      }
      default:
        this.#emit({ id: msg.id, result: {} });
    }
  }
}

function makeHarness() {
  const mod = new MockCdpModule();
  const inbox: string[] = [];
  let paused = 0;
  let resumed = 0;
  const gate = new TurnGate();
  const session = new CdpDebugSession({
    gate,
    loadModule: () => Promise.resolve(mod),
    sink: (_connId, json) => inbox.push(json),
    onPaused: () => {
      paused += 1;
    },
    onResumed: () => {
      resumed += 1;
    },
  });
  return { mod, session, gate, inbox, counts: () => ({ paused, resumed }) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CdpDebugSession glue (mock module implementing the WASM contract)', () => {
  it('installs the sink BEFORE qjsd_cdp_init and connects', async () => {
    const h = makeHarness();
    await h.session.startSession(7);
    expect(h.mod.initCalls).toBe(1);
    expect(h.mod.sinkAtInit).toBe(true);
    expect(h.mod.connected).toEqual([7]);
    expect(h.session.isReady).toBe(true);
  });

  it('lazily initializes once and is idempotent per connection id', async () => {
    const h = makeHarness();
    await h.session.startSession(1);
    await h.session.startSession(1);
    expect(h.mod.initCalls).toBe(1);
    expect(h.mod.connected).toEqual([1]);
  });

  it('forwards every outbound CDP message to the sink byte-for-byte (no translation)', async () => {
    const h = makeHarness();
    await h.session.startSession(1);
    h.session.sendCdp(1, JSON.stringify({ id: 1, method: 'Debugger.enable' }));
    expect(h.inbox).toHaveLength(1);
    // The exact bytes the wasm emitted — the session must not reshape them.
    expect(JSON.parse(h.inbox[0])).toEqual({ id: 1, result: {} });
  });

  it('disarms the watchdog on Debugger.paused and rearms it on Debugger.resumed', async () => {
    const h = makeHarness();
    await h.session.startSession(1);
    h.session.sendCdp(1, JSON.stringify({ id: 2, method: 'Debugger.setBreakpoint' }));

    const p = h.session.runGuest('run();');
    await tick();
    // paused event forwarded → onPaused fired exactly once, not yet resumed.
    expect(h.counts()).toEqual({ paused: 1, resumed: 0 });

    h.session.sendCdp(1, JSON.stringify({ id: 3, method: 'Debugger.resume' }));
    expect(await p).toBe(0);
    expect(h.counts()).toEqual({ paused: 1, resumed: 1 });
  });

  it('sendCdp bypasses the gate while a parked turn serializes a later runGuest', async () => {
    const h = makeHarness();
    await h.session.startSession(1);
    h.session.sendCdp(1, JSON.stringify({ id: 2, method: 'Debugger.setBreakpoint' }));

    // Turn 1 parks.
    let settled1 = false;
    const p1 = h.session.runGuest('parks();').then((rc) => {
      settled1 = true;
      return rc;
    });
    await tick();
    expect(settled1).toBe(false);
    expect(h.mod.evalCalls).toBe(1);

    // Turn 2 queues behind it — its eval must NOT have been issued to the module yet.
    let settled2 = false;
    const p2 = h.session.runGuest('later();').then((rc) => {
      settled2 = true;
      return rc;
    });
    await tick();
    expect(settled2).toBe(false);
    expect(h.mod.evalCalls).toBe(1);

    // Control-plane round-trip completes while turn 1 is parked AND turn 2 is queued.
    const before = h.inbox.length;
    h.session.sendCdp(
      1,
      JSON.stringify({
        id: 10,
        method: 'Debugger.evaluateOnCallFrame',
        params: { callFrameId: '0', expression: 'x' },
      })
    );
    expect(h.inbox.length).toBe(before + 1);
    expect(JSON.stringify(JSON.parse(h.inbox[h.inbox.length - 1]))).toContain('"value":"world"');
    expect(settled2).toBe(false);

    // Resume: turn 1 completes, then the gate drains turn 2 (no breakpoint → completes).
    h.session.sendCdp(1, JSON.stringify({ id: 3, method: 'Debugger.resume' }));
    expect(await p1).toBe(0);
    expect(await p2).toBe(0);
    expect(h.mod.evalCalls).toBe(2);
  });

  it('sendCdp before startSession throws (module not loaded)', () => {
    const h = makeHarness();
    expect(() => h.session.sendCdp(1, '{}')).toThrow('before startSession');
  });

  it('disconnect calls qjsd_cdp_disconnect only for a connected id', async () => {
    const h = makeHarness();
    await h.session.startSession(1);
    h.session.disconnect(2); // never connected → no-op
    h.session.disconnect(1);
    expect(h.mod.disconnected).toEqual([1]);
  });
});
