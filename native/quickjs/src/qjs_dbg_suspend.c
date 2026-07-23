/*
 * qjs_dbg_suspend.c — Asyncify suspend/wake shim for the QuickJS debug wasm.
 *
 * Compiled ONLY into the debug wasm (build-wasm-debug.sh), never into the
 * production build. suspend() unwinds the whole C stack back to the JS event
 * loop (so the JS thread stays responsive while the guest is "paused") and
 * returns only after the JS side calls the stored resolver via wake() and
 * Asyncify rewinds. This mirrors the proven Milestone A primitive
 * (native/quickjs/poc/asyncify_poc.c); the pause/resume policy lives in
 * QuickJSDebugCore, which calls these two functions.
 *
 * Licensed under the Apache License, Version 2.0.
 */
#include <emscripten.h>

/* Unwind the C stack and park until wake(). Fires globalThis.__rillDbg.onPaused
 * synchronously during the suspend, then stores the Promise resolver on
 * globalThis.__rillDbg.resume for wake() to call. */
EM_ASYNC_JS(void, rill_qjs_dbg_suspend_async, (void), {
  await new Promise((resolve) => {
    globalThis.__rillDbg = globalThis.__rillDbg || {};
    if (globalThis.__rillDbg.onPaused) globalThis.__rillDbg.onPaused();
    globalThis.__rillDbg.resume = resolve;
  });
});

/* Resolve the parked promise so Asyncify rewinds and suspend() returns. Safe to
 * call when nothing is parked (no-op). */
EM_JS(void, rill_qjs_dbg_wake, (void), {
  const dbg = globalThis.__rillDbg;
  if (!dbg) return;
  const resolve = dbg.resume;
  dbg.resume = null;
  if (resolve) resolve();
});
