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
 *   4. resume() rewinds and the eval completes past the breakpoint; not paused.
 *   5. step-over arms-then-wakes and lands on a NEW line, then resume completes.
 *
 * Build first: `source /ext/emsdk/emsdk_env.sh && bash ../build-wasm-debug.sh`.
 * Exit code is non-zero if any claim fails.
 *
 * Licensed under the Apache License, Version 2.0.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Asyncify's rewind rebuilds QuickJS's deep interpreter call stack inside V8's
// execution stack, which needs more headroom than the default. Re-exec once with
// a larger V8 stack so a plain `node run-debug-wasm.mjs` just works.
if (!process.env.RILL_DBG_REEXEC) {
    const child = spawnSync(
        process.execPath,
        ["--stack-size=4000", fileURLToPath(import.meta.url)],
        { stdio: "inherit", env: { ...process.env, RILL_DBG_REEXEC: "1" } },
    );
    process.exit(child.status === null ? 1 : child.status);
}

// Line numbers are 1-based and load-bearing: the breakpoint targets line 3
// (inside bar), 2 frames below top-level: top-level -> foo() -> bar().
const LINES = [
    "globalThis.afterBp = 'unset';",              // 1
    "function bar(x) {",                          // 2
    "  var y = x * 2;",                           // 3  <-- breakpoint
    "  return y + 1;",                            // 4  runs only after resume/step
    "}",                                          // 5
    "function foo() { return bar(21); }",         // 6
    "var r = foo();",                             // 7
    "globalThis.afterBp = 'set-after-resume';",   // 8  set only after resume
    "r;",                                         // 9  eval result = 43
];
const SRC = LINES.join("\n");
const BP_LINE = 3;
const EXPECTED = 43;

let failures = 0;
function claim(n, ok, detail) {
    if (!ok) failures++;
    console.log(`[claim ${n}] ${ok ? "PASS" : "FAIL"} - ${detail}`);
}
const tick = () => new Promise((res) => setTimeout(res, 0));

const factory = (await import(join(__dirname, "..", "build-debug",
    "quickjs-sandbox-debug.mjs"))).default;
const Module = await factory();

let pausedCount = 0;
globalThis.__rillDbg = { onPaused: () => { pausedCount++; }, resume: null };

const cc = (name, ret, argT, args, opts) => Module.ccall(name, ret, argT, args, opts);

if (cc("qjsd_init", "number", [], []) !== 0) {
    console.error("qjsd_init failed");
    process.exit(1);
}
cc("qjsd_add_breakpoint", null, ["string", "number"], ["guest.js", BP_LINE]);

// ---- Run 1: pause / snapshot / resume, all through the real DebugCore. -------
let settled = false;
let value = null;
const p1 = cc("qjsd_eval", "number", ["string"], [SRC], { async: true });
p1.then((v) => { settled = true; value = v; }, (e) => { settled = true; value = e; });

claim(1,
    pausedCount === 1 && !settled && cc("qjsd_is_paused", "number", [], []) === 1 &&
        cc("qjsd_paused_line", "number", [], []) === BP_LINE,
    `breakpoint unwound the C stack (paused=${pausedCount}, evalPending=${!settled}, line=${cc("qjsd_paused_line", "number", [], [])})`);

let macro = false;
let micro = false;
await new Promise((res) => setTimeout(() => { macro = true; res(); }, 0));
await Promise.resolve().then(() => { micro = true; });
claim(2,
    macro && micro && !settled && cc("qjsd_is_paused", "number", [], []) === 1,
    `JS thread responsive while paused (macro=${macro}, micro=${micro}, evalPending=${!settled})`);

const fc = cc("qjsd_frame_count", "number", [], []);
const f0 = cc("qjsd_frame_line", "number", [], [0]);
claim(3,
    fc >= 2 && f0 === BP_LINE,
    `pre-unwind snapshot survived the unwind (frameCount=${fc}, frame0Line=${f0})`);

cc("qjsd_resume", null, [], []);
const r1 = await p1;
claim(4,
    r1 === EXPECTED && cc("qjsd_is_paused", "number", [], []) === 0,
    `resume rewound and completed the eval (result=${r1}, expected=${EXPECTED}, paused=${cc("qjsd_is_paused", "number", [], [])})`);

// ---- Run 2: step-over lands on a new line (arm-then-wake across rewind). ------
pausedCount = 0;
let settled2 = false;
const p2 = cc("qjsd_eval", "number", ["string"], [SRC], { async: true });
p2.then(() => { settled2 = true; }, () => { settled2 = true; });
await tick();  // let the breakpoint suspend land
const pausedAt = cc("qjsd_paused_line", "number", [], []);
cc("qjsd_step_over", null, [], []);
await tick();  // let the step re-pause on the next line
const steppedTo = cc("qjsd_paused_line", "number", [], []);
claim(5,
    pausedAt === BP_LINE && steppedTo !== BP_LINE && cc("qjsd_is_paused", "number", [], []) === 1 && !settled2,
    `step-over advanced to a new line (from ${pausedAt} to ${steppedTo})`);
cc("qjsd_resume", null, [], []);
await p2;

console.log(failures === 0 ? "\nALL CLAIMS PASS" : `\n${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
