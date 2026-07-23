/*
 * run-debug-wasm.mjs — Milestone B harness.
 *
 * Drives the REAL QuickJSDebugCore (not the raw Milestone A hook) through the
 * Asyncify debug wasm and checks that the SuspendController seam works on the
 * single JS thread:
 *   1. A breakpoint 2+ interpreter frames deep unwinds the whole C stack back to
 *      the JS caller (eval Promise pending; qjsd_is_paused==1; line correct).
 *   2. The JS thread stays responsive while paused (macrotask + microtask settle
 *      while the eval Promise is still pending).
 *   3. The pre-unwind frame snapshot survives after the C stack is gone
 *      (qjsd_frame_count >= 2 and qjsd_frame_line(0) == breakpoint line).
 *   4-5. CROSS-UNWIND EVALUATE: a synchronous export runs JS_Call DURING the
 *      suspension (C stack unwound), reading the pre-unwind binding snapshot —
 *      reads a frame arg (x==21) and computes over it (x*2+1==43).
 *   6. resume() rewinds and the eval completes past the breakpoint even AFTER an
 *      in-pause evaluate ran (proving evaluate did not corrupt the parked state).
 *   7. step-over arms-then-wakes and lands on a NEW line, then resume completes.
 *   8-10. Cross-unwind evaluate READS then MUTATES a captured object; the
 *      mutation is visible to the guest after resume (the snapshot dup shares
 *      object identity with the live frame across the unwind/rewind).
 *
 * Build first: `source /ext/emsdk/emsdk_env.sh && bash ../build-wasm-debug.sh`.
 * Exit code is non-zero if any claim fails.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Asyncify's rewind rebuilds QuickJS's deep interpreter call stack inside V8's
// execution stack, which needs more headroom than the default. Re-exec once with
// a larger V8 stack so a plain `node run-debug-wasm.mjs` just works.
if (!process.env.RILL_DBG_REEXEC) {
  const child = spawnSync(process.execPath, ['--stack-size=4000', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, RILL_DBG_REEXEC: '1' },
  });
  process.exit(child.status === null ? 1 : child.status);
}

// Line numbers are 1-based and load-bearing: the breakpoint targets line 3
// (inside bar), 2 frames below top-level: top-level -> foo() -> bar().
const LINES = [
  "globalThis.afterBp = 'unset';", // 1
  'function bar(x) {', // 2
  '  var y = x * 2;', // 3  <-- breakpoint
  '  return y + 1;', // 4  runs only after resume/step
  '}', // 5
  'function foo() { return bar(21); }', // 6
  'var r = foo();', // 7
  "globalThis.afterBp = 'set-after-resume';", // 8  set only after resume
  'r;', // 9  eval result = 43
];
const SRC = LINES.join('\n');
const BP_LINE = 3;
const EXPECTED = 43;

let failures = 0;
function claim(n, ok, detail) {
  if (!ok) failures++;
  console.log(`[claim ${n}] ${ok ? 'PASS' : 'FAIL'} - ${detail}`);
}
const tick = () => new Promise((res) => setTimeout(res, 0));

const factory = (await import(join(__dirname, '..', 'build-debug', 'quickjs-sandbox-debug.mjs')))
  .default;
const Module = await factory();

let pausedCount = 0;
globalThis.__rillDbg = {
  onPaused: () => {
    pausedCount++;
  },
  resume: null,
};

const cc = (name, ret, argT, args, opts) => Module.ccall(name, ret, argT, args, opts);

if (cc('qjsd_init', 'number', [], []) !== 0) {
  console.error('qjsd_init failed');
  process.exit(1);
}
cc('qjsd_add_breakpoint', null, ['string', 'number'], ['guest.js', BP_LINE]);

// ---- Run 1: pause / snapshot / resume, all through the real DebugCore. -------
let settled = false;
let value = null;
const p1 = cc('qjsd_eval', 'number', ['string'], [SRC], { async: true });
p1.then(
  (v) => {
    settled = true;
    value = v;
  },
  (e) => {
    settled = true;
    value = e;
  }
);

claim(
  1,
  pausedCount === 1 &&
    !settled &&
    cc('qjsd_is_paused', 'number', [], []) === 1 &&
    cc('qjsd_paused_line', 'number', [], []) === BP_LINE,
  `breakpoint unwound the C stack (paused=${pausedCount}, evalPending=${!settled}, line=${cc('qjsd_paused_line', 'number', [], [])})`
);

let macro = false;
let micro = false;
await new Promise((res) =>
  setTimeout(() => {
    macro = true;
    res();
  }, 0)
);
await Promise.resolve().then(() => {
  micro = true;
});
claim(
  2,
  macro && micro && !settled && cc('qjsd_is_paused', 'number', [], []) === 1,
  `JS thread responsive while paused (macro=${macro}, micro=${micro}, evalPending=${!settled})`
);

const fc = cc('qjsd_frame_count', 'number', [], []);
const f0 = cc('qjsd_frame_line', 'number', [], [0]);
claim(
  3,
  fc >= 2 && f0 === BP_LINE,
  `pre-unwind snapshot survived the unwind (frameCount=${fc}, frame0Line=${f0})`
);

// Cross-unwind evaluate: a synchronous export that runs JS_Call DURING the
// suspension (the C stack is unwound), reading the pre-unwind binding snapshot
// instead of the gone live frame. Frame 0 = bar(x=21); local y not yet assigned
// at the line-3 breakpoint, so evaluate the arg and an expression over it.
const evX = cc('qjsd_evaluate_on_frame', 'number', ['number', 'string'], [0, 'x']);
claim(
  4,
  evX === 21 && cc('qjsd_is_paused', 'number', [], []) === 1,
  `cross-unwind evaluate read a snapshot arg while suspended (x=${evX})`
);
const evY = cc('qjsd_evaluate_on_frame', 'number', ['number', 'string'], [0, 'x * 2 + 1']);
claim(5, evY === 43, `cross-unwind evaluate computed in the frame scope (x*2+1=${evY})`);

cc('qjsd_resume', null, [], []);
const r1 = await p1;
claim(
  6,
  r1 === EXPECTED && cc('qjsd_is_paused', 'number', [], []) === 0,
  `resume rewound and completed the eval AFTER an in-pause evaluate (result=${r1}, expected=${EXPECTED})`
);

// ---- Run 2: step-over lands on a new line (arm-then-wake across rewind). ------
pausedCount = 0;
let settled2 = false;
const p2 = cc('qjsd_eval', 'number', ['string'], [SRC], { async: true });
p2.then(
  () => {
    settled2 = true;
  },
  () => {
    settled2 = true;
  }
);
await tick(); // let the breakpoint suspend land
const pausedAt = cc('qjsd_paused_line', 'number', [], []);
cc('qjsd_step_over', null, [], []);
await tick(); // let the step re-pause on the next line
const steppedTo = cc('qjsd_paused_line', 'number', [], []);
claim(
  7,
  pausedAt === BP_LINE &&
    steppedTo !== BP_LINE &&
    cc('qjsd_is_paused', 'number', [], []) === 1 &&
    !settled2,
  `step-over advanced to a new line (from ${pausedAt} to ${steppedTo})`
);
cc('qjsd_resume', null, [], []);
await p2;

// ---- Run 3: cross-unwind evaluate READS then MUTATES a captured object; the
//      mutation is visible to the guest after resume, proving the snapshot dup
//      shares object identity with the live frame across the unwind/rewind. -----
cc('qjsd_remove_breakpoint', null, ['string', 'number'], ['guest.js', BP_LINE]);
const OBJ_LINES = [
  'function h(o) {', // 1
  '  var local = 7;', // 2
  '  globalThis.seen = o.x;', // 3  <-- breakpoint (o built, local assigned)
  '  return o.x;', // 4  reflects any mutation done while paused
  '}', // 5
  'h({ x: 1 });', // 6
];
const OBJ_BP = 3;
cc('qjsd_add_breakpoint', null, ['string', 'number'], ['guest.js', OBJ_BP]);
let settled3 = false;
const p3 = cc('qjsd_eval', 'number', ['string'], [OBJ_LINES.join('\n')], { async: true });
p3.then(
  () => {
    settled3 = true;
  },
  () => {
    settled3 = true;
  }
);
await tick(); // let the breakpoint suspend land

const ev = (expr) => cc('qjsd_evaluate_on_frame', 'number', ['number', 'string'], [0, expr]);
claim(
  8,
  cc('qjsd_is_paused', 'number', [], []) === 1 && !settled3 && ev('local') === 7,
  `cross-unwind evaluate read a captured local (local=${ev('local')})`
);
const before = ev('o.x');
const mutated = ev('(o.x = 5, o.x)');
claim(
  9,
  before === 1 && mutated === 5,
  `cross-unwind evaluate read (o.x=${before}) then mutated (o.x=${mutated}) a captured object`
);
// A result-coercion that throws (valueOf) must be drained, not leaked into the
// resumed guest: the export returns the INT_MIN sentinel and stays paused/clean.
const thrown = ev('({ valueOf() { throw 1; } })');
claim(
  10,
  thrown === -2147483648 && cc('qjsd_is_paused', 'number', [], []) === 1 && !settled3,
  `throwing-coercion evaluate drained its exception (sentinel=${thrown}, still paused)`
);
cc('qjsd_resume', null, [], []);
const r3 = await p3;
claim(
  11,
  r3 === 5,
  `object mutation propagated + guest resumed exception-clean (h returned o.x=${r3})`
);

console.log(failures === 0 ? '\nALL CLAIMS PASS' : `\n${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
