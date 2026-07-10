/**
 * Browser PAGE harness for the in-browser CDP debug E2E (design P4).
 *
 * The page is a dumb bidirectional pipe. It:
 *   1. spawns the debug Worker (the fat CDP wasm + CdpDebugSession live there);
 *   2. opens an OUTBOUND WebSocket to the reverse-tunnel relay's /agent endpoint and
 *      registers a guest target (browsers cannot listen for inbound connections, so the
 *      page dials out — the relay then bridges an external CDP client to this page);
 *   3. forwards raw CDP both ways: relay -> worker (commands) and worker -> relay (responses
 *      and events), byte-for-byte.
 *
 * It exposes two globals the Playwright spec drives:
 *   window.__cdpReady        true once the worker is initialized AND the agent socket is
 *                            registered with the relay (so /json will list this target).
 *   window.__runGuest(code)  trigger a guest program run in the worker (the app-load moment
 *                            that hits the breakpoint). Returns nothing; completion is
 *                            observed over CDP (Debugger.resumed) or via window.__lastRc.
 *
 * The relay URL is passed in the page query string (?relay=ws://host:port/agent) by the
 * spec, which learned the ephemeral relay port from run.ts.
 *
 * Licensed under the Apache License, Version 2.0.
 */

const params = new URLSearchParams(location.search);
const relayUrl = params.get('relay');
const GUEST_ID = 'rill-guest';

interface PageWindow {
  __cdpReady?: boolean;
  __lastRc?: number;
  __pageErr?: string;
  __runGuest?: (code: string) => void;
}
const w = window as unknown as PageWindow;

if (!relayUrl) {
  w.__pageErr = 'missing ?relay= query param';
  throw new Error('[cdp-debug-page] missing ?relay= query param');
}

// The debug Worker: bundled to /dist/cdp-debug-worker.js, a module worker so it can pull in
// CdpDebugSession/TurnGate and dynamic-import the served fat wasm.
const worker = new Worker('/dist/cdp-debug-worker.js', { type: 'module' });

let agent: WebSocket | null = null;
let registered = false;
// Buffer worker output produced before the agent socket is open+registered so the very
// first CDP bytes are never dropped on the wire.
const outboundQueue: string[] = [];

function flushOutbound() {
  if (!agent || agent.readyState !== WebSocket.OPEN || !registered) return;
  while (outboundQueue.length > 0) {
    agent.send(outboundQueue.shift() as string);
  }
}

function sendToRelay(json: string) {
  outboundQueue.push(json);
  flushOutbound();
}

worker.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { t: string; json?: string; rc?: number; msg?: string };
  switch (msg.t) {
    case 'ready':
      // Worker session is up; now dial the relay and register the guest target.
      openAgent();
      break;
    case 'out':
      sendToRelay(msg.json ?? '');
      break;
    case 'ran':
      w.__lastRc = msg.rc;
      break;
    case 'error':
      w.__pageErr = `worker: ${msg.msg ?? 'unknown'}`;
      break;
  }
};

function openAgent() {
  const ws = new WebSocket(relayUrl as string);
  agent = ws;
  ws.onopen = () => {
    // First frame MUST be the registration handshake (relay contract).
    ws.send(JSON.stringify({ type: 'register', id: GUEST_ID, title: 'Rill Guest', url: 'rill://guest' }));
    registered = true;
    w.__cdpReady = true;
    flushOutbound();
  };
  // Raw CDP command from the external client (via the relay) -> hand to the worker.
  ws.onmessage = (ev: MessageEvent) => {
    worker.postMessage({ t: 'cdp', json: typeof ev.data === 'string' ? ev.data : String(ev.data) });
  };
  ws.onerror = () => {
    w.__pageErr = 'agent websocket error';
  };
}

w.__runGuest = (code: string) => {
  worker.postMessage({ t: 'run', code });
};

// Kick the worker into starting the session; on 'ready' we open the agent socket.
worker.postMessage({ t: 'init' });
