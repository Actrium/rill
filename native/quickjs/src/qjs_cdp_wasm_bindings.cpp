/*
 * qjs_cdp_wasm_bindings.cpp — the FAT debug-wasm surface: it embeds the real CDP
 * engine (AdapterDebugTarget -> DebuggerAdapter -> QuickJSEngineDebugger -> core)
 * so the wasm speaks raw Chrome DevTools Protocol directly. The browser worker
 * (and the node CDP harness) is then a dumb pipe: raw CDP bytes in via
 * qjsd_cdp_dispatch, raw CDP bytes out via the __rillCdp.onMessage callback.
 *
 * This is the single source of truth for CDP serialization — the SAME C++ the
 * native path uses and tests — instead of reimplementing RemoteObject / scope /
 * scriptParsed in TypeScript. Compiled ONLY into the debug wasm; never shipped.
 *
 * Threading model on the web: there is no second thread. A breakpoint suspends
 * the guest by unwinding the C stack (Asyncify) back to the JS event loop, so
 * qjsd_cdp_eval must be called via ccall({async:true}). While the guest is parked
 * the worker is free and services qjsd_cdp_dispatch synchronously — that is how
 * evaluate/getProperties/resume reach the engine during a pause.
 *
 * Licensed under the Apache License, Version 2.0.
 */

// Emscripten-only translation unit. It is swept into the QuickJS pod by the
// source glob, so guard the whole body on __EMSCRIPTEN__ (always defined under
// emcc, never under an Apple/host toolchain) — a non-emscripten build then sees
// an empty TU instead of failing on <emscripten.h>.
#ifdef __EMSCRIPTEN__

#include "QuickJSDebugCore.h"
#include "QuickJSEngineDebugger.h"
#include "devtools/AdapterDebugTarget.h"
#include "devtools/DebuggerAdapter.h"
#include "quickjs.h"

#include <emscripten.h>

#include <cstring>
#include <memory>
#include <string>
#include <vector>

using namespace rill::devtools;
using rill::qjs_debug::QuickJSDebugCore;
using rill::qjs_debug::QuickJSEngineDebugger;

namespace {
JSRuntime* g_rt = nullptr;
JSContext* g_ctx = nullptr;
QuickJSDebugCore* g_core = nullptr;
std::shared_ptr<QuickJSEngineDebugger> g_engine;
std::shared_ptr<DebuggerAdapter> g_adapter;
std::unique_ptr<AdapterDebugTarget> g_target;
}  // namespace

// Outbound: hand one CDP message (response or event) to the JS host. The worker
// installs globalThis.__rillCdp = { onMessage(connId, json) }. Synchronous JS —
// never suspends — so it is safe to call from anywhere, including mid-pause.
EM_JS(void, rill_qjs_cdp_out, (int connId, const char* json), {
  const cdp = globalThis.__rillCdp;
  if (cdp && cdp.onMessage) cdp.onMessage(connId, UTF8ToString(json));
});

extern "C" {

EMSCRIPTEN_KEEPALIVE
int qjsd_cdp_init(void) {
  if (g_core) return 0;
  g_rt = JS_NewRuntime();
  if (!g_rt) return -1;
  JS_UpdateStackTop(g_rt);  // this thread owns the runtime
  g_ctx = JS_NewContext(g_rt);
  if (!g_ctx) return -1;
  g_core = new QuickJSDebugCore(g_rt, g_ctx);
  g_engine = std::make_shared<QuickJSEngineDebugger>(g_core, /*tenantId=*/1);
  g_adapter = std::make_shared<DebuggerAdapter>();
  g_adapter->setEngineDebugger(g_engine);
  g_target = std::make_unique<AdapterDebugTarget>(g_adapter, /*tenantId=*/1);
  auto adapter = g_adapter;
  g_engine->setPausedNotifier(
      [adapter](PauseReason r, const std::vector<CallFrame>& frames,
                const std::vector<std::string>& hits) {
        adapter->onPaused(1, r, frames, hits);
      });
  g_engine->setScriptParsedNotifier(
      [adapter](const ScriptInfo& s) { adapter->onScriptParsed(1, s); });
  return 0;
}

EMSCRIPTEN_KEEPALIVE
void qjsd_cdp_connect(int connId) {
  if (!g_target) return;
  g_target->onClientConnect(
      static_cast<ConnectionId>(connId),
      [connId](const RawCdpMessage& m) { rill_qjs_cdp_out(connId, m.c_str()); });
}

EMSCRIPTEN_KEEPALIVE
void qjsd_cdp_disconnect(int connId) {
  if (g_target) g_target->onClientDisconnect(static_cast<ConnectionId>(connId));
}

// Dispatch one raw CDP command. Synchronous. Used both before eval (enable /
// setBreakpoint) and DURING a pause (evaluate / getProperties / resume), which
// on the web runs while qjsd_cdp_eval's Promise is parked at the breakpoint.
EMSCRIPTEN_KEEPALIVE
void qjsd_cdp_dispatch(int connId, const char* json) {
  if (g_target && json) {
    g_target->dispatch(static_cast<ConnectionId>(connId), json);
  }
}

// Run a guest program. Called via ccall({async:true}) so a breakpoint suspends
// mid-eval (Asyncify unwind) and the returned Promise resolves after resume.
// Returns 0 on completion, -1 on a guest exception (drained so nothing leaks).
EMSCRIPTEN_KEEPALIVE
int qjsd_cdp_eval(const char* code) {
  if (!g_ctx || !code) return -1;
  JSValue v = JS_Eval(g_ctx, code, std::strlen(code), "guest.js",
                      JS_EVAL_TYPE_GLOBAL);
  const int rc = JS_IsException(v) ? -1 : 0;
  if (rc) JS_FreeValue(g_ctx, JS_GetException(g_ctx));
  JS_FreeValue(g_ctx, v);
  return rc;
}

}  // extern "C"

#endif  // __EMSCRIPTEN__
