/*
 * run-poc.mjs — Milestone A harness.
 *
 * Drives the Asyncify PoC and checks the three claims:
 *   1. A breakpoint 2+ interpreter frames deep unwinds the whole C stack back to
 *      the JS caller (eval returns a still-pending Promise while "paused").
 *   2. The JS thread stays responsive while paused (a macrotask and a microtask
 *      both settle while the eval Promise is still pending).
 *   3. A JS-side resume rewinds and the eval completes with the value computed
 *      AFTER the breakpoint line (proving continuation, not restart).
 *
 * Exit code is non-zero if any claim fails.
 *
 * Licensed under the Apache License, Version 2.0.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Asyncify's rewind rebuilds QuickJS's deep interpreter call stack inside V8's
// execution stack, which needs more headroom than the default limit. Re-exec
// ourselves once with a larger V8 stack so a plain `node run-poc.mjs` just works.
if (!process.env.RILL_POC_REEXEC) {
    const child = spawnSync(
        process.execPath,
        ["--stack-size=4000", fileURLToPath(import.meta.url)],
        { stdio: "inherit", env: { ...process.env, RILL_POC_REEXEC: "1" } },
    );
    process.exit(child.status === null ? 1 : child.status);
}

// Script evaluated in QuickJS. Line numbers are 1-based and load-bearing:
// the breakpoint targets line 3 (inside bar), which runs 2 frames below
// top-level: top-level -> foo() -> bar().
const LINES = [
    "globalThis.afterBp = 'unset';",              // 1
    "function bar(x) {",                          // 2
    "  var y = x * 2;",                           // 3  <-- breakpoint
    "  return y + 1;",                            // 4  runs only after resume
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
    const tag = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[claim ${n}] ${tag} - ${detail}`);
}

const factory = (await import(join(__dirname, "quickjs-asyncify-poc.mjs"))).default;
const Module = await factory();

let paused = false;
globalThis.__rillDbg = {
    onPaused: () => { paused = true; },
    resume: null,
};

if (Module.ccall("qjs_poc_init", "number", [], []) !== 0) {
    console.error("qjs_poc_init failed");
    process.exit(1);
}
Module.ccall("qjs_poc_set_breakpoint", null, ["number"], [BP_LINE]);

// Kick off the eval. With Asyncify this returns a pending Promise the moment the
// breakpoint suspends deep inside the interpreter.
const p = Module.ccall("qjs_poc_eval", "number", ["string"], [SRC], { async: true });

let settled = false;
let settledValue = null;
p.then(
    (v) => { settled = true; settledValue = v; },
    (e) => { settled = true; settledValue = e; },
);

// Claim 1: the C stack unwound back to us. onPaused ran synchronously during the
// suspend, and the eval Promise is still pending.
claim(
    1,
    paused === true && settled === false,
    `breakpoint suspended eval mid-interpreter (paused=${paused}, evalPending=${!settled})`,
);

// Claim 2: the JS thread keeps servicing its event loop while paused. A
// setTimeout(0) macrotask and a Promise microtask both settle; the eval Promise
// must still be pending afterward.
let macrotaskRan = false;
let microtaskRan = false;
await new Promise((res) => setTimeout(() => { macrotaskRan = true; res(); }, 0));
await Promise.resolve().then(() => { microtaskRan = true; });
claim(
    2,
    macrotaskRan && microtaskRan && paused === true && settled === false,
    `macrotask+microtask settled while eval still pending (macro=${macrotaskRan}, micro=${microtaskRan}, evalPending=${!settled})`,
);

// Claim 3: resume rewinds the C stack from the suspend point; the eval finishes
// and returns work computed AFTER the breakpoint line.
if (typeof globalThis.__rillDbg.resume !== "function") {
    claim(3, false, "no resume() was parked by the suspend primitive");
} else {
    globalThis.__rillDbg.resume();
    const result = await p;
    // The global assigned on line 8 (after the breakpoint) proves execution
    // continued past the suspend point rather than restarting.
    const afterBp = Module.ccall("qjs_poc_eval", "number", ["string"],
        ["afterBp === 'set-after-resume' ? 1 : 0"]);
    claim(
        3,
        result === EXPECTED && afterBp === 1,
        `resume completed eval: result=${result} (expected ${EXPECTED}), post-breakpoint global set=${afterBp === 1}`,
    );
}

console.log(failures === 0 ? "\nALL CLAIMS PASS" : `\n${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
