#include "ThreadPool.h"
#include <stdexcept>

namespace rill::tenant_manager {

ThreadPool::ThreadPool(uint32_t maxThreads) : maxThreads_(maxThreads) {}

ThreadPool::~ThreadPool() {
  // Acquire exclusive lock and stop all threads.
  std::unique_lock<std::shared_mutex> lock(mutex_);

  // Request stop on all threads first (non-blocking).
  for (auto& [id, thread] : threads_) {
    thread->requestStop();
  }

  // Clearing the map destroys each unique_ptr, which joins the thread.
  threads_.clear();
}

TenantThread* ThreadPool::createThread(TenantId id) {
  std::unique_lock<std::shared_mutex> lock(mutex_);

  if (threads_.count(id)) {
    throw std::runtime_error("TenantThread already exists for id " +
                             std::to_string(id));
  }

  if (maxThreads_ > 0 && threads_.size() >= maxThreads_) {
    throw std::runtime_error("ThreadPool limit reached (" +
                             std::to_string(maxThreads_) + ")");
  }

  auto thread = std::make_unique<TenantThread>(id);
  auto* ptr = thread.get();
  threads_.emplace(id, std::move(thread));
  return ptr;
}

void ThreadPool::destroyThread(TenantId id) {
  std::unique_ptr<TenantThread> threadToDestroy;

  {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    auto it = threads_.find(id);
    if (it == threads_.end()) {
      return; // No-op if not found.
    }

    // Move out so the destructor (which joins) runs outside the lock.
    threadToDestroy = std::move(it->second);
    threads_.erase(it);
  }

  // Request stop explicitly before the unique_ptr destructor joins.
  threadToDestroy->requestStop();
  // threadToDestroy is destroyed here, joining the thread.
}

TenantThread* ThreadPool::getThread(TenantId id) const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  auto it = threads_.find(id);
  if (it == threads_.end()) {
    return nullptr;
  }
  return it->second.get();
}

size_t ThreadPool::activeThreadCount() const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  return threads_.size();
}

} // namespace rill::tenant_manager
