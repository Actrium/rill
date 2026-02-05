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
