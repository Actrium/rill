# QuickJS Asyncify pause/resume PoC (Milestone A)

A self-contained proof of concept that VM-level pause/resume works for
wasm-compiled QuickJS on a single JS thread, using Emscripten Asyncify. It drives
the existing, unchanged per-context debug seam
(`rill_qjs_set_debug_hook` / `RillQjsDebugHook` in
`../vendor/quickjs-debug.h`) and touches nothing in the production build.

## What it proves

1. A breakpoint fired 2+ interpreter frames deep (top-level -> `foo()` -> `bar()`)
   unwinds the **entire** C stack back to the JS caller: `qjs_poc_eval` returns a
   still-pending Promise while "paused".
2. The JS thread stays responsive while paused: a `setTimeout(0)` macrotask and a
   Promise microtask both settle while the eval Promise is still pending.
3. A JS-side `resume()` rewinds the C stack and the eval completes with a value
   computed **after** the breakpoint line (`43`, plus a global assigned after the
   breakpoint) — proving continuation from the suspend point, not a restart.

## Files

- `asyncify_poc.c` — minimal C bindings. Registers a debug hook that calls the
  async import `rill_qjs_dbg_suspend()` (an `EM_ASYNC_JS` that awaits a Promise)
  when the current line matches an armed breakpoint at depth >= 2. One-shot: the
  breakpoint disarms on first hit so the rewound eval runs to completion.
- `build-asyncify-poc.sh` — direct `emcc` invocation for the vendor QuickJS
  sources + `asyncify_poc.c`.
- `run-poc.mjs` — Node ESM harness that checks the three claims and exits
  non-zero on any failure.

## Build and run

```sh
source /ext/emsdk/emsdk_env.sh
cd native/quickjs/poc
./build-asyncify-poc.sh          # -> quickjs-asyncify-poc.{mjs,wasm}
node run-poc.mjs                 # prints PASS for all three claims, exits 0
```

`run-poc.mjs` re-execs itself once with `--stack-size=4000`: Asyncify's rewind
rebuilds QuickJS's deep interpreter call stack inside V8's execution stack, which
needs more headroom than the default limit.

## Negative control (Asyncify OFF)

```sh
./build-asyncify-poc.sh off      # -> quickjs-noasyncify-poc.{mjs,wasm}
```

The `off` build compiles the suspend primitive as a plain `EM_JS` that fires
`onPaused` but cannot unwind the C stack. Result: the hook still runs, but
`qjs_poc_eval` returns synchronously (`43`) with no resume parked — i.e. it is
structurally impossible to pause the VM without Asyncify. This is the negative
control that isolates Asyncify as the mechanism responsible for the pause.

## Measured size delta (emcc 6.0.0, `-O1`)

| build                | wasm size (bytes) |
| -------------------- | ----------------- |
| Asyncify ON          | 2,902,374         |
| Asyncify OFF         | 840,981           |
| delta                | +2,061,393 (+245%) |

The ~3.5x growth is why the production wasm stays Asyncify-free; this PoC is
isolated to Milestone A and never enters the shipping build.

## Working emcc flags

Compile defines: `-DCONFIG_VERSION='"2024-01-13"' -DCONFIG_BIGNUM -D_GNU_SOURCE
-DEMSCRIPTEN -DRILL_QJS_DEBUG`.

Asyncify link flags that finally worked: `-sASYNCIFY=1
-sASYNCIFY_STACK_SIZE=1048576` (the initial 16384 was far too small for
QuickJS's large interpreter frames and aborted with `RuntimeError: unreachable`
during the unwind), plus `-sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1
-sEXPORT_NAME=createQuickJSAsyncifyPoc -sENVIRONMENT=node,web,worker
-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString
-sEXPORTED_FUNCTIONS=_malloc,_free,_qjs_poc_init,_qjs_poc_set_breakpoint,_qjs_poc_eval
-O1 -Wno-error=incompatible-function-pointer-types`. `EM_ASYNC_JS` auto-registers
its async import, so no explicit `ASYNCIFY_IMPORTS` list was needed.
