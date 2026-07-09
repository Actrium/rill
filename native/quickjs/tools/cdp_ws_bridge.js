// WebSocket + /json-discovery bridge that puts a real Chrome DevTools front-end
// in front of the QuickJS rill CDP host (cdp_stdio_host). Chrome discovers the
// target via /json, opens a WebSocket, and every frame is piped to the host's
// stdin; every host stdout line is sent back as a frame.
//
//   HOSTBIN=./cdp_stdio_host PORT=9333 node cdp_ws_bridge.js
'use strict';
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '9333', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HOSTBIN = process.env.HOSTBIN || './cdp_stdio_host';

const targetId = 'rill-quickjs-1';
const wsPath = `/devtools/page/${targetId}`;
const wsAuthority = `${HOST}:${PORT}${wsPath}`;

function targets() {
  return [{
    id: targetId,
    type: 'node',
    title: 'rill QuickJS guest',
    url: 'guest.js',
    description: 'rill CDP debugger (QuickJS engine)',
    webSocketDebuggerUrl: `ws://${wsAuthority}`,
    devtoolsFrontendUrl: `devtools://devtools/bundled/js_app.html?ws=${wsAuthority}`,
  }];
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  if (req.url === '/json/version') {
    res.end(JSON.stringify({
      Browser: 'rill/quickjs',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: `ws://${wsAuthority}`,
    }));
  } else if (req.url === '/json' || req.url === '/json/list') {
    res.end(JSON.stringify(targets()));
  } else {
    // Unknown discovery endpoints (e.g. /json/protocol, /json/new): answer 200
    // with an empty object so front-ends probing them do not error out.
    res.end('{}');
  }
});

const wss = new WebSocketServer({ server, path: wsPath });
wss.on('connection', (ws) => {
  console.error('[bridge] front-end connected; spawning host');
  const child = spawn(HOSTBIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.trim()) { try { ws.send(line); } catch (_) {} }
  });
  ws.on('message', (data) => {
    try { child.stdin.write(data.toString() + '\n'); } catch (_) {}
  });
  ws.on('close', () => {
    // Prefer a clean shutdown: closing stdin gives the host EOF, so it resumes a
    // paused runtime and tears down in order (exit 0). Hard-kill only if it hangs.
    try { child.stdin.end(); } catch (_) {}
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000);
    child.on('exit', () => clearTimeout(t));
  });
  child.on('exit', (code, sig) => { console.error(`[bridge] host exited (code=${code} sig=${sig})`); try { ws.close(); } catch (_) {} });
});

server.listen(PORT, HOST, () =>
  console.error(`[bridge] http://${HOST}:${PORT}/json  ws://${wsAuthority}`));
