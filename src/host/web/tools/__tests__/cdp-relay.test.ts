/**
 * Reverse-tunnel CDP relay — pairing and discovery tests.
 *
 * Starts the relay on an ephemeral port, connects a fake AGENT (the browser
 * page) and a fake DEVTOOLS client (the CDP tool), and asserts:
 *   - the registered target appears in /json with the right webSocketDebuggerUrl
 *   - /json/version returns the Chrome-shaped basics
 *   - a command from devtools reaches the agent verbatim, and the agent's reply
 *     reaches devtools verbatim (the relay is a dumb pipe)
 *   - dropping the agent 404s discovery and closes the paired client
 *
 * No sleeps: every step awaits an 'open'/'message'/'close' event.
 */

import { afterEach, describe, expect, it } from 'bun:test';
// @ts-expect-error — .mjs sibling module without types; runtime resolution is fine.
import { startRelay } from '../cdp-relay.mjs';
import WebSocket from 'ws';

type Relay = Awaited<ReturnType<typeof startRelay>>;

const openSockets: WebSocket[] = [];
let relay: Relay | null = null;

function connect(url: string): WebSocket {
  const ws = new WebSocket(url);
  // Keep a PERSISTENT error listener on every test socket: the helpers below
  // use once(), which detaches after the first event, and a socket that errors
  // again during teardown (e.g. a refused upgrade followed by the destroyed
  // TCP socket) would otherwise raise an unhandled 'error' and kill the run.
  ws.on('error', () => {});
  openSockets.push(ws);
  return ws;
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function onceMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data: WebSocket.RawData) => resolve(data.toString()));
    ws.once('error', reject);
  });
}

function onceClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once('close', (code: number) => resolve(code));
  });
}

async function fetchJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://${relay!.host}:${relay!.port}${path}`);
  const status = res.status;
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status, body };
}

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.terminate();
    } catch {}
  }
  if (relay) {
    await relay.close();
    relay = null;
  }
});

describe('cdp-relay reverse tunnel', () => {
  it('lists a registered agent target in /json with the right webSocketDebuggerUrl', async () => {
    relay = await startRelay({ port: 0, log: () => {} });

    const agent = connect(`ws://127.0.0.1:${relay.port}/agent`);
    await onceOpen(agent);
    agent.send(
      JSON.stringify({ type: 'register', id: 'guest-1', title: 'My Guest', url: 'rill://guest/1' }),
    );

    // Poll discovery until the async registration frame is processed. No sleeps.
    let target: any = null;
    for (let i = 0; i < 50 && !target; i++) {
      const { body } = await fetchJson('/json');
      target = Array.isArray(body) ? body.find((t: any) => t.id === 'guest-1') : null;
    }

    expect(target).toBeTruthy();
    expect(target.type).toBe('node');
    expect(target.title).toBe('My Guest');
    expect(target.url).toBe('rill://guest/1');
    expect(target.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${relay.port}/devtools/guest-1`,
    );
  });

  it('serves /json/version with Chrome-shaped basics', async () => {
    relay = await startRelay({ port: 0, log: () => {} });
    const { status, body } = await fetchJson('/json/version');
    expect(status).toBe(200);
    expect(typeof body.Browser).toBe('string');
    expect(body['Protocol-Version']).toBe('1.3');
  });

  it('pipes CDP frames verbatim in both directions', async () => {
    relay = await startRelay({ port: 0, log: () => {} });

    const agent = connect(`ws://127.0.0.1:${relay.port}/agent`);
    await onceOpen(agent);
    agent.send(JSON.stringify({ type: 'register', id: 'guest-2', title: 'T', url: 'rill://g/2' }));

    // Wait until discovery sees it, then connect the devtools client.
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      const { body } = await fetchJson('/json');
      seen = Array.isArray(body) && body.some((t: any) => t.id === 'guest-2');
    }
    expect(seen).toBe(true);

    const devtools = connect(`ws://127.0.0.1:${relay.port}/devtools/guest-2`);
    await onceOpen(devtools);

    // client -> agent, verbatim.
    const command =
      '{"id":1,"method":"Runtime.evaluate","params":{"expression":"1+1","returnByValue":true}}';
    const agentRecv = onceMessage(agent);
    devtools.send(command);
    expect(await agentRecv).toBe(command);

    // agent -> client, verbatim.
    const reply = '{"id":1,"result":{"result":{"type":"number","value":2}}}';
    const devtoolsRecv = onceMessage(devtools);
    agent.send(reply);
    expect(await devtoolsRecv).toBe(reply);
  });

  it('404s discovery of a devtools connect after the agent disconnects', async () => {
    relay = await startRelay({ port: 0, log: () => {} });

    const agent = connect(`ws://127.0.0.1:${relay.port}/agent`);
    await onceOpen(agent);
    agent.send(JSON.stringify({ type: 'register', id: 'guest-3', title: 'T', url: 'rill://g/3' }));

    // Wait until the target is discoverable before pairing a client.
    let registered = false;
    for (let i = 0; i < 50 && !registered; i++) {
      const { body } = await fetchJson('/json');
      registered = Array.isArray(body) && body.some((t: any) => t.id === 'guest-3');
    }
    expect(registered).toBe(true);

    const dt = connect(`ws://127.0.0.1:${relay.port}/devtools/guest-3`);
    await onceOpen(dt);

    // Drop the agent — discovery must forget it and the paired client must close.
    const gone = onceClose(dt);
    agent.close();
    await gone;

    const { body } = await fetchJson('/json');
    expect(Array.isArray(body) && body.some((t: any) => t.id === 'guest-3')).toBe(false);

    // A fresh devtools connect to the vanished target is refused (upgrade 404).
    // How a refused (non-101) upgrade surfaces varies by WebSocket runtime AND
    // by version: Node's ws fires 'error' (or 'unexpected-response' if a listener
    // exists); bun >=1.3 fires 'error' (plus 'close'); bun <=1.2 fires ONLY
    // 'close' (code 1006) and does not implement 'unexpected-response'. The one
    // invariant across all of them is that a refused upgrade never 'open's.
    // Resolve on the first terminal event — any runtime emits at least one — and
    // assert it was not an open, so the test is runtime/version agnostic.
    const late = connect(`ws://127.0.0.1:${relay.port}/devtools/guest-3`);
    const outcome = await new Promise<string>((resolve) => {
      late.once('open', () => resolve('open'));
      late.once('error', () => resolve('error'));
      late.once('unexpected-response', () => resolve('unexpected-response'));
      late.once('close', () => resolve('close'));
    });
    expect(outcome).not.toBe('open');
  });
});
