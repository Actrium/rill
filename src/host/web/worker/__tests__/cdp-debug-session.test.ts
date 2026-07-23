/**
 * CdpDebugSession — REAL fat-CDP-debug-wasm end-to-end (Milestone B web-debug, design P2).
 *
 * Drives {@link CdpDebugSession} against the ACTUAL artifact
 * (native/quickjs/build-debug/quickjs-cdp-debug.mjs — the real CDP engine compiled with
 * Asyncify), not a mock. It proves the full CDP round-trip over a breakpoint suspend
 * through the session's public surface:
 *   enable → setBreakpoint(guest.js) → runGuest → Debugger.paused arrives →
 *   sendCdp evaluateOnCallFrame resolves the arg/local/closure while the C stack is
 *   unwound → resume → runGuest's Promise resolves 0.
 * and the routing invariant:
 *   while a guest turn is PARKED at the breakpoint, a sendCdp round-trip still completes
 *   (control plane BYPASSES the gate) and a second runGuest QUEUES behind the parked turn
 *   (guest-eval entry is serialized by the TurnGate).
 *
 * Build the artifact first:
 *   source /ext/emsdk/emsdk_env.sh && bash native/quickjs/build-wasm-cdp.sh
 * When it is absent (CI without emsdk) these cases are skipped; the mock companion suite
 * (cdp-debug-session.mock.test.ts) still covers the glue.
 *
 * Bun drives the Asyncify rewind natively; the node harness (run-cdp-wasm.mjs) needs
 * `--stack-size=4000`, but `bun test` does not.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CdpDebugSession, type CdpDebugModule } from '../cdp-debug-session';
import { TurnGate } from '../turn-gate';

const ARTIFACT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'native',
  'quickjs',
  'build-debug',
  'quickjs-cdp-debug.mjs'
);
const HAS_WASM = existsSync(ARTIFACT);

// Line 5 (CDP lineNumber 4) is where greet's arg (name), local (count) and closure (base)
// all hold values — identical to native/quickjs/test/run-cdp-wasm.mjs.
const SRC = [
  'function make(base) {', // 1
  '  return function greet(name) {', // 2
  '    var count = base + 1;', // 3
  "    var msg = 'hi ' + name;", // 4
  '    globalThis.out = msg;', // 5  <-- breakpoint (CDP lineNumber 4)
  '    return msg;', // 6
  '  };', // 7
  '}', // 8
  'var g = make(10);', // 9
  "g('world');", // 10
].join('\n');
const BP_CDP_LINE = 4;

const tick = () => new Promise((r) => setTimeout(r, 0));

async function loadRealModule(): Promise<CdpDebugModule> {
  const factory = (await import(ARTIFACT)).default as () => Promise<CdpDebugModule>;
  return factory();
}

/** A capturing sink + watchdog counters + a fresh session over the real wasm. */
function makeHarness() {
  const inbox: Array<{ id?: number; method?: string; [k: string]: unknown }> = [];
  let paused = 0;
  let resumed = 0;
  const gate = new TurnGate();
  const session = new CdpDebugSession({
    gate,
    loadModule: loadRealModule,
    sink: (_connId, json) => inbox.push(JSON.parse(json)),
    onPaused: () => {
      paused += 1;
    },
    onResumed: () => {
      resumed += 1;
    },
  });
  return {
    session,
    gate,
    inbox,
    responseFor: (id: number) => inbox.find((m) => m.id === id),
    eventFor: (method: string) => inbox.find((m) => m.method === method),
    counts: () => ({ paused, resumed }),
  };
}

describe.skipIf(!HAS_WASM)('CdpDebugSession over the real fat CDP debug wasm', () => {
  it('full session: enable → setBreakpoint → runGuest pauses → evaluateOnCallFrame → resume', async () => {
    const h = makeHarness();
    await h.session.startSession(1);

    h.session.sendCdp(1, JSON.stringify({ id: 1, method: 'Debugger.enable' }));
    expect(h.responseFor(1)).toBeDefined();

    h.session.sendCdp(
      1,
      JSON.stringify({
        id: 2,
        method: 'Debugger.setBreakpoint',
        params: { location: { scriptId: 'guest.js', lineNumber: BP_CDP_LINE } },
      })
    );
    expect(JSON.stringify(h.responseFor(2))).toContain('breakpointId');

    // Run the guest: it must pause at the breakpoint (Asyncify unwind). The Promise stays
    // pending across the pause — the whole point of the gate slot staying busy.
    let settled = false;
    const evalP = h.session.runGuest(SRC).then((rc) => {
      settled = true;
      return rc;
    });
    await tick();

    expect(JSON.stringify(h.eventFor('Debugger.scriptParsed'))).toContain('guest.js');
    expect(h.eventFor('Debugger.paused')).toBeDefined();
    expect(settled).toBe(false);
    // Watchdog: the breakpoint disarmed the eval watchdog (must not terminate the worker).
    expect(h.counts().paused).toBe(1);
    expect(h.counts().resumed).toBe(0);

    // Evaluate in the paused frame over the pipe while the C stack is gone.
    h.session.sendCdp(
      1,
      JSON.stringify({
        id: 10,
        method: 'Debugger.evaluateOnCallFrame',
        params: { callFrameId: '0', expression: 'name' },
      })
    );
    expect(JSON.stringify(h.responseFor(10))).toContain('"value":"world"');
    h.session.sendCdp(
      1,
      JSON.stringify({
        id: 11,
        method: 'Debugger.evaluateOnCallFrame',
        params: { callFrameId: '0', expression: 'count' },
      })
    );
    expect(JSON.stringify(h.responseFor(11))).toContain('"value":11');

    // Resume: Asyncify rewinds and the guest eval completes.
    h.session.sendCdp(1, JSON.stringify({ id: 3, method: 'Debugger.resume' }));
    const rc = await evalP;
    expect(rc).toBe(0);
    expect(settled).toBe(true);
    expect(h.eventFor('Debugger.resumed')).toBeDefined();
    // Watchdog rearmed on resume.
    expect(h.counts().resumed).toBe(1);
  });

  it('a parked guest turn does not block a sendCdp round-trip; a new runGuest queues behind it', async () => {
    const h = makeHarness();
    await h.session.startSession(1);
    h.session.sendCdp(1, JSON.stringify({ id: 1, method: 'Debugger.enable' }));
    h.session.sendCdp(
      1,
      JSON.stringify({
        id: 2,
        method: 'Debugger.setBreakpoint',
        params: { location: { scriptId: 'guest.js', lineNumber: BP_CDP_LINE } },
      })
    );

    // Turn 1 parks at the breakpoint.
    let settled1 = false;
    const p1 = h.session.runGuest(SRC).then((rc) => {
      settled1 = true;
      return rc;
    });
    await tick();
    expect(h.eventFor('Debugger.paused')).toBeDefined();
    expect(settled1).toBe(false);

    // Turn 2 must QUEUE behind the parked turn — the gate slot is busy. Its guest body
    // (a fresh one-liner that never hits the breakpoint) must NOT have run yet.
    let settled2 = false;
    const p2 = h.session.runGuest('globalThis.__second = 41;').then((rc) => {
      settled2 = true;
      return rc;
    });
    await tick();
    expect(h.gate.pending + (h.gate.isBusy ? 1 : 0)).toBeGreaterThanOrEqual(1);
    expect(settled2).toBe(false);

    // BYPASS proof: a control-plane round-trip completes while turn 1 is parked AND turn 2
    // is queued — sendCdp never takes a gate slot, so it services the pause without deadlock.
    h.session.sendCdp(
      1,
      JSON.stringify({
        id: 10,
        method: 'Debugger.evaluateOnCallFrame',
        params: { callFrameId: '0', expression: 'base' },
      })
    );
    expect(JSON.stringify(h.responseFor(10))).toContain('"value":10');
    // The queued turn STILL has not run (proves it is serialized behind the parked turn).
    expect(settled2).toBe(false);

    // Resume turn 1; then turn 2 drains and runs to completion.
    h.session.sendCdp(1, JSON.stringify({ id: 3, method: 'Debugger.resume' }));
    expect(await p1).toBe(0);
    expect(await p2).toBe(0);
    expect(settled1).toBe(true);
    expect(settled2).toBe(true);
  });
});
