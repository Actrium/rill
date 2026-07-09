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
#pragma once

#include <jsi/instrumentation.h>

namespace jsi = facebook::jsi;

namespace qjs {

class QuickJSRuntime;

class QuickJSInstrumentation : public jsi::Instrumentation {
public:
  QuickJSInstrumentation(QuickJSRuntime *runtime);

  std::string getRecordedGCStats() override;

  std::unordered_map<std::string, int64_t> getHeapInfo(bool) override;

  void collectGarbage(std::string cause) override;

  void createSnapshotToFile(
      const std::string &,
      const jsi::Instrumentation::HeapSnapshotOptions & = {false}) override;

  void createSnapshotToStream(
      std::ostream &,
      const jsi::Instrumentation::HeapSnapshotOptions & = {false}) override;

  void writeBasicBlockProfileTraceToFile(const std::string &) const override;

  void dumpProfilerSymbolsToFile(const std::string &) const override;

  void dumpOpcodeStats(std::ostream &) const {}

  void startTrackingHeapObjectStackTraces(
      std::function<void(uint64_t lastSeenObjectID,
                         std::chrono::microseconds timestamp,
                         std::vector<HeapStatsUpdate> stats)>) override{};

  void stopTrackingHeapObjectStackTraces() override {};

  void startHeapSampling(size_t) override {};

  void stopHeapSampling(std::ostream &) override {};

  std::string flushAndDisableBridgeTrafficTrace() override { return ""; };

private:
  QuickJSRuntime *runtime_;
};

} // namespace qjs
