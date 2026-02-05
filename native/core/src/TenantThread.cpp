#include "TenantThread.h"
#include <chrono>
#include <stdexcept>

namespace rill::orchestrator {

TenantThread::TenantThread(TenantId id)
    : id_(id), timerWheel_(std::make_unique<TimerWheel>()) {
  running_.store(true, std::memory_order_release);
  thread_ = std::thread(&TenantThread::threadMain, this);
}

TenantThread::~TenantThread() {
  requestStop();
  if (thread_.joinable()) {
    thread_.join();
  }
}

void TenantThread::post(std::function<void()> task, TaskPriority priority) {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    if (!running_.load(std::memory_order_acquire)) {
      return; // Silently drop tasks after stop is requested.
    }
    taskQueue_.push(PrioritizedTask{priority, taskSequence_++, std::move(task)});
  }
  queueCv_.notify_one();
}

bool TenantThread::isRunning() const {
  return running_.load(std::memory_order_acquire);
}

void TenantThread::requestStop() {
  bool expected = true;
  if (running_.compare_exchange_strong(expected, false,
                                       std::memory_order_acq_rel)) {
    queueCv_.notify_one();
  }
}

// --- Timer delegation ---
// These methods post work to the tenant thread so that TimerWheel
// is only ever accessed from a single thread (the tenant thread).

TimerId TenantThread::scheduleTimeout(std::function<void()> cb,
                                      double delayMs) {
  // We need to return the TimerId synchronously, so we use runSync
  // if called from an external thread. However, if the caller is on
  // the tenant thread, we call directly to avoid deadlock.
  if (std::this_thread::get_id() == thread_.get_id()) {
    return timerWheel_->addTimeout(std::move(cb), delayMs);
  }
  return runSync<TimerId>([this, cb = std::move(cb), delayMs]() -> TimerId {
    return timerWheel_->addTimeout(std::move(cb), delayMs);
  });
}

TimerId TenantThread::scheduleInterval(std::function<void()> cb,
                                       double intervalMs) {
  if (std::this_thread::get_id() == thread_.get_id()) {
    return timerWheel_->addInterval(std::move(cb), intervalMs);
  }
  return runSync<TimerId>(
      [this, cb = std::move(cb), intervalMs]() -> TimerId {
        return timerWheel_->addInterval(std::move(cb), intervalMs);
      });
}

bool TenantThread::cancelTimer(TimerId id) {
  if (std::this_thread::get_id() == thread_.get_id()) {
    return timerWheel_->cancel(id);
  }
  return runSync<bool>([this, id]() -> bool { return timerWheel_->cancel(id); });
}

void TenantThread::pauseTimers() {
  if (std::this_thread::get_id() == thread_.get_id()) {
    timerWheel_->pause();
    return;
  }
  post([this]() { timerWheel_->pause(); }, TaskPriority::Immediate);
}

void TenantThread::resumeTimers() {
  if (std::this_thread::get_id() == thread_.get_id()) {
    timerWheel_->resume();
    return;
  }
  post([this]() { timerWheel_->resume(); }, TaskPriority::Immediate);
}

// --- Event loop ---

void TenantThread::threadMain() {
  using namespace std::chrono;

  while (running_.load(std::memory_order_acquire)) {
    std::vector<PrioritizedTask> batch;

    {
      std::unique_lock<std::mutex> lock(queueMutex_);

      // Determine how long to wait based on next timer expiry.
      auto waitUntil = [&]() -> steady_clock::time_point {
        auto nextExpiry = timerWheel_->nextExpiryMs();
        if (nextExpiry.has_value()) {
          // Convert absolute ms since epoch to a time_point.
          auto dur = duration<double, std::milli>(*nextExpiry);
          return steady_clock::time_point(
              duration_cast<steady_clock::duration>(dur));
        }
        // No timers pending — wait up to 100ms to stay responsive.
        return steady_clock::now() + milliseconds(100);
      };

      if (taskQueue_.empty()) {
        queueCv_.wait_until(lock, waitUntil());
      }

      // Drain all pending tasks into a local batch.
      while (!taskQueue_.empty()) {
        batch.push_back(std::move(const_cast<PrioritizedTask&>(
            taskQueue_.top())));
        taskQueue_.pop();
      }
    }

    // Execute tasks outside the lock.
    for (auto& task : batch) {
      if (task.fn) {
        task.fn();
      }
    }

    // Advance timers.
    double nowMs =
        duration_cast<duration<double, std::milli>>(
            steady_clock::now().time_since_epoch())
            .count();
    timerWheel_->tick(nowMs);
  }

  // Drain remaining tasks on shutdown so that any pending promises are
  // fulfilled (prevents hanging futures).
  std::vector<PrioritizedTask> remaining;
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    while (!taskQueue_.empty()) {
      remaining.push_back(std::move(
          const_cast<PrioritizedTask&>(taskQueue_.top())));
      taskQueue_.pop();
    }
  }
  for (auto& task : remaining) {
    if (task.fn) {
      task.fn();
    }
  }
}

} // namespace rill::orchestrator
