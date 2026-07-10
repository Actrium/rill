// Reverse-tunnel CDP relay (dev-only transport).
//
// A guest debugger running inside a browser tab cannot listen for inbound
// connections — browsers may only open OUTBOUND WebSocket connections. This
// relay is the classic broker / reverse tunnel (Weinre-style) that lets an
// external CDP client (chrome-remote-interface, chrome://inspect, VS Code)
// reach that in-page debugger.
//
//   Browser PAGE ──outbound ws──▶ /agent ─┐
//                                          ├─ relay pairs the two sockets and
//   CDP CLIENT   ──inbound  ws──▶ /devtools/<id> ─┘  pipes raw CDP frames verbatim
//
// The relay holds NO CDP state. It is a dumb pipe plus target discovery
// (/json, /json/version) plus pairing. All protocol semantics live at the
// endpoints.
//
// Endpoints
//   ws  /agent            the PAGE connects here and registers a guest target
//                         with a first JSON frame: {type:'register', id, title, url}
//   GET /json             discovery — array of Chrome-shaped target descriptors
//   GET /json/version     {Browser, 'Protocol-Version'}
//   ws  /devtools/<id>    a CDP client connects here; paired with target <id>
//
// This module is self-contained ESM. Run directly (node cdp-relay.mjs) to start
// a server on env PORT or the default, or import { startRelay } for tests.

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const DEFAULT_PORT = 9500;
const BROWSER_ID = 'Rill-CDP-Relay/1.0';
const PROTOCOL_VERSION = '1.3';

/**
 * Start the relay.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]   TCP port; 0 picks an ephemeral port. Defaults to
 *                               env PORT or DEFAULT_PORT.
 * @param {string} [opts.host]   bind address, default 127.0.0.1 (dev-only).
 * @param {(...a:any[])=>void} [opts.log]  logger, default console.error.
 * @returns {Promise<{port:number, host:string, server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function startRelay(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const log = opts.log ?? ((...a) => console.error('[cdp-relay]', ...a));

  // One page == one guest target (MVP). id -> target record.
  /** @type {Map<string, {id:string, title:string, url:string, agent:import('ws').WebSocket, devtools:import('ws').WebSocket|null}>} */
  const targets = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);

    if (req.method === 'GET' && url.pathname === '/json/version') {
      return sendJson(res, 200, {
        Browser: BROWSER_ID,
        'Protocol-Version': PROTOCOL_VERSION,
      });
    }

    // Chrome polls both /json and /json/list.
    if (req.method === 'GET' && (url.pathname === '/json' || url.pathname === '/json/list')) {
      const httpHost = req.headers.host ?? `${host}:${server.address()?.port}`;
      const list = [...targets.values()].map((t) => describeTarget(t, httpHost));
      return sendJson(res, 200, list);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  // Separate WS servers per path, both in noServer mode so the HTTP upgrade
  // handler can route by URL path.
  const agentWss = new WebSocketServer({ noServer: true });
  const devtoolsWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const path = url.pathname;

    if (path === '/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => onAgent(ws));
      return;
    }

    const m = /^\/devtools\/(.+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const target = targets.get(id);
      if (!target) {
        // No such guest — refuse the upgrade with a plain 404.
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      devtoolsWss.handleUpgrade(req, socket, head, (ws) => onDevtools(ws, target));
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  /** A PAGE connected on /agent; wait for its register frame. */
  function onAgent(ws) {
    /** @type {string|null} */
    let boundId = null;

    ws.on('message', (data, isBinary) => {
      if (boundId === null) {
        // First frame must be the registration handshake.
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          log('agent sent non-JSON registration frame; closing');
          ws.close(1002, 'expected register frame');
          return;
        }
        if (!msg || msg.type !== 'register') {
          log('agent first frame was not {type:"register"}; closing');
          ws.close(1002, 'expected register frame');
          return;
        }
        const id = typeof msg.id === 'string' && msg.id ? msg.id : randomUUID();
        if (targets.has(id)) {
          // Reclaim: drop the stale target and its paired client.
          teardownTarget(targets.get(id));
        }
        const target = {
          id,
          title: typeof msg.title === 'string' ? msg.title : `Rill Guest ${id}`,
          url: typeof msg.url === 'string' ? msg.url : `rill://guest/${id}`,
          agent: ws,
          devtools: null,
        };
        targets.set(id, target);
        boundId = id;
        log(`registered target ${id} (${target.title})`);
        return;
      }

      // Post-registration frames from the page are CDP output → forward verbatim.
      const target = targets.get(boundId);
      if (target?.devtools && target.devtools.readyState === target.devtools.OPEN) {
        target.devtools.send(data, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      if (boundId !== null) {
        const target = targets.get(boundId);
        if (target && target.agent === ws) {
          targets.delete(boundId);
          // Agent gone → drop the pairing and the discovery entry.
          if (target.devtools && target.devtools.readyState === target.devtools.OPEN) {
            target.devtools.close(1001, 'agent disconnected');
          }
          log(`target ${boundId} unregistered (agent closed)`);
        }
      }
    });

    ws.on('error', (err) => log('agent socket error:', err?.message ?? err));
  }

  /** A CDP CLIENT connected on /devtools/<id>; pair it with the target's agent. */
  function onDevtools(ws, target) {
    if (target.devtools && target.devtools.readyState === target.devtools.OPEN) {
      // MVP: one client per target. Evict the previous one.
      target.devtools.close(1001, 'superseded by new devtools client');
    }
    target.devtools = ws;
    log(`devtools client paired with target ${target.id}`);

    ws.on('message', (data, isBinary) => {
      // CDP command from the client → forward verbatim to the page.
      if (target.agent.readyState === target.agent.OPEN) {
        target.agent.send(data, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      // Client gone → unpair, but keep the target registered.
      if (target.devtools === ws) {
        target.devtools = null;
        log(`devtools client unpaired from target ${target.id}`);
      }
    });

    ws.on('error', (err) => log('devtools socket error:', err?.message ?? err));
  }

  function teardownTarget(target) {
    if (!target) return;
    targets.delete(target.id);
    try {
      target.devtools?.close(1001, 'target reclaimed');
    } catch {}
    try {
      target.agent?.close(1001, 'target reclaimed');
    } catch {}
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const actualPort = server.address().port;
      log(`listening on http://${host}:${actualPort} (discovery: /json)`);
      resolve({
        port: actualPort,
        host,
        server,
        close: () =>
          new Promise((res) => {
            for (const t of targets.values()) {
              try {
                t.devtools?.terminate();
              } catch {}
              try {
                t.agent?.terminate();
              } catch {}
            }
            targets.clear();
            agentWss.close();
            devtoolsWss.close();
            // Stop accepting and forcibly drop every live socket: idle HTTP
            // keep-alive connections (from discovery polling) and upgraded
            // WebSocket sockets would otherwise keep the listener open. We do
            // not wait on the server.close() callback — under some runtimes it
            // never fires once a socket was upgraded — the listening socket is
            // released synchronously here.
            server.close();
            server.closeAllConnections?.();
            server.once('close', () => res());
            queueMicrotask(res);
          }),
      });
    });
  });
}

function describeTarget(t, httpHost) {
  const wsUrl = `ws://${httpHost}/devtools/${encodeURIComponent(t.id)}`;
  return {
    id: t.id,
    type: 'node',
    title: t.title,
    url: t.url,
    webSocketDebuggerUrl: wsUrl,
    devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${httpHost}/devtools/${encodeURIComponent(t.id)}`,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=UTF-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Run directly: node src/host/web/tools/cdp-relay.mjs [port]
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const argPort = process.argv[2] ? Number(process.argv[2]) : undefined;
  startRelay({ port: argPort }).catch((err) => {
    console.error('[cdp-relay] failed to start:', err);
    process.exit(1);
  });
}
