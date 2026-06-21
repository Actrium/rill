#pragma once
#include "TimerWheel.h"
#include <atomic>
#include <condition_variable>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>
#include <type_traits>

namespace rill::tenant_manager {

using TenantId = uint32_t;

enum class TaskPriority : uint8_t {
  Immediate = 0,
  High = 1,
  Normal = 2,
  Low = 3,
};

class TenantThread {
public:
  explicit TenantThread(TenantId id);
  ~TenantThread();

  // Non-copyable, non-movable
  TenantThread(const TenantThread&) = delete;
  TenantThread& operator=(const TenantThread&) = delete;

  // Post a task to the thread's queue with the given priority.
  void post(std::function<void()> task,
            TaskPriority priority = TaskPriority::Normal);

  // Run a task synchronously on the tenant thread and return the result.
  // Blocks the calling thread until the task completes.
  // Must NOT be called from the tenant thread itself (deadlock).
  template <typename R>
  R runSync(std::function<R()> task);

  bool isRunning() const;
  void requestStop();

  // Timer delegation — safe to call from any thread.
  TimerId scheduleTimeout(std::function<void()> cb, double delayMs);
  TimerId scheduleInterval(std::function<void()> cb, double intervalMs);
  // Returns true if the timer was still pending and got cancelled.
  // Synchronous by design to make quota accounting deterministic.
  bool cancelTimer(TimerId id);
  void pauseTimers();
  void resumeTimers();

  TenantId id() const { return id_; }

private:
  void threadMain();

  struct PrioritizedTask {
    TaskPriority priority;
    uint64_t sequence; // FIFO ordering within the same priority
    std::function<void()> fn;

    bool operator>(const PrioritizedTask& other) const {
      if (priority != other.priority) {
        return static_cast<uint8_t>(priority) >
               static_cast<uint8_t>(other.priority);
      }
      return sequence > other.sequence;
    }
  };

  TenantId id_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::mutex queueMutex_;
  std::condition_variable queueCv_;
  std::priority_queue<PrioritizedTask, std::vector<PrioritizedTask>,
                      std::greater<PrioritizedTask>>
      taskQueue_;
  uint64_t taskSequence_ = 0;
  std::unique_ptr<TimerWheel> timerWheel_;
};

// --- Template implementation (must be in header) ---

template <typename R>
R TenantThread::runSync(std::function<R()> task) {
  std::promise<R> promise;
  std::future<R> future = promise.get_future();

  post(
      [&promise, task = std::move(task)]() {
        try {
          if constexpr (std::is_void_v<R>) {
            task();
            promise.set_value();
          } else {
            promise.set_value(task());
          }
        } catch (...) {
          promise.set_exception(std::current_exception());
        }
      },
      TaskPriority::Immediate);

  return future.get();
}

} // namespace rill::tenant_manager
