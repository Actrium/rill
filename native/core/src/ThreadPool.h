#pragma once
#include "TenantThread.h"
#include <shared_mutex>
#include <unordered_map>

namespace rill::orchestrator {

class ThreadPool {
public:
  // maxThreads == 0 means unlimited.
  explicit ThreadPool(uint32_t maxThreads = 0);
  ~ThreadPool();

  // Non-copyable, non-movable
  ThreadPool(const ThreadPool&) = delete;
  ThreadPool& operator=(const ThreadPool&) = delete;

  // Create a new tenant thread. Returns a non-owning pointer.
  // Throws if maxThreads would be exceeded or id already exists.
  TenantThread* createThread(TenantId id);

  // Stop and destroy the tenant thread for the given id.
  void destroyThread(TenantId id);

  // Retrieve a tenant thread by id, or nullptr if not found.
  TenantThread* getThread(TenantId id) const;

  // Number of active tenant threads.
  size_t activeThreadCount() const;

private:
  std::unordered_map<TenantId, std::unique_ptr<TenantThread>> threads_;
  mutable std::shared_mutex mutex_;
  uint32_t maxThreads_;
};

} // namespace rill::orchestrator
