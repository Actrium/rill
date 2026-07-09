// Drives a full debugging session against the rill QuickJS CDP host through the
// WebSocket bridge, using chrome-remote-interface — the same CDP client library
// the Chrome DevTools front-end is built on. Proves the transport + protocol
// interoperate with a real CDP front-end over a real socket.
//
//   PORT=9333 node cdp_client_probe.js
'use strict';
const CDP = require('chrome-remote-interface');

const PORT = parseInt(process.env.PORT || '9333', 10);
const HOST = process.env.HOST || '127.0.0.1';

let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails++; };
const waitFor = (pred, ms, label) => new Promise((res) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (pred()) { clearInterval(iv); res(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); console.log(`  (timeout: ${label})`); res(false); }
  }, 10);
});

(async () => {
  console.log('=== real CDP front-end (chrome-remote-interface) vs rill QuickJS ===');
  // Connect straight to the target ws URL (skip auto-discovery, which probes
  // browser-only endpoints the bridge does not serve).
  const wsUrl = process.env.WS || `ws://${HOST}:${PORT}/devtools/page/rill-quickjs-1`;
  // local: use the bundled protocol descriptor instead of fetching it from the
  // target (the bridge is not a full browser endpoint).
  const client = await CDP({ target: wsUrl, local: true });
  const { Debugger, Runtime } = client;

  const scripts = [];
  let paused = null;
  Debugger.scriptParsed((p) => scripts.push(p));
  Debugger.paused((p) => { paused = p; });
  Debugger.resumed(() => { paused = null; });

  await Runtime.enable();
  await Debugger.enable();

  // The host pre-registers guest.js, so Debugger.enable replays scriptParsed.
  await waitFor(() => scripts.some((s) => (s.url || '').includes('guest.js')), 2000, 'scriptParsed');
  const guest = scripts.find((s) => (s.url || '').includes('guest.js'));
  check(!!guest, 'front-end received Debugger.scriptParsed for guest.js');

  // getScriptSource round-trips the whole-script source.
  if (guest) {
    const { scriptSource } = await Debugger.getScriptSource({ scriptId: guest.scriptId });
    check(/function greet/.test(scriptSource), 'Debugger.getScriptSource returned the guest source');
  }

  // Set a breakpoint by URL on line 3 (0-based lineNumber 2: `var msg = ...`).
  const bp = await Debugger.setBreakpointByUrl({ url: 'guest.js', lineNumber: 2, columnNumber: 0 });
  check(!!bp.breakpointId, `Debugger.setBreakpointByUrl -> ${bp.breakpointId}`);

  // Trigger a guest run; the host re-evaluates and the breakpoint fires.
  await Runtime.runIfWaitingForDebugger();
  const didPause = await waitFor(() => paused !== null, 3000, 'Debugger.paused');
  check(didPause, 'breakpoint hit: Debugger.paused delivered to the front-end');

  if (paused) {
    const frames = paused.callFrames || [];
    check(frames.length >= 1 && frames[0].functionName === 'greet',
      `paused with a real call stack (top = ${frames[0] && frames[0].functionName})`);
    check(paused.reason === 'other' || paused.reason === 'breakpoint' || (paused.hitBreakpoints || []).length > 0,
      `pause reason/hit reported (reason=${paused.reason}, hits=${JSON.stringify(paused.hitBreakpoints)})`);

    // Evaluate in the paused frame (global-scope MVP): read a global.
    const ev = await Debugger.evaluateOnCallFrame({
      callFrameId: frames[0].callFrameId,
      expression: 'globalThis.count',
    });
    check(ev.result && ev.result.type === 'number',
      `Debugger.evaluateOnCallFrame globalThis.count -> ${ev.result && ev.result.value}`);

    await Debugger.resume();
    const didResume = await waitFor(() => paused === null, 3000, 'resume');
    check(didResume, 'Debugger.resume ran the guest to completion');
  }

  await client.close();
  console.log(`=== ${fails === 0 ? 'ALL PASS' : 'FAILURES'} (${fails} failed) ===`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('probe error:', e); process.exit(2); });
