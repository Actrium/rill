// M2 e2e: drive the QuickJS engine debugger through the FULL CDP relay stack —
// AdapterDebugTarget -> DebuggerAdapter -> QuickJSEngineDebugger -> QuickJSDebugCore
// -> the patched interpreter — with raw CDP messages, exactly as CDPServer would.
//
//   - Debugger.enable / Debugger.setBreakpoint round-trip through the sink;
//   - a breakpoint on source line 3 (CDP lineNumber 2) pauses the runtime;
//   - the Debugger.paused event arrives out-of-band through the connection sink;
//   - Debugger.resume (dispatched from another thread) unblocks the runtime;
//   - the post-resume side effect is observable.
//
// Portable C/C++, builds locally. See build-run-cdp.sh.

#include "QuickJSDebugCore.h"
#include "QuickJSEngineDebugger.h"
#include "devtools/AdapterDebugTarget.h"
#include "devtools/DebuggerAdapter.h"
#include "quickjs.h"

#include <chrono>
#include <condition_variable>
#include <cstring>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

using namespace rill::devtools;
using rill::qjs_debug::QuickJSDebugCore;
using rill::qjs_debug::QuickJSEngineDebugger;

static int g_failures = 0;
static void check(bool ok, const std::string& what) {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << what << "\n";
  if (!ok) ++g_failures;
}

// Pull the first "objectId":"..." out of a RemoteObject JSON blob.
static std::string extractObjectId(const std::string& json) {
  const std::string key = "\"objectId\":\"";
  auto p = json.find(key);
  if (p == std::string::npos) return "";
  p += key.size();
  auto e = json.find('"', p);
  return e == std::string::npos ? "" : json.substr(p, e - p);
}

namespace {
struct Sink {
  std::mutex m;
  std::condition_variable cv;
  std::string all;
  void push(const std::string& msg) {
    std::lock_guard<std::mutex> lk(m);
    all += msg;
    all += '\n';
    cv.notify_all();
  }
  bool waitFor(const std::string& needle, const char* label) {
    std::unique_lock<std::mutex> lk(m);
    bool ok = cv.wait_for(lk, std::chrono::seconds(10),
                          [&] { return all.find(needle) != std::string::npos; });
    if (!ok) std::cout << "  (timeout waiting for " << label << ")\n";
    return ok;
  }
};
}  // namespace

int main() {
  std::cout << "=== QuickJS CDP relay e2e (full stack) ===\n";

  JSRuntime* rt = JS_NewRuntime();
  JSContext* ctx = JS_NewContext(rt);
  QuickJSDebugCore core(rt, ctx);

  auto engineDbg = std::make_shared<QuickJSEngineDebugger>(&core, /*tenantId=*/1);
  auto adapter = std::make_shared<DebuggerAdapter>();
  adapter->setEngineDebugger(engineDbg);
  AdapterDebugTarget target(adapter, /*tenantId=*/1);

  // Engine pause -> Debugger.paused event (through the adapter's sink).
  engineDbg->setPausedNotifier(
      [adapter](PauseReason r, const std::vector<CallFrame>& frames,
                const std::vector<std::string>& hits) {
        adapter->onPaused(1, r, frames, hits);
      });

  Sink sink;
  target.onClientConnect(1, [&sink](const RawCdpMessage& m) { sink.push(m); });

  target.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");
  check(sink.waitFor("\"id\":1", "enable response"), "Debugger.enable acknowledged");

  target.dispatch(
      1,
      R"({"id":2,"method":"Debugger.setBreakpoint","params":{"location":{"scriptId":"bp.js","lineNumber":2}}})");
  check(sink.waitFor("\"breakpointId\"", "setBreakpoint response"),
        "Debugger.setBreakpoint acknowledged (CDP line 2 = source line 3)");

  std::promise<void> evalDone;
  auto evalFut = evalDone.get_future();
  std::thread runtimeThread([&] {
    JS_UpdateStackTop(rt);  // runtime runs on this thread (see M1 harness note)
    static const char* kCode =
        "globalThis.log = [];\n"   // 1
        "log.push('a');\n"          // 2
        "log.push('b');\n"          // 3 <- breakpoint
        "globalThis.done = 1;\n";   // 4
    JSValue v =
        JS_Eval(ctx, kCode, std::strlen(kCode), "bp.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, v);
    evalDone.set_value();
  });

  check(sink.waitFor("\"Debugger.paused\"", "paused event"),
        "Debugger.paused delivered out-of-band via the connection sink");
  check(evalFut.wait_for(std::chrono::milliseconds(200)) != std::future_status::ready,
        "runtime thread stays blocked while paused");

  // While paused, evaluate expressions in the (global-scope) paused context.
  // The dispatch runs the eval on the blocked runtime thread and returns once
  // its response has been pushed to the sink.
  target.dispatch(
      1,
      R"({"id":10,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"1+2"}})");
  check(sink.waitFor("\"value\":3,\"description\":\"3\"", "eval 1+2"),
        "evaluateOnCallFrame 1+2 -> number 3");
  target.dispatch(
      1,
      R"({"id":11,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"'a'+'b'"}})");
  check(sink.waitFor("\"type\":\"string\",\"value\":\"ab\"", "eval string"),
        "evaluateOnCallFrame 'a'+'b' -> string \"ab\"");
  // Reads global state: at the line-3 breakpoint, log holds only 'a'.
  target.dispatch(
      1,
      R"({"id":12,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"globalThis.log.length"}})");
  check(sink.waitFor("\"value\":1,\"description\":\"1\"", "eval global read"),
        "evaluateOnCallFrame globalThis.log.length -> 1");
  // A throwing expression is reported as an error and clears the pending
  // exception so the paused program can still resume cleanly.
  target.dispatch(
      1,
      R"json({"id":13,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"nope()"}})json");
  check(sink.waitFor("\"subtype\":\"error\"", "eval throw"),
        "evaluateOnCallFrame nope() -> error object");

  target.dispatch(1, R"({"id":3,"method":"Debugger.resume"})");
  bool finished =
      evalFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
  check(finished, "Debugger.resume unblocked the runtime; eval completed");
  runtimeThread.join();

  JSValue g = JS_GetGlobalObject(ctx);
  JSValue doneV = JS_GetPropertyStr(ctx, g, "done");
  int32_t done = -1;
  JS_ToInt32(ctx, &done, doneV);
  check(done == 1, "post-resume side effect observed (done === 1)");
  JS_FreeValue(ctx, doneV);
  JS_FreeValue(ctx, g);

  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);

  // --- Nested stack over CDP: Debugger.paused must carry every call frame. ----
  {
    JSRuntime* nrt = JS_NewRuntime();
    JSContext* nctx = JS_NewContext(nrt);
    QuickJSDebugCore ncore(nrt, nctx);
    auto nEngine =
        std::make_shared<QuickJSEngineDebugger>(&ncore, /*tenantId=*/1);
    auto nAdapter = std::make_shared<DebuggerAdapter>();
    nAdapter->setEngineDebugger(nEngine);
    AdapterDebugTarget nTarget(nAdapter, /*tenantId=*/1);
    nEngine->setPausedNotifier(
        [nAdapter](PauseReason r, const std::vector<CallFrame>& frames,
                   const std::vector<std::string>& hits) {
          nAdapter->onPaused(1, r, frames, hits);
        });

    Sink nsink;
    nTarget.onClientConnect(1, [&nsink](const RawCdpMessage& m) { nsink.push(m); });
    nTarget.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");
    // Breakpoint inside c() at source line 2 (CDP lineNumber 1).
    nTarget.dispatch(
        1,
        R"({"id":2,"method":"Debugger.setBreakpoint","params":{"location":{"scriptId":"stack.js","lineNumber":1}}})");

    std::promise<void> nDone;
    auto nFut = nDone.get_future();
    std::thread nThread([&] {
      JS_UpdateStackTop(nrt);
      static const char* kStack =
          "function c() {\n"          // 1
          "  globalThis.hit = 1;\n"   // 2 <- breakpoint
          "}\n"                        // 3
          "function b() {\n"          // 4
          "  c();\n"                   // 5
          "}\n"                        // 6
          "function a() {\n"          // 7
          "  b();\n"                   // 8
          "}\n"                        // 9
          "a();\n";                    // 10
      JSValue v = JS_Eval(nctx, kStack, std::strlen(kStack), "stack.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(nctx, v);
      nDone.set_value();
    });

    check(nsink.waitFor("\"Debugger.paused\"", "nested paused event"),
          "nested Debugger.paused delivered");
    // The serialized callFrames array carries the innermost c and its callers
    // (functions kept multi-line so QuickJS does not tail-call-eliminate them).
    check(nsink.waitFor("\"functionName\":\"c\"", "frame c"),
          "paused payload includes innermost frame c");
    check(nsink.waitFor("\"functionName\":\"b\"", "frame b"),
          "paused payload includes caller frame b");
    check(nsink.waitFor("\"functionName\":\"a\"", "frame a"),
          "paused payload includes caller frame a");

    nTarget.dispatch(1, R"({"id":3,"method":"Debugger.resume"})");
    check(nFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "nested case resumed to completion");
    nThread.join();

    JS_FreeContext(nctx);
    JS_FreeRuntime(nrt);
  }

  // --- scriptParsed registry drives setBreakpointByUrl + getScriptSource. -----
  {
    JSRuntime* srt = JS_NewRuntime();
    JSContext* sctx = JS_NewContext(srt);
    QuickJSDebugCore score(srt, sctx);
    auto sEngine = std::make_shared<QuickJSEngineDebugger>(&score, 1);
    auto sAdapter = std::make_shared<DebuggerAdapter>();
    sAdapter->setEngineDebugger(sEngine);
    AdapterDebugTarget sTarget(sAdapter, 1);
    sEngine->setPausedNotifier(
        [sAdapter](PauseReason r, const std::vector<CallFrame>& frames,
                   const std::vector<std::string>& hits) {
          sAdapter->onPaused(1, r, frames, hits);
        });
    sEngine->setScriptParsedNotifier(
        [sAdapter](const ScriptInfo& s) { sAdapter->onScriptParsed(1, s); });

    Sink ssink;
    sTarget.onClientConnect(1, [&ssink](const RawCdpMessage& m) { ssink.push(m); });
    sTarget.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");

    static const char* kUrlScript =
        "globalThis.n = (globalThis.n || 0) + 1;\n"  // line 1
        "globalThis.mark = 42;\n";                    // line 2 <- breakpoint by url

    // Run once so the script is seen and announced via Debugger.scriptParsed.
    std::thread reg([&] {
      JS_UpdateStackTop(srt);
      JSValue v = JS_Eval(sctx, kUrlScript, std::strlen(kUrlScript), "url.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(sctx, v);
    });
    reg.join();
    check(ssink.waitFor("\"Debugger.scriptParsed\"", "scriptParsed") &&
              ssink.waitFor("\"url\":\"url.js\"", "scriptParsed url"),
          "Debugger.scriptParsed announced url.js");

    // Now a URL-addressed breakpoint resolves through the registry.
    sTarget.dispatch(
        1,
        R"({"id":2,"method":"Debugger.setBreakpointByUrl","params":{"url":"url.js","lineNumber":1}})");
    check(ssink.waitFor("\"breakpointId\":\"1\"", "byUrl bp id"),
          "setBreakpointByUrl resolved url.js -> breakpoint");

    // getScriptSource returns the registered source.
    sTarget.dispatch(
        1,
        R"({"id":4,"method":"Debugger.getScriptSource","params":{"scriptId":"url.js"}})");
    check(ssink.waitFor("globalThis.mark", "script source"),
          "getScriptSource returns url.js source");

    // Re-run the same filename: a fresh bytecode token, yet the url-keyed
    // breakpoint still fires (breakpoints key on scriptId, not token).
    std::promise<void> hit;
    auto hitFut = hit.get_future();
    std::thread run2([&] {
      JS_UpdateStackTop(srt);
      JSValue v = JS_Eval(sctx, kUrlScript, std::strlen(kUrlScript), "url.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(sctx, v);
      hit.set_value();
    });
    check(ssink.waitFor("\"Debugger.paused\"", "byUrl paused"),
          "url-keyed breakpoint fires on a re-run (new token)");
    sTarget.dispatch(1, R"({"id":5,"method":"Debugger.resume"})");
    check(hitFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "resume completed the re-run");
    run2.join();

    JS_FreeContext(sctx);
    JS_FreeRuntime(srt);
  }

  // --- In-frame scope: scopeChain + evaluate against locals/args/closure. ------
  {
    JSRuntime* lrt = JS_NewRuntime();
    JSContext* lctx = JS_NewContext(lrt);
    QuickJSDebugCore lcore(lrt, lctx);
    auto lEngine = std::make_shared<QuickJSEngineDebugger>(&lcore, 1);
    auto lAdapter = std::make_shared<DebuggerAdapter>();
    lAdapter->setEngineDebugger(lEngine);
    AdapterDebugTarget lTarget(lAdapter, 1);
    lEngine->setPausedNotifier(
        [lAdapter](PauseReason r, const std::vector<CallFrame>& frames,
                   const std::vector<std::string>& hits) {
          lAdapter->onPaused(1, r, frames, hits);
        });

    Sink lsink;
    lTarget.onClientConnect(1, [&lsink](const RawCdpMessage& m) { lsink.push(m); });
    lTarget.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");
    // Breakpoint inside greet at source line 5 (CDP lineNumber 4): by then its
    // argument (name), locals (count, msg) and captured closure var (base) all
    // hold values.
    lTarget.dispatch(
        1,
        R"({"id":2,"method":"Debugger.setBreakpoint","params":{"location":{"scriptId":"scope.js","lineNumber":4}}})");

    std::promise<void> lDone;
    auto lFut = lDone.get_future();
    std::thread lThread([&] {
      JS_UpdateStackTop(lrt);
      static const char* kScope =
          "function make(base) {\n"            // 1
          "  return function greet(name) {\n"  // 2
          "    var count = base + 1;\n"        // 3
          "    var msg = 'hi ' + name;\n"      // 4
          "    globalThis.out = msg;\n"        // 5 <- breakpoint
          "    return msg;\n"                  // 6
          "  };\n"                              // 7
          "}\n"                                 // 8
          "var g = make(10);\n"                // 9
          "g('world');\n";                      // 10
      JSValue v = JS_Eval(lctx, kScope, std::strlen(kScope), "scope.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(lctx, v);
      lDone.set_value();
    });

    check(lsink.waitFor("\"Debugger.paused\"", "scope paused event"),
          "in-frame scope: Debugger.paused delivered");
    // The paused top frame advertises a Local/Closure/Global scope chain.
    check(lsink.waitFor("\"type\":\"local\"", "local scope") &&
              lsink.waitFor("\"type\":\"closure\"", "closure scope") &&
              lsink.waitFor("\"type\":\"global\"", "global scope"),
          "paused frame carries a local/closure/global scope chain");
    check(lsink.waitFor("\"objectId\":\"0:local\"", "local objectId"),
          "scope objects carry frame-scoped objectIds");

    // evaluateOnCallFrame resolves the argument, a local, and the closure var.
    lTarget.dispatch(
        1,
        R"({"id":10,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"name"}})");
    check(lsink.waitFor("\"type\":\"string\",\"value\":\"world\"", "eval arg"),
          "evaluateOnCallFrame name -> \"world\" (argument)");
    lTarget.dispatch(
        1,
        R"({"id":11,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"count"}})");
    check(lsink.waitFor("\"value\":11,\"description\":\"11\"", "eval local"),
          "evaluateOnCallFrame count -> 11 (local)");
    lTarget.dispatch(
        1,
        R"({"id":12,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"base"}})");
    check(lsink.waitFor("\"value\":10,\"description\":\"10\"", "eval closure"),
          "evaluateOnCallFrame base -> 10 (closure capture)");
    lTarget.dispatch(
        1,
        R"({"id":13,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"name.length"}})");
    check(lsink.waitFor("\"value\":5,\"description\":\"5\"", "eval member"),
          "evaluateOnCallFrame name.length -> 5 (in-scope member access)");

    // getProperties enumerates a scope object's variables while paused.
    std::string localProps = lEngine->getProperties(1, "0:local");
    check(localProps.find("\"name\":\"name\"") != std::string::npos &&
              localProps.find("\"name\":\"count\"") != std::string::npos &&
              localProps.find("\"name\":\"msg\"") != std::string::npos,
          "getProperties(0:local) lists name/count/msg");
    std::string closureProps = lEngine->getProperties(1, "0:closure");
    check(closureProps.find("\"name\":\"base\"") != std::string::npos,
          "getProperties(0:closure) lists base");

    lTarget.dispatch(1, R"({"id":3,"method":"Debugger.resume"})");
    check(lFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "in-frame scope case resumed to completion");
    lThread.join();

    JS_FreeContext(lctx);
    JS_FreeRuntime(lrt);
  }

  // --- Nested objects: evaluate mints an objectId, getProperties expands it, ----
  // --- child objects carry their own ids, and every id dies at resume. ---------
  {
    JSRuntime* ort = JS_NewRuntime();
    JSContext* octx = JS_NewContext(ort);
    QuickJSDebugCore ocore(ort, octx);
    auto oEngine = std::make_shared<QuickJSEngineDebugger>(&ocore, 1);
    auto oAdapter = std::make_shared<DebuggerAdapter>();
    oAdapter->setEngineDebugger(oEngine);
    AdapterDebugTarget oTarget(oAdapter, 1);
    oEngine->setPausedNotifier(
        [oAdapter](PauseReason r, const std::vector<CallFrame>& frames,
                   const std::vector<std::string>& hits) {
          oAdapter->onPaused(1, r, frames, hits);
        });

    Sink osink;
    oTarget.onClientConnect(1, [&osink](const RawCdpMessage& m) { osink.push(m); });
    oTarget.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");
    // Breakpoint at source line 3 (CDP lineNumber 2): obj is fully built by then.
    oTarget.dispatch(
        1,
        R"({"id":2,"method":"Debugger.setBreakpoint","params":{"location":{"scriptId":"obj.js","lineNumber":2}}})");

    std::promise<void> oDone;
    auto oFut = oDone.get_future();
    std::thread oThread([&] {
      JS_UpdateStackTop(ort);
      static const char* kObj =
          "function run() {\n"                                    // 1
          "  var obj = { a: 1, b: 'two', nested: { c: 3 } };\n"  // 2
          "  globalThis.out = obj.a;\n"                           // 3 <- breakpoint
          "  return obj;\n"                                       // 4
          "}\n"                                                    // 5
          "run();\n";                                              // 6
      JSValue v = JS_Eval(octx, kObj, std::strlen(kObj), "obj.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(octx, v);
      oDone.set_value();
    });

    check(osink.waitFor("\"Debugger.paused\"", "object paused event"),
          "nested objects: Debugger.paused delivered");

    // evaluate "obj" -> a RemoteObject carrying a fresh objectId (not inlined).
    std::string objEval = oEngine->evaluateOnCallFrame(1, "0", "obj");
    check(objEval.find("\"type\":\"object\"") != std::string::npos &&
              objEval.find("\"objectId\":\"obj:") != std::string::npos,
          "evaluate obj -> object RemoteObject with an objectId");
    const std::string objId = extractObjectId(objEval);

    // getProperties(objId) lists a/b/nested; nested is itself an object with id.
    std::string props = oEngine->getProperties(1, objId);
    check(props.find("\"name\":\"a\"") != std::string::npos &&
              props.find("\"value\":1,\"description\":\"1\"") != std::string::npos,
          "getProperties(obj) exposes a === 1");
    check(props.find("\"name\":\"b\"") != std::string::npos &&
              props.find("\"type\":\"string\",\"value\":\"two\"") !=
                  std::string::npos,
          "getProperties(obj) exposes b === \"two\"");
    check(props.find("\"name\":\"nested\"") != std::string::npos &&
              props.find("\"objectId\":\"obj:") != std::string::npos,
          "getProperties(obj) exposes nested as an expandable object");

    // Drill into the child object: its own objectId expands to c === 3. Find the
    // nested descriptor, then the objectId within it.
    auto nestedPos = props.find("\"name\":\"nested\"");
    const std::string nestedId =
        extractObjectId(props.substr(nestedPos));
    check(!nestedId.empty() && nestedId != objId,
          "nested object has its own distinct objectId");
    std::string nestedProps = oEngine->getProperties(1, nestedId);
    check(nestedProps.find("\"name\":\"c\"") != std::string::npos &&
              nestedProps.find("\"value\":3,\"description\":\"3\"") !=
                  std::string::npos,
          "getProperties(nested) exposes c === 3");

    oTarget.dispatch(1, R"({"id":3,"method":"Debugger.resume"})");
    check(oFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "nested objects case resumed to completion");
    oThread.join();

    // After resume the pause-scoped registry is emptied: the id no longer
    // resolves (not paused -> empty result).
    std::string afterResume = oEngine->getProperties(1, objId);
    check(afterResume == R"({"result":[]})",
          "objectIds are invalidated after resume (registry freed)");

    JS_FreeContext(octx);
    JS_FreeRuntime(ort);
  }

  std::cout << "=== " << (g_failures == 0 ? "ALL PASS" : "FAILURES") << " ("
            << g_failures << " failed) ===\n";
  return g_failures == 0 ? 0 : 1;
}
