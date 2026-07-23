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

// Emscripten-only translation unit. It is swept into the QuickJS pod by the
// source glob, so guard the whole body on __EMSCRIPTEN__ (always defined under
// emcc, never under an Apple/host toolchain) — a non-emscripten build then sees
// an empty TU instead of failing on <emscripten.h>.
#ifdef __EMSCRIPTEN__

#include "QuickJSDebugCore.h"
#include "quickjs.h"

#include <emscripten.h>

#include <climits>
#include <cstring>
#include <set>
#include <string>
#include <utility>
#include <vector>

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

EMSCRIPTEN_KEEPALIVE
void qjsd_remove_breakpoint(const char* scriptId, int line) {
  if (g_core) g_core->removeBreakpoint(scriptId ? scriptId : "", line);
}

// Evaluate an expression in the scope of the paused frame at frameIndex, reading
// the pre-unwind binding snapshot (the live frame is gone after the Asyncify
// unwind), and return its value as an int (INT_MIN on not-paused / exception).
// This is the cross-unwind evaluate: a synchronous export that runs JS_Call
// DURING the suspension, guarded by runOnPausedThread (nulls the dangling frame
// pointer + suppresses the hook). Mirrors the lean core mechanism that
// QuickJSEngineDebugger wraps into a CDP RemoteObject in the real web host.
EMSCRIPTEN_KEEPALIVE
int qjsd_evaluate_on_frame(int frameIndex, const char* expr) {
  if (!g_core || !expr) return INT_MIN;
  const std::string e(expr);
  int out = INT_MIN;
  const bool ran = g_core->runOnPausedThread([&](JSContext* ctx) {
    const auto& all = g_core->pausedBindings();
    // Build the wrapper param list from the frame's args/locals/closures
    // (inner shadows outer); fall back to a bare global eval if the frame index
    // is out of range.
    std::vector<std::pair<std::string, JSValueConst>> binds;
    JSValueConst thisVal = JS_UNDEFINED;
    if (frameIndex >= 0 && static_cast<std::size_t>(frameIndex) < all.size()) {
      const auto& fb = all[frameIndex];
      std::set<std::string> seen;
      auto take = [&](const std::vector<QuickJSDebugCore::CapturedVar>& src) {
        for (const auto& v : src) {
          if (v.name.empty() || seen.count(v.name)) continue;
          seen.insert(v.name);
          binds.push_back({v.name, v.value});
        }
      };
      take(fb.args);
      take(fb.locals);
      take(fb.closures);
      thisVal = fb.thisVal;
    }
    std::string w = "(function(";
    for (std::size_t i = 0; i < binds.size(); ++i) {
      if (i) w += ",";
      w += binds[i].first;
    }
    w += "){return (" + e + ");})";
    JSValue fn = JS_Eval(ctx, w.c_str(), w.size(), "<evaluate>",
                         JS_EVAL_TYPE_GLOBAL);
    JSValue v;
    if (JS_IsException(fn)) {
      JS_FreeValue(ctx, JS_GetException(ctx));
      JS_FreeValue(ctx, fn);
      v = JS_Eval(ctx, e.c_str(), e.size(), "<evaluate>", JS_EVAL_TYPE_GLOBAL);
    } else {
      std::vector<JSValue> argv;
      argv.reserve(binds.size());
      for (const auto& b : binds) argv.push_back(b.second);
      v = JS_Call(ctx, fn, thisVal, static_cast<int>(argv.size()),
                  argv.empty() ? nullptr : argv.data());
      JS_FreeValue(ctx, fn);
    }
    if (JS_IsException(v)) {
      JS_FreeValue(ctx, JS_GetException(ctx));  // the call itself threw
    } else if (JS_ToInt32(ctx, &out, v) < 0) {
      // Coercing the result ran a throwing valueOf; drain the exception so the
      // guest resumes exception-clean before the Asyncify rewind, and report the
      // sentinel rather than a bogus zero.
      JS_FreeValue(ctx, JS_GetException(ctx));
      out = INT_MIN;
    }
    JS_FreeValue(ctx, v);
  });
  return ran ? out : INT_MIN;
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

#endif  // __EMSCRIPTEN__
