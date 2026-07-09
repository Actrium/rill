// -----------------------------------------------------------------------------
// TEST-ONLY JSI HOST - excluded from the shipped pod (see RillSandboxNative.podspec
// exclude_files). This file is part of a full jsi::Runtime over QuickJS. It is NOT
// the sandbox product: production hosts install the *SandboxJSI HostObject into
// their OWN runtime and never link this cluster (verified: no rill downstream links
// it). It is retained solely as a self-contained, dependency-free JSI host that lets
// the sandbox be unit- and leak-tested natively via native/quickjs/Makefile
// (QuickJS builds with vendored sources on plain Linux - no RN/JSC/Hermes needed).
// Do NOT add production code that depends on this file; if you do, it must be moved
// back into the shipped source set deliberately.
// -----------------------------------------------------------------------------
#include "QuickJSInstrumentation.h"

#include "QuickJSRuntime.h"
namespace qjs {
QuickJSInstrumentation::QuickJSInstrumentation(QuickJSRuntime *runtime)
    : runtime_(runtime) {}

std::string QuickJSInstrumentation::getRecordedGCStats() { return ""; }

std::unordered_map<std::string, int64_t>
QuickJSInstrumentation::getHeapInfo(bool) {
  if (runtime_) {
    return runtime_->getHeapInfo();
  } else {
    return {};
  }
}

void QuickJSInstrumentation::collectGarbage(std::string) {
  JS_RunGC(runtime_->getJSRuntime());
}

void QuickJSInstrumentation::createSnapshotToFile(
    const std::string &, const jsi::Instrumentation::HeapSnapshotOptions &) {}

void QuickJSInstrumentation::createSnapshotToStream(
    std::ostream &, const jsi::Instrumentation::HeapSnapshotOptions &) {}

void QuickJSInstrumentation::writeBasicBlockProfileTraceToFile(
    const std::string &) const {}

void QuickJSInstrumentation::dumpProfilerSymbolsToFile(
    const std::string &) const {}
} // namespace qjs
