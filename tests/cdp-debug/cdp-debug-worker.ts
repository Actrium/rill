/**
 * Browser Worker entry for the in-browser CDP debug E2E (design P4).
 *
 * This is the production-shaped debug side: the fat CDP debug wasm runs INSIDE a
 * Web Worker, driven by the real {@link CdpDebugSession} (P2) and gated by the real
 * {@link TurnGate} (WI-2) — the exact modules a shipping web host would use. The page
 * is a dumb pipe between this worker and the reverse-tunnel relay; this worker is a
 * dumb pipe between postMessage and the wasm's raw CDP surface. No CDP is translated
 * in TypeScript anywhere — the wasm speaks Chrome DevTools Protocol directly.
 *
 * postMessage protocol (page <-> worker):
 *   page -> worker : {t:'init'}         start the session (lazy-load + init wasm)
 *                    {t:'cdp', json}    one raw CDP command -> qjsd_cdp_dispatch
 *                    {t:'run', code}    run a guest program through the TurnGate
 *   worker -> page : {t:'ready'}        session started; connection 1 is live
 *                    {t:'out', json}    one raw CDP message (response/event) from wasm
 *                    {t:'ran', rc}      a {t:'run'} completed (rc: 0 ok, -1 guest throw)
 *                    {t:'error', msg}   init/dispatch failure surfaced for diagnostics
 *
 * Why a Worker (not the page main thread): a breakpoint unwinds and PARKS the guest's
 * C stack (Asyncify) until resume; keeping that off the page thread is the shipping
 * shape. Because the unwind returns to the event loop, the worker thread stays free
 * during the pause and services evaluate/resume synchronously via {@link CdpDebugSession.sendCdp}.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { CdpDebugSession, type CdpDebugFactory, type CdpDebugModule } from '../../src/host/web/worker/cdp-debug-session';
import { TurnGate } from '../../src/host/web/worker/turn-gate';

// The single guest connection this worker serves (one page == one guest target).
const CONN_ID = 1;

// Load the fat debug wasm the browser way: a COMPUTED specifier so the bundler cannot
// statically analyze it and is forced to leave it as a runtime import — the 3.6MB
// artifact is fetched by the browser as its own ES module (and it locates its sibling
// .wasm via import.meta.url), never inlined into this worker bundle. The files are
// served at /cdp-wasm/ by tests/cdp-debug/run.ts.
async function loadDebugModule(): Promise<CdpDebugModule> {
  const specifier = new URL('/cdp-wasm/quickjs-cdp-debug.mjs', self.location.href).href;
  const mod = (await import(specifier)) as { default: CdpDebugFactory };
  return mod.default();
}

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

const session = new CdpDebugSession({
  // Every outbound raw CDP message the wasm emits is piped to the page verbatim.
  sink: (_connId, json) => post({ t: 'out', json }),
  gate: new TurnGate(),
  loadModule: loadDebugModule,
});

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { t: string; json?: string; code?: string };
  switch (msg.t) {
    case 'init':
      session
        .startSession(CONN_ID)
        .then(() => post({ t: 'ready' }))
        .catch((err) => post({ t: 'error', msg: String((err as Error)?.stack ?? err) }));
      break;
    case 'cdp':
      // Control-plane + setup CDP. SYNCHRONOUS and gate-bypassing — services a pause
      // (evaluate/resume) while a guest eval is parked at a breakpoint.
      try {
        session.sendCdp(CONN_ID, msg.json ?? '');
      } catch (err) {
        post({ t: 'error', msg: String((err as Error)?.stack ?? err) });
      }
      break;
    case 'run':
      // Guest-eval ENTRY through the TurnGate. The Promise stays pending across a
      // breakpoint pause and resolves after resume.
      session
        .runGuest(msg.code ?? '')
        .then((rc) => post({ t: 'ran', rc }))
        .catch((err) => post({ t: 'error', msg: String((err as Error)?.stack ?? err) }));
      break;
  }
};
