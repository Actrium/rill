/**
 * In-browser CDP debug E2E (design P4) — the last honest gap closed.
 *
 * Proves the WHOLE reverse-tunnel debugging chain works in a REAL headless browser, not
 * just in node (native/quickjs/test/run-cdp-wasm.mjs already proved the fat wasm speaks CDP
 * in a node event loop). What this test adds and de-risks:
 *   - Asyncify unwind/rewind actually works under the browser's JS engine, inside a module
 *     Web Worker — a breakpoint parks the guest C stack and resume rebuilds it.
 *   - The reverse-tunnel relay bridges a genuine OUTBOUND page WebSocket to an external raw
 *     CDP client, including /json target discovery.
 *   - The full pipe composes: raw CDP client -> relay -> page -> worker -> fat wasm -> back.
 *
 * The flow mirrors a real debugger attach: Debugger.enable, setBreakpoint, trigger the guest
 * (the app-load moment), receive Debugger.paused with real call frames while the C stack is
 * unwound, evaluateOnCallFrame against the pre-unwind binding snapshot (arg/local/closure),
 * then resume and watch the guest run to completion.
 *
 * Run via `bun tests/cdp-debug/run.ts` (starts the relay + static server, then Playwright).
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { expect, test } from '@playwright/test';
import WebSocket from 'ws';

// biome-ignore lint/suspicious/noExplicitAny: Playwright page with in-page globals
type AnyWindow = any;

// The guest: make(base) -> greet(name); breakpoint at source line 5 (CDP lineNumber 4),
// where greet's arg (name), local (count) and closure capture (base) all hold values.
const GUEST = [
  'function make(base) {',
  '  return function greet(name) {',
  '    var count = base + 1;',
  "    var msg = 'hi ' + name;",
  '    globalThis.out = msg;',
  '    return msg;',
  '  };',
  '}',
  'var g = make(10);',
  "g('world');",
].join('\n');
const BP_CDP_LINE = 4; // 0-based CDP line == source line 5

/** Minimal raw CDP client over a WebSocket: id-matched command/response + event waiters. */
class CdpClient {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, (msg: AnyWindow) => void>();
  #events: AnyWindow[] = [];
  #eventWaiters: Array<{ method: string; resolve: (m: AnyWindow) => void }> = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (typeof msg.id === 'number') {
        this.#pending.get(msg.id)?.(msg);
        this.#pending.delete(msg.id);
        return;
      }
      // An event.
      this.#events.push(msg);
      const idx = this.#eventWaiters.findIndex((w) => w.method === msg.method);
      if (idx >= 0) {
        const [waiter] = this.#eventWaiters.splice(idx, 1);
        waiter.resolve(msg);
      }
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('open', () => resolve(new CdpClient(ws)));
      ws.on('error', reject);
    });
  }

  send(method: string, params?: AnyWindow): Promise<AnyWindow> {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve with an already-seen event, or wait for the next one with this method. */
  waitEvent(method: string, timeoutMs = 15000): Promise<AnyWindow> {
    const seen = this.#events.find((e) => e.method === method);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.#eventWaiters.push({
        method,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  close() {
    this.#ws.close();
  }
}

test.describe('In-browser CDP debug over the reverse-tunnel relay', () => {
  test('attach, breakpoint, paused with real frames, evaluateOnCallFrame, resume', async ({
    page,
  }) => {
    const relayPort = process.env.RELAY_PORT;
    expect(relayPort, 'RELAY_PORT not set by run.ts').toBeTruthy();
    const relayHttp = `http://127.0.0.1:${relayPort}`;

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    // 1. Load the page; it spawns the worker, inits the fat wasm, and dials the relay.
    const relayWs = `ws://127.0.0.1:${relayPort}/agent`;
    await page.goto(`/cdp-debug-page.html?relay=${encodeURIComponent(relayWs)}`);
    await page.waitForFunction(() => (window as AnyWindow).__cdpReady === true, null, {
      timeout: 30000,
    });
    const pageErr = await page.evaluate(() => (window as AnyWindow).__pageErr ?? null);
    expect(pageErr, 'page harness error before attach').toBeNull();

    // 2. Discover the guest target via the relay's /json (exercises P3 discovery).
    const targets = (await (await fetch(`${relayHttp}/json`)).json()) as AnyWindow[];
    expect(targets.length, 'relay /json listed no guest target').toBeGreaterThan(0);
    const wsUrl = targets[0].webSocketDebuggerUrl as string;
    expect(wsUrl, 'target has no webSocketDebuggerUrl').toContain('/devtools/');

    // 3. Attach a raw CDP client through the relay.
    const cdp = await CdpClient.connect(wsUrl);
    try {
      const enableResp = await cdp.send('Debugger.enable');
      expect(enableResp.error, `Debugger.enable errored: ${JSON.stringify(enableResp)}`).toBeUndefined();

      const bpResp = await cdp.send('Debugger.setBreakpoint', {
        location: { scriptId: 'guest.js', lineNumber: BP_CDP_LINE },
      });
      expect(
        JSON.stringify(bpResp),
        `setBreakpoint had no breakpointId: ${JSON.stringify(bpResp)}`
      ).toContain('breakpointId');

      // 4. Trigger the guest (app-load moment). It must suspend at the breakpoint. The
      //    setBreakpoint response above already round-tripped through the worker, so the
      //    breakpoint is armed before we run.
      await page.evaluate((code) => (window as AnyWindow).__runGuest(code), GUEST);

      // 5. scriptParsed then paused, with real call frames (greet on top).
      const scriptParsed = await cdp.waitEvent('Debugger.scriptParsed');
      expect(JSON.stringify(scriptParsed), 'scriptParsed missing guest.js').toContain('guest.js');

      const paused = await cdp.waitEvent('Debugger.paused');
      const frames = paused.params.callFrames as AnyWindow[];
      expect(frames?.length, 'paused with no call frames').toBeGreaterThan(0);
      expect(
        frames.some((f) => f.functionName === 'greet'),
        `no greet frame: ${JSON.stringify(frames.map((f) => f.functionName))}`
      ).toBe(true);
      const topFrameId = frames[0].callFrameId as string;

      // 6. Evaluate in the paused frame — over the wire, while the C stack is unwound.
      const evalOnFrame = async (expr: string) => {
        const r = await cdp.send('Debugger.evaluateOnCallFrame', {
          callFrameId: topFrameId,
          expression: expr,
        });
        return r.result?.result ?? {};
      };
      expect((await evalOnFrame('name')).value, 'name (arg) != "world"').toBe('world');
      expect((await evalOnFrame('count')).value, 'count (local) != 11').toBe(11);
      expect((await evalOnFrame('base')).value, 'base (closure) != 10').toBe(10);

      // 7. Resume: Asyncify rewinds the guest, which runs to completion.
      const resumed = cdp.waitEvent('Debugger.resumed');
      await cdp.send('Debugger.resume');
      await resumed;
      await page.waitForFunction(() => (window as AnyWindow).__lastRc === 0, null, { timeout: 15000 });
      const rc = await page.evaluate(() => (window as AnyWindow).__lastRc);
      expect(rc, 'guest did not complete with rc=0 after resume').toBe(0);
    } finally {
      cdp.close();
    }

    expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
  });
});
