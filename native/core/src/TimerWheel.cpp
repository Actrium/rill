#include "TimerWheel.h"
#include <algorithm>
#include <chrono>

namespace rill::orchestrator {

double TimerWheel::currentTimeMs() const {
  using namespace std::chrono;
  auto now = steady_clock::now();
  return duration_cast<duration<double, std::milli>>(now.time_since_epoch())
      .count();
}

TimerId TimerWheel::addTimeout(std::function<void()> cb, double delayMs) {
  double nowMs = currentTimeMs();
  double expiryMs = nowMs + delayMs;
  TimerId id = nextId_++;

  TimerEntry entry{id, std::move(cb), expiryMs, 0.0, 0.0, false};

  if (isPaused_) {
    entry.paused = true;
    entry.remainingMs = delayMs;
    // Store under a sentinel expiry; will be recalculated on resume.
    wheel_[expiryMs].push_back(std::move(entry));
  } else {
    wheel_[expiryMs].push_back(std::move(entry));
  }

  return id;
}

TimerId TimerWheel::addInterval(std::function<void()> cb, double intervalMs) {
  double nowMs = currentTimeMs();
  double expiryMs = nowMs + intervalMs;
  TimerId id = nextId_++;

  TimerEntry entry{id, std::move(cb), expiryMs, intervalMs, 0.0, false};

  if (isPaused_) {
    entry.paused = true;
    entry.remainingMs = intervalMs;
    wheel_[expiryMs].push_back(std::move(entry));
  } else {
    wheel_[expiryMs].push_back(std::move(entry));
  }

  return id;
}

bool TimerWheel::cancel(TimerId id) {
  bool removed = false;
  for (auto it = wheel_.begin(); it != wheel_.end();) {
    auto& entries = it->second;
    const auto before = entries.size();
    entries.erase(
        std::remove_if(entries.begin(), entries.end(),
                       [id](const TimerEntry& e) { return e.id == id; }),
        entries.end());
    if (entries.size() != before) {
      removed = true;
    }

    if (entries.empty()) {
      it = wheel_.erase(it);
    } else {
      ++it;
    }
  }
  return removed;
}

void TimerWheel::pause() {
  if (isPaused_) return;
  isPaused_ = true;
  pausedAt_ = currentTimeMs();

  // Snapshot remaining time for each entry.
  for (auto& [expiry, entries] : wheel_) {
    for (auto& entry : entries) {
      entry.remainingMs = entry.expiryMs - pausedAt_;
      if (entry.remainingMs < 0) {
        entry.remainingMs = 0;
      }
      entry.paused = true;
    }
  }
}

void TimerWheel::resume() {
  if (!isPaused_) return;
  isPaused_ = false;

  double nowMs = currentTimeMs();

  // Rebuild the wheel with recalculated expiry times.
  std::map<double, std::vector<TimerEntry>> newWheel;
  for (auto& [_, entries] : wheel_) {
    for (auto& entry : entries) {
      entry.expiryMs = nowMs + entry.remainingMs;
      entry.remainingMs = 0;
      entry.paused = false;
      newWheel[entry.expiryMs].push_back(std::move(entry));
    }
  }
  wheel_ = std::move(newWheel);
}

std::optional<double> TimerWheel::nextExpiryMs() const {
  if (wheel_.empty()) return std::nullopt;
  if (isPaused_) return std::nullopt;
  return wheel_.begin()->first;
}

void TimerWheel::tick(double nowMs) {
  if (isPaused_) return;

  // Collect all expired buckets.
  std::vector<TimerEntry> fired;
  auto it = wheel_.begin();
  while (it != wheel_.end() && it->first <= nowMs) {
    for (auto& entry : it->second) {
      fired.push_back(std::move(entry));
    }
    it = wheel_.erase(it);
  }

  // Execute callbacks and re-insert intervals.
  for (auto& entry : fired) {
    if (entry.callback) {
      entry.callback();
    }

    // Re-schedule interval timers.
    if (entry.intervalMs > 0) {
      double nextExpiry = nowMs + entry.intervalMs;
      entry.expiryMs = nextExpiry;
      wheel_[nextExpiry].push_back(std::move(entry));
    }
  }
}

size_t TimerWheel::activeCount() const {
  size_t count = 0;
  for (const auto& [_, entries] : wheel_) {
    count += entries.size();
  }
  return count;
}

} // namespace rill::orchestrator
