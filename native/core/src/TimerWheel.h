#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <vector>

namespace rill::orchestrator {

using TimerId = uint32_t;

class TimerWheel {
public:
  TimerId addTimeout(std::function<void()> cb, double delayMs);
  TimerId addInterval(std::function<void()> cb, double intervalMs);
  // Returns true if a timer entry was found and removed.
  // Note: cancellation is synchronous because TimerWheel is single-threaded
  // (owned by TenantThread).
  bool cancel(TimerId id);
  void pause();
  void resume();
  std::optional<double> nextExpiryMs() const;
  void tick(double nowMs);
  size_t activeCount() const;

private:
  struct TimerEntry {
    TimerId id;
    std::function<void()> callback;
    double expiryMs;
    double intervalMs;  // 0 = timeout, >0 = interval
    double remainingMs; // used when paused
    bool paused = false;
  };

  // Wheel keyed by expiry time; each bucket holds entries sharing that expiry.
  std::map<double, std::vector<TimerEntry>> wheel_;
  uint32_t nextId_ = 1;
  bool isPaused_ = false;
  double pausedAt_ = 0;

  double currentTimeMs() const;
};

} // namespace rill::orchestrator
