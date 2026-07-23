/*
 * run-cdp-wasm.mjs — FAT CDP debug-wasm harness (Milestone B, browser-E2E core).
 *
 * Drives the debug wasm that embeds the REAL CDP engine
 * (AdapterDebugTarget -> DebuggerAdapter -> QuickJSEngineDebugger -> core) with
 * RAW Chrome DevTools Protocol messages — exactly what a browser worker / relay
 * will pipe from chrome-remote-interface — and checks a full CDP round-trip over
 * an Asyncify pause:
 *   1. Debugger.enable + setBreakpoint acknowledged (real CDP responses).
 *   2. Running the guest emits Debugger.scriptParsed then Debugger.paused with
 *      real call frames (functionName greet).
 *   3. While paused (C stack unwound), Debugger.evaluateOnCallFrame resolves the
 *      arg / local / closure against the pre-unwind snapshot (name/count/base).
 *   4. Debugger.resume rewinds and the guest eval completes.
 *
 * Build first: `source /ext/emsdk/emsdk_env.sh && bash ../build-wasm-cdp.sh`.
 * Exit code is non-zero if any claim fails.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Asyncify rewind rebuilds QuickJS's deep interpreter stack inside V8's stack;
// re-exec once with more headroom so a plain `node run-cdp-wasm.mjs` just works.
if (!process.env.RILL_DBG_REEXEC) {
  const child = spawnSync(process.execPath, ['--stack-size=4000', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, RILL_DBG_REEXEC: '1' },
  });
  process.exit(child.status === null ? 1 : child.status);
}

// Line numbers are load-bearing: breakpoint at source line 5 (CDP lineNumber 4),
// where greet's arg (name), locals (count, msg) and closure (base) all hold values.
const LINES = [
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
];
const SRC = LINES.join('\n');
const BP_CDP_LINE = 4; // 0-based CDP line == source line 5

let failures = 0;
function claim(n, ok, detail) {
  if (!ok) failures++;
  console.log(`[claim ${n}] ${ok ? 'PASS' : 'FAIL'} - ${detail}`);
}
const tick = () => new Promise((res) => setTimeout(res, 0));

const factory = (await import(join(__dirname, '..', 'build-debug', 'quickjs-cdp-debug.mjs')))
  .default;
const Module = await factory();

// The worker/relay installs this; here the harness IS the pipe. Collect every
// outbound CDP message (responses carry "id"; events carry "method").
const inbox = [];
globalThis.__rillCdp = { onMessage: (_connId, json) => inbox.push(JSON.parse(json)) };
const responseFor = (id) => inbox.find((m) => m.id === id);
const eventFor = (method) => inbox.find((m) => m.method === method);

const cc = (name, ret, argT, args, opts) => Module.ccall(name, ret, argT, args, opts);
const dispatch = (json) => cc('qjsd_cdp_dispatch', null, ['number', 'string'], [1, json]);

if (cc('qjsd_cdp_init', 'number', [], []) !== 0) {
  console.error('qjsd_cdp_init failed');
  process.exit(1);
}
cc('qjsd_cdp_connect', null, ['number'], [1]);

// ---- Set up the session with raw CDP, before running the guest. --------------
dispatch(JSON.stringify({ id: 1, method: 'Debugger.enable' }));
claim(1, !!responseFor(1), 'Debugger.enable acknowledged (real CDP response)');

dispatch(
  JSON.stringify({
    id: 2,
    method: 'Debugger.setBreakpoint',
    params: { location: { scriptId: 'guest.js', lineNumber: BP_CDP_LINE } },
  })
);
const bpResp = responseFor(2);
claim(
  2,
  bpResp && JSON.stringify(bpResp).includes('breakpointId'),
  'Debugger.setBreakpoint acknowledged with a breakpointId'
);

// ---- Run the guest: it must pause at the breakpoint (Asyncify unwind). --------
let settled = false;
const evalP = cc('qjsd_cdp_eval', 'number', ['string'], [SRC], { async: true });
evalP.then(
  () => {
    settled = true;
  },
  () => {
    settled = true;
  }
);
await tick(); // let scriptParsed + the breakpoint suspend land

const scriptParsed = eventFor('Debugger.scriptParsed');
claim(
  3,
  !!scriptParsed && JSON.stringify(scriptParsed).includes('guest.js'),
  'Debugger.scriptParsed announced guest.js'
);

const paused = eventFor('Debugger.paused');
claim(
  4,
  !!paused && !settled && JSON.stringify(paused).includes('"greet"'),
  'Debugger.paused delivered with real call frames (greet on top)'
);

// ---- Evaluate in the paused frame, over the pipe, while the C stack is gone. --
const evalOnFrame = (id, expr) => {
  dispatch(
    JSON.stringify({
      id,
      method: 'Debugger.evaluateOnCallFrame',
      params: { callFrameId: '0', expression: expr },
    })
  );
  return responseFor(id);
};
const rName = evalOnFrame(10, 'name');
claim(
  5,
  JSON.stringify(rName || {}).includes('"value":"world"'),
  'evaluateOnCallFrame name -> "world" (arg, via raw CDP over the pipe)'
);
const rCount = evalOnFrame(11, 'count');
claim(
  6,
  JSON.stringify(rCount || {}).includes('"value":11'),
  'evaluateOnCallFrame count -> 11 (local)'
);
const rBase = evalOnFrame(12, 'base');
claim(
  7,
  JSON.stringify(rBase || {}).includes('"value":10'),
  'evaluateOnCallFrame base -> 10 (closure capture)'
);

// ---- Expand the paused frame's local scope with Runtime.getProperties. --------
// A real DevTools GUI expands scope/object nodes through the Runtime domain, which
// the fat target fronts alongside Debugger. The local scope objectId is "<frame>:local".
dispatch(
  JSON.stringify({
    id: 13,
    method: 'Runtime.getProperties',
    params: { objectId: '0:local', ownProperties: true },
  })
);
const rProps = responseFor(13);
const propsStr = JSON.stringify(rProps || {});
claim(
  8,
  propsStr.includes('"count"') && propsStr.includes('"msg"'),
  'Runtime.getProperties(0:local) lists the frame locals (count, msg)'
);

// ---- Resume: Asyncify rewinds and the guest eval completes. ------------------
dispatch(JSON.stringify({ id: 3, method: 'Debugger.resume' }));
const rc = await evalP;
claim(
  9,
  rc === 0 && settled && !!eventFor('Debugger.resumed'),
  'Debugger.resume rewound the guest; eval completed and Debugger.resumed sent'
);

console.log(failures === 0 ? '\nALL CLAIMS PASS' : `\n${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
