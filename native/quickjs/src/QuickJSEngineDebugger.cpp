#include "QuickJSEngineDebugger.h"

#ifdef RILL_QJS_DEBUG

#include "devtools/CDPServer.h"  // rill::devtools::cdp::escapeJSON
#include "quickjs.h"
#include "quickjs-debug.h"  // rill_qjs_enumerate_frame_vars / rill_qjs_frame_this

#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>
#include <sstream>
#include <vector>

namespace rill::qjs_debug {

namespace rd = rill::devtools;

namespace {
// A frame variable collected during a paused enumeration. `value` is borrowed
// from the live frame (valid only while paused); used transiently, never freed.
struct QjsVar {
  std::string name;
  JSValueConst value;
};

// Only real source identifiers may be bound into the evaluate wrapper's parameter
// list; QuickJS also carries compiler-internal slots (e.g. "<ret>") whose names
// are not valid parameters.
bool isBindableName(const std::string& n) {
  auto isStart = [](char c) {
    return std::isalpha((unsigned char)c) || c == '_' || c == '$';
  };
  auto isPart = [](char c) {
    return std::isalnum((unsigned char)c) || c == '_' || c == '$';
  };
  if (n.empty() || !isStart(n[0])) return false;
  for (char c : n)
    if (!isPart(c)) return false;
  return true;
}
}  // namespace

// extern "C" sink for rill_qjs_enumerate_frame_vars; copies the borrowed name and
// keeps the borrowed value (used only within the paused job that collected it).
// Defined inside the namespace so it can name the anonymous-namespace QjsVar.
extern "C" void rill_qjs_var_collect_sink(void* user, const char* name,
                                          JSValueConst value) {
  static_cast<std::vector<QjsVar>*>(user)->push_back(
      {name ? std::string(name) : std::string(), value});
}

std::string QuickJSEngineDebugger::registerObject(JSContext* ctx,
                                                 JSValueConst v) {
  std::string id = "obj:" + std::to_string(nextObjectId_++);
  pauseObjects_.emplace(id, JS_DupValue(ctx, v));  // retained until pause exit
  return id;
}

void QuickJSEngineDebugger::freePauseObjects(JSContext* ctx) {
  for (auto& [id, val] : pauseObjects_) JS_FreeValue(ctx, val);
  pauseObjects_.clear();
  // ids are not reused across pauses (nextObjectId_ stays monotonic) so a stale
  // client id from a previous pause can never collide with a fresh object.
}

std::string QuickJSEngineDebugger::toRemoteObjectJson(JSContext* ctx,
                                                      JSValueConst v) {
  if (JS_IsUndefined(v)) return R"({"type":"undefined"})";
  if (JS_IsNull(v)) return R"({"type":"object","subtype":"null","value":null})";
  if (JS_IsBool(v))
    return std::string("{\"type\":\"boolean\",\"value\":") +
           (JS_ToBool(ctx, v) ? "true" : "false") + "}";
  if (JS_IsNumber(v)) {
    double d = 0;
    JS_ToFloat64(ctx, &d, v);
    const char* s = JS_ToCString(ctx, v);
    std::ostringstream ss;
    if (std::isfinite(d))
      ss << "{\"type\":\"number\",\"value\":" << (s ? s : "0")
         << ",\"description\":\"" << (s ? s : "0") << "\"}";
    else  // NaN / +-Infinity are not valid JSON numbers
      ss << "{\"type\":\"number\",\"description\":\""
         << (s ? s : "NaN") << "\"}";
    if (s) JS_FreeCString(ctx, s);
    return ss.str();
  }
  if (JS_IsString(v)) {
    const char* s = JS_ToCString(ctx, v);
    std::string out = "{\"type\":\"string\",\"value\":\"" +
                      rd::cdp::escapeJSON(s ? s : "") + "\"}";
    if (s) JS_FreeCString(ctx, s);
    return out;
  }
  // Objects and functions: describe them and mint a pause-scoped objectId so the
  // client can expand them via getProperties. Functions report type "function";
  // arrays get subtype "array"; everything else is a plain object.
  const char* s = JS_ToCString(ctx, v);
  const std::string desc = rd::cdp::escapeJSON(s ? s : "");
  if (s) JS_FreeCString(ctx, s);
  const std::string oid = registerObject(ctx, v);
  if (JS_IsFunction(ctx, v)) {
    return "{\"type\":\"function\",\"className\":\"Function\",\"description\":\"" +
           desc + "\",\"objectId\":\"" + oid + "\"}";
  }
  if (JS_IsArray(ctx, v) > 0) {
    return "{\"type\":\"object\",\"subtype\":\"array\",\"className\":\"Array\","
           "\"description\":\"" + desc + "\",\"objectId\":\"" + oid + "\"}";
  }
  return "{\"type\":\"object\",\"className\":\"Object\",\"description\":\"" +
         desc + "\",\"objectId\":\"" + oid + "\"}";
}

void QuickJSEngineDebugger::emitOwnProps(JSContext* ctx, JSValueConst obj,
                                         std::vector<std::string>& out) {
  JSPropertyEnum* tab = nullptr;
  uint32_t len = 0;
  if (JS_GetOwnPropertyNames(ctx, &tab, &len, obj,
                             JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0)
    return;
  const uint32_t cap = len < 200 ? len : 200;  // bound the payload
  for (uint32_t i = 0; i < cap; ++i) {
    const char* nm = JS_AtomToCString(ctx, tab[i].atom);
    JSValue pv = JS_GetProperty(ctx, obj, tab[i].atom);
    if (nm && !JS_IsException(pv)) {
      out.push_back(
          "{\"name\":\"" + rd::cdp::escapeJSON(nm) +
          "\",\"value\":" + toRemoteObjectJson(ctx, pv) +
          ",\"configurable\":true,\"enumerable\":true,\"writable\":true}");
    }
    if (nm) JS_FreeCString(ctx, nm);
    JS_FreeValue(ctx, pv);
  }
  JS_FreeEnumArray(ctx, tab, len);
}

QuickJSEngineDebugger::QuickJSEngineDebugger(QuickJSDebugCore* core,
                                             rd::TenantId tenantId)
    : core_(core), tenantId_(tenantId) {
  core_->setPausedCallback(
      [this](const std::string& scriptId, int line1Based, PauseReason reason) {
        onCorePaused(scriptId, line1Based, reason);
      });
  core_->setScriptSeenCallback(
      [this](const std::string& scriptId, const std::string& url,
             const std::string& source) { onScriptSeen(scriptId, url, source); });
  // Pause-scoped objectIds are dropped on the runtime thread as each pause ends;
  // freeing there is the only thread-safe point for the dup'd JSValues.
  core_->setResumingCallback(
      [this](JSContext* ctx) { freePauseObjects(ctx); });
}

QuickJSEngineDebugger::~QuickJSEngineDebugger() {
  // Detach from the core before we die: clear the paused callback (it captures
  // this) and drop our breakpoints so a still-live core can't pause with no
  // observer. The core outlives us (owned by the sandbox context, torn down
  // after the debug target).
  core_->setPausedCallback(nullptr);
  core_->setScriptSeenCallback(nullptr);
  core_->setResumingCallback(nullptr);
  std::lock_guard<std::mutex> lk(mutex_);
  for (const auto& [id, loc] : breakpoints_) {
    core_->removeBreakpoint(loc.first, loc.second);
  }
  breakpoints_.clear();
}

void QuickJSEngineDebugger::setPausedNotifier(PausedNotifier fn) {
  notifier_ = std::move(fn);
}

void QuickJSEngineDebugger::setScriptParsedNotifier(ScriptParsedNotifier fn) {
  scriptNotifier_ = std::move(fn);
}

bool QuickJSEngineDebugger::enable(rd::TenantId) { return true; }

void QuickJSEngineDebugger::disable(rd::TenantId) {
  std::lock_guard<std::mutex> lk(mutex_);
  for (const auto& [id, loc] : breakpoints_) {
    core_->removeBreakpoint(loc.first, loc.second);
  }
  breakpoints_.clear();
}

std::optional<std::string> QuickJSEngineDebugger::setBreakpoint(
    rd::TenantId, const std::string& scriptId, int lineNumber,
    int /*columnNumber*/, const std::string& /*condition*/) {
  const int line1Based = lineNumber + 1;  // CDP 0-based -> QuickJS 1-based
  std::string id;
  {
    std::lock_guard<std::mutex> lk(mutex_);
    id = std::to_string(nextBreakpointId_++);
    breakpoints_.emplace(id, std::make_pair(scriptId, line1Based));
  }
  core_->addBreakpoint(scriptId, line1Based);
  return id;
}

bool QuickJSEngineDebugger::removeBreakpoint(rd::TenantId,
                                             const std::string& breakpointId) {
  std::pair<std::string, int> loc;
  {
    std::lock_guard<std::mutex> lk(mutex_);
    auto it = breakpoints_.find(breakpointId);
    if (it == breakpoints_.end()) return false;
    loc = it->second;
    breakpoints_.erase(it);
  }
  core_->removeBreakpoint(loc.first, loc.second);
  return true;
}

void QuickJSEngineDebugger::pause(rd::TenantId) { core_->requestPause(); }

void QuickJSEngineDebugger::resume(rd::TenantId) { core_->resume(); }

void QuickJSEngineDebugger::step(rd::TenantId, rd::StepAction action) {
  switch (action) {
    case rd::StepAction::StepInto: core_->stepInto(); break;
    case rd::StepAction::StepOver: core_->stepOver(); break;
    case rd::StepAction::StepOut:  core_->stepOut();  break;
    case rd::StepAction::Continue: core_->resume();   break;
  }
}

std::string QuickJSEngineDebugger::evaluateOnCallFrame(
    rd::TenantId, const std::string& callFrameId,
    const std::string& expression) {
  // Evaluate in the paused frame's scope: gather the frame's arguments, locals,
  // and captured closure variables, then run the expression inside a synthesized
  // wrapper `(function(<names>){ return (<expr>); })` called with those current
  // values and the frame's `this`. Inner bindings (args/locals) shadow closure
  // bindings. Falls back to global scope if the wrapper cannot be built. Not
  // paused -> undefined.
  int frameIndex = 0;
  try {
    frameIndex = std::stoi(callFrameId);
  } catch (...) {
    frameIndex = 0;
  }
  std::string result = R"({"type":"undefined"})";
  core_->runOnPausedThread([&](JSContext* ctx) {
    std::vector<QjsVar> args, locals, closures;
    rill_qjs_enumerate_frame_vars(ctx, frameIndex, RILL_QJS_VAR_ARG,
                                  &rill_qjs_var_collect_sink, &args);
    rill_qjs_enumerate_frame_vars(ctx, frameIndex, RILL_QJS_VAR_LOCAL,
                                  &rill_qjs_var_collect_sink, &locals);
    rill_qjs_enumerate_frame_vars(ctx, frameIndex, RILL_QJS_VAR_CLOSURE,
                                  &rill_qjs_var_collect_sink, &closures);

    std::vector<QjsVar> bindings;
    std::set<std::string> seen;
    auto take = [&](std::vector<QjsVar>& src) {
      for (auto& v : src) {
        if (!isBindableName(v.name) || seen.count(v.name)) continue;
        seen.insert(v.name);
        bindings.push_back(v);
      }
    };
    take(args);
    take(locals);
    take(closures);  // outer scope: only names not already shadowed

    std::string wrapper = "(function(";
    for (std::size_t i = 0; i < bindings.size(); ++i) {
      if (i) wrapper += ",";
      wrapper += bindings[i].name;
    }
    wrapper += "){return (" + expression + ");})";

    JSValue fn = JS_Eval(ctx, wrapper.c_str(), wrapper.size(), "<evaluate>",
                         JS_EVAL_TYPE_GLOBAL);
    JSValue v;
    if (JS_IsException(fn)) {
      // The wrapper itself failed to compile (e.g. an unexpected binding name);
      // clear it and fall back to a plain global-scope evaluation.
      JS_FreeValue(ctx, JS_GetException(ctx));
      JS_FreeValue(ctx, fn);
      v = JS_Eval(ctx, expression.c_str(), expression.size(), "<evaluate>",
                  JS_EVAL_TYPE_GLOBAL);
    } else {
      std::vector<JSValue> argv;
      argv.reserve(bindings.size());
      for (auto& b : bindings) argv.push_back(b.value);
      JSValue thisVal = rill_qjs_frame_this(ctx, frameIndex);
      v = JS_Call(ctx, fn, thisVal, static_cast<int>(argv.size()),
                  argv.empty() ? nullptr : argv.data());
      JS_FreeValue(ctx, fn);
    }

    if (JS_IsException(v)) {
      // Take and clear the pending exception so the paused program resumes
      // cleanly; report it as an error remote object.
      JSValue e = JS_GetException(ctx);
      const char* s = JS_ToCString(ctx, e);
      result = "{\"type\":\"object\",\"subtype\":\"error\",\"className\":"
               "\"Error\",\"description\":\"" +
               rd::cdp::escapeJSON(s ? s : "") + "\"}";
      if (s) JS_FreeCString(ctx, s);
      JS_FreeValue(ctx, e);
    } else {
      result = toRemoteObjectJson(ctx, v);
    }
    JS_FreeValue(ctx, v);
  });
  return result;
}

std::string QuickJSEngineDebugger::getProperties(rd::TenantId,
                                                 const std::string& objectId) {
  // Two objectId shapes, both resolved on the paused runtime thread into CDP
  // PropertyDescriptors. Not paused / bad id -> empty.
  //   "obj:N"            a pause-scoped object minted by toRemoteObjectJson; its
  //                      own enumerable properties (children get their own ids).
  //   "<frameIndex>:kind" a scope from onCorePaused's scopeChain
  //                      (kind = local|closure|global).
  std::vector<std::string> descriptors;
  bool ran = false;

  if (objectId.rfind("obj:", 0) == 0) {
    ran = core_->runOnPausedThread([&](JSContext* ctx) {
      auto it = pauseObjects_.find(objectId);
      if (it == pauseObjects_.end()) return;  // stale id from a previous pause
      emitOwnProps(ctx, it->second, descriptors);
    });
  } else {
    auto colon = objectId.find(':');
    if (colon == std::string::npos) return R"({"result":[]})";
    int frameIndex = 0;
    try {
      frameIndex = std::stoi(objectId.substr(0, colon));
    } catch (...) {
      return R"({"result":[]})";
    }
    const std::string kind = objectId.substr(colon + 1);
    ran = core_->runOnPausedThread([&](JSContext* ctx) {
      auto emit = [&](const std::string& name, JSValueConst val) {
        descriptors.push_back(
            "{\"name\":\"" + rd::cdp::escapeJSON(name) +
            "\",\"value\":" + toRemoteObjectJson(ctx, val) +
            ",\"configurable\":true,\"enumerable\":true,\"writable\":true}");
      };
      if (kind == "local") {
        std::vector<QjsVar> vars;
        rill_qjs_enumerate_frame_vars(ctx, frameIndex, RILL_QJS_VAR_ARG,
                                      &rill_qjs_var_collect_sink, &vars);
        rill_qjs_enumerate_frame_vars(ctx, frameIndex, RILL_QJS_VAR_LOCAL,
                                      &rill_qjs_var_collect_sink, &vars);
        for (auto& v : vars)
          if (isBindableName(v.name)) emit(v.name, v.value);
      } else if (kind == "closure") {
        std::vector<QjsVar> vars;
        rill_qjs_enumerate_frame_vars(ctx, frameIndex, RILL_QJS_VAR_CLOSURE,
                                      &rill_qjs_var_collect_sink, &vars);
        for (auto& v : vars)
          if (isBindableName(v.name)) emit(v.name, v.value);
      } else if (kind == "global") {
        JSValue g = JS_GetGlobalObject(ctx);
        emitOwnProps(ctx, g, descriptors);
        JS_FreeValue(ctx, g);
      }
    });
  }
  if (!ran) return R"({"result":[]})";

  std::string out = R"({"result":[)";
  for (std::size_t i = 0; i < descriptors.size(); ++i) {
    if (i) out += ",";
    out += descriptors[i];
  }
  out += "]}";
  return out;
}

std::vector<rd::CallFrame> QuickJSEngineDebugger::getCallFrames(rd::TenantId) {
  std::lock_guard<std::mutex> lk(mutex_);
  return lastFrames_;
}

std::vector<rd::ScriptInfo> QuickJSEngineDebugger::getScripts(rd::TenantId) {
  std::lock_guard<std::mutex> lk(mutex_);
  std::vector<rd::ScriptInfo> out;
  out.reserve(scripts_.size());
  for (const auto& [id, info] : scripts_) out.push_back(info);
  return out;
}

std::string QuickJSEngineDebugger::getScriptSource(rd::TenantId,
                                                   const std::string& scriptId) {
  std::lock_guard<std::mutex> lk(mutex_);
  auto it = sources_.find(scriptId);
  return it == sources_.end() ? std::string() : it->second;
}

void QuickJSEngineDebugger::onScriptSeen(const std::string& scriptId,
                                         const std::string& url,
                                         const std::string& source) {
  rd::ScriptInfo info;
  info.scriptId = scriptId;
  info.url = url;
  // endLine lets a front-end size the script; count source newlines.
  info.endLine = static_cast<int>(
      std::count(source.begin(), source.end(), '\n'));
  {
    std::lock_guard<std::mutex> lk(mutex_);
    scripts_[scriptId] = info;
    sources_[scriptId] = source;
  }
  if (scriptNotifier_) scriptNotifier_(info);
}

bool QuickJSEngineDebugger::isPaused(rd::TenantId) { return core_->isPaused(); }

rd::PauseReason QuickJSEngineDebugger::toCdpReason(PauseReason reason) {
  switch (reason) {
    case PauseReason::Breakpoint: return rd::PauseReason::Breakpoint;
    case PauseReason::Step:       return rd::PauseReason::Step;
    case PauseReason::Pause:      return rd::PauseReason::DebugCommand;
  }
  return rd::PauseReason::Other;
}

void QuickJSEngineDebugger::onCorePaused(const std::string& scriptId,
                                         int line1Based, PauseReason reason) {
  // Snapshot the whole live stack (top frame first) while it is still intact.
  std::vector<rd::CallFrame> frames;
  const auto snaps = core_->captureFrames();
  frames.reserve(snaps.size());
  for (std::size_t i = 0; i < snaps.size(); ++i) {
    const auto& s = snaps[i];
    rd::CallFrame f;
    f.callFrameId = std::to_string(i);
    f.functionName = s.functionName.empty() ? "<anonymous>" : s.functionName;
    f.scriptId = s.scriptId;
    f.url = s.scriptId;
    f.lineNumber = s.line1Based - 1;  // QuickJS 1-based -> CDP 0-based
    f.columnNumber = 0;
    // Scope chain: Local (args + locals) and Closure resolve against this frame;
    // Global is shared. objectIds are "<frameIndex>:<kind>" and are resolved
    // lazily by getProperties() while still paused. Enumerating a scope that has
    // no variables simply yields an empty property list.
    const std::string idx = std::to_string(i);
    f.scopeChain.push_back({"local", idx + ":local", f.functionName});
    f.scopeChain.push_back({"closure", idx + ":closure", ""});
    f.scopeChain.push_back({"global", idx + ":global", ""});
    frames.push_back(std::move(f));
  }
  if (frames.empty()) {
    // Fallback: a pause must always surface a location even if the walk came up
    // empty (e.g. the top frame was stripped).
    rd::CallFrame f;
    f.callFrameId = "0";
    f.scriptId = scriptId;
    f.url = scriptId;
    f.lineNumber = line1Based - 1;
    f.columnNumber = 0;
    frames.push_back(std::move(f));
  }

  // A breakpoint pause reports which engine breakpoint id(s) fired at the top
  // frame (scriptId + 1-based line).
  std::vector<std::string> hitBreakpoints;
  {
    std::lock_guard<std::mutex> lk(mutex_);
    lastFrames_ = frames;
    if (reason == PauseReason::Breakpoint) {
      for (const auto& [id, loc] : breakpoints_) {
        if (loc.first == scriptId && loc.second == line1Based)
          hitBreakpoints.push_back(id);
      }
    }
  }
  if (notifier_) notifier_(toCdpReason(reason), frames, hitBreakpoints);
}

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
