/*
 * qjs_debug_wasm_bindings.cpp — extern-C surface so a JS/node harness can drive
 * the real QuickJSDebugCore through the Asyncify debug wasm.
 *
 * Compiled ONLY into the debug wasm (build-wasm-debug.sh), never into the
 * production build. Owns one static runtime/context/core: this milestone
 * debugs a single context on the single JS thread. The eval export is called
 * with ccall({async:true}) so a breakpoint suspends mid-eval; the reader exports
 * expose the paused state and the pre-unwind frame snapshot (which must survive
 * after the C stack is gone).
 *
 * Licensed under the Apache License, Version 2.0.
 */
#include "QuickJSDebugCore.h"
#include "quickjs.h"

#include <emscripten.h>

#include <climits>
#include <cstring>
#include <string>

using rill::qjs_debug::PauseReason;
using rill::qjs_debug::QuickJSDebugCore;

namespace {
JSRuntime* g_rt = nullptr;
JSContext* g_ctx = nullptr;
QuickJSDebugCore* g_core = nullptr;
int g_pausedLine = -1;
}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int qjsd_init(void) {
  if (g_core) return 0;
  g_rt = JS_NewRuntime();
  if (!g_rt) return -1;
  JS_UpdateStackTop(g_rt);  // this thread owns the runtime
  g_ctx = JS_NewContext(g_rt);
  if (!g_ctx) return -1;
  g_core = new QuickJSDebugCore(g_rt, g_ctx);
  g_core->setPausedCallback(
      [](const std::string& /*scriptId*/, int line, PauseReason) {
        g_pausedLine = line;  // runs on the JS thread just before the suspend
      });
  return 0;
}

EMSCRIPTEN_KEEPALIVE
void qjsd_add_breakpoint(const char* scriptId, int line) {
  if (g_core) g_core->addBreakpoint(scriptId ? scriptId : "", line);
}

// Evaluate a program and return its completion value as an int (INT_MIN on
// exception). Called via ccall({async:true}) so a breakpoint suspends mid-eval;
// the returned Promise then resolves with the value computed after resume.
EMSCRIPTEN_KEEPALIVE
int qjsd_eval(const char* code) {
  if (!g_ctx || !code) return INT_MIN;
  JSValue v = JS_Eval(g_ctx, code, std::strlen(code), "guest.js",
                      JS_EVAL_TYPE_GLOBAL);
  int result = INT_MIN;
  if (!JS_IsException(v)) {
    int32_t n = 0;
    JS_ToInt32(g_ctx, &n, v);
    result = n;
  }
  JS_FreeValue(g_ctx, v);
  return result;
}

EMSCRIPTEN_KEEPALIVE void qjsd_resume(void) { if (g_core) g_core->resume(); }
EMSCRIPTEN_KEEPALIVE void qjsd_step_into(void) { if (g_core) g_core->stepInto(); }
EMSCRIPTEN_KEEPALIVE void qjsd_step_over(void) { if (g_core) g_core->stepOver(); }
EMSCRIPTEN_KEEPALIVE void qjsd_step_out(void) { if (g_core) g_core->stepOut(); }
EMSCRIPTEN_KEEPALIVE void qjsd_request_pause(void) {
  if (g_core) g_core->requestPause();
}

EMSCRIPTEN_KEEPALIVE
int qjsd_is_paused(void) { return (g_core && g_core->isPaused()) ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE
int qjsd_paused_line(void) { return g_pausedLine; }

// Snapshot readers — proof the frames were captured BEFORE the Asyncify unwind
// (after the unwind the live C stack is gone, so these read the snapshot).
EMSCRIPTEN_KEEPALIVE
int qjsd_frame_count(void) {
  return g_core ? static_cast<int>(g_core->pausedFrames().size()) : 0;
}

EMSCRIPTEN_KEEPALIVE
int qjsd_frame_line(int i) {
  if (!g_core) return -1;
  const auto& frames = g_core->pausedFrames();
  if (i < 0 || i >= static_cast<int>(frames.size())) return -1;
  return frames[i].line1Based;
}

}  // extern "C"
